import type { V3Result } from "../client.js";
import { compact } from "./compact.js";
import { encodeCursor, fingerprint, readCursor, repeatArgs, type Cursor, type Kind } from "./cursor.js";

export interface MoreEntry {
  items?: number;
  chars?: number;
  approxChars: number;
  pages: number;
  cursor: string;
}

export type More = Record<string, MoreEntry>;

export interface FirstPage {
  data: unknown;
  creditCost: number | null;
  requestId: string | null;
  more?: More;
  note?: string;
}

export interface Page {
  path: string;
  items?: number;
  chars?: number;
  from: number;
  list?: unknown[];
  text?: string;
  more?: More;
  nextCursor: string | null;
  creditCost: number | null;
  requestId: string | null;
  changed?: true;
  restartCursor?: string;
  note?: string;
}

export const MORE_NOTE =
  "Lists named in `more` are left out of `data` because of the answer's size. To read one, call get_more with its `cursor`: every page is a new lookup and is charged, and the list takes about `pages` pages.";

export const CHANGED_NOTE =
  "This list changed since the earlier pages were read, so items may repeat or be missing. This page comes from the updated list; to read it consistently, start again from `restartCursor` (every page is charged).";

export const ITEM_GONE_NOTE =
  "The item this cursor reads from changed or is no longer in its list, so this page is empty. To read that list again, start from `restartCursor` (every page is charged).";

type Part = { path: string; value: unknown[] | string };
type Money = Pick<V3Result, "creditCost" | "requestId">;
type Extra = Pick<Page, "changed" | "restartCursor" | "note">;
type EntryFor = (path: string, value: unknown[] | string) => MoreEntry | null;
type Wrap = (node: Record<string, unknown>, more: More) => unknown;

const ROOT_KEY = "data";
const MAX_FINGERPRINT = "AAAAAAAA";
const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
const LOOKAHEAD = 32;

const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const shown = (path: string) => (path === "" ? ROOT_KEY : path);
const join = (prefix: string, key: string) => (prefix ? `${prefix}.${key}` : key);

type Located = { value: unknown } | { gone: string; bindings: string[] };

function locate(root: unknown, path: string, bindings: string[] = []): Located {
  if (path === "") return { value: root };
  const keys = path.split(".");
  let node = root;
  let bound = 0;
  for (const [depth, key] of keys.entries()) {
    if (Array.isArray(node) && bound < bindings.length) {
      const isWanted = (item: unknown) => fingerprint(compact(item)) === bindings[bound];
      const given = Number(key);
      const isInList = Number.isInteger(given) && given >= 0 && given < node.length;
      const index = isInList && isWanted(node[given]) ? given : node.findIndex(isWanted);
      if (index < 0) return { gone: keys.slice(0, depth).join("."), bindings: bindings.slice(0, bound) };
      bound += 1;
      node = node[index];
      continue;
    }
    if (node === null || typeof node !== "object" || !Object.hasOwn(node, key)) return { value: undefined };
    node = (node as Record<string, unknown>)[key];
  }
  return { value: node };
}

function partsOf(node: Record<string, unknown>, path = "", out: Part[] = []): Part[] {
  for (const [key, value] of Object.entries(node)) {
    const at = join(path, key);
    if (Array.isArray(value) || typeof value === "string") out.push({ path: at, value });
    else if (isObject(value)) partsOf(value, at, out);
  }
  return out;
}

function without(node: Record<string, unknown>, left: Set<string>, path = ""): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    const at = join(path, key);
    if (left.has(at)) continue;
    if (!isObject(value)) out[key] = value;
    else {
      const inner = without(value, left, at);
      if (Object.keys(inner).length > 0) out[key] = inner;
    }
  }
  return out;
}

function fitObject(node: Record<string, unknown>, prefix: string, budget: number, wrap: Wrap, entryFor: EntryFor) {
  const parts = partsOf(node);
  const entries = new Map<string, MoreEntry | null>();
  const entryOf = (part: Part) => {
    if (!entries.has(part.path)) entries.set(part.path, entryFor(join(prefix, part.path), part.value));
    return entries.get(part.path)!;
  };
  const left = new Set<string>();
  const render = () => ({
    node: without(node, left),
    more: Object.fromEntries(parts.filter((part) => left.has(part.path)).map((part) => [join(prefix, part.path), entryOf(part)!])),
  });
  const measure = () => {
    const { node: rest, more } = render();
    return size(wrap(rest, more));
  };
  let current = measure();
  const moveIfSmaller = (part: Part) => {
    if (!entryOf(part)) return;
    left.add(part.path);
    const moved = measure();
    if (moved < current) current = moved;
    else left.delete(part.path);
  };
  const lists = parts.filter((part) => Array.isArray(part.value));
  for (const list of lists) moveIfSmaller(list);
  const texts = parts.filter((part) => typeof part.value === "string").sort((a, b) => size(b.value) - size(a.value));
  for (const text of texts) {
    if (current <= budget) break;
    moveIfSmaller(text);
  }
  for (const list of lists.filter((part) => left.has(part.path)).sort((a, b) => size(a.value) - size(b.value))) {
    left.delete(list.path);
    if (measure() > budget) left.add(list.path);
  }
  return render();
}

function reserveFor({ creditCost, requestId }: Money): Money {
  return { creditCost: Math.max(99_999, creditCost ?? 0), requestId: "x".repeat(Math.max(32, requestId?.length ?? 0)) };
}

function frame(cursor: Cursor, value: unknown[] | string, from: number, body: Pick<Page, "list" | "text" | "more">, nextCursor: string | null, money: Money, extra: Extra): Page {
  return {
    path: shown(cursor.p),
    ...(typeof value === "string" ? { chars: value.length } : { items: value.length }),
    from,
    ...body,
    nextCursor,
    creditCost: money.creditCost,
    requestId: money.requestId,
    ...extra,
  };
}

function listEnd(list: unknown[], from: number, used: number, budget: number): number {
  let end = from;
  for (; end < list.length; end++) {
    const add = size(list[end]) + (end > from ? 1 : 0);
    if (used + add > budget) break;
    used += add;
  }
  return end;
}

function textEnd(text: string, from: number, used: number, budget: number): number {
  let end = from;
  while (end < text.length) {
    const step = text.codePointAt(end)! > 0xffff ? 2 : 1;
    const add = size(text.slice(end, end + step)) - 2;
    if (used + add > budget) break;
    used += add;
    end += step;
  }
  if (end === text.length) return end;
  const start = from + segmenter.segment(text.slice(from, end + LOOKAHEAD)).containing(end - from)!.index;
  return start > from ? start : end;
}

function endOf(value: unknown[] | string, cursor: Cursor, from: number, budget: number, money: Money, extra: Extra): number {
  const longestNext = encodeCursor({ ...cursor, o: value.length, h: MAX_FINGERPRINT });
  const empty = typeof value === "string" ? { text: "" } : { list: [] };
  const used = size(frame(cursor, value, from, empty, longestNext, reserveFor(money), extra));
  return typeof value === "string" ? textEnd(value, from, used, budget) : listEnd(value, from, used, budget);
}

function countPages(value: unknown[] | string, cursor: Cursor, budget: number): number {
  const money = { creditCost: null, requestId: null };
  for (let pages = 1, from = 0; ; pages++) {
    const end = endOf(value, { ...cursor, o: from }, from, budget, money, {});
    const next = end > from ? end : from + 1;
    if (next >= value.length) return pages;
    from = next;
  }
}

function entryMaker(kind: Kind, argsFor: (path: string) => Cursor["a"], budget: number, bindings?: string[]): EntryFor {
  return (path, value) => {
    const cursor: Cursor = { v: 1, t: kind, a: argsFor(path), p: path, o: 0, ...(bindings && { i: bindings }) };
    const text = encodeCursor(cursor);
    if (!readCursor(text)) return null;
    return {
      ...(typeof value === "string" ? { chars: value.length } : { items: value.length }),
      approxChars: size(value),
      pages: countPages(value, cursor, budget),
      cursor: text,
    };
  };
}

export function firstPage(result: V3Result, { kind, args, budget }: { kind: Kind; args: Record<string, unknown>; budget: number }): FirstPage {
  const data = compact(result.data);
  const money = { creditCost: result.creditCost, requestId: result.requestId };
  if (size({ data, ...money }) <= budget) return { data, ...money };
  const entryFor = entryMaker(kind, (path) => repeatArgs(kind, args, data, path), budget);
  const wrap = (node: unknown, more: More): FirstPage => ({ data: node, ...money, more, note: MORE_NOTE });
  if (!isObject(data)) {
    const entry = entryFor("", data as unknown[] | string);
    return entry ? wrap(Array.isArray(data) ? [] : null, { [ROOT_KEY]: entry }) : { data, ...money };
  }
  const { node, more } = fitObject(data, "", budget, wrap, entryFor);
  return wrap(node, more);
}

export function isWithin(value: unknown, budget: number): boolean {
  return size(value) <= budget;
}

function gonePage(cursor: Cursor, gone: { gone: string; bindings: string[] }, money: Money): Page {
  const restart: Cursor = { v: 1, t: cursor.t, a: cursor.a, p: gone.gone, o: 0, ...(gone.bindings.length > 0 && { i: gone.bindings }) };
  return { path: shown(cursor.p), from: cursor.o, nextCursor: null, ...money, changed: true, restartCursor: encodeCursor(restart), note: ITEM_GONE_NOTE };
}

export function nextPage(fresh: V3Result, cursor: Cursor, { budget }: { budget: number }): Page | null {
  const money = { creditCost: fresh.creditCost, requestId: fresh.requestId };
  const found = locate(fresh.data, cursor.p, cursor.i);
  if ("gone" in found) return gonePage(cursor, found, money);
  const value = compact(found.value);
  if (!Array.isArray(value) && typeof value !== "string") return null;
  const restart = encodeCursor({ v: 1, t: cursor.t, a: cursor.a, p: cursor.p, o: 0, ...(cursor.i && { i: cursor.i }) });
  const isChanged = cursor.o > 0 && cursor.h !== fingerprint(value.slice(0, cursor.o));
  const extra: Extra = isChanged ? { changed: true, restartCursor: restart, note: CHANGED_NOTE } : {};
  const from = Math.min(cursor.o, value.length);
  const at = { ...cursor, o: from };
  const nextCursor = (end: number) => (end < value.length ? encodeCursor({ ...cursor, o: end, h: fingerprint(value.slice(0, end)) }) : null);
  const end = endOf(value, at, from, budget, money, extra);
  if (typeof value === "string") return frame(at, value, from, { text: value.slice(from, end) }, nextCursor(end), money, extra);
  if (end > from || from >= value.length) return frame(at, value, from, { list: value.slice(from, end) }, nextCursor(end), money, extra);

  const item = value[from];
  const itemPath = join(cursor.p, String(from));
  const entryFor = entryMaker(cursor.t, () => cursor.a, budget, [...(cursor.i ?? []), fingerprint(item)]);
  const next = nextCursor(from + 1);
  if (isObject(item)) {
    const longestNext = encodeCursor({ ...cursor, o: value.length, h: MAX_FINGERPRINT });
    const wrap = (node: unknown, more: More) => frame(at, value, from, { list: [node], more }, longestNext, reserveFor(money), extra);
    const { node, more } = fitObject(item, itemPath, budget, wrap, entryFor);
    return frame(at, value, from, { list: [node], more }, next, money, extra);
  }
  const entry = entryFor(itemPath, item as unknown[] | string);
  return frame(at, value, from, entry ? { list: [], more: { [itemPath]: entry } } : { list: [item] }, next, money, extra);
}
