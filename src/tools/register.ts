import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { CallV3, V3Params } from "../client.js";
import { SSE_KEEP_ALIVE_MS } from "../config.js";
import { describeFailure, type MessageOptions } from "../errors.js";
import { v3Params } from "../generated/v3-params.js";
import { toolDefs, type ToolDef } from "./definitions.js";

function outputSchema(returns: ToolDef["returns"]) {
  return z.object({
    data: returns === "array" ? z.array(z.looseObject({})) : z.looseObject({}),
    creditCost: z.number().nullable(),
    requestId: z.string().nullable(),
  });
}

function failure(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

export interface ToolOptions extends MessageOptions {
  progressMs?: number;
}

export function registerTools(server: McpServer, callV3: CallV3, options: ToolOptions = {}): void {
  const progressMs = options.progressMs ?? SSE_KEEP_ALIVE_MS;
  for (const def of toolDefs) {
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: z.object(v3Params[def.path]),
        outputSchema: outputSchema(def.returns),
        annotations: { title: def.title, readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      },
      async (params, ctx) => {
        const problem = def.checkParams?.(params);
        if (problem) return failure(problem);
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
          const result = await callV3({
            path: def.path,
            params: params as V3Params,
            signal: ctx.mcpReq.signal,
            clientName: server.server.getClientVersion()?.name,
          });
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: { ...result },
          };
        } catch (error) {
          const message = describeFailure(error, options);
          if (message === null) throw error;
          return failure(message);
        } finally {
          clearInterval(progressTimer);
        }
      },
    );
  }
}
