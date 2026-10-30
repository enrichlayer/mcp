import { CUT_OFF_ADVICE } from "../errors.js";
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

const RESULT =
  "The result has the full v3 answer in `data`, the credits charged for the call in `creditCost` and the `requestId` to quote to support.";

const SECTIONS =
  "Ask only for the sections you need: a full profile may not fit the client's limit on tool output (25,000 tokens in Claude Code).";

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
      "`personalEmail` and `workEmail` return only addresses validated as deliverable. To find someone's work email from a profile URL, pass `profile` and `workEmail: \"include\"`: an empty `contactInformation.emails.work` means no work email was found here, and find_work_emails with the person's name and company domain may still find candidates.",
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
