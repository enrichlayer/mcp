import { test } from "node:test";
import assert from "node:assert/strict";
import { CACHE_ONLY_MAX_AGE_SECONDS, MAX_INPUT_CHARS, PAGE_BYTES } from "../build/config.js";
import { compact } from "../build/fit/compact.js";
import { encodeCursor, readCursor, SECTIONS } from "../build/fit/cursor.js";
import { v3Params } from "../build/generated/v3-params.js";
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
  const data = { ...bigCompany({ points: 5, affiliates: 2, locations: 2 }), slug: { linkedin: null }, contactInformation: { socialLinks: { linkedinUrl: null } } };
  data.description = "An example company text. ".repeat(4000);
  const { client } = await setup(t, (_, n) => ({ body: data, headers: headers(1, `req-${n}`) }));
  const url = `https://www.linkedin.com/company/${"a".repeat(MAX_INPUT_CHARS - 33)}`;

  const first = await client.callTool({ name: "get_company_profile", arguments: { url } });
  const pages = await readEverything(client, first.structuredContent);

  const descriptionPages = pages.filter((page) => page.path === "description");
  assert.equal(readCursor(first.structuredContent.more.description.cursor).a.url, url);
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

function tooBigCompany() {
  const data = bigCompany();
  for (let i = 0; i < 150; i += 1) data[`note${i}`] = `${i} ${"m".repeat(300)}`;
  return data;
}

test("an answer that cannot fit even with its long lists left out, asked for without sections, says it cannot come through MCP and gives the request id", async (t) => {
  const { client } = await setup(t, () => ({ body: tooBigCompany(), headers: headers(3, "req-big") }));

  const result = await client.callTool({ name: "get_company_profile", arguments: { url: COMPANY_URL } });

  assert.equal(result.isError, true);
  assert.equal(
    result.content[0].text,
    "This answer does not fit in 24,000 bytes even with its long lists left out, so it cannot be returned through MCP. This call was charged 3 credits. To have the charge checked, contact support@enrichlayer.com with request id req-big.",
  );
});

test("an answer that cannot fit is not blamed on the sections it asked for when none of their fields is left in it", async (t) => {
  const { client } = await setup(t, () => ({ body: tooBigCompany(), headers: headers(3, "req-big") }));

  const result = await client.callTool({ name: "get_company_profile", arguments: { url: COMPANY_URL, extra: "include", exitData: "exclude", fundingData: "include" } });

  assert.equal(result.isError, true);
  assert.equal(
    result.content[0].text,
    "This answer does not fit in 24,000 bytes even with its long lists left out, so it cannot be returned through MCP. This call was charged 3 credits. To have the charge checked, contact support@enrichlayer.com with request id req-big.",
  );
});

test("an answer that cannot fit names only the sections asked for whose fields are still in it", async (t) => {
  const data = bigCompany();
  data.stock = Object.fromEntries(Array.from({ length: 250 }, (_, i) => [`listing${i}`, `${i} ${"s".repeat(90)}`]));
  data.funding.summary = { roundsCount: 12, totalFundingAmountUsd: 5000000 };
  const { client } = await setup(t, () => ({ body: data, headers: headers(3, "req-big") }));

  const result = await client.callTool({ name: "get_company_profile", arguments: { url: COMPANY_URL, extra: "include", fundingData: "include" } });

  assert.equal(result.isError, true);
  assert.equal(
    result.content[0].text,
    "This answer does not fit in 24,000 bytes even with its long lists left out. Call get_company_profile again without some of the optional sections you asked for: extra. This call was charged 3 credits. To have the charge checked, contact support@enrichlayer.com with request id req-big.",
  );
});

test("a page that cannot fit says it cannot come through MCP, gives the request id and a cursor past its item", async (t) => {
  const data = bigPerson({ roles: 2 });
  data.experience.work[0] = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`field${i}`, `${i} ${"q".repeat(300)}`]));
  const { client } = await setup(t, (_, n) => ({ body: data, headers: headers(n === 1 ? 1 : 2, `req-${n}`) }));

  const first = await client.callTool({ name: "get_person_profile", arguments: { profile: "jane-example" } });
  const page = await client.callTool({ name: "get_more", arguments: { cursor: first.structuredContent.more["experience.work"].cursor } });
  const skip = /call get_more with the cursor ([A-Za-z0-9_-]+)\./.exec(page.content[0].text)[1];
  const rest = await client.callTool({ name: "get_more", arguments: { cursor: skip } });

  assert.equal(page.isError, true);
  assert.equal(
    page.content[0].text,
    `This page does not fit in 24,000 bytes, so it cannot be read through MCP, and calling get_person_profile again leads to the same page. To skip this item and read the rest of the list, call get_more with the cursor ${skip}. This call was charged 2 credits. To have the charge checked, contact support@enrichlayer.com with request id req-2.`,
  );
  assert.deepEqual(rest.structuredContent.list, compact(data).experience.work.slice(1));
  assert.equal(rest.structuredContent.nextCursor, null);
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

const sectionParams = (path) =>
  Object.entries(v3Params[path])
    .filter(([, schema]) => schema.safeParse("include").success && !schema.safeParse("not-a-section").success)
    .map(([name]) => name)
    .sort();

test("the section map in the source and the section tests cover every optional section of a person and a company", () => {
  for (const [kind, path] of [["p", "/v3/person"], ["c", "/v3/company"]]) {
    const expected = sectionParams(path);

    assert.deepEqual([...new Set(SECTIONS[kind].map(([, section]) => section))].sort(), expected, `${kind}: source`);
    assert.deepEqual([...new Set(SECTION_FIELDS.filter(([rowKind]) => rowKind === kind).map(([, param]) => param))].sort(), expected, `${kind}: tests`);
  }
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

const companyPageOf = (url) => {
  const [, kind, slug] = /\/(company|showcase)\/([^?/]+)/.exec(url.replace(/([^:]\/)\/+/g, "$1"));
  return { kind, slug: decodeURIComponent(slug) };
};
const companySlugOf = (url) => companyPageOf(url).slug;
const personSlugOf = (profile) => decodeURIComponent(/\/in\/([^?/]+)/.exec(profile.replace(/([^:]\/)\/+/g, "$1"))?.[1] ?? profile);

test("a page of a company comes from the company the first call returned, whatever else its URL names", async (t) => {
  const company = (slug, text) => ({ ...bigCompany({ points: 5, affiliates: 2, locations: 2 }), slug: { linkedin: slug }, contactInformation: { socialLinks: { linkedinUrl: null } }, description: `${text} ${"d".repeat(30000)}` });
  const companies = { acme: company("acme", "Acme builds examples."), other: company("other", "Other builds examples.") };
  const { api, client } = await setup(t, (request, n) => ({ body: companies[companySlugOf(request.query.url)], headers: headers(1, `req-${n}`) }));

  const first = await client.callTool({ name: "get_company_profile", arguments: { url: "https://www.linkedin.com/company//acme?next=/company/other" } });
  const pages = await readEverything(client, first.structuredContent);

  assert.equal(first.structuredContent.data.slug.linkedin, "acme");
  assert.equal(pages.map((page) => page.text).join(""), companies.acme.description);
  assert.deepEqual(api.requests.map((request) => companySlugOf(request.query.url)), api.requests.map(() => "acme"));
});

test("a company is repeated by the URL the API gives for it, when that differs from the URL rebuilt from its slug", async (t) => {
  const page = (text, linkedinUrl) => ({ ...bigCompany({ points: 5, affiliates: 2, locations: 2 }), slug: { linkedin: "acme-cloud" }, contactInformation: { socialLinks: { linkedinUrl } }, description: `${text} ${"d".repeat(30000)}` });
  const pages = {
    "showcase/acme-cloud": page("The Acme Cloud showcase.", "https://www.linkedin.com/showcase/acme-cloud"),
    "company/acme-cloud": page("Another Acme Cloud company.", "https://www.linkedin.com/company/acme-cloud"),
  };
  const pageKey = (url) => Object.values(companyPageOf(url)).join("/");
  const { api, client } = await setup(t, (request, n) => ({ body: pages[pageKey(request.query.url)], headers: headers(1, `req-${n}`) }));

  const first = await client.callTool({ name: "get_company_profile", arguments: { url: "https://www.linkedin.com/showcase/acme-cloud" } });
  const read = await readEverything(client, first.structuredContent);

  assert.equal(read.map((one) => one.text).join(""), pages["showcase/acme-cloud"].description);
  assert.deepEqual(api.requests.map((request) => pageKey(request.query.url)), api.requests.map(() => "showcase/acme-cloud"));
});

test("every cursor given out for an identifier at the limit or written oddly is accepted by get_more and reads the same profile", async (t) => {
  const longSlug = "j".repeat(MAX_INPUT_CHARS + 88);
  const companyOf = (url) => {
    const { kind, slug } = companyPageOf(url);
    return { kind, slug: slug.toLowerCase() };
  };
  const { api, client } = await setup(t, (request, n) => {
    if (request.path === "/v3/company") {
      const { kind, slug } = companyOf(request.query.url);
      const linkedinUrl = `https://www.linkedin.com/${kind}/${encodeURIComponent(slug)}`;
      return { body: { ...bigCompany(), slug: { linkedin: slug }, contactInformation: { socialLinks: { linkedinUrl } } }, headers: headers(1, `req-${n}`) };
    }
    return { body: { ...bigPerson(), slug: { linkedin: request.query.email ? longSlug : personSlugOf(request.query.profile).toLowerCase() } }, headers: headers(1, `req-${n}`) };
  });
  const identityOf = (request) =>
    request.query.url ? Object.values(companyOf(request.query.url)).join("/") : (request.query.email ?? personSlugOf(request.query.profile).toLowerCase());
  const calls = [
    ["get_company_profile", { url: `https://www.linkedin.com/company/${"a".repeat(MAX_INPUT_CHARS - 33)}` }],
    ["get_company_profile", { url: `https://linkedin.com/company/${"a".repeat(MAX_INPUT_CHARS - 29)}` }],
    ["get_company_profile", { url: `https://linkedin.com/company/${"%C3%A9".repeat(80)}aaa` }],
    ["get_company_profile", { url: `https://www.linkedin.com/company/${"é".repeat(MAX_INPUT_CHARS - 33)}` }],
    ["get_company_profile", { url: "https://www.linkedin.com/company//acme?next=/company/other" }],
    ["get_company_profile", { url: "https://www.linkedin.com/company/acme/" }],
    ["get_company_profile", { url: "https://www.linkedin.com/showcase/acme-cloud" }],
    ["get_company_profile", { url: "https://www.LinkedIn.com/company/ACME" }],
    ["get_person_profile", { profile: `https://www.linkedin.com/in/${"a".repeat(MAX_INPUT_CHARS - 28)}`, activities: "include" }],
    ["get_person_profile", { profile: "https://www.linkedin.com/in//jane-example?next=/in/other" }],
    ["get_person_profile", { profile: `https://www.linkedin.com/in/${"%C3%A9".repeat(80)}` }],
    ["get_person_profile", { email: "jane@example.com" }],
  ];

  for (const [name, args] of calls) {
    const from = api.requests.length;
    const first = await client.callTool({ name, arguments: args });
    assert.equal(first.isError, undefined, first.content?.[0]?.text);
    const pages = await readEverything(client, first.structuredContent);

    const identities = api.requests.slice(from).map(identityOf);
    assert.ok(pages.length > 0, JSON.stringify(args));
    assert.deepEqual(identities, identities.map(() => identities[0]), JSON.stringify(args));
  }
});
