import type { Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { registerRoutes } from "./routes.js";
import { registerOperations } from "./operations.js";
import { createBackups, registerBackupRoutes } from "./s3-backup.js";

const TICK_MS = 60_000;

export async function activate(ctx: PluginContext) {
  const router = ctx.http.router<Router>();
  registerRoutes(router, ctx);
  registerOperations(ctx);
  const backups = createBackups(ctx);
  registerBackupRoutes(router, ctx, backups);
  ctx.schedule.every(
    TICK_MS,
    () =>
      backups
        .runDue()
        .catch((error: unknown) =>
          ctx.log.warn(
            `Scheduled hosts backups failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        ),
    { id: "backups", jitterMs: 5_000, runNow: true },
  );
}

export async function deactivate() {
  // Everything registered through ctx is disposed by core.
}
