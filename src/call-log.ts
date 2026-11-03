import { V3ApiError, V3InterruptedError, V3NetworkError, V3TimeoutError, type CallV3 } from "./client.js";
import { toolDefs } from "./tools/definitions.js";

const toolByPath = new Map<string, string>(toolDefs.map((def) => [def.path, def.name]));

export type LogWriter = (line: string) => void;

function failure(error: unknown): { status: number | string; creditCost: number | null; requestId: string | null } {
  if (error instanceof V3ApiError) return { status: error.status, creditCost: error.creditCost, requestId: error.requestId };
  if (error instanceof V3InterruptedError) return { status: "cut", creditCost: error.creditCost, requestId: error.requestId };
  const status =
    error instanceof V3TimeoutError ? "timeout"
    : error instanceof V3NetworkError ? "network"
    : error instanceof Error && error.name === "AbortError" ? "cancelled"
    : "error";
  return { status, creditCost: null, requestId: null };
}

export function logCalls(callV3: CallV3, write: LogWriter, onError?: (error: unknown) => void): CallV3 {
  return async (request) => {
    const started = performance.now();
    const entry = { tool: toolByPath.get(request.path) ?? request.path, client: request.clientName?.slice(0, 64) ?? null };
    const elapsed = () => Math.round(performance.now() - started);
    try {
      const result = await callV3(request);
      write(JSON.stringify({ ...entry, status: "ok", creditCost: result.creditCost, requestId: result.requestId, ms: elapsed() }));
      return result;
    } catch (error) {
      write(JSON.stringify({ ...entry, ...failure(error), ms: elapsed() }));
      onError?.(error);
      throw error;
    }
  };
}
