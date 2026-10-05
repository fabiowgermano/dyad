import net from "node:net";

/**
 * Serves a prototype preview on the private-network address.
 *
 * Dyad starts every preview behind a proxy that listens on loopback only, so
 * its URL opens nowhere but on the service host. The gateway listens on the
 * configured private address (for example the WireGuard one), accepts a
 * connection only from the listed peer addresses and forwards the bytes to the
 * loopback proxy. It carries no content of its own and rewrites nothing: the
 * preview still talks to Dyad's own proxy.
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

export class FactoryPreviewGateway {
  private readonly servers = new Map<number, Promise<net.Server>>();
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
      started = this.start(target);
      this.servers.set(target, started);
      started.catch(() => this.servers.delete(target));
    }
    const server = await started;
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("preview gateway has no TCP address");
    }
    const exposed = new URL(url.toString());
    exposed.hostname = this.options.bindHost;
    exposed.port = String(address.port);
    return exposed.toString();
  }

  private async start(target: number): Promise<net.Server> {
    const [first, last] = this.options.portRange ?? DEFAULT_PREVIEW_PORT_RANGE;
    const span = last - first + 1;
    const offset = Math.floor(Math.random() * span);
    for (let i = 0; i < span; i++) {
      const port = first + ((offset + i) % span);
      try {
        return await this.listenOn(target, port);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      }
    }
    throw new Error(`no free preview port in ${first}-${last}`);
  }

  private listenOn(target: number, port: number): Promise<net.Server> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((client) => {
        if (!this.allowed.has(normalizePeer(client.remoteAddress))) {
          client.destroy();
          return;
        }
        const upstream = net.connect(target, "127.0.0.1");
        client.pipe(upstream);
        upstream.pipe(client);
        const close = () => {
          client.destroy();
          upstream.destroy();
        };
        client.on("error", close);
        upstream.on("error", close);
        client.on("close", close);
        upstream.on("close", close);
      });
      server.once("error", reject);
      server.listen(port, this.options.bindHost, () => resolve(server));
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
              (server) => server.close(() => resolve()),
              () => resolve(),
            ),
          ),
      ),
    );
  }
}
