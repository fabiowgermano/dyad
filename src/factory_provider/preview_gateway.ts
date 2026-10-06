import http from "node:http";
import net from "node:net";

/**
 * Serves a prototype preview on the private-network address.
 *
 * Dyad starts every preview behind a proxy that listens on loopback only, so
 * its URL opens nowhere but on the service host. The gateway listens on the
 * configured private address (for example the WireGuard one), accepts a
 * connection only from the listed peer addresses and forwards HTTP and
 * WebSocket traffic to the loopback proxy.
 *
 * Dyad's proxy answers 421 to any request whose Host (or browser Origin) is not
 * its own `localhost:<port>`, so the gateway is an HTTP gateway and not a byte
 * forwarder: it rewrites Host, and a browser Origin or Referer that names the
 * gateway, to the loopback proxy's origin on the way in, and rewrites the
 * origin in a redirect Location back to the gateway on the way out. It serves
 * only requests whose Host is the gateway's own address, which keeps a DNS
 * rebinding page from reaching the preview. It carries no content of its own.
 */
export interface FactoryPreviewGatewayOptions {
  bindHost: string;
  allowedPeers: readonly string[];
  /** Inclusive port range the gateway binds in, so a firewall rule can name it. */
  portRange?: readonly [number, number];
}

export const DEFAULT_PREVIEW_PORT_RANGE = [49152, 49300] as const;

export function parsePortRange(raw: string | undefined): [number, number] {
  const value = raw?.trim();
  if (!value) return [...DEFAULT_PREVIEW_PORT_RANGE];
  const match = /^(\d{1,5})-(\d{1,5})$/.exec(value);
  const first = Number(match?.[1]);
  const last = Number(match?.[2]);
  if (!match || first < 1024 || last > 65535 || first > last) {
    throw new Error(
      "FACTORY_DYAD_PREVIEW_PORTS must be FIRST-LAST within 1024-65535",
    );
  }
  return [first, last];
}

function normalizePeer(address: string | undefined): string {
  if (!address) return "";
  return address.startsWith("::ffff:") ? address.slice(7) : address;
}

interface Exposed {
  server: http.Server;
  /** The gateway's own origin, as the browser sees it. */
  origin: string;
  /** The loopback proxy's origin, as Dyad's proxy expects to be addressed. */
  upstreamOrigin: string;
}

/** Replace an origin prefix in a header value, leaving other values alone. */
function swapOrigin(value: string, from: string, to: string): string {
  return value === from ||
    value.startsWith(from + "/") ||
    value.startsWith(from + "?")
    ? to + value.slice(from.length)
    : value;
}

export class FactoryPreviewGateway {
  private readonly servers = new Map<number, Promise<Exposed>>();
  private readonly allowed: Set<string>;

  constructor(private readonly options: FactoryPreviewGatewayOptions) {
    if (!options.bindHost) throw new Error("preview gateway needs a bind host");
    if (options.allowedPeers.length === 0) {
      throw new Error("preview gateway needs at least one allowed peer");
    }
    this.allowed = new Set(options.allowedPeers.map(normalizePeer));
  }

  /**
   * Exposes the loopback preview URL on the private address and returns the
   * URL to give to the operator. The same loopback port always maps to the
   * same gateway while this process runs.
   */
  async expose(localUrl: string): Promise<string> {
    const url = new URL(localUrl);
    const target = Number(url.port);
    if (!Number.isInteger(target) || target <= 0) {
      throw new Error("preview URL has no port");
    }
    let started = this.servers.get(target);
    if (!started) {
      started = this.start(target, url.host);
      this.servers.set(target, started);
      started.catch(() => this.servers.delete(target));
    }
    const exposed = await started;
    const out = new URL(url.toString());
    const gateway = new URL(exposed.origin);
    out.hostname = gateway.hostname;
    out.port = gateway.port;
    return out.toString();
  }

  private async start(target: number, upstreamHost: string): Promise<Exposed> {
    const [first, last] = this.options.portRange ?? DEFAULT_PREVIEW_PORT_RANGE;
    const span = last - first + 1;
    const offset = Math.floor(Math.random() * span);
    for (let i = 0; i < span; i++) {
      const port = first + ((offset + i) % span);
      try {
        return await this.listenOn(target, upstreamHost, port);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      }
    }
    throw new Error(`no free preview port in ${first}-${last}`);
  }

  private listenOn(
    target: number,
    upstreamHost: string,
    port: number,
  ): Promise<Exposed> {
    const origin = `http://${this.options.bindHost}:${port}`;
    const upstreamOrigin = `http://${upstreamHost}`;
    const gatewayHost = `${this.options.bindHost}:${port}`;

    // Headers as the loopback proxy must see them.
    const forwardHeaders = (raw: string[]): Array<[string, string]> => {
      const out: Array<[string, string]> = [];
      for (let i = 0; i < raw.length; i += 2) {
        const name = raw[i];
        let value = raw[i + 1];
        switch (name.toLowerCase()) {
          case "host":
            value = upstreamHost;
            break;
          case "origin":
          case "referer":
            value = swapOrigin(value, origin, upstreamOrigin);
            break;
        }
        out.push([name, value]);
      }
      return out;
    };
    const hostIsOurs = (req: http.IncomingMessage) =>
      req.headers.host?.toLowerCase() === gatewayHost.toLowerCase();

    const server = http.createServer((req, res) => {
      if (!hostIsOurs(req)) {
        res.writeHead(421, { "content-type": "text/plain" });
        res.end("This preview is served only at its own address.");
        return;
      }
      const upstream = http.request(
        {
          host: "127.0.0.1",
          port: target,
          method: req.method,
          path: req.url,
          headers: Object.fromEntries(forwardHeaders(req.rawHeaders)),
          agent: false,
        },
        (up) => {
          const headers = { ...up.headers };
          if (typeof headers.location === "string") {
            headers.location = swapOrigin(
              headers.location,
              upstreamOrigin,
              origin,
            );
          }
          res.writeHead(up.statusCode ?? 502, headers);
          up.pipe(res);
        },
      );
      upstream.on("error", () => {
        if (!res.headersSent)
          res.writeHead(502, { "content-type": "text/plain" });
        res.end("The preview is not reachable.");
      });
      req.pipe(upstream);
    });

    server.on("upgrade", (req, socket, head) => {
      if (!hostIsOurs(req)) {
        socket.end(
          "HTTP/1.1 421 Misdirected Request\r\nConnection: close\r\n\r\n",
        );
        return;
      }
      const upstream = net.connect(target, "127.0.0.1", () => {
        let handshake = `${req.method} ${req.url} HTTP/1.1\r\n`;
        for (const [name, value] of forwardHeaders(req.rawHeaders)) {
          handshake += `${name}: ${value}\r\n`;
        }
        upstream.write(handshake + "\r\n");
        if (head.length > 0) upstream.write(head);
        socket.pipe(upstream);
        upstream.pipe(socket);
      });
      const close = () => {
        socket.destroy();
        upstream.destroy();
      };
      socket.on("error", close);
      upstream.on("error", close);
      socket.on("close", close);
      upstream.on("close", close);
    });

    // A peer that is not listed never gets as far as an HTTP request.
    server.on("connection", (socket) => {
      if (!this.allowed.has(normalizePeer(socket.remoteAddress))) {
        socket.destroy();
      }
    });

    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, this.options.bindHost, () =>
        resolve({ server, origin, upstreamOrigin }),
      );
    });
  }

  async close(): Promise<void> {
    const started = [...this.servers.values()];
    this.servers.clear();
    await Promise.all(
      started.map(
        async (pending) =>
          new Promise<void>((resolve) =>
            pending.then(
              ({ server }) => {
                server.closeAllConnections?.();
                server.close(() => resolve());
              },
              () => resolve(),
            ),
          ),
      ),
    );
  }
}
