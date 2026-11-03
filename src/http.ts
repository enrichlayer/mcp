#!/usr/bin/env node

import { createServer } from "node:http";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { apiBaseUrl, httpConfig, VERSION } from "./config.js";
import { createHttpApp } from "./http-app.js";
import { initSentry, isReportable } from "./sentry.js";

const SHUTDOWN_GRACE_MS = 10_000;

try {
  const config = httpConfig();
  const sentry = initSentry({ dsn: config.sentryDsn, environment: config.sentryEnvironment, release: VERSION });
  const report = (error: unknown) => {
    if (isReportable(error)) sentry.capture(error);
  };
  const app = createHttpApp({
    baseUrl: config.baseUrl,
    jwtSecret: config.jwtSecret,
    apiBaseUrl: apiBaseUrl(),
    write: (line) => console.log(line),
    onError: report,
  });
  const server = createServer(toNodeHandler(app, { onerror: report }));
  server.listen(config.port, () => console.log(JSON.stringify({ event: "listening", port: config.port, version: VERSION })));

  const shutdown = () => {
    server.close();
    setTimeout(() => server.closeAllConnections(), SHUTDOWN_GRACE_MS).unref();
    void app.close().then(() => sentry.flush());
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
} catch (error) {
  console.error("Unable to start the Enrich Layer v3 MCP HTTP server:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
