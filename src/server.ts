import { McpServer } from "@modelcontextprotocol/server";
import { apiKeyCredentials } from "./auth/api-key.js";
import { createV3Client, type CallV3 } from "./client.js";
import { apiBaseUrl, REQUEST_TIMEOUT_MS, RETRY_DELAYS_MS, USER_AGENT, VERSION } from "./config.js";
import { registerTools } from "./tools/register.js";

export function defaultClient(env: NodeJS.ProcessEnv = process.env): CallV3 {
  return createV3Client({
    baseUrl: apiBaseUrl(env),
    userAgent: USER_AGENT,
    credentials: apiKeyCredentials(env),
    timeoutMs: REQUEST_TIMEOUT_MS,
    retryDelaysMs: RETRY_DELAYS_MS,
  });
}

export function createServer(callV3: CallV3 = defaultClient()): McpServer {
  const server = new McpServer({ name: "enrichlayer-v3", version: VERSION });
  registerTools(server, callV3);
  return server;
}
