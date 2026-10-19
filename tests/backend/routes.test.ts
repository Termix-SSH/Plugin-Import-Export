import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Router } from "express";
import {
  createMockCtx,
  type MockPluginContext,
} from "@termix-ssh/plugin-sdk/testing";
import { PluginCapabilityError } from "@termix-ssh/plugin-sdk/backend";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import manifestJson from "../../manifest.json";
import { activate } from "../../src/backend/index.js";

const manifest = manifestJson as unknown as PluginManifest;

let mock: MockPluginContext;
let server: http.Server;
let port: number;

async function start(permissions: string[] = ["import-export.use"]) {
  let router: Router | null = null;
  mock = createMockCtx({
    pluginId: manifest.id,
    manifest,
    capabilities: manifest.capabilities,
    router: () => (router = express.Router()),
    permissions,
  });
  await activate(mock.ctx);

  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => {
    mock.setActor("user-1");
    next();
  });
  app.use((req, res, next) => router!(req, res, next));
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  port = (server.address() as AddressInfo).port;
}

beforeEach(async () => {
  await start();
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function request(method: string, path: string, body?: unknown) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
}

describe("bulk import", () => {
  it("imports the rows and reports the counts", async () => {
    const spy = vi.spyOn(mock.ctx.hosts, "importMany");
    const result = await request("POST", "/bulk-import", {
      hosts: [{ name: "a", ip: "10.0.0.1", port: 22, username: "root" }],
      overwrite: true,
    });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      success: 1,
      updated: 0,
      skipped: 0,
      failed: 0,
      message: "Import completed: 1 created, 0 updated, 0 skipped, 0 failed",
    });
    expect(spy).toHaveBeenCalledWith(expect.any(Array), {
      overwrite: true,
      credentials: undefined,
    });
  });

  it("refuses an empty list", async () => {
    const result = await request("POST", "/bulk-import", { hosts: [] });
    expect(result.status).toBe(400);
  });

  it("refuses more than 100 hosts", async () => {
    const hosts = Array.from({ length: 101 }, () => ({ ip: "10.0.0.1" }));
    const result = await request("POST", "/bulk-import", { hosts });
    expect(result.status).toBe(400);
    expect(result.body.error).toMatch(/100/);
  });

  it("passes credential placeholders through", async () => {
    const spy = vi.spyOn(mock.ctx.hosts, "importMany");
    await request("POST", "/bulk-import", {
      hosts: [{ ip: "10.0.0.1" }],
      credentials: [{ alias: "deploy" }],
    });
    expect(spy).toHaveBeenCalledWith(expect.any(Array), {
      overwrite: false,
      credentials: [{ alias: "deploy" }],
    });
  });

  it("answers 403 when the user may not create hosts", async () => {
    vi.spyOn(mock.ctx.hosts, "importMany").mockRejectedValue(
      new Error("The acting user lacks the hosts.create permission"),
    );
    const result = await request("POST", "/bulk-import", {
      hosts: [{ ip: "10.0.0.1" }],
    });
    expect(result.status).toBe(403);
  });

  it("answers 400 with the reason when the import is invalid", async () => {
    vi.spyOn(mock.ctx.hosts, "importMany").mockRejectedValue(
      new Error("An atomic import cannot overwrite existing hosts"),
    );
    const result = await request("POST", "/bulk-import", {
      hosts: [{ ip: "10.0.0.1" }],
    });
    expect(result.status).toBe(400);
    expect(result.body.error).toMatch(/atomic/);
  });
});

describe("ssh config import", () => {
  it("imports the config text", async () => {
    const spy = vi.spyOn(mock.ctx.hosts, "importSshConfig");
    const result = await request("POST", "/ssh-config-import", {
      content: "Host web\n  HostName 10.0.0.2\n",
    });
    expect(result.status).toBe(200);
    expect(spy).toHaveBeenCalledWith("Host web\n  HostName 10.0.0.2\n", {
      overwrite: false,
    });
  });

  it("refuses a missing config", async () => {
    const result = await request("POST", "/ssh-config-import", {});
    expect(result.status).toBe(400);
  });
});

describe("export", () => {
  it("returns only the hosts for a full export", async () => {
    vi.spyOn(mock.ctx.hosts, "exportMany").mockResolvedValue({
      hosts: [{ exportId: 1, password: "secret" }],
      version: "ignored",
    });
    const result = await request("GET", "/export");
    expect(result.body).toEqual({
      hosts: [{ exportId: 1, password: "secret" }],
    });
  });

  it("asks for a share export without secrets", async () => {
    const spy = vi.spyOn(mock.ctx.hosts, "exportMany").mockResolvedValue({
      hosts: [],
      version: "1",
      credentials: [],
    });
    const result = await request("GET", "/export?share=1");
    expect(spy).toHaveBeenCalledWith({ share: true });
    expect(result.body).toEqual({ hosts: [], version: "1", credentials: [] });
  });

  it("exports one host by id", async () => {
    const spy = vi
      .spyOn(mock.ctx.hosts, "exportMany")
      .mockResolvedValue({ hosts: [{ exportId: 5 }] });
    const result = await request("GET", "/export/5");
    expect(spy).toHaveBeenCalledWith({ hostIds: [5] });
    expect(result.body).toEqual({ exportId: 5 });
  });

  it("keeps the old single host export path", async () => {
    vi.spyOn(mock.ctx.hosts, "exportMany").mockResolvedValue({
      hosts: [{ exportId: 5 }],
    });
    const result = await request("GET", "/db/host/5/export");
    expect(result.body).toEqual({ exportId: 5 });
  });

  it("answers 404 when the host is not the user own", async () => {
    vi.spyOn(mock.ctx.hosts, "exportMany").mockResolvedValue({ hosts: [] });
    const result = await request("GET", "/export/9");
    expect(result.status).toBe(404);
  });

  it("refuses a bad id", async () => {
    const result = await request("GET", "/export/abc");
    expect(result.status).toBe(400);
  });

  it("answers 403 when the export is not allowed", async () => {
    vi.spyOn(mock.ctx.hosts, "exportMany").mockRejectedValue(
      new PluginCapabilityError(manifest.id, "hosts:export"),
    );
    const result = await request("GET", "/export");
    expect(result.status).toBe(403);
  });
});

describe("permission", () => {
  it("blocks every route without the use permission", async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await start([]);
    const result = await request("GET", "/export");
    expect(result.status).toBe(403);
  });
});
