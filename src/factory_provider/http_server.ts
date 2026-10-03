import crypto from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import {
  FACTORY_PROVIDER_PROTOCOL_VERSION,
  FactoryCreatePrototypeRequestSchema,
  type FactoryPrototypeOperation,
} from "./protocol";
import type { FactoryPrototypeRuntime } from "./runtime";

const DEFAULT_MAX_BODY_BYTES = 1_048_576;

export interface FactoryProviderServerOptions {
  runtime: FactoryPrototypeRuntime;
  token: string;
  host?: string;
  port?: number;
  maxBodyBytes?: number;
  dyadVersion: string;
  dyadCommit: string;
}

export interface FactoryProviderServer {
  server: http.Server;
  host: string;
  port: number;
  close(): Promise<void>;
}

function sendJson(
  res: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  const encoded = Buffer.from(JSON.stringify(body));
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": encoded.length,
    "cache-control": "no-store",
  });
  res.end(encoded);
}

function unauthorized(res: ServerResponse): void {
  res.setHeader("www-authenticate", "Bearer");
  sendJson(res, 401, { error: { code: "UNAUTHORIZED" } });
}

function validBearer(req: IncomingMessage, expectedToken: string): boolean {
  const value = req.headers.authorization;
  if (!value?.startsWith("Bearer ")) return false;
  const actual = Buffer.from(value.slice("Bearer ".length));
  const expected = Buffer.from(expectedToken);
  return (
    actual.length === expected.length &&
    crypto.timingSafeEqual(actual, expected)
  );
}

async function readJsonBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > maxBytes) {
      throw new Error("REQUEST_TOO_LARGE");
    }
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function operationStatus(operation: FactoryPrototypeOperation): number {
  switch (operation.state) {
    case "accepted":
    case "running":
      return 202;
    case "completed":
      return 200;
    case "rejected":
      return 422;
    case "failed":
      return 502;
  }
}

function safeOperationId(pathname: string): string | null {
  const prefix = "/v1/operations/";
  if (!pathname.startsWith(prefix)) return null;
  const encoded = pathname.slice(prefix.length);
  if (!encoded || encoded.includes("/")) return null;
  try {
    const decoded = decodeURIComponent(encoded);
    return decoded.length > 0 && decoded.length <= 512 ? decoded : null;
  } catch {
    return null;
  }
}

export async function startFactoryProviderServer(
  options: FactoryProviderServerOptions,
): Promise<FactoryProviderServer> {
  if (options.token.length < 32) {
    throw new Error("Factory provider token must be at least 32 characters");
  }
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://factory-provider.local");

      if (req.method === "GET" && url.pathname === "/healthz") {
        sendJson(res, 200, {
          status: "ok",
          protocolVersion: FACTORY_PROVIDER_PROTOCOL_VERSION,
          dyadVersion: options.dyadVersion,
          dyadCommit: options.dyadCommit,
        });
        return;
      }

      if (!validBearer(req, options.token)) {
        unauthorized(res);
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/prototypes") {
        let body: unknown;
        try {
          body = await readJsonBody(req, maxBodyBytes);
        } catch (error) {
          if ((error as Error).message === "REQUEST_TOO_LARGE") {
            sendJson(res, 413, { error: { code: "REQUEST_TOO_LARGE" } });
            return;
          }
          sendJson(res, 400, { error: { code: "INVALID_JSON" } });
          return;
        }

        const parsed = FactoryCreatePrototypeRequestSchema.safeParse(body);
        if (!parsed.success) {
          sendJson(res, 400, {
            error: {
              code: "INVALID_REQUEST",
              details: parsed.error.issues.map((issue) => ({
                path: issue.path.join("."),
                message: issue.message,
              })),
            },
          });
          return;
        }

        const operation = await options.runtime.createPrototype(parsed.data);
        sendJson(res, operationStatus(operation), operation);
        return;
      }

      if (req.method === "GET") {
        const operationId = safeOperationId(url.pathname);
        if (operationId) {
          const operation = await options.runtime.getOperation(operationId);
          if (!operation) {
            sendJson(res, 404, { error: { code: "OPERATION_NOT_FOUND" } });
            return;
          }
          sendJson(res, operationStatus(operation), operation);
          return;
        }
      }

      sendJson(res, 404, { error: { code: "NOT_FOUND" } });
    } catch {
      sendJson(res, 500, { error: { code: "INTERNAL_ERROR" } });
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Factory provider server did not bind to a TCP address");
  }

  return {
    server,
    host,
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
