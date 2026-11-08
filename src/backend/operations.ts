import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";

/**
 * Export always runs in share mode so the assistant and MCP never see
 * passwords or keys.
 */
export function registerOperations(ctx: PluginContext): void {
  if (typeof ctx.operations?.register !== "function") return;

  ctx.operations.register("import-export.export", {
    run: async () => {
      const exported = await ctx.hosts.exportMany({ share: true });
      const rows = exported.hosts.map((host) => {
        const row = host as Record<string, unknown>;
        return {
          id: String(row.exportId ?? row.name ?? row.ip),
          name: String(row.name || row.ip || ""),
          host: String(row.ip ?? ""),
          port: row.port,
          username: String(row.username ?? ""),
          folder: String(row.folder ?? ""),
        };
      });
      return { summary: `${rows.length} hosts`, data: { rows } };
    },
  });

  ctx.operations.register("import-export.ssh-config-import", {
    run: async (input) => {
      const content = typeof input.content === "string" ? input.content : "";
      if (!content.trim()) throw new Error("Config content is required");
      const result = await ctx.hosts.importSshConfig(content, {
        overwrite: input.overwrite === true,
      });
      return {
        summary: `${result.success} created, ${result.updated} updated, ${result.skipped} skipped, ${result.failed} failed`,
        changed: result.success + result.updated > 0,
        data: { errors: result.errors },
      };
    },
  });
}
