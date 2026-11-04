import { OAuthError, OAuthErrorCode, type AuthInfo, type OAuthTokenVerifier } from "@modelcontextprotocol/server";
import { jwtVerify, type JWTPayload } from "jose";
import type { Credentials } from "./api-key.js";

export interface TokenVerifierOptions {
  issuer: string;
  secret: string;
}

function invalidToken(description: string): OAuthError {
  return new OAuthError(OAuthErrorCode.InvalidToken, description);
}

export function tokenVerifier({ issuer, secret }: TokenVerifierOptions): OAuthTokenVerifier {
  const key = new TextEncoder().encode(secret);
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      let payload: JWTPayload;
      try {
        ({ payload } = await jwtVerify(token, key, { algorithms: ["HS256"], issuer, audience: issuer, requiredClaims: ["exp"] }));
      } catch {
        throw invalidToken("The access token is invalid or has expired");
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
    },
  };
}

export function tokenCredentials(authInfo: AuthInfo | undefined): Credentials {
  return {
    authorization() {
      const apiKey = authInfo?.extra?.apiKey;
      if (typeof apiKey !== "string") throw invalidToken("The access token does not carry a usable API key");
      return `Bearer ${apiKey}`;
    },
  };
}
