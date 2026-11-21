import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import express, { type Router } from "express";
import {
  createMockCtx,
  type MockPluginContext,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import manifestJson from "../../manifest.json";
import { activate } from "../../src/backend/index.js";
import { openBackup, sealBackup } from "../../src/backend/backup-crypto.js";
import {
  backupFiles,
  cleanPrefix,
  nextBackupAt,
} from "../../src/backend/s3-backup.js";

const manifest = manifestJson as unknown as PluginManifest;

describe("backup files", () => {
  it("opens with the right passphrase only", () => {
    const sealed = sealBackup('{"hosts":[1]}', "correct horse");
    expect(sealed).not.toContain('"hosts":[1]');
    expect(openBackup(sealed, "correct horse")).toBe('{"hosts":[1]}');
    expect(() => openBackup(sealed, "wrong one")).toThrow(/passphrase/);
    expect(() => openBackup("{}", "x")).toThrow(/not a Termix/);
  });

  it("plans daily and weekly times in UTC", () => {
    const from = new Date("2026-11-19T10:00:00Z");
    expect(nextBackupAt("off", 3, from)).toBeNull();
    expect(nextBackupAt("daily", 3, from)).toBe("2026-11-20T03:00:00.000Z");
    expect(nextBackupAt("daily", 12, from)).toBe("2026-11-19T12:00:00.000Z");
    expect(nextBackupAt("weekly", 3, from)).toBe("2026-11-22T03:00:00.000Z");
  });

  it("cleans folders and picks only its own files, newest first", () => {
    expect(cleanPrefix("/termix/backups/")).toBe("termix/backups/");
    expect(cleanPrefix("")).toBe("");
    expect(() => cleanPrefix("a/../b")).toThrow();
    const files = backupFiles(
      [
        {
          key: "x/termix-hosts-20260101-000000.json",
          size: 1,
          modifiedAt: null,
        },
        {
          key: "x/termix-hosts-20260102-000000.json",
          size: 1,
          modifiedAt: null,
        },
        { key: "x/other.json", size: 1, modifiedAt: null },
        {
          key: "y/termix-hosts-20260103-000000.json",
          size: 1,
          modifiedAt: null,
        },
      ],
      "x/",
    );
    expect(files.map((f) => f.key)).toEqual([
      "x/termix-hosts-20260102-000000.json",
      "x/termix-hosts-20260101-000000.json",
    ]);
  });
});

describe("backup routes", () => {
  let mock: MockPluginContext;
  let server: http.Server;
  let port: number;
  const bucket = new Map<string, string>();

  const files = {
    accounts: vi.fn(async () => [{ id: 1, name: "MinIO" }]),
    buckets: vi.fn(async () => ["backups"]),
    putText: vi.fn(
      async (_a: number, _b: string, key: string, text: string) => {
        bucket.set(key, text);
      },
    ),
    list: vi.fn(async (_a: number, _b: string, prefix: string) =>
      [...bucket.keys()]
        .filter((key) => key.startsWith(prefix))
        .map((key) => ({ key, size: 1, modifiedAt: null })),
    ),
    getText: vi.fn(async (_a: number, _b: string, key: string) => {
      const text = bucket.get(key);
      if (!text) throw new Error("not found");
      return text;
    }),
    remove: vi.fn(async (_a: number, _b: string, key: string) => {
      bucket.delete(key);
    }),
  };

  async function start(withStorage = true) {
    bucket.clear();
    let router: Router | null = null;
    mock = createMockCtx({
      sandbox: true,
      pluginId: manifest.id,
      manifest,
      capabilities: manifest.capabilities,
      router: () => (router = express.Router()),
      permissions: ["import-export.use"],
      services: withStorage ? { "object-storage.files": files } : {},
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

  it("says when Object Storage is missing", async () => {
    await start(false);
    const res = await request("GET", "/backup");
    expect(res.body).toMatchObject({ available: false, config: null });
    const save = await request("PUT", "/backup", {
      accountId: 1,
      bucket: "backups",
      passphrase: "long enough",
    });
    expect(save.status).toBe(409);
  });

  it("saves without showing the passphrase, backs up, keeps N and restores", async () => {
    await start();
    expect(
      (await request("PUT", "/backup", { accountId: 1, bucket: "backups" }))
        .status,
    ).toBe(400);
    const saved = await request("PUT", "/backup", {
      accountId: 1,
      bucket: "backups",
      prefix: "termix",
      schedule: "daily",
      hour: 2,
      keep: 1,
      passphrase: "long enough",
    });
    expect(saved.status).toBe(200);
    expect(saved.body.config).toMatchObject({
      prefix: "termix/",
      hasPassphrase: true,
    });
    expect(JSON.stringify(saved.body)).not.toContain("long enough");

    vi.spyOn(mock.ctx.hosts, "exportMany").mockResolvedValue({
      hosts: [{ name: "web", ip: "10.0.0.1", password: "hunter2" }],
    });
    bucket.set("termix/termix-hosts-20200101-000000.json", "old");
    const run = await request("POST", "/backup/run");
    expect(run.status).toBe(200);
    expect(run.body.hosts).toBe(1);
    expect([...bucket.keys()]).toEqual([run.body.key]);
    expect(bucket.get(run.body.key)).not.toContain("hunter2");

    const listed = await request("GET", "/backup/files");
    expect(listed.body.files).toHaveLength(1);

    const importMany = vi
      .spyOn(mock.ctx.hosts, "importMany")
      .mockResolvedValue({
        success: 1,
        updated: 0,
        skipped: 0,
        failed: 0,
        errors: [],
        createdHostIds: [],
      });
    const bad = await request("POST", "/backup/restore", {
      key: run.body.key,
      passphrase: "not the one",
    });
    expect(bad.status).toBe(400);
    const restored = await request("POST", "/backup/restore", {
      key: run.body.key,
    });
    expect(restored.body).toMatchObject({ success: 1 });
    expect(importMany.mock.calls[0][0][0]).toMatchObject({
      name: "web",
      password: "hunter2",
    });

    const outside = await request("POST", "/backup/restore", {
      key: "elsewhere/termix-hosts-20200101-000000.json",
    });
    expect(outside.status).toBe(400);
  });
});
