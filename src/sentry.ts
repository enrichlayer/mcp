import * as Sentry from "@sentry/node";
import { V3ApiError, V3TimeoutError } from "./client.js";

const REDACTED = "[REDACTED]";
const SECRET_KEY = /api[_ -]?key|authorization|cookie|credential|password|secret|token/i;
const SECRET_VALUES = [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi];

export function scrub(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return SECRET_VALUES.reduce((text, pattern) => text.replace(pattern, REDACTED), value);
  if (value === null || typeof value !== "object") return value;
  if (depth > 8) return REDACTED;
  if (Array.isArray(value)) return value.map((item) => scrub(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, SECRET_KEY.test(key) ? REDACTED : scrub(item, depth + 1)]),
  );
}

export function isReportable(error: unknown): boolean {
  if (error instanceof V3ApiError) return error.status >= 500;
  if (error instanceof V3TimeoutError) return false;
  return !(error instanceof Error && error.name === "AbortError");
}

export interface ErrorReporter {
  capture(error: unknown): void;
  flush(): Promise<boolean>;
}

export function initSentry(options: { dsn?: string; environment?: string; release: string }): ErrorReporter {
  if (!options.dsn) return { capture: () => {}, flush: async () => true };
  Sentry.init({
    dsn: options.dsn,
    environment: options.environment,
    release: options.release,
    defaultIntegrations: false,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    beforeSend: (event) => scrub(event) as Sentry.ErrorEvent,
  });
  return {
    capture: (error) => {
      Sentry.captureException(error);
    },
    flush: () => Sentry.flush(2_000),
  };
}
