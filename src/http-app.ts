import {
  createMcpHandler,
  hostHeaderValidationResponse,
  requireBearerAuth,
  type McpServerFactory,
} from "@modelcontextprotocol/server";
import { tokenCredentials, tokenVerifier } from "./auth/token.js";
import { logCalls, type LogWriter } from "./call-log.js";
import { createV3Client } from "./client.js";
import { REQUEST_TIMEOUT_MS, RETRY_DELAYS_MS, SSE_KEEP_ALIVE_MS, USER_AGENT, VERSION } from "./config.js";
import { createServer } from "./server.js";

export const MCP_PATH = "/v3/mcp";
export const HEALTH_PATH = "/v3/health";
export const RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource/v3/mcp";
const LOCAL_HOSTS = ["localhost", "127.0.0.1"];
const SCOPE = "api";

export interface HttpAppOptions {
  baseUrl: string;
  jwtSecret: string;
  apiBaseUrl: string;
  write: LogWriter;
  onError?: (error: unknown) => void;
  keepAliveMs?: number;
  timeoutMs?: number;
  retryDelaysMs?: number[];
}

export interface HttpApp {
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
}

function getOnly(request: Request, respond: () => Response): Response {
  if (request.method === "GET") return respond();
  return Response.json({ error: "method_not_allowed" }, { status: 405, headers: { Allow: "GET" } });
}

export function createHttpApp(options: HttpAppOptions): HttpApp {
  const allowedHosts = [new URL(options.baseUrl).hostname, ...LOCAL_HOSTS];
  const resourceMetadata = {
    resource: options.baseUrl,
    authorization_servers: [options.baseUrl],
    scopes_supported: [SCOPE],
    resource_name: "Enrich Layer v3 MCP Server",
    resource_documentation: "https://github.com/enrichlayer/mcp#readme",
  };
  const authenticate = requireBearerAuth({
    verifier: tokenVerifier({ issuer: options.baseUrl, secret: options.jwtSecret }),
    requiredScopes: [SCOPE],
    resourceMetadataUrl: `${options.baseUrl}${RESOURCE_METADATA_PATH}`,
  });

  const factory: McpServerFactory = ({ authInfo, requestInfo }) => {
    const callV3 = createV3Client({
      baseUrl: options.apiBaseUrl,
      userAgent: USER_AGENT,
      credentials: tokenCredentials(authInfo),
      timeoutMs: options.timeoutMs ?? REQUEST_TIMEOUT_MS,
      retryDelaysMs: options.retryDelaysMs ?? RETRY_DELAYS_MS,
    });
    const logged = logCalls(callV3, options.write, options.onError);
    const httpUserAgent = requestInfo?.headers.get("user-agent") ?? undefined;
    return createServer((request) => logged({ ...request, clientName: request.clientName ?? httpUserAgent }), { hosted: true });
  };

  const mcp = createMcpHandler(factory, {
    legacy: "stateless",
    responseMode: "sse",
    keepAliveMs: options.keepAliveMs ?? SSE_KEEP_ALIVE_MS,
    onerror: options.onError,
  });

  return {
    async fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname === MCP_PATH) {
        const wrongHost = hostHeaderValidationResponse(request, allowedHosts);
        if (wrongHost) return wrongHost;
        const auth = await authenticate(request);
        if (auth instanceof Response) return auth;
        return mcp.fetch(request, { authInfo: auth });
      }
      if (pathname === HEALTH_PATH) return getOnly(request, () => Response.json({ status: "ok", version: VERSION }));
      if (pathname === RESOURCE_METADATA_PATH) return getOnly(request, () => Response.json(resourceMetadata));
      return Response.json({ error: "not_found" }, { status: 404 });
    },
    close: () => mcp.close(),
  };
}
