import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { JSONRPCMessage, MessageExtraInfo } from "@modelcontextprotocol/sdk/types.js";
import { registerResources } from "./resources.js";
import { registerSandboxTools } from "./tools/sandbox.js";
import { registerExecTools } from "./tools/exec.js";
import { registerFilesystemTools } from "./tools/filesystem.js";
import { registerImageTools } from "./tools/image.js";
import { registerLogTools } from "./tools/logs.js";
import { registerVolumeTools } from "./tools/volume.js";
import { registerMetricsTools } from "./tools/metrics.js";
import { registerRuntimeTools } from "./tools/runtime.js";
import { registerSnapshotTools } from "./tools/snapshot.js";
import { registerSshTools } from "./tools/ssh.js";
import { getServerConfig } from "./config.js";

const SERVER_VERSION = "0.7.7";

// Reject inconsistent image policy before accepting clients.
getServerConfig();

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "microsandbox",
    version: SERVER_VERSION,
  });

  registerResources(server);
  registerRuntimeTools(server);
  registerSandboxTools(server);
  registerExecTools(server);
  registerLogTools(server);
  registerFilesystemTools(server);
  registerVolumeTools(server);
  registerMetricsTools(server);
  registerImageTools(server);
  registerSnapshotTools(server);
  registerSshTools(server);

  return server;
}

const transportMode = getOption("transport") ?? process.env.MICROSANDBOX_MCP_TRANSPORT ?? "stdio";

if (transportMode === "http") {
  await startHttpServer();
} else if (transportMode === "stdio") {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  enableTransportTrace(transport, "stdio");
  await server.connect(transport);
} else {
  throw new Error(`Unsupported transport ${JSON.stringify(transportMode)}; use stdio or http`);
}

function getOption(name: string): string | undefined {
  const prefix = `--${name}`;
  const inline = process.argv.find((argument) => argument.startsWith(`${prefix}=`));
  if (inline) return inline.slice(prefix.length + 1);

  const index = process.argv.indexOf(prefix);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function startHttpServer(): Promise<void> {
  const host = getOption("host") ?? process.env.MICROSANDBOX_MCP_HTTP_HOST ?? "127.0.0.1";
  const port = parsePort(
    getOption("port") ?? process.env.MICROSANDBOX_MCP_HTTP_PORT,
    3000,
  );
  const endpoint = getOption("path") ?? process.env.MICROSANDBOX_MCP_HTTP_PATH ?? "/mcp";
  const sessions = new Map<string, {
    server: McpServer;
    transport: StreamableHTTPServerTransport;
  }>();

  const httpServer = createServer(async (req, res) => {
    setCorsHeaders(res);

    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }

    if (new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`).pathname !== endpoint) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }

    try {
      const sessionId = headerValue(req, "mcp-session-id");
      const session = sessionId ? sessions.get(sessionId) : undefined;
      trace("http", "request", {
        method: req.method,
        path: req.url,
        sessionId: sessionId ?? null,
      });

      if (req.method === "POST") {
        const body = await readJsonBody(req);

        if (session) {
          await session.transport.handleRequest(req, res, body);
          return;
        }

        if (!sessionId && isInitializeRequest(body)) {
          let transport!: StreamableHTTPServerTransport;
          const server = createMcpServer();
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: randomUUID,
            onsessioninitialized: (initializedSessionId) => {
              sessions.set(initializedSessionId, { server, transport });
            },
          });
          transport.onclose = () => {
            if (transport.sessionId) sessions.delete(transport.sessionId);
          };
          enableTransportTrace(transport, `http:${transport.sessionId ?? "new"}`);
          await server.connect(transport);
          await transport.handleRequest(req, res, body);
          return;
        }

        sendJson(res, sessionId ? 404 : 400, {
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: sessionId ? "Session not found" : "Invalid initialization request",
          },
          id: null,
        });
        return;
      }

      if (req.method === "GET" || req.method === "DELETE") {
        if (!sessionId) {
          sendJson(res, 400, { error: "Missing Mcp-Session-Id header" });
          return;
        }
        if (!session) {
          sendJson(res, 404, { error: "Session not found" });
          return;
        }
        await session.transport.handleRequest(req, res);
        return;
      }

      res.setHeader("Allow", "GET, POST, DELETE, OPTIONS");
      sendJson(res, 405, { error: "Method not allowed" });
    } catch (error) {
      console.error("MCP HTTP request failed:", error);
      if (!res.headersSent) {
        sendJson(res, 500, { error: "Internal server error" });
      } else {
        res.destroy();
      }
    }
  });

  const close = async () => {
    for (const { server, transport } of sessions.values()) {
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  };
  process.once("SIGINT", () => void close().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void close().finally(() => process.exit(0)));

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => resolve());
  });
  console.error(`microsandbox MCP HTTP server listening at http://${host}:${port}${endpoint}`);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1024 * 1024) throw new Error("Request body too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function parsePort(value: string | undefined, fallback: number): number {
  const port = Number.parseInt(value ?? "", 10);
  if (Number.isInteger(port) && port >= 1 && port <= 65535) return port;
  return fallback;
}

function setCorsHeaders(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Mcp-Session-Id, Last-Event-ID");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, Last-Event-ID");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  if (res.headersSent) return;
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(payload);
}

function enableTransportTrace(transport: Transport, label: string): void {
  if (!traceEnabled()) return;

  const originalOnMessage = transport.onmessage;
  transport.onmessage = (message: JSONRPCMessage, extra?: MessageExtraInfo) => {
    trace(label, "received", { message, ...(extra ? { extra } : {}) });
    originalOnMessage?.(message, extra);
  };

  const originalSend = transport.send.bind(transport);
  transport.send = (message: JSONRPCMessage, options?: TransportSendOptions) => {
    trace(label, "sent", { message, ...(options ? { options } : {}) });
    return originalSend(message, options);
  };
}

function traceEnabled(): boolean {
  return process.env.MICROSANDBOX_MCP_TRACE === "1" || process.env.MICROSANDBOX_MCP_TRACE === "true";
}

function trace(label: string, direction: string, value: unknown): void {
  if (!traceEnabled()) return;
  const maxBytes = parsePositiveInt(process.env.MICROSANDBOX_MCP_TRACE_MAX_BYTES, 32 * 1024);
  const serialized = JSON.stringify(value);
  const output = Buffer.byteLength(serialized, "utf8") > maxBytes
    ? `${serialized.slice(0, maxBytes)}…[truncated]`
    : serialized;
  console.error(`[microsandbox-mcp trace] ${label} ${direction} ${output}`);
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
