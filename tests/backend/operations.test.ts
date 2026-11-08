import { describe, expect, it, vi } from "vitest";
import { parseManifest } from "@termix-ssh/plugin-sdk/manifest";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import manifest from "../../manifest.json";
import { registerOperations } from "../../src/backend/operations.js";

type Handler = {
  run: (input: Record<string, unknown>, context: unknown) => Promise<any>;
};

function setup() {
  const handlers = new Map<string, Handler>();
  const exportMany = vi.fn(async () => ({
    hosts: [
      { exportId: "a", name: "web", ip: "10.0.0.1", port: 22, username: "me" },
    ],
  }));
  const importSshConfig = vi.fn(async () => ({
    success: 2,
    updated: 0,
    skipped: 1,
    failed: 0,
    errors: [],
  }));
  const ctx = {
    operations: {
      register: (id: string, handler: Handler) => handlers.set(id, handler),
    },
    hosts: { exportMany, importSshConfig },
  } as unknown as PluginContext;
  registerOperations(ctx);
  return { handlers, exportMany, importSshConfig };
}

const actions = (
  manifest.contributes as unknown as {
    operations: { actions: { id: string; risk: string; surfaces: object }[] };
  }
).operations.actions;

describe("declared operations", () => {
  it("is a valid manifest", () => {
    expect(parseManifest(manifest).errors ?? []).toEqual([]);
  });

  it("has a handler for every declared action", () => {
    const { handlers } = setup();
    expect([...handlers.keys()].sort()).toEqual(
      actions.map((a) => a.id).sort(),
    );
  });

  it("keeps the import away from the assistant and MCP", () => {
    const action = actions.find((a) => a.id.endsWith("ssh-config-import"));
    expect(action?.risk).toBe("change");
    expect(action?.surfaces).toMatchObject({ assistant: false, mcp: false });
  });
});

describe("handlers", () => {
  it("exports without secrets", async () => {
    const { handlers, exportMany } = setup();
    const result = await handlers
      .get("import-export.export")!
      .run({}, { userId: "u" });
    expect(exportMany).toHaveBeenCalledWith({ share: true });
    expect(result.data.rows[0]).toMatchObject({
      name: "web",
      host: "10.0.0.1",
    });
  });

  it("imports an ssh config", async () => {
    const { handlers, importSshConfig } = setup();
    const result = await handlers
      .get("import-export.ssh-config-import")!
      .run({ content: "Host a", overwrite: true }, {});
    expect(importSshConfig).toHaveBeenCalledWith("Host a", { overwrite: true });
    expect(result.changed).toBe(true);
  });

  it("refuses an empty config", async () => {
    const { handlers } = setup();
    await expect(
      handlers
        .get("import-export.ssh-config-import")!
        .run({ content: " " }, {}),
    ).rejects.toThrow();
  });
});
