import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { TokenExchangeError, tokenExchanger } from "../build/auth/exchange.js";
import { tokenCredentials } from "../build/auth/token.js";
import { createV3Client } from "../build/client.js";
import { httpConfig } from "../build/config.js";
import { isReportable } from "../build/sentry.js";
import { createHttpApp } from "../build/http-app.js";
import { headers, startApi } from "./helpers.mjs";

const SECRET = "test-secret-for-the-hosted-connector";
const BASE_URL = "https://connector.example.com";
const METADATA_URL = `${BASE_URL}/.well-known/oauth-protected-resource/v3/mcp`;
const API_KEY = "test-key-from-token";
const ENV_API_KEY = "environment-api-key-that-must-never-be-sent";
const MCP_AUDIENCE = "urn:test:mcp";
const API_AUDIENCE = "urn:test:api";
const CLIENT_ID = "mcp client+:%&";
const CLIENT_SECRET = "generated secret+:%&";
const TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";
const VALIDATE = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "validate_email", arguments: { email: "jane@example.com" } } };

const signingKeys = await generateKeyPair("ES256");
const strangerKeys = await generateKeyPair("ES256");
const publicJwk = { ...(await exportJWK(signingKeys.publicKey)), kid: "issuer-key", alg: "ES256", use: "sig" };

// The stdio key must never reach the REST API on the hosted path.
process.env.ENRICHLAYER_API_KEY = ENV_API_KEY;

/** An in-process double of the sign-in service: its JWKS and its token endpoint. */
async function startIssuer(answer = () => undefined) {
  const exchanges = [];
  const counts = { jwks: 0, redirected: 0 };
  const state = { jwksStatus: 200, jwksBody: undefined, answer };
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const reply = (status, payload, extra = {}) => {
      if (res.destroyed) return;
      res.writeHead(status, { "content-type": "application/json", ...extra });
      res.end(typeof payload === "string" ? payload : JSON.stringify(payload));
    };
    if (req.url === "/.well-known/jwks.json") {
      counts.jwks++;
      return reply(state.jwksStatus, state.jwksBody ?? { keys: [publicJwk] });
    }
    if (req.url === "/redirected-token") {
      counts.redirected++;
      return reply(200, { access_token: "redirected-token", issued_token_type: TOKEN_TYPE, token_type: "Bearer", expires_in: 600 });
    }
    if (req.url === "/token" && req.method === "POST") {
      const form = new URLSearchParams(body);
      exchanges.push({ authorization: req.headers.authorization, contentType: req.headers["content-type"], form });
      const custom = await state.answer(form, exchanges.length);
      if (custom) return reply(custom.status, custom.body ?? {}, custom.headers);
      return reply(200, {
        access_token: `rest-token-${exchanges.length}`,
        issued_token_type: TOKEN_TYPE,
        token_type: "Bearer",
        expires_in: 600,
      });
    }
    reply(404, { error: "not_found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    exchanges,
    counts,
    state,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

function issuerSettings(issuer) {
  return { issuer: issuer.url, mcpAudience: MCP_AUDIENCE, apiAudience: API_AUDIENCE, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET };
}

async function setup(t, { respond, answer, withIssuer = true } = {}) {
  const issuer = await startIssuer(answer);
  const api = await startApi(respond ?? (() => ({ body: { emailStatus: "valid" }, headers: headers(1, "req-1") })));
  const lines = [];
  const errors = [];
  const app = createHttpApp({
    baseUrl: BASE_URL,
    jwtSecret: SECRET,
    ...(withIssuer && { issuer: issuerSettings(issuer) }),
    apiBaseUrl: api.url,
    write: (line) => lines.push(line),
    onError: (error) => errors.push(error),
    timeoutMs: 2_000,
    retryDelaysMs: [0, 0],
  });
  const server = createServer(toNodeHandler(app));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await app.close();
    await api.close();
    await issuer.close();
  });
  return { api, issuer, lines, errors, url: `http://127.0.0.1:${server.address().port}` };
}

function signEs256(issuer, claims = {}, { header = {}, key = signingKeys.privateKey } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: issuer.url,
    aud: MCP_AUDIENCE,
    sub: "user-one",
    client_id: "shared-client",
    grant_id: "grant-one",
    scope: "api",
    exp: now + 600,
    iat: now,
    jti: `jti-${Math.random()}`,
    ...claims,
  };
  for (const name of Object.keys(payload)) if (payload[name] === undefined) delete payload[name];
  const protectedHeader = { alg: "ES256", kid: "issuer-key", typ: "at+jwt", ...header };
  for (const name of Object.keys(protectedHeader)) if (protectedHeader[name] === undefined) delete protectedHeader[name];
  return new SignJWT(payload).setProtectedHeader(protectedHeader).sign(key);
}

function signHs256(claims = {}) {
  return new SignJWT({ api_key: API_KEY, scope: "api", ...claims })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("client-1")
    .setIssuer(BASE_URL)
    .setAudience(BASE_URL)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(SECRET));
}

function unsigned(issuer, alg) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: issuer.url, aud: MCP_AUDIENCE, sub: "user-one", client_id: "c", grant_id: "g", scope: "api", exp: now + 600, iat: now, jti: "j" };
  return `${encode({ alg, kid: "issuer-key", typ: "at+jwt" })}.${encode(claims)}.`;
}

function post(url, body, token) {
  return fetch(`${url}/v3/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
      ...(token && { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
}

async function callTool(url, token) {
  const response = await post(url, VALIDATE, token);
  assert.equal(response.status, 200);
  const data = (await response.text()).split("\n").filter((line) => line.startsWith("data: "));
  return JSON.parse(data.at(-1).slice("data: ".length)).result;
}

function challenge(description) {
  return `Bearer error="invalid_token", error_description="${description}", scope="api", resource_metadata="${METADATA_URL}"`;
}

// A. Today's tokens keep working beside the new ones.

test("A: an HS256 token works unchanged when the issuer is configured, and nothing is exchanged", async (t) => {
  const { api, issuer, url } = await setup(t);

  const result = await callTool(url, await signHs256());

  assert.deepEqual(result.structuredContent, { data: { emailStatus: "valid" }, creditCost: 1, requestId: "req-1" });
  assert.equal(api.requests[0].headers.authorization, `Bearer ${API_KEY}`);
  assert.equal(issuer.exchanges.length, 0);
  assert.equal(issuer.counts.jwks, 0);
});

// B. Every malformed ES256 token is refused before the API is called.

test("B: an ES256 token with a wrong issuer, audience, type, key, claim or algorithm gets 401 with a challenge", async (t) => {
  const { api, issuer, url } = await setup(t);
  const past = Math.floor(Date.now() / 1000) - 60;
  const invalid = "The access token is invalid or has expired";
  const cases = [
    ["wrong issuer", await signEs256(issuer, { iss: "https://auth.example.com" }), invalid],
    ["wrong audience", await signEs256(issuer, { aud: BASE_URL }), invalid],
    ["expired", await signEs256(issuer, { exp: past }), invalid],
    ["unknown signing key", await signEs256(issuer, {}, { key: strangerKeys.privateKey }), invalid],
    ["no typ at+jwt", await signEs256(issuer, {}, { header: { typ: undefined } }), invalid],
    ["no kid", await signEs256(issuer, {}, { header: { kid: undefined } }), invalid],
    ...["sub", "client_id", "grant_id", "scope", "exp", "iat", "jti"].map((name) => [
      `missing ${name}`,
      signEs256(issuer, { [name]: undefined }),
      invalid,
    ]),
    ["empty grant_id", await signEs256(issuer, { grant_id: "" }), "The access token has no usable grant_id claim"],
    ["numeric client_id", await signEs256(issuer, { client_id: 7 }), "The access token has no usable client_id claim"],
    ["alg none", unsigned(issuer, "none"), "The access token is signed with an unsupported algorithm"],
    ["alg RS256", unsigned(issuer, "RS256"), "The access token is signed with an unsupported algorithm"],
  ];

  for (const [name, token, description] of cases) {
    const response = await post(url, VALIDATE, await token);
    assert.equal(response.status, 401, name);
    assert.equal(response.headers.get("www-authenticate"), challenge(description), name);
  }
  assert.equal(api.requests.length, 0);
  assert.equal(issuer.exchanges.length, 0);
});

test("B: an unreachable JWKS is a server error, not an invalid token", async (t) => {
  const { api, issuer, url } = await setup(t);
  issuer.state.jwksStatus = 503;

  const response = await post(url, VALIDATE, await signEs256(issuer));

  assert.equal(response.status, 500);
  assert.equal(response.headers.get("www-authenticate"), null);
  assert.equal(api.requests.length, 0);
});

test("B: a JWKS answer that is not 200 or not a key set is a server error, not an invalid token", async (t) => {
  const answers = [
    [404, undefined],
    [429, undefined],
    [302, undefined],
    [200, "<html>maintenance</html>"],
    [200, { keys: "none" }],
    [200, { keys: [null] }],
  ];

  for (const [status, body] of answers) {
    const { api, issuer, url } = await setup(t);
    issuer.state.jwksStatus = status;
    issuer.state.jwksBody = body;

    const response = await post(url, VALIDATE, await signEs256(issuer));

    assert.equal(response.status, 500, `${status} ${JSON.stringify(body)}`);
    assert.equal(response.headers.get("www-authenticate"), null);
    assert.equal(api.requests.length, 0);
  }
});

// C. A valid ES256 token: the REST API sees only the exchanged token.

test("C: a valid ES256 token is exchanged and the REST call carries the exchanged token, never an API key", async (t) => {
  const { api, issuer, lines, url } = await setup(t);
  const token = await signEs256(issuer);

  const result = await callTool(url, token);

  assert.deepEqual(result.structuredContent, { data: { emailStatus: "valid" }, creditCost: 1, requestId: "req-1" });
  assert.equal(api.requests.length, 1);
  assert.equal(api.requests[0].headers.authorization, "Bearer rest-token-1");
  assert.equal(issuer.counts.jwks, 1);
  assert.equal(issuer.exchanges.length, 1);
  const [exchange] = issuer.exchanges;
  const basic = Buffer.from(`${encodeURIComponent(CLIENT_ID).replace(/%20/g, "+")}:${encodeURIComponent(CLIENT_SECRET).replace(/%20/g, "+")}`);
  assert.equal(exchange.authorization, `Basic ${basic.toString("base64")}`);
  assert.equal(exchange.contentType, "application/x-www-form-urlencoded");
  assert.deepEqual(Object.fromEntries(exchange.form), {
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: token,
    subject_token_type: TOKEN_TYPE,
    requested_token_type: TOKEN_TYPE,
    audience: API_AUDIENCE,
  });
  for (const line of lines) assert.equal(line.includes(token) || line.includes("rest-token-1"), false);
});

test("C: a failed exchange fails the call and never falls back to an API key", async (t) => {
  const { api, issuer, lines, url } = await setup(t, { answer: () => ({ status: 400, body: { error: "invalid_grant" } }) });

  const result = await callTool(url, await signEs256(issuer));

  assert.equal(result.isError, true);
  assert.equal(
    result.content[0].text,
    "The sign-in service refused the token exchange (HTTP 400, invalid_grant). Reconnect Enrich Layer in your MCP client and sign in again.",
  );
  assert.equal(api.requests.length, 0);
  assert.equal(issuer.exchanges.length, 1);
  assert.equal(JSON.parse(lines[0]).status, "exchange");
});

test("C: an exchange refused for our own client or settings says to try again later and is reported, not a sign-in problem", async (t) => {
  const refusals = [
    [{ status: 401, body: { error: "invalid_client" } }, "HTTP 401, invalid_client"],
    [{ status: 400, body: { error: "invalid_target" } }, "HTTP 400, invalid_target"],
    [{ status: 400, body: { error: "unauthorized_client" } }, "HTTP 400, unauthorized_client"],
    [{ status: 401, body: { error: "invalid_grant" } }, "HTTP 401, invalid_grant"],
    [{ status: 400, body: { error: "Bad Request: see https://example.com/help" } }, "HTTP 400"],
    [{ status: 400, body: "<html>bad request</html>" }, "HTTP 400"],
  ];
  const { api, issuer, errors, url } = await setup(t, { answer: (_, n) => refusals[n - 1][0] });

  for (const [, status] of refusals) {
    const result = await callTool(url, await signEs256(issuer));
    assert.equal(result.content[0].text, `The sign-in service refused the token exchange (${status}). Try again in a few minutes.`);
  }

  assert.deepEqual(errors.map(isReportable), [true, true, true, true, true, true]);
  assert.equal(api.requests.length, 0);
});

test("C: a grant the sign-in service refuses stays out of Sentry", async (t) => {
  const { errors, issuer, url } = await setup(t, { answer: () => ({ status: 400, body: { error: "invalid_grant" } }) });

  await callTool(url, await signEs256(issuer));

  assert.deepEqual(errors.map(isReportable), [false]);
});

test("C: an exchange answer that is not a bearer access token fails the call", async (t) => {
  const answers = [
    { access_token: "t", token_type: "Bearer", expires_in: 600 },
    { access_token: "t", issued_token_type: TOKEN_TYPE, token_type: "DPoP", expires_in: 600 },
    { access_token: "t", issued_token_type: TOKEN_TYPE, token_type: "Bearer", expires_in: 0 },
    { issued_token_type: TOKEN_TYPE, token_type: "Bearer", expires_in: 600 },
  ];
  const { api, issuer, url } = await setup(t, { answer: (_, n) => ({ status: 200, body: answers[n - 1] }) });

  for (let i = 0; i < answers.length; i++) {
    const result = await callTool(url, await signEs256(issuer));
    assert.equal(result.isError, true, JSON.stringify(answers[i]));
  }
  assert.equal(api.requests.length, 0);
});

test("C: a redirect from the token endpoint is not followed", async (t) => {
  const { api, issuer, url } = await setup(t, { answer: () => ({ status: 302, headers: { location: "/redirected-token" } }) });

  const result = await callTool(url, await signEs256(issuer));

  assert.equal(result.isError, true);
  assert.equal(issuer.counts.redirected, 0);
  assert.equal(api.requests.length, 0);
});

// D. The exchanged-token cache never crosses grants or users.

test("D: one token is exchanged once; two grants of one user and two users of one client each get their own", async (t) => {
  const { api, issuer, url } = await setup(t);
  const first = await signEs256(issuer, { sub: "user-one", grant_id: "grant-one" });
  const otherGrant = await signEs256(issuer, { sub: "user-one", grant_id: "grant-two" });
  // Same client and, adversarially, the same grant id: only the token itself tells them apart.
  const otherUser = await signEs256(issuer, { sub: "user-two", grant_id: "grant-one" });

  for (const token of [first, first, otherGrant, otherUser, otherGrant]) await callTool(url, token);

  assert.deepEqual(
    api.requests.map((request) => request.headers.authorization),
    ["Bearer rest-token-1", "Bearer rest-token-1", "Bearer rest-token-2", "Bearer rest-token-3", "Bearer rest-token-2"],
  );
  assert.deepEqual(
    issuer.exchanges.map((exchange) => exchange.form.get("subject_token")),
    [first, otherGrant, otherUser],
  );
});

test("D: an exchanged token is not reused within 30 s of its expiry", async (t) => {
  const { api, issuer, url } = await setup(t, {
    answer: (_, n) => ({ status: 200, body: { access_token: `short-${n}`, issued_token_type: TOKEN_TYPE, token_type: "Bearer", expires_in: 30 } }),
  });
  const token = await signEs256(issuer);

  await callTool(url, token);
  await callTool(url, token);

  assert.equal(issuer.exchanges.length, 2);
  assert.deepEqual(api.requests.map((request) => request.headers.authorization), ["Bearer short-1", "Bearer short-2"]);
});

test("D: a retry after a slow failed attempt asks for the token again instead of sending an expired one", async (t) => {
  const { api, issuer, url } = await setup(t, {
    // expires_in 31 leaves 1 s of reuse; the first attempt outlasts it.
    answer: (_, n) => ({ status: 200, body: { access_token: `short-${n}`, issued_token_type: TOKEN_TYPE, token_type: "Bearer", expires_in: 31 } }),
    respond: (_, n) => (n === 1 ? { status: 503, body: {}, delayMs: 1_300 } : { body: { emailStatus: "valid" }, headers: headers(1, "req-r") }),
  });

  const result = await callTool(url, await signEs256(issuer));

  assert.equal(result.isError, undefined);
  assert.deepEqual(api.requests.map((request) => request.headers.authorization), ["Bearer short-1", "Bearer short-2"]);
  assert.equal(issuer.exchanges.length, 2);
});

test("D: an API 401 drops the cached exchanged token, so a revoked grant is refused on the next call", async (t) => {
  const { api, issuer, url } = await setup(t, {
    answer: (_, n) => (n === 2 ? { status: 400, body: { error: "invalid_grant" } } : undefined),
    respond: () => ({ status: 401, body: { description: "Token revoked" }, headers: headers(0, "req-x") }),
  });
  const token = await signEs256(issuer);

  const first = await callTool(url, token);
  const second = await callTool(url, token);

  assert.match(first.content[0].text, /^The sign-in was rejected: Token revoked\./);
  assert.equal(
    second.content[0].text,
    "The sign-in service refused the token exchange (HTTP 400, invalid_grant). Reconnect Enrich Layer in your MCP client and sign in again.",
  );
  assert.equal(issuer.exchanges.length, 2);
  assert.equal(api.requests.length, 1);
});

test("D: a failed exchange is not cached; the next call exchanges again", async (t) => {
  const { api, issuer, url } = await setup(t, { answer: (_, n) => (n === 1 ? { status: 500, body: {} } : undefined) });
  const token = await signEs256(issuer);

  const first = await callTool(url, token);
  const second = await callTool(url, token);

  assert.equal(first.isError, true);
  assert.equal(second.isError, undefined);
  assert.equal(issuer.exchanges.length, 2);
  assert.deepEqual(api.requests.map((request) => request.headers.authorization), ["Bearer rest-token-2"]);
});

test("D: an exchanged token without expires_in serves its own call and is not reused", async (t) => {
  const { api, issuer, url } = await setup(t, {
    answer: (_, n) => ({ status: 200, body: { access_token: `no-expiry-${n}`, issued_token_type: TOKEN_TYPE, token_type: "Bearer" } }),
  });
  const token = await signEs256(issuer);

  const first = await callTool(url, token);
  const second = await callTool(url, token);

  assert.deepEqual([first.isError, second.isError], [undefined, undefined]);
  assert.equal(issuer.exchanges.length, 2);
  assert.deepEqual(api.requests.map((request) => request.headers.authorization), ["Bearer no-expiry-1", "Bearer no-expiry-2"]);
});

test("D: a call ends at its own deadline while the exchange still runs, and says the API was not called", async (t) => {
  const { api, errors, issuer, url } = await setup(t, { answer: () => sleep(3_000) });
  const started = Date.now();

  const result = await callTool(url, await signEs256(issuer));
  const elapsed = Date.now() - started;

  assert.equal(result.content[0].text, "The sign-in service did not answer within 2 s. Try again in a few minutes.");
  assert.equal(elapsed < 2_800, true, `${elapsed} ms`);
  assert.equal(api.requests.length, 0);
  assert.deepEqual(errors.map(isReportable), [true]);
});

test("D: a cancelled call stops waiting at once, and the exchange it shares still serves the other call", async (t) => {
  const issuer = await startIssuer(() => sleep(1_000));
  const api = await startApi(() => ({ body: { emailStatus: "valid" }, headers: headers(1, "req-c") }));
  t.after(async () => {
    await api.close();
    await issuer.close();
  });
  const exchanger = tokenExchanger(issuerSettings(issuer));
  const authInfo = { token: await signEs256(issuer), clientId: "shared-client", scopes: ["api"], expiresAt: Date.now() / 1000 + 600, extra: { grantId: "grant-one" } };
  const callV3 = createV3Client({ baseUrl: api.url, userAgent: "test", credentials: tokenCredentials(authInfo, exchanger), timeoutMs: 5_000, retryDelaysMs: [0, 0] });
  const controller = new AbortController();
  const request = { path: "/v3/email/validate", params: { email: "jane@example.com" } };

  const cancelled = callV3({ ...request, signal: controller.signal });
  const other = callV3(request);
  const started = Date.now();
  setTimeout(() => controller.abort(), 100);

  await assert.rejects(cancelled, { name: "AbortError" });
  const cancelledAfter = Date.now() - started;
  const result = await other;

  assert.equal(cancelledAfter < 800, true, `${cancelledAfter} ms`);
  assert.deepEqual(result, { data: { emailStatus: "valid" }, creditCost: 1, requestId: "req-c" });
  assert.equal(issuer.exchanges.length, 1);
  assert.deepEqual(api.requests.map((r) => r.headers.authorization), ["Bearer rest-token-1"]);
});

test("C: API refusals advise a signed-in user to sign in again, and keep the API key advice for HS256 users", async (t) => {
  const { issuer, url } = await setup(t, {
    respond: (request) => ({
      status: request.query.email === "a@example.com" ? 401 : 403,
      body: { description: request.query.email === "a@example.com" ? "Invalid credentials" : "Account has been suspended" },
      headers: headers(0, "req-w"),
    }),
  });
  const call = async (token, email) => {
    const response = await post(url, { ...VALIDATE, params: { ...VALIDATE.params, arguments: { email } } }, token);
    const data = (await response.text()).split("\n").filter((line) => line.startsWith("data: "));
    return JSON.parse(data.at(-1).slice("data: ".length)).result.content[0].text;
  };
  const es256 = await signEs256(issuer);
  const hs256 = await signHs256();

  assert.equal(
    await call(es256, "a@example.com"),
    "The sign-in was rejected: Invalid credentials. Reconnect Enrich Layer in your MCP client and sign in again. (credits charged: 0, request id: req-w)",
  );
  assert.equal(
    await call(es256, "b@example.com"),
    "Access denied for /v3/email/validate: Account has been suspended. This account cannot use this endpoint; reconnect and sign in with an account that can, or contact support@enrichlayer.com. (credits charged: 0, request id: req-w)",
  );
  assert.equal(
    await call(hs256, "a@example.com"),
    "The API key was rejected: Invalid credentials. Reconnect Enrich Layer in your MCP client and sign in again with a valid API key from https://enrichlayer.com/dashboard. (credits charged: 0, request id: req-w)",
  );
  assert.equal(
    await call(hs256, "b@example.com"),
    "Access denied for /v3/email/validate: Account has been suspended. This key or its account cannot use this endpoint; reconnect and sign in with a key that can, or contact support@enrichlayer.com. (credits charged: 0, request id: req-w)",
  );
});

test("C: only a grant the sign-in service refused stays out of Sentry; every other exchange failure is reported", () => {
  assert.equal(isReportable(new TokenExchangeError("refused", 400, "invalid_grant")), false);
  assert.equal(isReportable(new TokenExchangeError("refused", 400)), true);
  assert.equal(isReportable(new TokenExchangeError("refused", 401)), true);
  assert.equal(isReportable(new TokenExchangeError("down", 503)), true);
  assert.equal(isReportable(new TokenExchangeError("unreachable")), true);
});

// E. No settings: today's behaviour; a partial set: no start.

test("E: without the issuer settings an ES256 token is refused exactly as today and no key is fetched", async (t) => {
  const { api, issuer, url } = await setup(t, { withIssuer: false });

  for (const token of [await signEs256(issuer), unsigned(issuer, "none")]) {
    const response = await post(url, VALIDATE, token);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("www-authenticate"), challenge("The access token is invalid or has expired"));
  }
  assert.equal(issuer.counts.jwks, 0);
  assert.equal(api.requests.length, 0);
});

test("E: with the issuer settings the resource metadata names the sign-in service", async (t) => {
  const { issuer, url } = await setup(t);

  const metadata = await (await fetch(`${url}/.well-known/oauth-protected-resource/v3/mcp`)).json();

  assert.deepEqual(metadata.authorization_servers, [issuer.url]);
  assert.equal(metadata.resource, BASE_URL);
});

const FULL = {
  MCP_BASE_URL: BASE_URL,
  AUTH_JWT_SECRET: SECRET,
  AUTH_ISSUER: "https://auth.enrichlayer.com",
  AUTH_MCP_AUDIENCE: MCP_AUDIENCE,
  AUTH_API_AUDIENCE: API_AUDIENCE,
  AUTH_MCP_CLIENT_ID: CLIENT_ID,
  AUTH_MCP_CLIENT_SECRET: CLIENT_SECRET,
};
const SETTINGS = ["AUTH_ISSUER", "AUTH_MCP_AUDIENCE", "AUTH_API_AUDIENCE", "AUTH_MCP_CLIENT_ID", "AUTH_MCP_CLIENT_SECRET"];

test("E: an AUTH_ISSUER that ends in a slash refuses to start, since it must equal the iss of the tokens", () => {
  assert.throws(() => httpConfig({ ...FULL, AUTH_ISSUER: "https://auth.enrichlayer.com/" }), {
    message: "AUTH_ISSUER must not end with a slash: https://auth.enrichlayer.com/; it must equal the iss of the access tokens.",
  });
});

test("E: all five issuer settings are read together, and any partial set is refused", () => {
  assert.deepEqual(httpConfig(FULL).issuer, {
    issuer: "https://auth.enrichlayer.com",
    mcpAudience: MCP_AUDIENCE,
    apiAudience: API_AUDIENCE,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
  });
  assert.equal("issuer" in httpConfig({ MCP_BASE_URL: BASE_URL, AUTH_JWT_SECRET: SECRET }), false);
  for (const name of SETTINGS) {
    for (const value of [undefined, " "]) {
      assert.throws(() => httpConfig({ ...FULL, [name]: value }), {
        message: `Set all of ${SETTINGS.join(", ")} or none of them; missing: ${name}.`,
      });
    }
  }
  assert.throws(() => httpConfig({ MCP_BASE_URL: BASE_URL, AUTH_JWT_SECRET: SECRET, AUTH_ISSUER: "https://auth.enrichlayer.com" }), {
    message: `Set all of ${SETTINGS.join(", ")} or none of them; missing: ${SETTINGS.slice(1).join(", ")}.`,
  });
  assert.throws(() => httpConfig({ ...FULL, AUTH_ISSUER: "http://auth.enrichlayer.com" }), {
    message: "AUTH_ISSUER must be an https URL: http://auth.enrichlayer.com",
  });
});

test("E: the HTTP server refuses to start on a partial issuer configuration and does not print the secret", () => {
  const { AUTH_MCP_CLIENT_ID, ...partial } = FULL;
  const run = spawnSync(process.execPath, ["build/http.js"], {
    env: { PATH: process.env.PATH, ...partial, PORT: "0" },
    encoding: "utf8",
    timeout: 10_000,
  });

  assert.equal(run.status, 1);
  assert.match(run.stderr, /missing: AUTH_MCP_CLIENT_ID\./);
  assert.equal(run.stdout.includes("listening"), false);
  assert.equal(`${run.stdout}${run.stderr}`.includes(CLIENT_SECRET), false);
});
