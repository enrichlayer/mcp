import type { CallToolResult, McpServer, ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { CallV3, V3Params } from "../client.js";
import { CACHE_ONLY_MAX_AGE_SECONDS, PAGE_BYTES, SSE_KEEP_ALIVE_MS } from "../config.js";
import { describeFailure, type MessageOptions } from "../errors.js";
import { KIND_PATHS, kindOf, readCursor } from "../fit/cursor.js";
import { firstPage, nextPage } from "../fit/pages.js";
import { v3Params } from "../generated/v3-params.js";
import { INVALID_CURSOR, listGone, moreToolDef, toolDefs, type ToolDef } from "./definitions.js";

const moreEntry = z.object({
  items: z.number().int().optional(),
  chars: z.number().int().optional(),
  approxChars: z.number().int(),
  pages: z.number().int(),
  cursor: z.string(),
});

function outputSchema(returns: ToolDef["returns"]) {
  return z.object({
    data: returns === "array" ? z.array(z.looseObject({})) : z.looseObject({}),
    creditCost: z.number().nullable(),
    requestId: z.string().nullable(),
    more: z.record(z.string(), moreEntry).optional(),
    note: z.string().optional(),
  });
}

const pageSchema = z.object({
  path: z.string(),
  items: z.number().int().optional(),
  chars: z.number().int().optional(),
  from: z.number().int(),
  list: z.array(z.unknown()).optional(),
  text: z.string().optional(),
  more: z.record(z.string(), moreEntry).optional(),
  nextCursor: z.string().nullable(),
  creditCost: z.number().nullable(),
  requestId: z.string().nullable(),
  changed: z.boolean().optional(),
  restartCursor: z.string().optional(),
  note: z.string().optional(),
});

const ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };

function failure(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

function success(value: object): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: { ...value } };
}

export interface ToolOptions extends MessageOptions {
  progressMs?: number;
}

export function registerTools(server: McpServer, callV3: CallV3, options: ToolOptions = {}): void {
  const progressMs = options.progressMs ?? SSE_KEEP_ALIVE_MS;

  async function answer(ctx: ServerContext, call: () => Promise<CallToolResult>): Promise<CallToolResult> {
    const progressToken = ctx.mcpReq._meta?.progressToken;
    let progress = 0;
    const progressTimer =
      progressToken === undefined
        ? undefined
        : setInterval(() => {
            progress += 1;
            ctx.mcpReq.notify({ method: "notifications/progress", params: { progressToken, progress } }).catch(() => {});
          }, progressMs);
    try {
      return await call();
    } catch (error) {
      const message = describeFailure(error, options);
      if (message === null) throw error;
      return failure(message);
    } finally {
      clearInterval(progressTimer);
    }
  }

  for (const def of toolDefs) {
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: z.object(v3Params[def.path]),
        outputSchema: outputSchema(def.returns),
        annotations: { title: def.title, ...ANNOTATIONS },
      },
      async (params, ctx) => {
        const problem = def.checkParams?.(params);
        if (problem) return failure(problem);
        return answer(ctx, async () => {
          const result = await callV3({
            path: def.path,
            params: params as V3Params,
            signal: ctx.mcpReq.signal,
            clientName: server.server.getClientVersion()?.name,
          });
          return success(firstPage(result, { kind: kindOf(def.path), args: params, budget: PAGE_BYTES }));
        });
      },
    );
  }

  server.registerTool(
    moreToolDef.name,
    {
      title: moreToolDef.title,
      description: moreToolDef.description,
      inputSchema: z.object({ cursor: z.string().describe(moreToolDef.cursorDescription) }),
      outputSchema: pageSchema,
      annotations: { title: moreToolDef.title, ...ANNOTATIONS },
    },
    async ({ cursor: text }, ctx) => {
      const cursor = readCursor(text);
      if (!cursor) return failure(INVALID_CURSOR);
      return answer(ctx, async () => {
        const isProfile = cursor.t === "p" || cursor.t === "c";
        const result = await callV3({
          path: KIND_PATHS[cursor.t],
          params: { ...cursor.a, ...(isProfile && { maxAgeSeconds: CACHE_ONLY_MAX_AGE_SECONDS }) },
          signal: ctx.mcpReq.signal,
          clientName: server.server.getClientVersion()?.name,
          tool: moreToolDef.name,
        });
        const page = nextPage(result, cursor, { budget: PAGE_BYTES });
        if (!page) return failure(listGone(cursor.t, result.creditCost));
        return success(page);
      });
    },
  );
}
