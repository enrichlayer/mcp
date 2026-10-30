import { createServer as createHttpServer } from "node:http";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { apiKeyCredentials } from "../build/auth/api-key.js";
import { createV3Client } from "../build/client.js";
import { USER_AGENT } from "../build/config.js";
import { createServer } from "../build/server.js";

export async function startApi(respond) {
  const requests = [];
  const server = createHttpServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const request = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers };
    requests.push(request);
    const reply = await respond(request, requests.length);
    if (reply.delayMs) await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
    if (res.destroyed) return;
    res.writeHead(reply.status ?? 200, { "Content-Type": "application/json", ...reply.headers });
    res.end(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body ?? {}));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

export function testClient(baseUrl, overrides = {}) {
  return createV3Client({
    baseUrl,
    userAgent: USER_AGENT,
    credentials: apiKeyCredentials({ ENRICHLAYER_API_KEY: "test-key" }),
    timeoutMs: 2_000,
    retryDelaysMs: [0, 0],
    ...overrides,
  });
}

export async function connectMcp(callV3) {
  const server = createServer(callV3);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

export const headers = (creditCost, requestId) => ({ "X-EnrichLayer-Credit-Cost": String(creditCost), "X-Request-Id": requestId });
