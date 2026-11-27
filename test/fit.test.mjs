import { test } from "node:test";
import assert from "node:assert/strict";
import { PAGE_BYTES } from "../build/config.js";
import { compact } from "../build/fit/compact.js";
import { encodeCursor, fingerprint, readCursor } from "../build/fit/cursor.js";
import { CHANGED_NOTE, ITEM_GONE_NOTE, MORE_NOTE, firstPage, nextPage } from "../build/fit/pages.js";
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
    encodeCursor({ ...good, a: { profile: "x".repeat(513) } }),
    encodeCursor({ ...good, i: ["short"] }),
  ]) {
    assert.equal(readCursor(broken), null, broken);
  }
});

test("a cursor into one item of a list never reads another item after the list shifts", () => {
  const data = bigPerson({ roles: 3 });
  data.experience.work[0] = { ...data.experience.work[0], title: "Director", description: `Director work. ${"d".repeat(30000)}` };
  const fresh = answer(data);
  const first = firstPage(fresh, { kind: "p", args: { profile: "jane-example" }, budget: PAGE_BYTES });
  const item = nextPage(fresh, readCursor(first.more["experience.work"].cursor), { budget: PAGE_BYTES });
  const shifted = structuredClone(data);
  shifted.experience.work.unshift({ title: "Advisor", company: "Example Advisory", startDate: { year: 2026 }, description: `Advisor work. ${"a".repeat(30000)}` });

  const page = nextPage(answer(shifted), readCursor(item.more["experience.work.0.description"].cursor), { budget: PAGE_BYTES });

  assert.ok(page.changed === true || page.text.startsWith("Director"), `got "${page.text.slice(0, 13)}" with changed: ${page.changed}`);
});

function directorDescriptionCursor() {
  const data = bigPerson({ roles: 3 });
  data.experience.work[0] = { ...data.experience.work[0], title: "Director", description: `Director work. ${"d".repeat(30000)}` };
  const fresh = answer(data);
  const first = firstPage(fresh, { kind: "p", args: { profile: "jane-example" }, budget: PAGE_BYTES });
  const item = nextPage(fresh, readCursor(first.more["experience.work"].cursor), { budget: PAGE_BYTES });
  return { data, cursor: readCursor(item.more["experience.work.0.description"].cursor) };
}

test("a cursor into an item that changed reads nothing from it and restarts from its list", () => {
  const { data, cursor } = directorDescriptionCursor();
  const changed = structuredClone(data);
  changed.experience.work[0].description = `Director work, rewritten. ${"e".repeat(30000)}`;

  const page = nextPage(answer(changed), cursor, { budget: PAGE_BYTES });

  assert.equal(page.changed, true);
  assert.equal(page.text, undefined);
  assert.equal(page.nextCursor, null);
  assert.equal(page.note, ITEM_GONE_NOTE);
  assert.deepEqual(readCursor(page.restartCursor), { v: 1, t: "p", a: { profile: "jane-example" }, p: "experience.work", o: 0 });
});

test("a cursor into an item that is gone never reads another item", () => {
  const { data, cursor } = directorDescriptionCursor();
  const gone = structuredClone(data);
  gone.experience.work.shift();

  const page = nextPage(answer(gone), cursor, { budget: PAGE_BYTES });

  assert.equal(page.changed, true);
  assert.equal(page.text, undefined);
  assert.equal(readCursor(page.restartCursor).p, "experience.work");
});

test("a text item of a list is found again after the list shifts", () => {
  const data = bigCompany({ points: 5, affiliates: 2, locations: 2 });
  data.specialties = ["Short one", `First long specialty ${"s".repeat(30000)}`];
  const fresh = answer(data);
  const first = firstPage(fresh, { kind: "c", args: COMPANY_ARGS, budget: PAGE_BYTES });
  const short = nextPage(fresh, readCursor(first.more.specialties.cursor), { budget: PAGE_BYTES });
  const long = nextPage(fresh, readCursor(short.nextCursor), { budget: PAGE_BYTES });
  const shifted = structuredClone(data);
  shifted.specialties.unshift(`Another long specialty ${"t".repeat(30000)}`);

  const page = nextPage(answer(shifted), readCursor(long.more["specialties.1"].cursor), { budget: PAGE_BYTES });

  assert.equal(page.changed, undefined);
  assert.equal(page.text.startsWith("First long specialty"), true);
});

test("two levels down, a cursor still finds its item after the outer list shifts", () => {
  const data = bigPerson({ roles: 2 });
  data.experience.work[0] = {
    title: "Director",
    projects: [
      { name: "Alpha", notes: `Alpha notes. ${"a".repeat(30000)}` },
      { name: "Beta", notes: `Beta notes. ${"b".repeat(30000)}` },
    ],
  };
  const fresh = answer(data);
  const first = firstPage(fresh, { kind: "p", args: { profile: "jane-example" }, budget: PAGE_BYTES });
  const work = nextPage(fresh, readCursor(first.more["experience.work"].cursor), { budget: PAGE_BYTES });
  const projects = nextPage(fresh, readCursor(work.more["experience.work.0.projects"].cursor), { budget: PAGE_BYTES });
  const shifted = structuredClone(data);
  shifted.experience.work.unshift({ title: "Advisor", description: `Advisor work. ${"x".repeat(30000)}` });

  const page = nextPage(answer(shifted), readCursor(projects.more["experience.work.0.projects.0.notes"].cursor), { budget: PAGE_BYTES });

  assert.equal(page.changed, undefined);
  assert.equal(page.text.startsWith("Alpha notes."), true);
});

test("a cursor with a position that is not in its list reads nothing from another item", () => {
  const { cursor } = directorDescriptionCursor();
  const data = bigPerson({ roles: 3 });

  const page = nextPage(answer(data), { ...cursor, p: "experience.work.-1.description" }, { budget: PAGE_BYTES });

  assert.equal(page.changed, true);
  assert.equal(page.text, undefined);
});

const LINKS_ARGS = { profile: "jane-example", socialLink: "include" };

function personWithFirstPageOf(target, { about, socialLinks }) {
  const build = (n) => ({
    slug: { linkedin: "jane-example" },
    fullName: "Jane Example",
    headline: `Founder ${"h".repeat(n % 13)}`,
    about,
    contactInformation: { socialLinks },
    figures: Object.fromEntries(Array.from({ length: 1 + Math.floor(n / 13) }, (_, i) => [`f${String(i).padStart(4, "0")}`, 1000])),
    activities: { posts: Array.from({ length: 150 }, (_, i) => ({ title: `Post ${i}: ${"an example thought ".repeat(10)}` })) },
  });
  const firstPageBytes = (n) => bytes(firstPage(answer(build(n)), { kind: "p", args: LINKS_ARGS, budget: target }));
  return build(target - firstPageBytes(0));
}

test("a first page of 24,001 bytes fits by moving a link whose move saves only its key and the objects it empties", () => {
  const data = personWithFirstPageOf(PAGE_BYTES + 1, { about: "Builds example companies.", socialLinks: { websiteUrl: `https://jane.example.com/${"w".repeat(214)}` } });
  const fresh = answer(data);
  assert.equal(bytes(firstPage(fresh, { kind: "p", args: LINKS_ARGS, budget: PAGE_BYTES + 1 })), PAGE_BYTES + 1);

  const page = firstPage(fresh, { kind: "p", args: LINKS_ARGS, budget: PAGE_BYTES });

  assert.ok(bytes(page) <= PAGE_BYTES, `first page is ${bytes(page)} bytes`);
  assert.deepEqual(Object.keys(page.more), ["contactInformation.socialLinks.websiteUrl", "activities.posts"]);
});

test("a first page of exactly 24,000 bytes keeps its texts in data", () => {
  const data = personWithFirstPageOf(PAGE_BYTES, { about: "Builds example companies.", socialLinks: { websiteUrl: `https://jane.example.com/${"w".repeat(214)}` } });

  const page = firstPage(answer(data), { kind: "p", args: LINKS_ARGS, budget: PAGE_BYTES });

  assert.equal(bytes(page), PAGE_BYTES);
  assert.deepEqual(Object.keys(page.more), ["activities.posts"]);
});

test("when moving the longest text would not make a 24,001-byte first page smaller, a shorter one is moved", () => {
  const socialLinks = { twitterUrl: "https://x.com/jane_example", websiteUrl: `https://jane.example.com/${"w".repeat(204)}` };
  const data = personWithFirstPageOf(PAGE_BYTES + 1, { about: `Builds example companies. ${"a".repeat(172)}`, socialLinks });
  const fresh = answer(data);
  assert.equal(bytes(firstPage(fresh, { kind: "p", args: LINKS_ARGS, budget: PAGE_BYTES + 1 })), PAGE_BYTES + 1);

  const page = firstPage(fresh, { kind: "p", args: LINKS_ARGS, budget: PAGE_BYTES });

  assert.ok(bytes(page) <= PAGE_BYTES, `first page is ${bytes(page)} bytes`);
  assert.deepEqual(Object.keys(page.more), ["about", "activities.posts"]);
  assert.deepEqual(page.data.contactInformation.socialLinks, socialLinks);
});

function onlyRoleDescriptionCursor() {
  const data = bigPerson({ roles: 1 });
  data.experience.work[0].description = `Director work. ${"d".repeat(30000)}`;
  const fresh = answer(data);
  const first = firstPage(fresh, { kind: "p", args: { profile: "jane-example" }, budget: PAGE_BYTES });
  const item = nextPage(fresh, readCursor(first.more["experience.work"].cursor), { budget: PAGE_BYTES });
  return { data, cursor: readCursor(item.more["experience.work.0.description"].cursor) };
}

test("a cursor into the only item of a list that became empty restarts from that list, and the restart gives an empty last page", () => {
  const { data, cursor } = onlyRoleDescriptionCursor();
  const emptied = structuredClone(data);
  emptied.experience.work = [];

  const page = nextPage(answer(emptied), cursor, { budget: PAGE_BYTES });
  const restart = nextPage(answer(emptied), readCursor(page.restartCursor), { budget: PAGE_BYTES });

  assert.equal(page.changed, true);
  assert.equal(page.note, ITEM_GONE_NOTE);
  assert.equal(page.nextCursor, null);
  assert.deepEqual(readCursor(page.restartCursor), { v: 1, t: "p", a: { profile: "jane-example" }, p: "experience.work", o: 0 });
  assert.equal(restart.items, 0);
  assert.deepEqual(restart.list, []);
  assert.equal(restart.nextCursor, null);
  assert.equal(restart.changed, undefined);
});

test("two levels down, a cursor whose outer list became empty restarts from that list", () => {
  const data = bigPerson({ roles: 1 });
  data.experience.work[0] = { title: "Director", projects: [{ name: "Alpha", notes: `Alpha notes. ${"a".repeat(30000)}` }] };
  const fresh = answer(data);
  const first = firstPage(fresh, { kind: "p", args: { profile: "jane-example" }, budget: PAGE_BYTES });
  const work = nextPage(fresh, readCursor(first.more["experience.work"].cursor), { budget: PAGE_BYTES });
  const projects = nextPage(fresh, readCursor(work.more["experience.work.0.projects"].cursor), { budget: PAGE_BYTES });
  const emptied = structuredClone(data);
  emptied.experience.work = [];

  const page = nextPage(answer(emptied), readCursor(projects.more["experience.work.0.projects.0.notes"].cursor), { budget: PAGE_BYTES });
  const restart = nextPage(answer(emptied), readCursor(page.restartCursor), { budget: PAGE_BYTES });

  assert.equal(page.changed, true);
  assert.deepEqual(readCursor(page.restartCursor), { v: 1, t: "p", a: { profile: "jane-example" }, p: "experience.work", o: 0 });
  assert.deepEqual(restart.list, []);
  assert.equal(restart.nextCursor, null);
});

test("a list read from the middle that became empty gives an empty last page marked as changed", () => {
  const data = bigCompany();
  const first = firstPage(answer(data), { kind: "c", args: COMPANY_ARGS, budget: PAGE_BYTES });
  const page = nextPage(answer(data), readCursor(first.more["companySize.employeeCountOverTime"].cursor), { budget: PAGE_BYTES });
  const emptied = bigCompany();
  emptied.companySize.employeeCountOverTime = [];

  const last = nextPage(answer(emptied), readCursor(page.nextCursor), { budget: PAGE_BYTES });

  assert.deepEqual(last.list, []);
  assert.equal(last.nextCursor, null);
  assert.equal(last.changed, true);
  assert.equal(readCursor(last.restartCursor).o, 0);
});

test("a cursor into a section that is gone altogether gives no page", () => {
  const { data, cursor } = onlyRoleDescriptionCursor();

  const page = nextPage(answer({ ...data, experience: null }), cursor, { budget: PAGE_BYTES });

  assert.equal(page, null);
});

test("a list whose cursor the server would refuse is not given out", () => {
  const key = "k".repeat(501);
  const data = { ...bigCompany({ points: 5, affiliates: 2, locations: 2 }), [key]: Array.from({ length: 2000 }, (_, i) => `item ${i}`) };

  const page = firstPage(answer(data), { kind: "c", args: COMPANY_ARGS, budget: PAGE_BYTES });

  assert.equal(Object.hasOwn(page.more ?? {}, key), false);
  assert.deepEqual(page.data[key], data[key]);
});

test("a slug that cannot be written into a URL is not used for the repeat", () => {
  const data = { ...bigCompany(), slug: { linkedin: "example-corp\uD800" } };

  const page = firstPage(answer(data), { kind: "c", args: COMPANY_ARGS, budget: PAGE_BYTES });

  const urls = Object.values(page.more).map((entry) => readCursor(entry.cursor).a.url);
  assert.deepEqual(urls, urls.map(() => COMPANY_ARGS.url));
});
