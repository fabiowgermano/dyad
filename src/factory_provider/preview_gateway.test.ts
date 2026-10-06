// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import net from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { FactoryPreviewGateway, parsePortRange } from "./preview_gateway";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

interface Seen {
  host?: string;
  origin?: string;
  referer?: string;
  url?: string;
}

/** A stand-in for Dyad's loopback proxy: it insists on its own localhost origin. */
async function upstream(): Promise<{ port: number; seen: Seen[] }> {
  const seen: Seen[] = [];
  let port = 0;
  const server = http.createServer((req, res) => {
    seen.push({
      host: req.headers.host,
      origin: req.headers.origin,
      referer: req.headers.referer,
      url: req.url,
    });
    if (req.headers.host !== `localhost:${port}`) {
      res.writeHead(421, { "content-type": "text/plain" });
      res.end("This preview belongs to a different app hostname.");
      return;
    }
    if (req.url === "/redirect") {
      res.writeHead(302, { location: `http://localhost:${port}/landing` });
      res.end();
      return;
    }
    res.end("preview-body");
  });
  const wss = new WebSocketServer({
    server,
    verifyClient: (info: { origin: string; req: http.IncomingMessage }) =>
      info.req.headers.host === `localhost:${port}` &&
      info.origin === `http://localhost:${port}`,
  });
  wss.on("connection", (socket) =>
    socket.on("message", (m) => socket.send(`echo:${m}`)),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as net.AddressInfo).port;
  closers.push(
    () =>
      new Promise((resolve) => {
        wss.close();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return { port, seen };
}

function gatewayFor(allowedPeers: string[] = ["127.0.0.1"]) {
  const gateway = new FactoryPreviewGateway({
    bindHost: "127.0.0.1",
    allowedPeers,
  });
  closers.push(() => gateway.close());
  return gateway;
}

function get(
  url: string,
  headers: Record<string, string> = {},
): Promise<{
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      {
        host: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        headers,
        agent: false,
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body, headers: res.headers }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("FactoryPreviewGateway", () => {
  it("serves the loopback preview on the bind address and rewrites Host for the proxy", async () => {
    const { port, seen } = await upstream();
    const exposed = await gatewayFor().expose(`http://localhost:${port}/app/`);
    const url = new URL(exposed);
    expect(url.hostname).toBe("127.0.0.1");
    expect(url.pathname).toBe("/app/");
    expect(url.port).not.toBe(String(port));
    const res = await get(exposed);
    expect(res.status).toBe(200);
    expect(res.body).toBe("preview-body");
    expect(seen.at(-1)?.host).toBe(`localhost:${port}`);
  });

  it("rewrites Origin and Referer that name the gateway, and leaves foreign ones alone", async () => {
    const { port, seen } = await upstream();
    const exposed = await gatewayFor().expose(`http://localhost:${port}/`);
    const origin = new URL(exposed).origin;
    await get(exposed + "x", { origin, referer: origin + "/page?q=1" });
    expect(seen.at(-1)).toMatchObject({
      origin: `http://localhost:${port}`,
      referer: `http://localhost:${port}/page?q=1`,
    });
    await get(exposed + "y", {
      origin: "http://evil.example",
      referer: "http://evil.example/p",
    });
    expect(seen.at(-1)).toMatchObject({
      origin: "http://evil.example",
      referer: "http://evil.example/p",
    });
  });

  it("rewrites a redirect Location back to the gateway", async () => {
    const { port } = await upstream();
    const exposed = await gatewayFor().expose(`http://localhost:${port}/`);
    const res = await get(new URL("/redirect", exposed).toString());
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${new URL(exposed).origin}/landing`);
  });

  it("refuses a request whose Host is not the gateway's own address", async () => {
    const { port } = await upstream();
    const exposed = await gatewayFor().expose(`http://localhost:${port}/`);
    const res = await get(exposed, { host: "attacker.example" });
    expect(res.status).toBe(421);
  });

  it("carries a WebSocket through, with the Origin the proxy accepts", async () => {
    const { port } = await upstream();
    const exposed = await gatewayFor().expose(`http://localhost:${port}/`);
    const gw = new URL(exposed);
    const ws = new WebSocket(`ws://${gw.host}/socket`, { origin: gw.origin });
    const reply = await new Promise<string>((resolve, reject) => {
      ws.on("open", () => ws.send("hi"));
      ws.on("message", (m) => resolve(String(m)));
      ws.on("error", reject);
      ws.on("unexpected-response", (_req, res) =>
        reject(new Error(`status ${res.statusCode}`)),
      );
    });
    ws.close();
    expect(reply).toBe("echo:hi");
  });

  it("keeps the same gateway for the same loopback preview", async () => {
    const { port } = await upstream();
    const gateway = gatewayFor();
    const a = await gateway.expose(`http://localhost:${port}/`);
    const b = await gateway.expose(`http://127.0.0.1:${port}/other`);
    expect(new URL(b).port).toBe(new URL(a).port);
  });

  it("drops a peer that is not listed", async () => {
    const { port } = await upstream();
    const exposed = await gatewayFor(["10.77.0.4"]).expose(
      `http://localhost:${port}/`,
    );
    await expect(get(exposed)).rejects.toThrow();
  });

  it("binds inside the configured port range", async () => {
    const { port } = await upstream();
    const gateway = new FactoryPreviewGateway({
      bindHost: "127.0.0.1",
      allowedPeers: ["127.0.0.1"],
      portRange: [49400, 49410],
    });
    closers.push(() => gateway.close());
    const exposed = new URL(await gateway.expose(`http://localhost:${port}/`));
    expect(Number(exposed.port)).toBeGreaterThanOrEqual(49400);
    expect(Number(exposed.port)).toBeLessThanOrEqual(49410);
    expect(parsePortRange(undefined)).toEqual([49152, 49300]);
    expect(parsePortRange("50000-50010")).toEqual([50000, 50010]);
    expect(() => parsePortRange("80-90")).toThrow("FIRST-LAST");
  });

  it("needs a bind host and at least one peer", () => {
    expect(
      () =>
        new FactoryPreviewGateway({ bindHost: "", allowedPeers: ["1.1.1.1"] }),
    ).toThrow();
    expect(
      () =>
        new FactoryPreviewGateway({ bindHost: "127.0.0.1", allowedPeers: [] }),
    ).toThrow();
  });
});
