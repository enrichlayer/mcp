import { test } from "node:test";
import assert from "node:assert/strict";
import { CACHE_ONLY_MAX_AGE_SECONDS, MAX_INPUT_CHARS, PAGE_BYTES } from "../build/config.js";
import { compact } from "../build/fit/compact.js";
import { encodeCursor, readCursor } from "../build/fit/cursor.js";
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

test("the first page of a company stays within the limit when its URL carries a long tracking value", async (t) => {
  const { client } = await setup(t, () => ({ body: bigCompany(), headers: headers(1, "req-url") }));
  const url = `${COMPANY_URL}?trk=${"x".repeat(MAX_INPUT_CHARS - COMPANY_URL.length - 5)}`;

  const first = await client.callTool({ name: "get_company_profile", arguments: { url } });

  assert.equal(url.length, MAX_INPUT_CHARS);
  assert.ok(bytes(first.structuredContent) <= PAGE_BYTES, `first page is ${bytes(first.structuredContent)} bytes`);
  for (const entry of Object.values(first.structuredContent.more)) assert.equal(readCursor(entry.cursor).a.url, COMPANY_URL);
});

test("a company URL longer than the limit is refused before the call", async (t) => {
  const { api, client } = await setup(t, () => ({ body: bigCompany(), headers: headers(1, "req-url") }));

  const result = await client.callTool({ name: "get_company_profile", arguments: { url: `${COMPANY_URL}?trk=${"x".repeat(1850)}` } });

  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, "`url` is longer than 512 characters; pass the page URL without tracking parameters.");
  assert.equal(api.requests.length, 0);
});

test("a page of a social link repeats the lookup with socialLink, without which the API leaves the links out", async (t) => {
  const person = bigPerson({ roles: 3, posts: 0, related: 0 });
  const socialLinks = { linkedinUrl: "https://www.linkedin.com/in/jane-example", twitterUrl: "https://x.com/jane_example", websiteUrl: `https://jane.example.com/?ref=${"w".repeat(30000)}` };
  const { api, client } = await setup(t, (request, n) => {
    const withLinks = request.query.socialLink === "include";
    return {
      body: { ...person, contactInformation: { ...person.contactInformation, socialLinks: withLinks ? socialLinks : null } },
      headers: headers(withLinks ? 2 : 1, `req-${n}`),
    };
  });

  const first = await client.callTool({ name: "get_person_profile", arguments: { profile: "jane-example", socialLink: "include" } });
  const page = await client.callTool({ name: "get_more", arguments: { cursor: first.structuredContent.more["contactInformation.socialLinks.websiteUrl"].cursor } });

  assert.equal(api.requests[1].query.socialLink, "include");
  assert.equal(page.isError, undefined, page.content?.[0]?.text);
});

async function readEverything(client, first) {
  const pages = [];
  const queue = Object.values(first.more ?? {}).map((entry) => entry.cursor);
  while (queue.length > 0) {
    const result = await client.callTool({ name: "get_more", arguments: { cursor: queue.shift() } });
    assert.equal(result.isError, undefined, result.content?.[0]?.text);
    const page = result.structuredContent;
    assert.ok(bytes(page) <= PAGE_BYTES, `${page.path} page at ${page.from} is ${bytes(page)} bytes`);
    if (page.nextCursor) {
      assert.ok(readCursor(page.nextCursor).o > page.from, `${page.path} page at ${page.from} does not move on`);
      queue.push(page.nextCursor);
    }
    for (const entry of Object.values(page.more ?? {})) queue.push(entry.cursor);
    pages.push(page);
  }
  return pages;
}

const LONG_INPUT_ADVICE = {
  url: "pass the page URL without tracking parameters",
  profile: "pass the profile URL without tracking parameters, or the username",
  twitter: "pass the username, or the profile URL without tracking parameters",
  facebook: "pass the username, or the profile URL without tracking parameters",
  github: "pass the username, or the profile URL without tracking parameters",
  email: "pass a single email address",
  q: "pass a shorter name or domain",
  full_name: "pass the name only",
  first_name: "pass the name only",
  last_name: "pass the name only",
  domain: "pass the domain only, such as example.com",
};

test("every value longer than the limit is refused before the call", async (t) => {
  const { api, client } = await setup(t, () => ({ body: {} }));
  const long = "x".repeat(MAX_INPUT_CHARS + 1);
  const calls = [
    ["get_company_profile", { url: long }, "url"],
    ["get_person_profile", { profile: long }, "profile"],
    ["get_person_profile", { email: long }, "email"],
    ["get_person_profile", { twitter: long }, "twitter"],
    ["get_person_profile", { facebook: long }, "facebook"],
    ["get_person_profile", { github: long }, "github"],
    ["search_companies", { q: long }, "q"],
    ["search_company_logos", { q: long }, "q"],
    ["find_work_emails", { full_name: long, domain: "example.com" }, "full_name"],
    ["find_work_emails", { first_name: long, domain: "example.com" }, "first_name"],
    ["find_work_emails", { last_name: long, domain: "example.com" }, "last_name"],
    ["find_work_emails", { full_name: "Jane Example", domain: long }, "domain"],
    ["validate_email", { email: long }, "email"],
  ];

  for (const [name, args, field] of calls) {
    const result = await client.callTool({ name, arguments: args });

    assert.equal(result.isError, true, name);
    assert.equal(result.content[0].text, `\`${field}\` is longer than 512 characters; ${LONG_INPUT_ADVICE[field]}.`);
  }
  assert.equal(api.requests.length, 0);
});

test("with values at the limit, every answer and every page fits and every page moves on", async (t) => {
  const person = { ...bigPerson(), slug: { linkedin: null } };
  const matches = Array.from({ length: 300 }, (_, i) => ({ companyName: `Example ${i}`, linkedinUrl: `https://www.linkedin.com/company/example-${i}`, domain: `example-${i}.com` }));
  const { client } = await setup(t, (request, n) => ({
    body: request.path === "/v3/company" ? bigCompany() : request.path === "/v3/person" ? person : matches,
    headers: headers(1, `req-${n}`),
  }));
  const atLimit = (prefix) => prefix + "a".repeat(MAX_INPUT_CHARS - prefix.length);
  const calls = [
    ["get_company_profile", { url: atLimit("https://www.linkedin.com/company/") }],
    ["get_person_profile", { profile: atLimit("https://www.linkedin.com/in/"), activities: "include" }],
    ["search_companies", { q: atLimit("") }],
  ];

  for (const [name, args] of calls) {
    const first = await client.callTool({ name, arguments: args });

    assert.equal(first.isError, undefined, first.content?.[0]?.text);
    assert.ok(bytes(first.structuredContent) <= PAGE_BYTES, `${name} first page is ${bytes(first.structuredContent)} bytes`);
    assert.ok(Object.keys(first.structuredContent.more).length > 0, name);
    await readEverything(client, first.structuredContent);
  }
});

test("a long text read with a cursor at the limit moves on with every page", async (t) => {
  const data = bigCompany({ points: 5, affiliates: 2, locations: 2 });
  data.description = "An example company text. ".repeat(4000);
  const { client } = await setup(t, (_, n) => ({ body: data, headers: headers(1, `req-${n}`) }));

  const first = await client.callTool({ name: "get_company_profile", arguments: { url: `https://www.linkedin.com/company/${"a".repeat(MAX_INPUT_CHARS - 33)}` } });
  const pages = await readEverything(client, first.structuredContent);

  const descriptionPages = pages.filter((page) => page.path === "description");
  assert.ok(descriptionPages.length > 3);
  assert.equal(descriptionPages.map((page) => page.text).join(""), data.description);
});

test("sixty more lists still give a first page within the limit", async (t) => {
  const data = bigCompany();
  data.extraLists = Object.fromEntries(Array.from({ length: 60 }, (_, j) => [`list${j}`, Array.from({ length: 60 }, (_, i) => `item ${j}-${i} ${"z".repeat(40)}`)]));
  const { client } = await setup(t, () => ({ body: data, headers: headers(1, "req-lists") }));

  const first = await client.callTool({ name: "get_company_profile", arguments: { url: `${COMPANY_URL}?trk=${"x".repeat(300)}` } });

  assert.equal(first.isError, undefined, first.content?.[0]?.text);
  assert.ok(bytes(first.structuredContent) <= PAGE_BYTES, `first page is ${bytes(first.structuredContent)} bytes`);
  assert.ok(Object.keys(first.structuredContent.more).length >= 60);
});

test("an answer that cannot fit even with its long lists left out is an error that names the charge", async (t) => {
  const data = bigCompany();
  for (let i = 0; i < 150; i += 1) data[`note${i}`] = `${i} ${"m".repeat(300)}`;
  const { client } = await setup(t, () => ({ body: data, headers: headers(3, "req-big") }));

  const result = await client.callTool({ name: "get_company_profile", arguments: { url: COMPANY_URL } });

  assert.equal(result.isError, true);
  assert.equal(
    result.content[0].text,
    "This answer does not fit in 24,000 bytes even with its long lists left out. Call get_company_profile again with fewer optional sections, or pass the page URL without tracking parameters. This call was charged 3 credits.",
  );
});

test("a page that cannot fit is an error that names the charge", async (t) => {
  const data = bigPerson({ roles: 2 });
  data.experience.work[0] = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`field${i}`, `${i} ${"q".repeat(300)}`]));
  const { client } = await setup(t, (_, n) => ({ body: data, headers: headers(n === 1 ? 1 : 2, `req-${n}`) }));

  const first = await client.callTool({ name: "get_person_profile", arguments: { profile: "jane-example" } });
  const page = await client.callTool({ name: "get_more", arguments: { cursor: first.structuredContent.more["experience.work"].cursor } });

  assert.equal(page.isError, true);
  assert.equal(page.content[0].text, "This page does not fit in 24,000 bytes. Call get_person_profile again with fewer optional sections for new cursors. This call was charged 2 credits.");
});

function withValueAt(data, path, value) {
  const copy = structuredClone(data);
  const keys = path.split(".");
  const last = keys.pop();
  let node = copy;
  for (const key of keys) node = node[key] ??= {};
  node[last] = value;
  return copy;
}

const longText = (prefix) => `${prefix}${"w".repeat(30000)}`;
const manyOf = (count, make) => Array.from({ length: count }, (_, i) => make(i));

const SECTION_FIELDS = [
  ["p", "socialLink", "contactInformation.socialLinks.websiteUrl", longText("https://jane.example.com/?ref=")],
  ["p", "socialLink", "slug.github", longText("jane-example-")],
  ["p", "phoneNumber", "contactInformation.phoneNumbers", manyOf(900, (i) => `+1 555 01${String(i).padStart(4, "0")} extension ${i}`)],
  ["p", "personalEmail", "contactInformation.emails.personal", manyOf(600, (i) => ({ email: `jane.${i}@example.com`, validity: "valid" }))],
  ["p", "workEmail", "contactInformation.emails.work", manyOf(600, (i) => ({ email: `jane.${i}@example-corp.com`, validity: "valid" }))],
  ["p", "careerInsight", "careerInsight.inferredSkills", manyOf(2000, (i) => `Example skill ${i}`)],
  ["p", "developerProfile", "developerProfile.github.languages", manyOf(2000, (i) => `Example language ${i}`)],
  ["p", "activities", "activities.posts", manyOf(300, (i) => ({ title: `Post ${i}: ${"an example thought ".repeat(5)}` }))],
  ["c", "fundingData", "funding.rounds", manyOf(400, (i) => ({ fundingType: "Series A", moneyRaised: 1000000 + i, announcedDate: "2026-01-01" }))],
  ["c", "exitData", "exits", manyOf(900, (i) => ({ name: `Exit ${i} of the example company` }))],
  ["c", "acquisitions", "acquisitions.acquired", manyOf(400, (i) => ({ name: `Acquired company ${i} of the example` }))],
  ["c", "extra", "funding.summary.crunchbaseUrl", longText("https://www.crunchbase.com/organization/example-corp?ref=")],
  ["c", "extra", "contactInformation.socialLinks.crunchbaseUrl", longText("https://www.crunchbase.com/organization/example-corp?ref=")],
  ["c", "extra", "slug.crunchbase", longText("example-corp-")],
  ["c", "extra", "contactInformation.emails", manyOf(600, (i) => ({ email: `contact.${i}@example.com` }))],
  ["c", "extra", "contactInformation.phoneNumbers", manyOf(900, (i) => `+1 555 02${String(i).padStart(4, "0")} extension ${i}`)],
  ["c", "extra", "stock.tickerSymbol", longText("EXMP")],
  ["c", "activities", "activities.posts", manyOf(300, (i) => ({ title: `Post ${i}: ${"an example thought ".repeat(5)}` }))],
];

function honoring(kind, data, query) {
  let body = data;
  for (const [rowKind, param, path] of SECTION_FIELDS) if (rowKind === kind && query[param] !== "include") body = withValueAt(body, path, null);
  return body;
}

test("the section map covers every optional section of a person and a company", () => {
  assert.deepEqual([...new Set(SECTION_FIELDS.map(([kind, param]) => `${kind}:${param}`))], [
    "p:socialLink",
    "p:phoneNumber",
    "p:personalEmail",
    "p:workEmail",
    "p:careerInsight",
    "p:developerProfile",
    "p:activities",
    "c:fundingData",
    "c:exitData",
    "c:acquisitions",
    "c:extra",
    "c:activities",
  ]);
});

for (const [kind, param, path, value] of SECTION_FIELDS) {
  test(`a page of ${path} repeats the lookup with ${param}`, async (t) => {
    const data = withValueAt(kind === "p" ? bigPerson({ roles: 3, posts: 0, related: 0 }) : bigCompany({ points: 5, affiliates: 2, locations: 2 }), path, value);
    const { api, client } = await setup(t, (request, n) => ({ body: honoring(kind, data, request.query), headers: headers(1, `req-${n}`) }));
    const name = kind === "p" ? "get_person_profile" : "get_company_profile";
    const identifier = kind === "p" ? { profile: "jane-example" } : { url: COMPANY_URL };

    const first = await client.callTool({ name, arguments: { ...identifier, [param]: "include" } });
    const page = await client.callTool({ name: "get_more", arguments: { cursor: first.structuredContent.more[path].cursor } });

    assert.equal(api.requests[1].query[param], "include");
    assert.equal(page.isError, undefined, page.content?.[0]?.text);
    assert.equal(page.structuredContent.path, path);
  });
}

test("a page read with socialLink shows what the repeat call was charged", async (t) => {
  const data = withValueAt(bigPerson({ roles: 3, posts: 0, related: 0 }), "contactInformation.socialLinks", { twitterUrl: "https://x.com/jane_example", websiteUrl: longText("https://jane.example.com/?ref=") });
  const { client } = await setup(t, (request, n) => ({ body: honoring("p", data, request.query), headers: headers(request.query.socialLink === "include" ? 2 : 1, `req-${n}`) }));

  const first = await client.callTool({ name: "get_person_profile", arguments: { profile: "jane-example", socialLink: "include" } });
  const page = await client.callTool({ name: "get_more", arguments: { cursor: first.structuredContent.more["contactInformation.socialLinks.websiteUrl"].cursor } });

  assert.equal(first.structuredContent.creditCost, 2);
  assert.equal(page.structuredContent.creditCost, 2);
  assert.equal(page.structuredContent.requestId, "req-2");
});
