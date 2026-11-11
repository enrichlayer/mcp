import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { SignJWT } from "jose";
import { httpConfig } from "../build/config.js";
import { createHttpApp } from "../build/http-app.js";
import { headers, startApi } from "./helpers.mjs";

const SECRET = "test-secret-for-the-hosted-connector";
const BASE_URL = "https://connector.example.com";
const API_KEY = "test-key-from-token";
const METADATA_URL = `${BASE_URL}/.well-known/oauth-protected-resource/v3/mcp`;
const VALIDATE = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "validate_email", arguments: { email: "jane@example.com" } } };

function signToken(claims = {}, { secret = SECRET, issuer = BASE_URL, audience = BASE_URL, expiresAt = "1h" } = {}) {
  return new SignJWT({ api_key: API_KEY, scope: "api", ...claims })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("client-1")
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(new TextEncoder().encode(secret));
}

async function setup(t, respond, options = {}) {
  const api = await startApi(respond);
  const lines = [];
  const app = createHttpApp({
    baseUrl: BASE_URL,
    jwtSecret: SECRET,
    apiBaseUrl: api.url,
    write: (line) => lines.push(line),
    timeoutMs: 2_000,
    retryDelaysMs: [0, 0],
    ...options,
  });
  const server = createServer(toNodeHandler(app));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await app.close();
    await api.close();
  });
  return { api, app, lines, url: `http://127.0.0.1:${server.address().port}` };
}

function post(url, body, { token, headers: extra = {}, method = "POST" } = {}) {
  return fetch(`${url}/v3/mcp`, {
    method,
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
      ...(token && { authorization: `Bearer ${token}` }),
      ...extra,
    },
    body: method === "POST" ? JSON.stringify(body) : undefined,
  });
}

function lastData(sse) {
  const data = sse.split("\n").filter((line) => line.startsWith("data: "));
  return JSON.parse(data.at(-1).slice("data: ".length));
}

function dataMessages(sse) {
  return sse
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)));
}

function challenge(error, description) {
  return `Bearer error="${error}", error_description="${description}", scope="api", resource_metadata="${METADATA_URL}"`;
}

test("a tool call through MCP sends the key from the token to the API and logs one line without secrets", async (t) => {
  const { api, lines, url } = await setup(t, () => ({ body: { emailStatus: "valid" }, headers: headers(1, "req-1") }));
  const token = await signToken();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const requestInit = { headers: { Authorization: `Bearer ${token}`, "User-Agent": "test-agent/1.0" } };
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/v3/mcp`), { requestInit }));
  t.after(() => client.close());

  const result = await client.callTool({ name: "validate_email", arguments: { email: "jane@example.com" } });

  assert.deepEqual(result.structuredContent, { data: { emailStatus: "valid" }, creditCost: 1, requestId: "req-1" });
  assert.equal(api.requests[0].headers.authorization, `Bearer ${API_KEY}`);
  assert.match(api.requests[0].headers["user-agent"], /^enrichlayer-mcp-v3\/\d+\.\d+\.\d+ \(test-agent\/1\.0\)$/);
  assert.equal(lines.length, 1);
  const { ms, ...line } = JSON.parse(lines[0]);
  assert.deepEqual(line, { tool: "validate_email", client: "test-agent/1.0", status: "ok", creditCost: 1, requestId: "req-1" });
  assert.equal(typeof ms, "number");
  assert.equal(lines[0].includes(API_KEY) || lines[0].includes(token), false);
});

test("a missing, forged, expired or foreign token gets 401 with the metadata link and never reaches the API", async (t) => {
  const { api, url } = await setup(t, () => ({ body: {} }));
  const past = Math.floor(Date.now() / 1000) - 60;
  const cases = [
    [undefined, "Missing Authorization header"],
    ["not-a-jwt", "The access token is invalid or has expired"],
    [await signToken({}, { secret: "another-secret-of-the-same-length!!" }), "The access token is invalid or has expired"],
    [await signToken({}, { expiresAt: past }), "The access token is invalid or has expired"],
    [await signToken({}, { audience: `${BASE_URL}/mcp` }), "The access token is invalid or has expired"],
    [await signToken({}, { issuer: "https://auth.example.com" }), "The access token is invalid or has expired"],
    [await signToken({ api_key: undefined }), "The access token does not carry a usable API key"],
    [await signToken({ api_key: "key\nwith-a-line-break" }), "The access token does not carry a usable API key"],
  ];

  for (const [token, description] of cases) {
    const response = await post(url, VALIDATE, { token });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("www-authenticate"), challenge("invalid_token", description));
  }
  assert.equal(api.requests.length, 0);
});

test("a token without the api scope gets 403 insufficient_scope", async (t) => {
  const { api, url } = await setup(t, () => ({ body: {} }));

  for (const token of [await signToken({ scope: undefined }), await signToken({ scope: "read" })]) {
    const response = await post(url, VALIDATE, { token });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("www-authenticate"), challenge("insufficient_scope", "Insufficient scope"));
  }
  assert.equal(api.requests.length, 0);
});

test("GET and DELETE on the MCP path get 405", async (t) => {
  const { url } = await setup(t, () => ({ body: {} }));
  const token = await signToken();

  for (const method of ["GET", "DELETE"]) {
    const response = await post(url, undefined, { token, method });
    assert.equal(response.status, 405);
  }
});

test("a request for another host is refused before the token is checked", async (t) => {
  const { app } = await setup(t, () => ({ body: {} }));

  const response = await app.fetch(new Request("http://127.0.0.1/v3/mcp", { method: "POST", headers: { host: "evil.example" }, body: "{}" }));

  assert.equal(response.status, 403);
});

test("the resource metadata and the health check describe this server", async (t) => {
  const { url } = await setup(t, () => ({ body: {} }));

  const metadata = await fetch(`${url}/.well-known/oauth-protected-resource/v3/mcp`);
  const health = await fetch(`${url}/v3/health`);
  const missing = await fetch(`${url}/mcp`);

  assert.deepEqual(await metadata.json(), {
    resource: BASE_URL,
    authorization_servers: [BASE_URL],
    scopes_supported: ["api"],
    resource_name: "Enrich Layer v3 MCP Server",
    resource_documentation: "https://github.com/enrichlayer/mcp#readme",
  });
  const { status, version } = await health.json();
  assert.equal(status, "ok");
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.equal(missing.status, 404);
});

test("a slow call streams keep-alive comments before the result, and the HTTP User-Agent names a 2025 client", async (t) => {
  const { api, url } = await setup(t, () => ({ body: { emailStatus: "valid" }, headers: headers(1, "req-2"), delayMs: 400 }), {
    keepAliveMs: 50,
  });
  const token = await signToken();

  const response = await post(url, VALIDATE, { token, headers: { "user-agent": "TestAgent/1.0" } });
  const sse = await response.text();

  assert.equal(response.headers.get("content-type"), "text/event-stream");
  assert.ok(sse.indexOf(": keepalive") !== -1 && sse.indexOf(": keepalive") < sse.indexOf("data: "));
  assert.deepEqual(lastData(sse).result.structuredContent, { data: { emailStatus: "valid" }, creditCost: 1, requestId: "req-2" });
  assert.match(api.requests[0].headers["user-agent"], /^enrichlayer-mcp-v3\/\d+\.\d+\.\d+ \(TestAgent\/1\.0\)$/);
});

test("a slow call with a progress token gets rising progress notifications before the result", async (t) => {
  const { url } = await setup(t, () => ({ body: { emailStatus: "valid" }, headers: headers(1, "req-p1"), delayMs: 400 }), {
    keepAliveMs: 50,
  });
  const token = await signToken();
  const call = { ...VALIDATE, params: { ...VALIDATE.params, _meta: { progressToken: "call-1" } } };

  const messages = dataMessages(await (await post(url, call, { token })).text());

  const progress = messages.slice(0, -1);
  assert.ok(progress.length > 0);
  assert.deepEqual(
    progress,
    progress.map((_, i) => ({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: "call-1", progress: i + 1 } })),
  );
  assert.deepEqual(messages.at(-1).result.structuredContent, { data: { emailStatus: "valid" }, creditCost: 1, requestId: "req-p1" });
});

test("a slow call without a progress token gets no progress notifications", async (t) => {
  const { url } = await setup(t, () => ({ body: { emailStatus: "valid" }, headers: headers(1, "req-p2"), delayMs: 400 }), {
    keepAliveMs: 50,
  });
  const token = await signToken();

  const sse = await (await post(url, VALIDATE, { token })).text();

  assert.ok(sse.includes(": keepalive"));
  const messages = dataMessages(sse);
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0].result.structuredContent, { data: { emailStatus: "valid" }, creditCost: 1, requestId: "req-p2" });
});

test("a failed call logs the API status, cost and request id", async (t) => {
  const errors = [];
  const { lines, url } = await setup(
    t,
    () => ({ status: 404, body: { code: 404, name: "Not Found", description: "Email not found" }, headers: headers(0, "req-3") }),
    { onError: (error) => errors.push(error) },
  );

  const response = await post(url, VALIDATE, { token: await signToken(), headers: { "user-agent": "TestAgent/1.0" } });
  assert.equal(lastData(await response.text()).result.isError, true);

  const { ms, ...line } = JSON.parse(lines[0]);
  assert.deepEqual(line, { tool: "validate_email", client: "TestAgent/1.0", status: 404, creditCost: 0, requestId: "req-3" });
  assert.equal(errors.length, 1);
});

test("a key the API rejects or limits tells a hosted user to sign in again, not to change the environment", async (t) => {
  const { url } = await setup(t, (request) => ({
    status: request.query.email === "rejected@example.com" ? 401 : 403,
    body: { description: request.query.email === "rejected@example.com" ? "Invalid API key" : "Account has been suspended" },
    headers: headers(0, "req-4"),
  }));
  const token = await signToken();
  const call = async (email) => {
    const response = await post(url, { ...VALIDATE, params: { ...VALIDATE.params, arguments: { email } } }, { token });
    return lastData(await response.text()).result.content[0].text;
  };

  assert.equal(
    await call("rejected@example.com"),
    "The API key was rejected: Invalid API key. Reconnect Enrich Layer in your MCP client and sign in again with a valid API key from https://enrichlayer.com/dashboard. (credits charged: 0, request id: req-4)",
  );
  assert.equal(
    await call("denied@example.com"),
    "Access denied for /v3/email/validate: Account has been suspended. This key or its account cannot use this endpoint; reconnect and sign in with a key that can, or contact support@enrichlayer.com. (credits charged: 0, request id: req-4)",
  );
});

test("the HTTP server needs MCP_BASE_URL and AUTH_JWT_SECRET", () => {
  assert.throws(() => httpConfig({}), { message: "Set MCP_BASE_URL and AUTH_JWT_SECRET to start the HTTP server." });
  assert.throws(() => httpConfig({ MCP_BASE_URL: BASE_URL }), { message: "Set AUTH_JWT_SECRET to start the HTTP server." });
  assert.throws(() => httpConfig({ MCP_BASE_URL: "not a url", AUTH_JWT_SECRET: SECRET }), { message: "MCP_BASE_URL is not a URL: not a url" });
  assert.deepEqual(httpConfig({ MCP_BASE_URL: `${BASE_URL}/`, AUTH_JWT_SECRET: SECRET, PORT: "3002" }), {
    port: 3002,
    baseUrl: BASE_URL,
    jwtSecret: SECRET,
    sentryDsn: undefined,
    sentryEnvironment: undefined,
  });
});
