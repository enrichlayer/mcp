import { test } from "node:test";
import assert from "node:assert/strict";
import { MissingApiKeyError } from "../build/auth/api-key.js";
import { V3NetworkError, V3TimeoutError } from "../build/client.js";
import { describeFailure } from "../build/errors.js";

test("a timeout says the call may be charged and how to get the saved copy", () => {
  assert.equal(
    describeFailure(new V3TimeoutError(305_000)),
    "Enrich Layer did not answer within 305 s. A call cut off before the answer arrives may still be charged. To get the copy that was saved in the meantime, call again without maxAgeSeconds; do not repeat a live lookup right away.",
  );
});

test("a network failure and a missing key tell what to fix", () => {
  assert.equal(
    describeFailure(new V3NetworkError("https://api.enrichlayer.com", new Error("getaddrinfo ENOTFOUND"))),
    "Could not reach Enrich Layer at https://api.enrichlayer.com: getaddrinfo ENOTFOUND. Check the network connection and ENRICHLAYER_API_BASE_URL, then call again.",
  );
  assert.equal(
    describeFailure(new MissingApiKeyError()),
    "ENRICHLAYER_API_KEY is not set. Create an API key at https://enrichlayer.com/dashboard, add it to the env of this MCP server and restart the server.",
  );
});

test("a network failure in the hosted connector does not point at an environment variable", () => {
  assert.equal(
    describeFailure(new V3NetworkError("https://api.enrichlayer.com", new Error("getaddrinfo ENOTFOUND")), { hosted: true }),
    "Could not reach Enrich Layer at https://api.enrichlayer.com: getaddrinfo ENOTFOUND. Try again in a few minutes.",
  );
});

test("a request that could not be built does not repeat what fetch said about it", () => {
  const cause = new TypeError('Headers.append: "Bearer FAKE_REVIEW_KEY\nSECOND_LINE" is an invalid header value.');

  assert.equal(
    describeFailure(new V3NetworkError("https://api.enrichlayer.com", cause)),
    "Could not reach Enrich Layer at https://api.enrichlayer.com: the request could not be built. Check the network connection and ENRICHLAYER_API_BASE_URL, then call again.",
  );
});

test("unknown errors are left to the MCP server", () => {
  assert.equal(describeFailure(new Error("boom")), null);
});
