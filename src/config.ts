import { createRequire } from "node:module";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

export const VERSION = version;
export const USER_AGENT = `enrichlayer-mcp-v3/${version}`;
export const DEFAULT_API_BASE_URL = "https://api.enrichlayer.com";
export const REQUEST_TIMEOUT_MS = 305_000;
export const RETRY_DELAYS_MS = [1_000, 3_000];

export function apiBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.ENRICHLAYER_API_BASE_URL || DEFAULT_API_BASE_URL).replace(/\/+$/, "");
}

export const DEFAULT_HTTP_PORT = 3000;
export const SSE_KEEP_ALIVE_MS = 15_000;

export interface HttpConfig {
  port: number;
  baseUrl: string;
  jwtSecret: string;
  sentryDsn?: string;
  sentryEnvironment?: string;
}

export function httpConfig(env: NodeJS.ProcessEnv = process.env): HttpConfig {
  const baseUrl = env.MCP_BASE_URL?.trim().replace(/\/+$/, "");
  const jwtSecret = env.AUTH_JWT_SECRET;
  if (!baseUrl || !jwtSecret) {
    const missing = [!baseUrl && "MCP_BASE_URL", !jwtSecret && "AUTH_JWT_SECRET"].filter(Boolean);
    throw new Error(`Set ${missing.join(" and ")} to start the HTTP server.`);
  }
  if (!URL.canParse(baseUrl)) throw new Error(`MCP_BASE_URL is not a URL: ${baseUrl}`);
  return {
    port: Number(env.PORT) || DEFAULT_HTTP_PORT,
    baseUrl,
    jwtSecret,
    sentryDsn: env.SENTRY_DSN || undefined,
    sentryEnvironment: env.SENTRY_ENVIRONMENT || undefined,
  };
}
