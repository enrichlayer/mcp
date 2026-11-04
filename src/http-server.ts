import { createServer, type Server } from "node:http";
import { toNodeHandler } from "@modelcontextprotocol/node";
import type { HttpApp } from "./http-app.js";

export interface HttpServerOptions {
  port: number;
  host?: string;
  graceMs: number;
  onError?: (error: Error) => void;
}

export interface HttpServer {
  server: Server;
  shutdown(): Promise<void>;
}

export async function startHttpServer(app: HttpApp, options: HttpServerOptions): Promise<HttpServer> {
  const handle = toNodeHandler(app, { onerror: options.onError });
  let active = 0;
  let onDrained: (() => void) | undefined;
  const server = createServer((req, res) => {
    active++;
    res.once("close", () => {
      active--;
      if (active === 0) onDrained?.();
    });
    void handle(req, res);
  });
  await new Promise<void>((resolve) => server.listen(options.port, options.host, resolve));

  let closing: Promise<void> | undefined;
  const drain = async () => {
    server.close();
    if (active > 0) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        new Promise<void>((resolve) => (onDrained = resolve)),
        new Promise<void>((resolve) => (timer = setTimeout(resolve, options.graceMs))),
      ]);
      clearTimeout(timer);
    }
    server.closeAllConnections();
    await app.close();
  };
  return { server, shutdown: () => (closing ??= drain()) };
}
