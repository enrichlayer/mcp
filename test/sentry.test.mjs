import { test } from "node:test";
import assert from "node:assert/strict";
import { V3ApiError, V3NetworkError, V3TimeoutError } from "../build/client.js";
import { isReportable, scrub } from "../build/sentry.js";

test("only server-side and unexpected failures are reported", () => {
  const cancelled = new Error("aborted");
  cancelled.name = "AbortError";

  assert.equal(isReportable(new V3ApiError("/v3/person", 404, {}, 0, "req-1")), false);
  assert.equal(isReportable(new V3ApiError("/v3/person", 503, {}, 0, "req-2")), true);
  assert.equal(isReportable(new V3TimeoutError(305_000)), false);
  assert.equal(isReportable(cancelled), false);
  assert.equal(isReportable(new V3NetworkError("https://api.enrichlayer.com", new Error("ECONNRESET"))), true);
  assert.equal(isReportable(new Error("boom")), true);
});

test("events lose secrets by key name and by value", () => {
  const event = {
    message: "Calling with Bearer abc.def-123 and eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl",
    request: { headers: { authorization: "Bearer abc", "user-agent": "claude" } },
    extra: { api_key: "secret-key", tool: "validate_email" },
  };

  assert.deepEqual(scrub(event), {
    message: "Calling with [REDACTED] and [REDACTED]",
    request: { headers: { authorization: "[REDACTED]", "user-agent": "claude" } },
    extra: { api_key: "[REDACTED]", tool: "validate_email" },
  });
});
