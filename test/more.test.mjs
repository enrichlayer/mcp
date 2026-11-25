import { test } from "node:test";
import assert from "node:assert/strict";
import { CACHE_ONLY_MAX_AGE_SECONDS, PAGE_BYTES } from "../build/config.js";
import { compact } from "../build/fit/compact.js";
import { encodeCursor } from "../build/fit/cursor.js";
import { INVALID_CURSOR } from "../build/tools/definitions.js";
import { bigCompany, bigPerson } from "./big-answers.mjs";
import { connectMcp, headers, startApi, testClient } from "./helpers.mjs";

const COMPANY_URL = "https://www.linkedin.com/company/example-corp";
const bytes = (value) => Buffer.byteLength(JSON.stringify(value));

async function setup(t, respond) {
  const api = await startApi(respond);
  const mcp = await connectMcp(testClient(api.url));
  t.after(async () => {
    await mcp.close();
    await api.close();
  });
  return { api, client: mcp.client };
}

async function readList(client, cursor) {
  const items = [];
  const pages = [];
  for (let next = cursor; next; ) {
    const result = await client.callTool({ name: "get_more", arguments: { cursor: next } });
    assert.equal(result.isError, undefined, result.content?.[0]?.text);
    pages.push(result.structuredContent);
    items.push(...result.structuredContent.list);
    next = result.structuredContent.nextCursor;
  }
  return { items, pages };
}

test("get_more reads a company list page by page from the cached copy, without sections", async (t) => {
  const data = bigCompany();
  const { api, client } = await setup(t, (_, n) => ({ body: data, headers: headers(n === 1 ? 10 : 1, `req-${n}`) }));

  const first = await client.callTool({ name: "get_company_profile", arguments: { url: COMPANY_URL, fundingData: "include", maxAgeSeconds: 0 } });
  const entry = first.structuredContent.more["companySize.employeeCountOverTime"];
  const { items, pages } = await readList(client, entry.cursor);

  assert.ok(bytes(first.structuredContent) <= PAGE_BYTES);
  assert.deepEqual(items, data.companySize.employeeCountOverTime);
  assert.equal(pages.length, entry.pages);
  assert.deepEqual(api.requests[0].query, { url: COMPANY_URL, fundingData: "include", maxAgeSeconds: "0" });
  for (const request of api.requests.slice(1)) {
    assert.equal(request.path, "/v3/company");
    assert.deepEqual(request.query, { url: COMPANY_URL, maxAgeSeconds: String(CACHE_ONLY_MAX_AGE_SECONDS) });
  }
  assert.deepEqual(pages.map((page) => [page.creditCost, page.requestId]), pages.map((_, i) => [1, `req-${i + 2}`]));
  for (const page of pages) assert.ok(bytes(page) <= PAGE_BYTES);
});

test("for a person, get_more asks by LinkedIn username and only for the section that holds the list", async (t) => {
  const data = bigPerson();
  const { api, client } = await setup(t, () => ({ body: data, headers: headers(1, "req-p") }));

  const first = await client.callTool({
    name: "get_person_profile",
    arguments: { email: "jane@example.com", activities: "include", workEmail: "include", personalEmail: "include" },
  });
  await client.callTool({ name: "get_more", arguments: { cursor: first.structuredContent.more["activities.posts"].cursor } });
  await client.callTool({ name: "get_more", arguments: { cursor: first.structuredContent.more["experience.work"].cursor } });

  assert.deepEqual(api.requests[1].query, { profile: "jane-example", activities: "include", maxAgeSeconds: String(CACHE_ONLY_MAX_AGE_SECONDS) });
  assert.deepEqual(api.requests[2].query, { profile: "jane-example", maxAgeSeconds: String(CACHE_ONLY_MAX_AGE_SECONDS) });
});

test("a page tells what the repeat call was charged", async (t) => {
  const { client } = await setup(t, (_, n) => ({ body: bigCompany(), headers: headers(n === 1 ? 1 : 7, `req-${n}`) }));

  const first = await client.callTool({ name: "get_company_profile", arguments: { url: COMPANY_URL } });
  const page = await client.callTool({ name: "get_more", arguments: { cursor: first.structuredContent.more.affiliatedCompanies.cursor } });

  assert.equal(page.structuredContent.creditCost, 7);
  assert.equal(page.structuredContent.requestId, "req-2");
});

test("a broken or tampered cursor is refused without calling the API", async (t) => {
  const { api, client } = await setup(t, () => ({ body: bigCompany() }));
  const tampered = encodeCursor({ v: 1, t: "c", a: { url: COMPANY_URL, maxAgeSeconds: 0 }, p: "locations", o: 0 });

  const broken = await client.callTool({ name: "get_more", arguments: { cursor: "not-a-cursor!" } });
  const live = await client.callTool({ name: "get_more", arguments: { cursor: tampered } });

  assert.equal(broken.isError, true);
  assert.equal(broken.content[0].text, INVALID_CURSOR);
  assert.equal(live.content[0].text, INVALID_CURSOR);
  assert.equal(api.requests.length, 0);
});

test("a list missing from the repeat answer is reported with what the call was charged", async (t) => {
  const { client } = await setup(t, (_, n) => ({ body: n === 1 ? bigCompany() : { name: "Example Corp" }, headers: headers(1, `req-${n}`) }));

  const first = await client.callTool({ name: "get_company_profile", arguments: { url: COMPANY_URL } });
  const page = await client.callTool({ name: "get_more", arguments: { cursor: first.structuredContent.more.affiliatedCompanies.cursor } });

  assert.equal(page.isError, true);
  assert.equal(
    page.content[0].text,
    "This list is not in the answer any more: the profile changed since the first page. Call get_company_profile again for a fresh answer and new cursors. This call was charged 1 credit.",
  );
});

test("a failed repeat call comes back as the usual tool error", async (t) => {
  const { client } = await setup(t, (_, n) =>
    n === 1
      ? { body: bigCompany(), headers: headers(1, "req-1") }
      : { status: 404, body: { code: 404, name: "Not Found", description: "Company not found" }, headers: headers(0, "req-2") },
  );

  const first = await client.callTool({ name: "get_company_profile", arguments: { url: COMPANY_URL } });
  const page = await client.callTool({ name: "get_more", arguments: { cursor: first.structuredContent.more.affiliatedCompanies.cursor } });

  assert.equal(page.isError, true);
  assert.equal(
    page.content[0].text,
    "Not found: Company not found. Check the identifier (URL, username, email or domain), or look it up by another identifier. (credits charged: 0, request id: req-2)",
  );
});

test("pages read through MCP rebuild a person's lists exactly", async (t) => {
  const data = bigPerson();
  const { client } = await setup(t, () => ({ body: data, headers: headers(1, "req") }));

  const first = await client.callTool({ name: "get_person_profile", arguments: { profile: "jane-example", activities: "include" } });
  const posts = await readList(client, first.structuredContent.more["activities.posts"].cursor);
  const work = await readList(client, first.structuredContent.more["experience.work"].cursor);

  assert.deepEqual(posts.items, compact(data).activities.posts);
  assert.deepEqual(work.items, compact(data).experience.work);
});
