// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { FactoryPreviewGateway } from "./preview_gateway";

/**
 * The gateway against Dyad's real preview proxy worker (worker/proxy_server.js),
 * the component that answered 421 to a request addressed by the private IP.
 */
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

describe("FactoryPreviewGateway in front of Dyad's proxy", () => {
  it("serves the app through the private address instead of answering 421", async () => {
    const app = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        "<!doctype html><html><head></head><body><h1>partner area</h1></body></html>",
      );
    });
    await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
    const appPort = (app.address() as net.AddressInfo).port;
    closers.push(
      () =>
        new Promise((resolve) => {
          app.closeAllConnections();
          app.close(() => resolve());
        }),
    );

    const proxyPort = await freePort();
    const worker = new Worker(
      path.resolve(__dirname, "../../worker/proxy_server.js"),
      {
        workerData: {
          targetOrigin: `http://127.0.0.1:${appPort}`,
          hostname: "localhost",
          port: proxyPort,
          fallbackPortStart: proxyPort + 1,
          maxPortAttempts: 1,
          authBootstrapToken: "test-token",
        },
      },
    );
    const started = new Promise<string>((resolve, reject) => {
      worker.on("message", (m) => {
        if (typeof m === "string" && m.startsWith("proxy-server-start url="))
          resolve(m.slice("proxy-server-start url=".length));
      });
      worker.on("error", reject);
    });
    closers.push(async () => {
      await worker.terminate();
    });
    const proxyUrl = await started;

    const gateway = new FactoryPreviewGateway({
      bindHost: "127.0.0.1",
      allowedPeers: ["127.0.0.1"],
    });
    closers.push(() => gateway.close());
    const exposed = await gateway.expose(proxyUrl);

    // Direct, by IP: Dyad's proxy refuses. This is the defect the gateway fixes.
    const direct = await fetch(`http://127.0.0.1:${new URL(proxyUrl).port}/`);
    expect(direct.status).toBe(421);

    const res = await fetch(exposed);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("partner area");
  });
});
