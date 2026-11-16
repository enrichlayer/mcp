import { createHash } from "node:crypto";
import { issuerEndpoint, type IssuerConfig } from "./issuer.js";

const TOKEN_EXCHANGE = "urn:ietf:params:oauth:grant-type:token-exchange";
const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";
const REUSE_MARGIN_MS = 30_000;
const MAX_ENTRIES = 1_000;
const EXCHANGE_TIMEOUT_MS = 30_000;

/** The sign-in service did not give this call a token for the REST API. Never answered with an API key instead. */
export class TokenExchangeError extends Error {
  constructor(
    message: string,
    /** The HTTP status of the refusal; undefined when the service could not be reached or answered nonsense. */
    readonly status?: number,
  ) {
    super(message);
    this.name = "TokenExchangeError";
  }
}

export interface TokenExchanger {
  /** The REST API access token for one incoming ES256 access token of one grant. */
  accessToken(subjectToken: string, grantId: string): Promise<string>;
  /** Drops the cached exchange for this token and grant if it is still the given REST token, e.g. after the API refused it. */
  forget(subjectToken: string, grantId: string, accessToken: string): void;
}

interface CacheEntry {
  promise: Promise<string>;
  // Undefined while the exchange is in flight; such entries are never evicted.
  expiresAt?: number;
  accessToken?: string;
}

export interface ExchangeOptions {
  timeoutMs?: number;
}

/**
 * RFC 8693 token exchange against `<issuer>/token`, cached until 30 s before
 * the exchanged token expires. The cache key is the grant id plus a hash of
 * the incoming token, so two grants, or two users of one client, never share
 * an exchanged token, and the incoming token itself is never kept as a key.
 */
export function tokenExchanger(config: IssuerConfig, { timeoutMs = EXCHANGE_TIMEOUT_MS }: ExchangeOptions = {}): TokenExchanger {
  const cache = new Map<string, CacheEntry>();
  const tokenUrl = issuerEndpoint(config, "/token");
  // OAuth client credentials are form-encoded individually before base64 (RFC 6749 §2.3.1).
  const formEncode = (value: string) => new URLSearchParams({ v: value }).toString().slice(2);
  const basic = Buffer.from(`${formEncode(config.clientId)}:${formEncode(config.clientSecret)}`).toString("base64");

  async function exchange(subjectToken: string): Promise<{ accessToken: string; expiresIn: number }> {
    let response: Response;
    try {
      response = await fetch(tokenUrl, {
        method: "POST",
        headers: {
          Authorization: `Basic ${basic}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          grant_type: TOKEN_EXCHANGE,
          subject_token: subjectToken,
          subject_token_type: ACCESS_TOKEN_TYPE,
          requested_token_type: ACCESS_TOKEN_TYPE,
          audience: config.apiAudience,
        }),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
      });
    } catch {
      throw new TokenExchangeError("The sign-in service could not be reached");
    }
    if (!response.ok) {
      // The body is not read into the error: an authorization server's answer may echo credentials.
      await response.body?.cancel().catch(() => {});
      throw new TokenExchangeError(`The sign-in service refused the token exchange (HTTP ${response.status})`, response.status);
    }
    let result: Record<string, unknown> | null;
    try {
      result = (await response.json()) as Record<string, unknown> | null;
    } catch {
      result = null;
    }
    if (
      !result ||
      typeof result.access_token !== "string" ||
      !/^[\x21-\x7e]+$/.test(result.access_token) ||
      typeof result.token_type !== "string" ||
      result.token_type.toLowerCase() !== "bearer" ||
      result.issued_token_type !== ACCESS_TOKEN_TYPE ||
      typeof result.expires_in !== "number" ||
      !Number.isFinite(result.expires_in) ||
      result.expires_in <= 0
    ) {
      throw new TokenExchangeError("The sign-in service answered the token exchange with an invalid response");
    }
    return { accessToken: result.access_token, expiresIn: result.expires_in };
  }

  const cacheKey = (subjectToken: string, grantId: string) =>
    JSON.stringify([grantId, createHash("sha256").update(subjectToken).digest("hex")]);

  return {
    forget(subjectToken, grantId, accessToken) {
      const key = cacheKey(subjectToken, grantId);
      if (cache.get(key)?.accessToken === accessToken) cache.delete(key);
    },
    accessToken(subjectToken, grantId) {
      const key = cacheKey(subjectToken, grantId);
      const now = Date.now();
      for (const [cachedKey, entry] of cache) {
        if (entry.expiresAt !== undefined && entry.expiresAt <= now) cache.delete(cachedKey);
      }
      const existing = cache.get(key);
      if (existing) return existing.promise;
      if (cache.size >= MAX_ENTRIES) {
        const oldest = [...cache].find(([, entry]) => entry.expiresAt !== undefined);
        if (!oldest) return Promise.reject(new TokenExchangeError("Too many token exchanges are in flight"));
        cache.delete(oldest[0]);
      }
      const entry: CacheEntry = {
        promise: exchange(subjectToken).then(
          ({ accessToken, expiresIn }) => {
            // Counted from before the request, so a slow exchange cannot extend reuse.
            entry.expiresAt = now + expiresIn * 1000 - REUSE_MARGIN_MS;
            entry.accessToken = accessToken;
            if (entry.expiresAt <= Date.now()) cache.delete(key);
            return accessToken;
          },
          (error: unknown) => {
            cache.delete(key);
            throw error;
          },
        ),
      };
      cache.set(key, entry);
      return entry.promise;
    },
  };
}
