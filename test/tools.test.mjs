import { test } from "node:test";
import assert from "node:assert/strict";
import { connectMcp, headers, startApi, testClient } from "./helpers.mjs";

const TOOL_NAMES = [
  "get_person_profile",
  "get_company_profile",
  "search_companies",
  "search_company_logos",
  "find_work_emails",
  "validate_email",
];
const PERSON = {
  fullName: "Jane Example",
  contactInformation: { emails: { work: [{ email: "jane@example.com", validity: "valid" }] } },
};

async function setup(t, respond) {
  const api = await startApi(respond);
  const mcp = await connectMcp(testClient(api.url));
  t.after(async () => {
    await mcp.close();
    await api.close();
  });
  return { api, client: mcp.client };
}

test("lists the six v3 tools as read-only, with input and output schemas", async (t) => {
  const { client } = await setup(t, () => ({ body: {} }));

  const { tools } = await client.listTools();

  assert.deepEqual(tools.map((tool) => tool.name).sort(), [...TOOL_NAMES].sort());
  for (const tool of tools) {
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.inputSchema.type, "object");
    assert.deepEqual(Object.keys(tool.outputSchema.properties).sort(), ["creditCost", "data", "requestId"]);
    assert.doesNotMatch(tool.description, /\bcredits? (each|per)\b|\$\d/);
  }
});

test("get_person_profile returns the full answer, the cost and the request id, also as JSON text", async (t) => {
  const { api, client } = await setup(t, () => ({ body: PERSON, headers: headers(1, "req-10") }));

  const result = await client.callTool({
    name: "get_person_profile",
    arguments: { profile: "https://linkedin.com/in/jane/", workEmail: "include" },
  });

  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, { data: PERSON, creditCost: 1, requestId: "req-10" });
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  assert.deepEqual(api.requests[0].query, { profile: "https://linkedin.com/in/jane/", workEmail: "include" });
});

test("get_person_profile asks for exactly one identifier before calling the API", async (t) => {
  const { api, client } = await setup(t, () => ({ body: PERSON }));

  const two = await client.callTool({ name: "get_person_profile", arguments: { profile: "jane", email: "jane@example.com" } });
  const none = await client.callTool({ name: "get_person_profile", arguments: { workEmail: "include" } });

  assert.equal(two.isError, true);
  assert.equal(two.content[0].text, "Pass exactly one of profile, email, twitter, facebook, github — got profile, email.");
  assert.equal(none.isError, true);
  assert.equal(none.content[0].text, "Pass exactly one of profile, email, twitter, facebook, github.");
  assert.equal(api.requests.length, 0);
});

test("find_work_emails asks for a name and a domain before calling the API", async (t) => {
  const { api, client } = await setup(t, () => ({ body: {} }));

  const result = await client.callTool({ name: "find_work_emails", arguments: { full_name: "Jane Example" } });

  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, "Pass full_name, or first_name and/or last_name, together with domain.");
  assert.equal(api.requests.length, 0);
});

test("search_companies returns the list of matches in data", async (t) => {
  const matches = [{ companyName: "Example Inc", linkedinUrl: "https://linkedin.com/company/example/" }];
  const { api, client } = await setup(t, () => ({ body: matches, headers: headers(1, "req-11") }));

  const result = await client.callTool({ name: "search_companies", arguments: { q: "example" } });

  assert.deepEqual(result.structuredContent.data, matches);
  assert.equal(api.requests[0].path, "/v3/company/search");
});

test("a rejected key comes back as a tool error that names ENRICHLAYER_API_KEY", async (t) => {
  const { client } = await setup(t, () => ({
    status: 401,
    body: { code: 401, name: "Unauthorized", description: "Invalid API key" },
    headers: headers(0, "req-12"),
  }));

  const result = await client.callTool({ name: "validate_email", arguments: { email: "jane@example.com" } });

  assert.equal(result.isError, true);
  assert.equal(
    result.content[0].text,
    "The API key was rejected: Invalid API key. Set ENRICHLAYER_API_KEY to a valid key from https://enrichlayer.com/dashboard and restart the MCP server. (credits charged: 0, request id: req-12)",
  );
});

test("a 409 tells how old the cached copy is and how to accept it", async (t) => {
  const { client } = await setup(t, () => ({
    status: 409,
    body: { code: 409, name: "Conflict", description: "Freshness conflict", cachedProfileAgeSeconds: 864000 },
    headers: headers(0, "req-13"),
  }));

  const result = await client.callTool({ name: "get_company_profile", arguments: { url: "https://linkedin.com/company/example/", maxAgeSeconds: 60 } });

  assert.equal(result.isError, true);
  assert.equal(
    result.content[0].text,
    "No copy is fresh enough and a live lookup did not succeed: Freshness conflict. The newest cached copy is 10 days old (864000 s). Call again later, or set maxAgeSeconds to at least 864000 to accept it. (credits charged: 0, request id: req-13)",
  );
});

test("a 403 for missing credits says to top up, other 403s say the key cannot use the endpoint", async (t) => {
  const { client } = await setup(t, (request) => ({
    status: 403,
    body: {
      code: 403,
      name: "Forbidden",
      description:
        request.query.email === "credits@example.com"
          ? "Insufficient credits. You need 1 credits for this request. Please top-up your credits or modify your request."
          : "Account has been suspended. Please email support@enrichlayer.com for more information.",
    },
    headers: headers(0, "req-14"),
  }));

  const credits = await client.callTool({ name: "validate_email", arguments: { email: "credits@example.com" } });
  const suspended = await client.callTool({ name: "validate_email", arguments: { email: "jane@example.com" } });

  assert.equal(
    credits.content[0].text,
    "Not enough credits: Insufficient credits. You need 1 credits for this request. Please top-up your credits or modify your request. Top up the account at https://enrichlayer.com/dashboard, then call again. (credits charged: 0, request id: req-14)",
  );
  assert.equal(
    suspended.content[0].text,
    "Access denied for /v3/email/validate: Account has been suspended. Please email support@enrichlayer.com for more information. This key or its account cannot use this endpoint; use a key that can, or contact support@enrichlayer.com. (credits charged: 0, request id: req-14)",
  );
});

test("calls through MCP name the client in the user agent", async (t) => {
  const { api, client } = await setup(t, () => ({ body: {} }));

  await client.callTool({ name: "validate_email", arguments: { email: "jane@example.com" } });

  assert.match(api.requests[0].headers["user-agent"], /^enrichlayer-mcp-v3\/\d+\.\d+\.\d+ \(test-client\)$/);
});

test("params the v3 spec does not define are not sent", async (t) => {
  const { api, client } = await setup(t, () => ({ body: {} }));

  await client.callTool({ name: "validate_email", arguments: { email: "jane@example.com", unknownParam: "x" } });

  assert.deepEqual(api.requests[0].query, { email: "jane@example.com" });
});
