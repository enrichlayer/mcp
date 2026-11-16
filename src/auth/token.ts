import { OAuthError, OAuthErrorCode, type AuthInfo, type OAuthTokenVerifier } from "@modelcontextprotocol/server";
import { createRemoteJWKSet, customFetch, decodeProtectedHeader, errors, jwtVerify, type JWTPayload } from "jose";
import type { RequestCredentials } from "../client.js";
import type { TokenExchanger } from "./exchange.js";
import { issuerEndpoint, type IssuerConfig } from "./issuer.js";

export interface TokenVerifierOptions {
  issuer: string;
  secret: string;
  /** When set, ES256 access tokens of this sign-in service are accepted beside today's HS256 tokens. */
  es256?: IssuerConfig;
}

const ES256_CLAIMS = ["sub", "client_id", "grant_id", "scope", "exp", "iat", "jti"];
const ES256_STRING_CLAIMS = ["sub", "client_id", "grant_id", "scope", "jti"] as const;
const INVALID = "The access token is invalid or has expired";

function invalidToken(description: string): OAuthError {
  return new OAuthError(OAuthErrorCode.InvalidToken, description);
}

function issuerUnavailable(): OAuthError {
  return new OAuthError(OAuthErrorCode.ServerError, "The signing keys of the sign-in service are unavailable");
}

function hs256Verifier({ issuer, secret }: TokenVerifierOptions): (token: string) => Promise<AuthInfo> {
  const key = new TextEncoder().encode(secret);
  return async (token) => {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, key, { algorithms: ["HS256"], issuer, audience: issuer, requiredClaims: ["exp"] }));
    } catch {
      throw invalidToken(INVALID);
    }
    const apiKey = payload.api_key;
    if (typeof payload.sub !== "string" || typeof apiKey !== "string" || !/^[\x21-\x7e]+$/.test(apiKey)) {
      throw invalidToken("The access token does not carry a usable API key");
    }
    return {
      token,
      clientId: payload.sub,
      scopes: typeof payload.scope === "string" ? payload.scope.split(" ").filter(Boolean) : [],
      expiresAt: payload.exp,
      extra: { apiKey },
    };
  };
}

function isKeySet(text: string): boolean {
  try {
    const { keys } = JSON.parse(text) as { keys?: unknown };
    return Array.isArray(keys) && keys.every((key) => key !== null && typeof key === "object" && !Array.isArray(key));
  } catch {
    return false;
  }
}

function es256Verifier(config: IssuerConfig): (token: string) => Promise<AuthInfo> {
  const keys = createRemoteJWKSet(issuerEndpoint(config, "/.well-known/jwks.json"), {
    // An outage of the sign-in service is a server error, not an invalid token,
    // so clients keep their valid credentials instead of signing in again.
    [customFetch]: async (url, init) => {
      let response: Response;
      let text: string;
      try {
        response = await fetch(url, init);
        text = await response.text();
      } catch {
        throw issuerUnavailable();
      }
      if (response.status !== 200 || !isKeySet(text)) throw issuerUnavailable();
      return new Response(text, { status: 200 });
    },
  });
  return async (token) => {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, keys, {
        algorithms: ["ES256"],
        typ: "at+jwt",
        issuer: config.issuer,
        audience: config.mcpAudience,
        requiredClaims: ES256_CLAIMS,
      }));
    } catch (error) {
      if (error instanceof OAuthError) throw error;
      if (error instanceof errors.JWKSTimeout) throw issuerUnavailable();
      throw invalidToken(INVALID);
    }
    for (const name of ES256_STRING_CLAIMS) {
      if (typeof payload[name] !== "string" || !payload[name]) throw invalidToken(`The access token has no usable ${name} claim`);
    }
    return {
      token,
      clientId: payload.client_id as string,
      scopes: (payload.scope as string).split(" ").filter(Boolean),
      expiresAt: payload.exp,
      extra: { grantId: payload.grant_id as string },
    };
  };
}

/**
 * Verifies today's HS256 tokens and, when `es256` is set, the sign-in
 * service's ES256 tokens. The token header picks the path; any other
 * algorithm, `none` included, is refused before a key is looked up.
 */
export function tokenVerifier(options: TokenVerifierOptions): OAuthTokenVerifier {
  const hs256 = hs256Verifier(options);
  if (!options.es256) return { verifyAccessToken: hs256 };
  const es256 = es256Verifier(options.es256);
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      let header: ReturnType<typeof decodeProtectedHeader>;
      try {
        header = decodeProtectedHeader(token);
      } catch {
        throw invalidToken(INVALID);
      }
      const { alg, kid } = header;
      if (alg === "ES256") {
        // A key id is required so a key rotation can never make two issuer keys candidates.
        if (typeof kid !== "string" || !kid) throw invalidToken(INVALID);
        return es256(token);
      }
      if (alg === "HS256") return hs256(token);
      throw invalidToken("The access token is signed with an unsupported algorithm");
    },
  };
}

/** Whether the request was authenticated by an exchanged ES256 token, whose user has no API key of their own. */
export function isExchangedToken(authInfo: AuthInfo | undefined): boolean {
  return typeof authInfo?.extra?.grantId === "string";
}

/**
 * The Authorization header for REST calls made for one verified token: the
 * API key of an HS256 token, or the exchanged token of an ES256 one. An ES256
 * token never falls back to an API key; a failed exchange fails the call.
 */
export function tokenCredentials(authInfo: AuthInfo | undefined, exchanger?: TokenExchanger): RequestCredentials {
  return {
    rejected(authorization) {
      const grantId = authInfo?.extra?.grantId;
      if (!authInfo || !exchanger || typeof grantId !== "string" || !authorization.startsWith("Bearer ")) return;
      exchanger.forget(authInfo.token, grantId, authorization.slice("Bearer ".length));
    },
    authorization() {
      const grantId = authInfo?.extra?.grantId;
      if (authInfo && typeof grantId === "string") {
        if (!exchanger) throw invalidToken("ES256 access tokens are not configured");
        return exchanger.accessToken(authInfo.token, grantId).then((accessToken) => `Bearer ${accessToken}`);
      }
      const apiKey = authInfo?.extra?.apiKey;
      if (typeof apiKey !== "string") throw invalidToken("The access token does not carry a usable API key");
      return `Bearer ${apiKey}`;
    },
  };
}
