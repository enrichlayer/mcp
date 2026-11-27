import { createHash } from "node:crypto";
import { z } from "zod";
import { MAX_INPUT_CHARS } from "../config.js";
import { v3Params, type V3Path } from "../generated/v3-params.js";

export const KIND_PATHS = {
  p: "/v3/person",
  c: "/v3/company",
  s: "/v3/company/search",
  l: "/v3/company/logo",
  e: "/v3/email/prospect",
  v: "/v3/email/validate",
} as const satisfies Record<string, V3Path>;

export type Kind = keyof typeof KIND_PATHS;
export type CursorArgs = Record<string, string | number>;

export interface Cursor {
  v: 1;
  t: Kind;
  a: CursorArgs;
  p: string;
  o: number;
  h?: string;
  i?: string[];
}

const PERSON_IDENTIFIERS = ["profile", "email", "twitter", "facebook", "github"];

const SECTIONS: Partial<Record<Kind, [string, string][]>> = {
  p: [
    ["activities", "activities"],
    ["contactInformation.phoneNumbers", "phoneNumber"],
    ["contactInformation.emails.personal", "personalEmail"],
    ["contactInformation.emails.work", "workEmail"],
    ["contactInformation.socialLinks", "socialLink"],
    ["slug.github", "socialLink"],
    ["slug.facebook", "socialLink"],
    ["slug.twitter", "socialLink"],
    ["careerInsight", "careerInsight"],
    ["developerProfile", "developerProfile"],
  ],
  c: [
    ["funding.summary.crunchbaseUrl", "extra"],
    ["funding", "fundingData"],
    ["exits", "exitData"],
    ["acquisitions", "acquisitions"],
    ["contactInformation.emails", "extra"],
    ["contactInformation.phoneNumbers", "extra"],
    ["contactInformation.socialLinks.crunchbaseUrl", "extra"],
    ["slug.crunchbase", "extra"],
    ["stock", "extra"],
    ["activities", "activities"],
  ],
};

const IDENTIFIERS: Record<Kind, string[]> = { p: PERSON_IDENTIFIERS, c: ["url"], s: ["q"], l: ["q"], e: [], v: [] };
const LONE_SURROGATE = /\p{Surrogate}/u;

export function kindOf(path: V3Path): Kind {
  return (Object.keys(KIND_PATHS) as Kind[]).find((kind) => KIND_PATHS[kind] === path)!;
}

export function sectionOf(kind: Kind, path: string): string | undefined {
  return SECTIONS[kind]?.find(([prefix]) => path === prefix || path.startsWith(`${prefix}.`))?.[1];
}

function isGiven(value: unknown): value is string | number {
  return typeof value === "number" || (typeof value === "string" && value.trim() !== "");
}

export function sectionsAsked(kind: Kind, params: Record<string, unknown>): string[] {
  const sections = new Set(SECTIONS[kind]?.map(([, section]) => section));
  return Object.keys(params).filter((name) => sections.has(name) && params[name] === "include");
}

export function repeatArgs(kind: Kind, firstArgs: Record<string, unknown>, data: unknown, path: string): CursorArgs {
  const pick = (names: string[]) => Object.fromEntries(names.filter((name) => isGiven(firstArgs[name])).map((name) => [name, firstArgs[name] as string | number]));
  if (kind !== "p" && kind !== "c") return pick(Object.keys(v3Params[KIND_PATHS[kind]]));
  const section = sectionOf(kind, path);
  const withSection = (identifier: CursorArgs): CursorArgs => ({ ...identifier, ...(section && { [section]: "include" }) });
  const given = withSection(pick(IDENTIFIERS[kind]));
  const slug = (data as { slug?: { linkedin?: unknown } } | null)?.slug?.linkedin;
  if (typeof slug !== "string" || slug.trim() === "" || LONE_SURROGATE.test(slug)) return given;
  const returned = withSection(kind === "p" ? { profile: slug } : { url: `https://www.linkedin.com/company/${encodeURIComponent(slug)}` });
  return hasValidArgs({ t: kind, a: returned }) ? returned : given;
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

const cursorSchema = z
  .object({
    v: z.literal(1),
    t: z.enum(Object.keys(KIND_PATHS) as [Kind, ...Kind[]]),
    a: z.record(z.string(), z.union([z.string(), z.number()])),
    p: z.string().max(500),
    o: z.number().int().min(0),
    h: z.string().regex(/^[A-Za-z0-9_-]{8}$/).optional(),
    i: z.array(z.string().regex(/^[A-Za-z0-9_-]{8}$/)).min(1).max(16).optional(),
  })
  .strict();

function hasValidArgs({ t, a }: Pick<Cursor, "t" | "a">): boolean {
  if ("maxAgeSeconds" in a) return false;
  if (Object.values(a).some((value) => typeof value === "string" && value.length > MAX_INPUT_CHARS)) return false;
  if (!z.object(v3Params[KIND_PATHS[t]]).strict().safeParse(a).success) return false;
  const identifiers = IDENTIFIERS[t].filter((name) => isGiven(a[name]));
  const sections = Object.keys(a).filter((name) => !IDENTIFIERS[t].includes(name));
  if (t !== "p" && t !== "c") return true;
  return identifiers.length === 1 && sections.length <= 1 && sections.every((name) => a[name] === "include");
}

export function readCursor(text: string): Cursor | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const result = cursorSchema.safeParse(parsed);
  if (!result.success) return null;
  const cursor = result.data as Cursor;
  return hasValidArgs(cursor) ? cursor : null;
}

export function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("base64url").slice(0, 8);
}
