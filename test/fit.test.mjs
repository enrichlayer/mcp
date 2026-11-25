import { test } from "node:test";
import assert from "node:assert/strict";
import { PAGE_BYTES } from "../build/config.js";
import { compact } from "../build/fit/compact.js";
import { encodeCursor, fingerprint, readCursor } from "../build/fit/cursor.js";
import { CHANGED_NOTE, MORE_NOTE, firstPage, nextPage } from "../build/fit/pages.js";
import { bigCompany, bigPerson } from "./big-answers.mjs";

const bytes = (value) => Buffer.byteLength(JSON.stringify(value));
const answer = (data, creditCost = 1, requestId = "0123456789abcdef0123456789abcdef") => ({ data, creditCost, requestId });
const COMPANY_ARGS = { url: "https://www.linkedin.com/company/example-corp" };
const TEXT_UNIT = `👨‍👩‍👧‍👦 Zürich é 東京 "quoted" \n`;
const UNIT_STARTS = new Set([...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(TEXT_UNIT)].map((part) => part.index));
const isGraphemeStart = (position) => UNIT_STARTS.has(position % TEXT_UNIT.length);

function readEverything(first, fresh) {
  const lists = new Map();
  const pages = [];
  const queue = Object.values(first.more ?? {}).map((entry) => entry.cursor);
  while (queue.length > 0) {
    const page = nextPage(fresh, readCursor(queue.shift()), { budget: PAGE_BYTES });
    pages.push(page);
    if (page.text !== undefined) lists.set(page.path, (lists.get(page.path) ?? "") + page.text);
    else lists.set(page.path, [...(lists.get(page.path) ?? []), ...structuredClone(page.list)]);
    for (const entry of Object.values(page.more ?? {})) queue.push(entry.cursor);
    if (page.nextCursor) queue.push(page.nextCursor);
  }
  const rebuilt = structuredClone(first.data);
  for (const [path, value] of [...lists].sort((a, b) => a[0].split(".").length - b[0].split(".").length)) {
    const keys = path.split(".");
    const last = keys.pop();
    let node = rebuilt;
    for (const key of keys) node = node[key] ??= {};
    node[last] = value;
  }
  return { rebuilt, pages };
}

test("fields with no value leave the answer, while zero, false and places inside lists stay", () => {
  const data = { a: null, b: "", c: [], d: {}, e: { f: null, g: [] }, zero: 0, no: false, range: [10001, null], list: [{ x: null, y: 1 }] };

  assert.deepEqual(compact(data), { zero: 0, no: false, range: [10001, null], list: [{ y: 1 }] });
});

test("an answer that fits comes back whole, only without its empty fields", () => {
  const data = { name: "Example", tagline: null, specialties: ["a"], funding: { rounds: [] } };

  const page = firstPage(answer(data), { kind: "c", args: COMPANY_ARGS, budget: PAGE_BYTES });

  assert.deepEqual(page, { data: { name: "Example", specialties: ["a"] }, creditCost: 1, requestId: "0123456789abcdef0123456789abcdef" });
});

test("a big company comes as a first page within the limit, with each list either whole in data or named in more", () => {
  const data = bigCompany();

  const page = firstPage(answer(data), { kind: "c", args: COMPANY_ARGS, budget: PAGE_BYTES });

  assert.ok(bytes(data) > 3 * PAGE_BYTES);
  assert.ok(bytes(page) <= PAGE_BYTES);
  assert.equal(page.note, MORE_NOTE);
  assert.deepEqual(Object.keys(page.more), [
    "companySize.employeeCountOverTime",
    "companySize.organizationSizeOverTime",
    "socialPresence.followerCountOverTime",
    "affiliatedCompanies",
  ]);
  assert.deepEqual(page.data.locations, compact(data).locations);
  assert.deepEqual(page.data.similarCompanies, compact(data).similarCompanies);
  assert.equal(page.data.affiliatedCompanies, undefined);
  assert.deepEqual(page.more["companySize.employeeCountOverTime"].items, 1500);
  assert.deepEqual(Object.keys(page.data), ["summary", "name", "description", "specialties", "slug", "industries", "location", "locations", "companySize", "headcountGrowthMetrics", "contactInformation", "socialPresence", "similarCompanies", "meta"]);
});

test("reading every page rebuilds the answer exactly, every page fits and pages counts them", () => {
  for (const [kind, data, args] of [["c", bigCompany(), COMPANY_ARGS], ["p", bigPerson(), { profile: "jane-example" }]]) {
    const fresh = answer(data);
    const first = firstPage(fresh, { kind, args, budget: PAGE_BYTES });

    const { rebuilt, pages } = readEverything(first, fresh);

    assert.deepEqual(rebuilt, compact(data));
    for (const page of pages) assert.ok(bytes(page) <= PAGE_BYTES, `${page.path} ${bytes(page)}`);
    for (const [path, entry] of Object.entries(first.more)) {
      assert.equal(pages.filter((page) => page.path === path).length, entry.pages, path);
    }
  }
});

test("the repeat asks for the person by LinkedIn username and only for the section of that list", () => {
  const first = firstPage(answer(bigPerson()), { kind: "p", args: { email: "jane@example.com", activities: "include", workEmail: "include" }, budget: PAGE_BYTES });

  const posts = readCursor(first.more["activities.posts"].cursor);
  const work = readCursor(first.more["experience.work"].cursor);

  assert.deepEqual(posts.a, { profile: "jane-example", activities: "include" });
  assert.deepEqual(work.a, { profile: "jane-example" });
});

test("a list that changed before the next page is flagged with a restart cursor, a list that only grew at its end is not", () => {
  const data = bigCompany();
  const first = firstPage(answer(data), { kind: "c", args: COMPANY_ARGS, budget: PAGE_BYTES });
  const firstOfSeries = nextPage(answer(data), readCursor(first.more["companySize.employeeCountOverTime"].cursor), { budget: PAGE_BYTES });
  const grown = bigCompany();
  grown.companySize.employeeCountOverTime.push({ date: "2026-11-25", value: 120500 });
  const shifted = bigCompany();
  shifted.companySize.employeeCountOverTime.unshift({ date: "2012-12-31", value: 99000 });

  const afterGrowth = nextPage(answer(grown), readCursor(firstOfSeries.nextCursor), { budget: PAGE_BYTES });
  const afterShift = nextPage(answer(shifted), readCursor(firstOfSeries.nextCursor), { budget: PAGE_BYTES });

  assert.equal(afterGrowth.changed, undefined);
  assert.equal(afterShift.changed, true);
  assert.equal(afterShift.note, CHANGED_NOTE);
  assert.equal(readCursor(afterShift.restartCursor).o, 0);
  assert.ok(afterShift.list.length > 0);
});

test("a cursor past the end of a list that got shorter gives an empty last page", () => {
  const data = bigCompany();
  const first = firstPage(answer(data), { kind: "c", args: COMPANY_ARGS, budget: PAGE_BYTES });
  const page = nextPage(answer(data), readCursor(first.more["companySize.employeeCountOverTime"].cursor), { budget: PAGE_BYTES });
  const shorter = bigCompany({ points: 10 });

  const last = nextPage(answer(shorter), readCursor(page.nextCursor), { budget: PAGE_BYTES });

  assert.deepEqual(last.list, []);
  assert.equal(last.nextCursor, null);
  assert.equal(last.changed, true);
});

test("an item bigger than a page comes alone, with its long parts in its own more", () => {
  const data = bigPerson({ roles: 3 });
  data.experience.work[1].description = "A very long description. ".repeat(3000);
  data.experience.work[1].projects = Array.from({ length: 2000 }, (_, i) => `project ${i}`);
  const fresh = answer(data);
  const first = firstPage(fresh, { kind: "p", args: { profile: "jane-example" }, budget: PAGE_BYTES });

  const { rebuilt, pages } = readEverything(first, fresh);

  const alone = pages.find((page) => page.path === "experience.work" && page.from === 1);
  assert.equal(alone.list.length, 1);
  assert.deepEqual(Object.keys(alone.more), ["experience.work.1.description", "experience.work.1.projects"]);
  assert.deepEqual(rebuilt, compact(data));
  for (const page of pages) assert.ok(bytes(page) <= PAGE_BYTES);
});

test("a long text is cut on whole graphemes, and one grapheme longer than a page on whole code points", () => {
  const data = bigCompany({ points: 5, affiliates: 2, locations: 2 });
  data.description = TEXT_UNIT.repeat(3000);
  data.tagline = `a${"\u{1D167}".repeat(15000)}`;
  const fresh = answer(data);
  const first = firstPage(fresh, { kind: "c", args: COMPANY_ARGS, budget: PAGE_BYTES });

  const { rebuilt, pages } = readEverything(first, fresh);

  assert.deepEqual(Object.keys(first.more), ["tagline", "description"]);
  assert.deepEqual(rebuilt, compact(data));
  const descriptionPages = pages.filter((page) => page.path === "description");
  assert.ok(descriptionPages.length > 1);
  for (const page of descriptionPages) {
    assert.ok(bytes(page) <= PAGE_BYTES);
    assert.equal(isGraphemeStart(page.from), true, `page starts at ${page.from}`);
  }
  const taglinePages = pages.filter((page) => page.path === "tagline");
  assert.ok(taglinePages.length > 1);
  for (const page of taglinePages) {
    assert.ok(bytes(page) <= PAGE_BYTES);
    assert.equal(page.text.isWellFormed(), true);
  }
});

function cutDeepIn(text, from) {
  const seen = [];
  const segment = Intl.Segmenter.prototype.segment;
  Intl.Segmenter.prototype.segment = function (input) {
    seen.push(input.length);
    return segment.call(this, input);
  };
  try {
    const cursor = { v: 1, t: "c", a: COMPANY_ARGS, p: "description", o: from, h: fingerprint(text.slice(0, from)) };
    return { page: nextPage(answer({ description: text }), cursor, { budget: PAGE_BYTES }), seen };
  } finally {
    Intl.Segmenter.prototype.segment = segment;
  }
}

test("a page deep in a long text is cut by looking at that page only, however long the text is", () => {
  const from = TEXT_UNIT.length * 2000;

  const short = cutDeepIn(TEXT_UNIT.repeat(3000), from);
  const long = cutDeepIn(TEXT_UNIT.repeat(28000), from);

  assert.equal(long.page.text, short.page.text);
  assert.deepEqual(long.seen, short.seen);
  assert.equal(isGraphemeStart(from + long.page.text.length), true);
  assert.ok(bytes(long.page) <= PAGE_BYTES);
});

test("a list of strings with quotes and line breaks is measured as written", () => {
  const data = bigCompany({ points: 5, affiliates: 2, locations: 2 });
  data.specialties = Array.from({ length: 4000 }, (_, i) => `"quoted" \\ line ${i}\n `);
  const fresh = answer(data);
  const first = firstPage(fresh, { kind: "c", args: COMPANY_ARGS, budget: PAGE_BYTES });

  const { rebuilt, pages } = readEverything(first, fresh);

  assert.deepEqual(rebuilt, compact(data));
  for (const page of pages) assert.ok(bytes(page) <= PAGE_BYTES, `${bytes(page)}`);
});

test("a tampered or broken cursor is refused", () => {
  const good = { v: 1, t: "p", a: { profile: "jane-example", activities: "include" }, p: "activities.posts", o: 80, h: "AbCdEfGh" };

  assert.deepEqual(readCursor(encodeCursor(good)), good);
  for (const broken of [
    "not a cursor",
    encodeCursor({ ...good, v: 2 }),
    encodeCursor({ ...good, extra: 1 }),
    encodeCursor({ ...good, a: { profile: "jane-example", activities: "include", workEmail: "include" } }),
    encodeCursor({ ...good, a: { profile: "jane-example", maxAgeSeconds: 0 } }),
    encodeCursor({ ...good, a: { profile: "jane-example", unknown: "x" } }),
    encodeCursor({ ...good, a: { profile: "jane-example", email: "jane@example.com" } }),
    encodeCursor({ ...good, a: { profile: "jane-example", activities: "exclude" } }),
    encodeCursor({ ...good, o: -1 }),
    encodeCursor({ ...good, h: "short" }),
    encodeCursor({ ...good, t: "x" }),
  ]) {
    assert.equal(readCursor(broken), null, broken);
  }
});
