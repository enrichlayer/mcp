import { DASHBOARD_URL, InvalidApiKeyError, MissingApiKeyError } from "./auth/api-key.js";
import { V3ApiError, V3InterruptedError, V3NetworkError, V3TimeoutError } from "./client.js";

const DAY_SECONDS = 86_400;
const SUPPORT_EMAIL = "support@enrichlayer.com";

export const CUT_OFF_ADVICE =
  "A call cut off before the answer arrives may still be charged. To get the copy that was saved in the meantime, call again without maxAgeSeconds; do not repeat a live lookup right away.";

function details(error: V3ApiError | V3InterruptedError): string {
  const parts = [`credits charged: ${error.creditCost ?? "unknown"}`];
  if (error.requestId) parts.push(`request id: ${error.requestId}`);
  return ` (${parts.join(", ")})`;
}

function apiErrorMessage(error: V3ApiError): string {
  const reason = (error.body.description ?? error.body.name ?? `HTTP ${error.status}`).replace(/[.\s]+$/, "");
  const age = error.body.cachedProfileAgeSeconds;

  if (error.status === 400) return `The request was rejected as invalid: ${reason}. Fix the parameters and call again.`;
  if (error.status === 401)
    return `The API key was rejected: ${reason}. Set ENRICHLAYER_API_KEY to a valid key from ${DASHBOARD_URL} and restart the MCP server.`;
  if (error.status === 403) {
    if (/insufficient credits|top.?up/i.test(reason))
      return `Not enough credits: ${reason}. Top up the account at ${DASHBOARD_URL}, then call again.`;
    return `Access denied for ${error.path}: ${reason}. This key or its account cannot use this endpoint; use a key that can, or contact ${SUPPORT_EMAIL}.`;
  }
  if (error.status === 404)
    return `Not found: ${reason}. Check the identifier (URL, username, email or domain), or look it up by another identifier.`;
  if (error.status === 409) {
    const cached =
      typeof age === "number"
        ? ` The newest cached copy is ${Math.floor(age / DAY_SECONDS)} days old (${age} s). Call again later, or set maxAgeSeconds to at least ${age} to accept it.`
        : " Call again later, or raise maxAgeSeconds to accept an older cached copy.";
    return `No copy is fresh enough and a live lookup did not succeed: ${reason}.${cached}`;
  }
  if (error.status === 429)
    return `Rate limit reached for this account: ${reason}. The limit is counted per account, and new accounts have a very small limit until their first payment; wait a minute and call again.`;
  if (error.status >= 500)
    return `Enrich Layer is unavailable right now (${error.status}): ${reason}. Try again in a few minutes.`;
  return `Enrich Layer API error ${error.status}: ${reason}. Try again later; if it keeps failing, contact ${SUPPORT_EMAIL} with the request id.`;
}

export function describeFailure(error: unknown): string | null {
  if (error instanceof V3ApiError) return apiErrorMessage(error) + details(error);
  if (error instanceof V3InterruptedError) return `${error.message}. ${CUT_OFF_ADVICE}${details(error)}`;
  if (error instanceof V3TimeoutError) return `${error.message}. ${CUT_OFF_ADVICE}`;
  if (error instanceof V3NetworkError)
    return `${error.message}. Check the network connection and ENRICHLAYER_API_BASE_URL, then call again.`;
  if (error instanceof MissingApiKeyError || error instanceof InvalidApiKeyError) return error.message;
  return null;
}
