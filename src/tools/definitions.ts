import { MAX_INPUT_CHARS, PAGE_BYTES } from "../config.js";
import { CUT_OFF_ADVICE, SUPPORT_EMAIL } from "../errors.js";
import { KIND_PATHS, type Kind } from "../fit/cursor.js";
import type { V3Path } from "../generated/v3-params.js";

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  path: V3Path;
  returns: "object" | "array";
  checkParams?: (params: Record<string, unknown>) => string | null;
}

const PERSON_IDENTIFIERS = ["profile", "email", "twitter", "facebook", "github"];

function isGiven(value: unknown): boolean {
  return typeof value === "string" ? value.trim() !== "" : value !== undefined;
}

const LIMIT = PAGE_BYTES.toLocaleString("en-US");

const RESULT = [
  "The result has the v3 answer in `data`, the credits charged for the call in `creditCost` and the `requestId` to quote to support.",
  "Fields with no value (null, empty lists, empty objects, empty text) are left out of `data`; for an optional section, a missing field means it found nothing or was not asked for.",
  `An answer is never longer than ${LIMIT} bytes: if the full answer is longer, \`data\` keeps every field and every list that fits, and each list it leaves out is named in \`more\` with its number of items, its approximate size, its number of pages and a \`cursor\` for get_more.`,
  "A list that is in `data` is always complete. Reading a page with get_more is a new lookup and is charged.",
].join(" ");

const SECTIONS = "Ask only for the sections you need: each one adds data, and most add to the cost.";

const FRESHNESS = [
  "`maxAgeSeconds` is the oldest cached copy you accept (default 30 days, usually answered in seconds).",
  "A small value starts a live lookup, which is slower and costs more: it can take up to 5 minutes and run past the time limit of the MCP client.",
  CUT_OFF_ADVICE,
].join(" ");

const VERDICTS = "`valid`, `invalid`, `catchall`, `malformed` or another value";

export const toolDefs: ToolDef[] = [
  {
    name: "get_person_profile",
    title: "Get Person Profile",
    path: "/v3/person",
    returns: "object",
    description: [
      "Look up one person by exactly one identifier: `profile` (LinkedIn profile URL or username), `email`, `twitter`, `facebook` or `github`.",
      "Optional sections add data to the answer and to the cost of the call: `socialLink`, `phoneNumber`, `personalEmail`, `workEmail`, `careerInsight`, `developerProfile`, `activities`.",
      SECTIONS,
      "`personalEmail` and `workEmail` return only addresses validated as deliverable. To find someone's work email from a profile URL, pass `profile` and `workEmail: \"include\"`: if `contactInformation.emails.work` is missing, no work email was found here, and find_work_emails with the person's name and company domain may still find candidates.",
      FRESHNESS,
      RESULT,
    ].join(" "),
    checkParams: (params) => {
      const given = PERSON_IDENTIFIERS.filter((name) => isGiven(params[name]));
      if (given.length === 1) return null;
      return `Pass exactly one of ${PERSON_IDENTIFIERS.join(", ")}${given.length > 1 ? ` — got ${given.join(", ")}` : ""}.`;
    },
  },
  {
    name: "get_company_profile",
    title: "Get Company Profile",
    path: "/v3/company",
    returns: "object",
    description: [
      "Look up a company by its LinkedIn company or showcase page URL (`url`).",
      "Optional sections add data to the answer and to the cost of the call: `fundingData`, `exitData`, `acquisitions`, `extra`, `activities`.",
      SECTIONS,
      FRESHNESS,
      RESULT,
    ].join(" "),
  },
  {
    name: "search_companies",
    title: "Search Companies",
    path: "/v3/company/search",
    returns: "array",
    description: [
      "Search companies by name (`q`). Returns up to 10 matches with the company name, logo URL, domain, industry, size, location and LinkedIn URL; pass the LinkedIn URL to get_company_profile for the full profile.",
      RESULT,
    ].join(" "),
  },
  {
    name: "search_company_logos",
    title: "Search Company Logos",
    path: "/v3/company/logo",
    returns: "array",
    description: [
      "Find companies by name or domain (`q`) and get their logo URLs, with the company name, domain and LinkedIn URL.",
      RESULT,
    ].join(" "),
  },
  {
    name: "find_work_emails",
    title: "Find Work Emails",
    path: "/v3/email/prospect",
    returns: "object",
    description: [
      "Find work email candidates for a person at a company: pass `full_name`, or `first_name` and/or `last_name`, together with the company `domain`.",
      `Each candidate has a validation verdict in \`validity\` — ${VERDICTS}; only \`valid\` is confirmed deliverable. \`limit\` caps the number of candidates (1–10).`,
      RESULT,
    ].join(" "),
    checkParams: (params) =>
      (isGiven(params.full_name) || isGiven(params.first_name) || isGiven(params.last_name)) && isGiven(params.domain)
        ? null
        : "Pass full_name, or first_name and/or last_name, together with domain.",
  },
  {
    name: "validate_email",
    title: "Validate Email",
    path: "/v3/email/validate",
    returns: "object",
    description: [
      `Check whether one email address is deliverable. \`emailStatus\` is the verdict — ${VERDICTS}; when the domain belongs to a known company, a company summary is attached.`,
      RESULT,
    ].join(" "),
  },
];

export const moreToolDef = {
  name: "get_more",
  title: "Get More",
  description: [
    "Read one page of a list that an earlier Enrich Layer answer left out because of its size.",
    "Pass a `cursor` from that answer's `more`, or the `nextCursor` or `restartCursor` of a page, exactly as it was returned.",
    "Every call is a new lookup of the same profile, read from the cached copy and asking only for the section that holds the list, and it is charged like that lookup: `creditCost` of the page is what was charged.",
    "For the few profiles the source can serve only live, a page costs more.",
    `A page holds whole items in their original order (time series oldest first) and is never longer than ${LIMIT} bytes; \`nextCursor\` is null after the last page.`,
    "Calling the same cursor again returns the same page and is charged again.",
    "If the list changed since the earlier pages, the page says so and gives `restartCursor` to read it again from the start.",
  ].join(" "),
  cursorDescription: "A `cursor`, `nextCursor` or `restartCursor` from an earlier Enrich Layer answer, exactly as it was returned.",
};

export const INVALID_CURSOR =
  "This is not a cursor this server gave out. Pass a `cursor`, `nextCursor` or `restartCursor` exactly as an Enrich Layer answer returned it.";

const LONG_INPUT_ADVICE: Record<string, string> = {
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

export function tooLongInput(params: Record<string, unknown>): string | null {
  const name = Object.keys(LONG_INPUT_ADVICE).find((key) => {
    const value = params[key];
    return typeof value === "string" && value.length > MAX_INPUT_CHARS;
  });
  return name ? `\`${name}\` is longer than ${MAX_INPUT_CHARS} characters; ${LONG_INPUT_ADVICE[name]}.` : null;
}

function charged(creditCost: number | null): string {
  return creditCost === null ? "The charge for this call is unknown." : `This call was charged ${creditCost} credit${creditCost === 1 ? "" : "s"}.`;
}

function toolOf(kind: Kind): string {
  return toolDefs.find((def) => def.path === KIND_PATHS[kind])!.name;
}

export function listGone(kind: Kind, creditCost: number | null): string {
  return `This list is not in the answer any more: the profile changed since the first page. Call ${toolOf(kind)} again for a fresh answer and new cursors. ${charged(creditCost)}`;
}

interface Charge {
  creditCost: number | null;
  requestId: string | null;
}

function chargedWithSupport({ creditCost, requestId }: Charge): string {
  return `${charged(creditCost)} To have the charge checked, contact ${SUPPORT_EMAIL}${requestId ? ` with request id ${requestId}` : ""}.`;
}

export function answerTooLarge(tool: string, sections: string[], charge: Charge): string {
  const next =
    sections.length > 0
      ? `. Call ${tool} again without some of the optional sections you asked for: ${sections.join(", ")}.`
      : ", so it cannot be returned through MCP.";
  return `This answer does not fit in ${LIMIT} bytes even with its long lists left out${next} ${chargedWithSupport(charge)}`;
}

export function pageTooLarge(kind: Kind, nextCursor: string | null, charge: Charge): string {
  const skip = nextCursor ? ` To skip this item and read the rest of the list, call get_more with the cursor ${nextCursor}.` : "";
  return `This page does not fit in ${LIMIT} bytes, so it cannot be read through MCP, and calling ${toolOf(kind)} again leads to the same page.${skip} ${chargedWithSupport(charge)}`;
}
