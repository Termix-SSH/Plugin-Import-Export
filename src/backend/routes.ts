import type { Request, Response, Router } from "express";
import {
  PluginCapabilityError,
  type PluginContext,
  type PluginHostImportResult,
} from "@termix-ssh/plugin-sdk/backend";

const MAX_IMPORT_HOSTS = 100;

function summary(result: PluginHostImportResult): string {
  return `Import completed: ${result.success} created, ${result.updated} updated, ${result.skipped} skipped, ${result.failed} failed`;
}

function importResponse(result: PluginHostImportResult) {
  return {
    message: summary(result),
    success: result.success,
    updated: result.updated,
    skipped: result.skipped,
    failed: result.failed,
    errors: result.errors,
  };
}

function fail(res: Response, error: unknown, fallback: number) {
  if (error instanceof PluginCapabilityError) {
    return res.status(403).json({ error: error.message });
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/lacks the .* permission/.test(message)) {
    return res.status(403).json({ error: message });
  }
  return res.status(fallback).json({ error: message });
}

export function registerRoutes(router: Router, ctx: PluginContext): void {
  router.use(ctx.rbac.require("use") as never);

  /**
   * @openapi
   * /plugin-api/import-export/bulk-import:
   *   post:
   *     summary: Import hosts from Termix JSON rows
   *     description: Imports up to 100 hosts for the signed-in user. The user needs the host create and edit permissions.
   *     tags:
   *       - Import and Export
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - hosts
   *             properties:
   *               hosts:
   *                 type: array
   *                 items:
   *                   type: object
   *               overwrite:
   *                 type: boolean
   *                 description: Update a host that matches on address, port and username instead of skipping it.
   *               credentials:
   *                 type: array
   *                 description: Credential placeholders the hosts can refer to by credentialAlias.
   *                 items:
   *                   type: object
   *     responses:
   *       200:
   *         description: Import completed.
   *       400:
   *         description: Invalid request body.
   *       403:
   *         description: Not allowed to import hosts.
   */
  router.post("/bulk-import", async (req: Request, res: Response) => {
    const { hosts, overwrite, credentials } = req.body ?? {};
    if (!Array.isArray(hosts) || hosts.length === 0) {
      return res
        .status(400)
        .json({ error: "Hosts array is required and must not be empty" });
    }
    if (hosts.length > MAX_IMPORT_HOSTS) {
      return res.status(400).json({
        error: `Maximum ${MAX_IMPORT_HOSTS} hosts allowed per import`,
      });
    }
    try {
      const result = await ctx.hosts.importMany(hosts, {
        overwrite: overwrite === true,
        credentials: Array.isArray(credentials) ? credentials : undefined,
      });
      res.json(importResponse(result));
    } catch (error) {
      fail(res, error, 400);
    }
  });

  /**
   * @openapi
   * /plugin-api/import-export/ssh-config-import:
   *   post:
   *     summary: Import hosts from an OpenSSH config file
   *     description: Parses the text of an OpenSSH config file and imports the hosts it defines.
   *     tags:
   *       - Import and Export
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - content
   *             properties:
   *               content:
   *                 type: string
   *                 description: The text of the config file.
   *               overwrite:
   *                 type: boolean
   *     responses:
   *       200:
   *         description: Import completed.
   *       400:
   *         description: Invalid request body.
   *       403:
   *         description: Not allowed to import hosts.
   */
  router.post("/ssh-config-import", async (req: Request, res: Response) => {
    const { content, overwrite } = req.body ?? {};
    if (typeof content !== "string" || !content.trim()) {
      return res.status(400).json({ error: "Config content is required" });
    }
    try {
      const result = await ctx.hosts.importSshConfig(content, {
        overwrite: overwrite === true,
      });
      res.json(importResponse(result));
    } catch (error) {
      fail(res, error, 400);
    }
  });

  /**
   * @openapi
   * /plugin-api/import-export/export:
   *   get:
   *     summary: Export all of the signed-in user's hosts
   *     description: By default the hosts come with their passwords and keys decrypted. With share set, every secret is left out and hosts that use a saved credential point at a scrubbed credentials list by name. Every export is written to the audit log.
   *     tags:
   *       - Import and Export
   *     parameters:
   *       - in: query
   *         name: share
   *         required: false
   *         schema:
   *           type: string
   *         description: Set to 1 to export without secrets.
   *     responses:
   *       200:
   *         description: The exported hosts.
   *       403:
   *         description: Not allowed to export hosts.
   *       500:
   *         description: Export failed.
   */
  router.get("/export", async (req: Request, res: Response) => {
    const share = req.query.share === "1" || req.query.share === "true";
    try {
      const exported = await ctx.hosts.exportMany({ share });
      res.json(share ? exported : { hosts: exported.hosts });
    } catch (error) {
      fail(res, error, 500);
    }
  });

  /**
   * @openapi
   * /plugin-api/import-export/export/{id}:
   *   get:
   *     summary: Export one host with its passwords and keys
   *     tags:
   *       - Import and Export
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *     responses:
   *       200:
   *         description: The exported host.
   *       400:
   *         description: Invalid host id.
   *       403:
   *         description: Not allowed to export hosts.
   *       404:
   *         description: Host not found.
   */
  router.get(
    ["/export/:id", "/db/host/:id/export"],
    async (req: Request, res: Response) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id < 1) {
        return res.status(400).json({ error: "Invalid host id" });
      }
      try {
        const exported = await ctx.hosts.exportMany({ hostIds: [id] });
        const host = exported.hosts[0];
        if (!host) return res.status(404).json({ error: "SSH host not found" });
        res.json(host);
      } catch (error) {
        fail(res, error, 500);
      }
    },
  );
}
