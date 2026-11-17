export const ISSUER_SETTINGS = [
  "AUTH_ISSUER",
  "AUTH_MCP_AUDIENCE",
  "AUTH_API_AUDIENCE",
  "AUTH_MCP_CLIENT_ID",
  "AUTH_MCP_CLIENT_SECRET",
] as const;

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

/** The sign-in service that issues ES256 access tokens, and this server's client registration with it. */
export interface IssuerConfig {
  /** The exact `iss` of its access tokens, also listed as the authorization server. */
  issuer: string;
  /** The exact `aud` its access tokens carry for this MCP server. */
  mcpAudience: string;
  /** The audience requested for the token the REST API accepts. */
  apiAudience: string;
  clientId: string;
  clientSecret: string;
}

/**
 * Reads the five AUTH_* issuer settings. None set: undefined, and the server
 * accepts only the HS256 tokens it accepts today. A partial set refuses to
 * start, so a half-finished rollout cannot quietly run without ES256 support.
 */
export function issuerConfig(env: NodeJS.ProcessEnv = process.env): IssuerConfig | undefined {
  const value = (name: (typeof ISSUER_SETTINGS)[number]) => env[name]?.trim() || undefined;
  const missing = ISSUER_SETTINGS.filter((name) => !value(name));
  if (missing.length === ISSUER_SETTINGS.length) return undefined;
  if (missing.length > 0) {
    throw new Error(`Set all of ${ISSUER_SETTINGS.join(", ")} or none of them; missing: ${missing.join(", ")}.`);
  }
  const issuer = value("AUTH_ISSUER")!;
  if (!URL.canParse(issuer)) throw new Error(`AUTH_ISSUER is not a URL: ${issuer}`);
  const url = new URL(issuer);
  if (url.protocol !== "https:" && !LOCAL_HOSTS.includes(url.hostname)) {
    throw new Error(`AUTH_ISSUER must be an https URL: ${issuer}`);
  }
  if (issuer.endsWith("/")) throw new Error(`AUTH_ISSUER must not end with a slash: ${issuer}; it must equal the iss of the access tokens.`);
  return {
    issuer,
    mcpAudience: value("AUTH_MCP_AUDIENCE")!,
    apiAudience: value("AUTH_API_AUDIENCE")!,
    clientId: value("AUTH_MCP_CLIENT_ID")!,
    clientSecret: value("AUTH_MCP_CLIENT_SECRET")!,
  };
}

/** An endpoint of the issuer, whether or not AUTH_ISSUER ends in a slash. */
export function issuerEndpoint(config: IssuerConfig, path: string): URL {
  return new URL(`${config.issuer.replace(/\/+$/, "")}${path}`);
}
