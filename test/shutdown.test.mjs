import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { SignJWT } from "jose";
import { createHttpApp } from "../build/http-app.js";
import { startHttpServer } from "../build/http-server.js";
import { headers, startApi } from "./helpers.mjs";

const SECRET = "test-secret-for-the-hosted-connector";
const BASE_URL = "https://connector.example.com";
const MODERN = "2026-07-28";
const LEGACY = "2025-06-18";
const HTTP_ENTRY = fileURLToPath(new URL("../build/http.js", import.meta.url));
const RESULT = { data: { emailStatus: "valid" }, creditCost: 1, requestId: "req-1" };

function signToken() {
  return new SignJWT({ api_key: "test-key-from-token", scope: "api" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("client-1")
    .setIssuer(BASE_URL)
    .setAudience(BASE_URL)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(SECRET));
}

function callTool(url, token, era) {
  const modern = era === MODERN;
  const meta = {
    "io.modelcontextprotocol/protocolVersion": MODERN,
    "io.modelcontextprotocol/clientInfo": { name: "modern-client", version: "1.0.0" },
    "io.modelcontextprotocol/clientCapabilities": {},
  };
  return fetch(`${url}/v3/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": era,
      authorization: `Bearer ${token}`,
      ...(modern && { "mcp-method": "tools/call", "mcp-name": "validate_email" }),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "validate_email", arguments: { email: "jane@example.com" }, ...(modern && { _meta: meta }) },
    }),
  });
}

async function resultOf(pending) {
  try {
    const data = (await (await pending).text()).split("\n").filter((line) => line.startsWith("data: ")).at(-1);
    return data ? (JSON.parse(data.slice("data: ".length)).result?.structuredContent ?? null) : null;
  } catch {
    return null;
  }
}

async function waitFor(condition, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function freePort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

test("SIGTERM lets calls in flight finish on both protocols, refuses new connections and exits", async (t) => {
  const api = await startApi(() => ({ body: RESULT.data, headers: headers(1, "req-1"), delayMs: 300 }));
  t.after(() => api.close());
  const port = await freePort();
  const child = spawn(process.execPath, [HTTP_ENTRY], {
    env: { PATH: process.env.PATH, PORT: String(port), MCP_BASE_URL: BASE_URL, AUTH_JWT_SECRET: SECRET, ENRICHLAYER_API_BASE_URL: api.url },
    stdio: ["ignore", "pipe", "inherit"],
  });
  t.after(() => child.kill("SIGKILL"));
  let stdout = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  await waitFor(() => stdout.includes('"event":"listening"'));
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  const url = `http://127.0.0.1:${port}`;
  const token = await signToken();

  const calls = [callTool(url, token, MODERN), callTool(url, token, LEGACY)];
  await waitFor(() => api.requests.length === 2);
  child.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 100));

  await assert.rejects(fetch(`${url}/v3/health`));
  assert.deepEqual(await Promise.all(calls.map(resultOf)), [RESULT, RESULT]);
  assert.deepEqual(await exited, { code: 0, signal: null });
});

test("a call still running when the grace period ends is cut off", async (t) => {
  const api = await startApi(() => ({ body: RESULT.data, headers: headers(1, "req-1"), delayMs: 2_000 }));
  t.after(() => api.close());
  const app = createHttpApp({ baseUrl: BASE_URL, jwtSecret: SECRET, apiBaseUrl: api.url, write: () => {}, retryDelaysMs: [0, 0] });
  const { server, shutdown } = await startHttpServer(app, { port: 0, host: "127.0.0.1", graceMs: 300 });
  const token = await signToken();

  const call = callTool(`http://127.0.0.1:${server.address().port}`, token, MODERN);
  await waitFor(() => api.requests.length === 1);
  const started = Date.now();
  await shutdown();
  const elapsed = Date.now() - started;

  assert.ok(elapsed >= 250 && elapsed < 1_500, `shutdown took ${elapsed} ms`);
  assert.equal(await resultOf(call), null);
});
