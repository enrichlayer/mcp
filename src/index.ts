#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createServer } from "./server.js";

try {
  await createServer().connect(new StdioServerTransport());
} catch (error) {
  console.error("Unable to start the Enrich Layer v3 MCP server:", error);
  process.exitCode = 1;
}
