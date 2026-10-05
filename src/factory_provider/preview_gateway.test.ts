// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import net from "node:net";
import { FactoryPreviewGateway, parsePortRange } from "./preview_gateway";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

async function upstream(): Promise<number> {
  const server = http.createServer((_req, res) => res.end("preview-body"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise((resolve) => server.close(() => resolve())));
  return (server.address() as net.AddressInfo).port;
}

describe("FactoryPreviewGateway", () => {
  it("serves the loopback preview on the bind address for an allowed peer", async () => {
    const port = await upstream();
    const gateway = new FactoryPreviewGateway({
      bindHost: "127.0.0.1",
      allowedPeers: ["127.0.0.1"],
    });
    closers.push(() => gateway.close());
    const exposed = await gateway.expose(`http://localhost:${port}/app/`);
    const url = new URL(exposed);
    expect(url.hostname).toBe("127.0.0.1");
    expect(url.pathname).toBe("/app/");
    expect(url.port).not.toBe(String(port));
    expect(await (await fetch(exposed)).text()).toBe("preview-body");
    // the same loopback preview keeps the same gateway
    expect(await gateway.expose(`http://127.0.0.1:${port}/`)).toBe(
      `http://127.0.0.1:${url.port}/`,
    );
  });

  it("drops a peer that is not listed", async () => {
    const port = await upstream();
    const gateway = new FactoryPreviewGateway({
      bindHost: "127.0.0.1",
      allowedPeers: ["10.77.0.4"],
    });
    closers.push(() => gateway.close());
    const exposed = await gateway.expose(`http://localhost:${port}/`);
    await expect(fetch(exposed)).rejects.toThrow();
  });

  it("binds inside the configured port range", async () => {
    const port = await upstream();
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
