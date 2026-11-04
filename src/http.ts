#!/usr/bin/env node

import { apiBaseUrl, httpConfig, VERSION } from "./config.js";
import { createHttpApp } from "./http-app.js";
import { startHttpServer } from "./http-server.js";
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
  const { shutdown } = await startHttpServer(app, { port: config.port, graceMs: SHUTDOWN_GRACE_MS, onError: report });
  console.log(JSON.stringify({ event: "listening", port: config.port, version: VERSION }));

  const stop = () => {
    void shutdown().then(() => sentry.flush());
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
} catch (error) {
  console.error("Unable to start the Enrich Layer v3 MCP HTTP server:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
