import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { failureReason, fetchBytes, NetworkError, rankMirrors } from "../src/tl/net.js";
import { useProxyFromEnv } from "../src/util/proxy.js";

/** A server that answers 403 to everything, and the port of one that is closed. */
let server: Server;
let port: number;
let closedPort: number;

beforeAll(async () => {
  server = createServer((_, res) => res.writeHead(403).end());
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
  const closed = createServer();
  await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
  closedPort = (closed.address() as AddressInfo).port;
  await new Promise((r) => closed.close(r));
});
afterAll(() => void server.close());

describe("failed downloads", () => {
  it("records why each repository did not answer", async () => {
    const refused = `http://127.0.0.1:${closedPort}`;
    const forbidden = `http://127.0.0.1:${port}`;
    const failures = new Map<string, string>();
    expect(await rankMirrors([refused, forbidden], 3, failures)).toEqual([]);
    expect(failures).toEqual(new Map([[refused, "ECONNREFUSED"], [forbidden, "HTTP 403"]]));
  });

  it("names the file and the reason", async () => {
    const url = `http://127.0.0.1:${port}/x`;
    const err = await fetchBytes(url, 0).catch((e) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect(err.message).toBe(`Could not download ${url}: HTTP 403`);
  });

  it("says a timeout in words", () => {
    expect(failureReason(Object.assign(new Error("aborted"), { name: "TimeoutError" }))).toBe("no answer in time");
  });
});

// Last, as it replaces fetch's dispatcher for the rest of this file.
describe("proxy", () => {
  it("leaves fetch alone when no proxy is set", async () => {
    const set = vi.fn();
    vi.doMock("undici", () => ({ EnvHttpProxyAgent: class {}, setGlobalDispatcher: set }));
    await useProxyFromEnv({});
    expect(set).not.toHaveBeenCalled();
    vi.doUnmock("undici");
  });

  it("sends HTTPS requests through HTTPS_PROXY", async () => {
    const tunnels: string[] = [];
    const proxy = createServer();
    proxy.on("connect", (req, socket) => {
      tunnels.push(req.url ?? "");
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    });
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
    vi.stubEnv("HTTPS_PROXY", `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`);
    await useProxyFromEnv();
    await fetch("https://mirror.invalid/x").catch(() => undefined);
    vi.unstubAllEnvs();
    proxy.close();
    expect(tunnels).toEqual(["mirror.invalid:443"]);
  });
});
