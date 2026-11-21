import type { Request, Response, Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import {
  BackupPassphraseError,
  openBackup,
  sealBackup,
} from "./backup-crypto.js";
import { keepAwake } from "./keep-awake.js";

/** What Object Storage's object-storage.files 1.x gives. */
export interface ObjectStorageFiles {
  accounts: () => Promise<Array<{ id: number; name: string }>>;
  buckets: (accountId: number) => Promise<string[]>;
  putText: (
    accountId: number,
    bucket: string,
    key: string,
    text: string,
    contentType?: string,
  ) => Promise<void>;
  list: (
    accountId: number,
    bucket: string,
    prefix: string,
  ) => Promise<Array<{ key: string; size: number; modifiedAt: string | null }>>;
  getText: (accountId: number, bucket: string, key: string) => Promise<string>;
  remove: (accountId: number, bucket: string, key: string) => Promise<void>;
}

export type BackupSchedule = "off" | "daily" | "weekly";

export interface BackupConfig {
  accountId: number;
  bucket: string;
  prefix: string;
  schedule: BackupSchedule;
  /** Hour of the day, in UTC, for scheduled backups. */
  hour: number;
  keep: number;
  passphraseSealed: string;
  lastRunAt: string | null;
  lastStatus: "success" | "failed" | null;
  lastError: string | null;
  nextRunAt: string | null;
}

export type BackupConfigView = Omit<BackupConfig, "passphraseSealed"> & {
  hasPassphrase: boolean;
};

const KEY_PREFIX = "backup:";
const FILE = /^termix-hosts-\d{8}-\d{6}\.json$/;
const SERVICE = "object-storage.files";
const IMPORT_CHUNK = 100;

export class BackupError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/** The next time a schedule is due after `from`, or null when it is off. */
export function nextBackupAt(
  schedule: BackupSchedule,
  hour: number,
  from = new Date(),
): string | null {
  if (schedule === "off") return null;
  const next = new Date(
    Date.UTC(
      from.getUTCFullYear(),
      from.getUTCMonth(),
      from.getUTCDate(),
      hour,
      0,
      0,
    ),
  );
  if (next.getTime() <= from.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  if (schedule === "weekly") {
    // Sundays, so a weekly backup lands on a quiet day.
    while (next.getUTCDay() !== 0) next.setUTCDate(next.getUTCDate() + 1);
  }
  return next.toISOString();
}

export function backupFileName(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `termix-hosts-${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}.json`
  );
}

/** A folder prefix in the bucket: no leading slash, one trailing slash. */
export function cleanPrefix(value: unknown): string {
  const text = String(value ?? "")
    .trim()
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  if (text.length > 200 || /[\\\0-\x1f]|\.\./.test(text)) {
    throw new BackupError("The folder is not valid");
  }
  return text ? `${text}/` : "";
}

/** The backups among a listing, newest first. */
export function backupFiles(
  objects: Array<{ key: string; size: number; modifiedAt: string | null }>,
  prefix: string,
) {
  return objects
    .filter(
      (o) => o.key.startsWith(prefix) && FILE.test(o.key.slice(prefix.length)),
    )
    .sort((a, b) => b.key.localeCompare(a.key));
}

export function createBackups(ctx: PluginContext) {
  const keyOf = (userId: string) => `${KEY_PREFIX}${userId}`;

  async function files(): Promise<ObjectStorageFiles> {
    const providers = await ctx.services.providers(SERVICE).catch(() => []);
    if (providers.length === 0) {
      throw new BackupError(
        "Install and turn on the Object Storage plugin to back up to a bucket",
        409,
      );
    }
    return ctx.services.get<ObjectStorageFiles>(SERVICE);
  }

  async function available(): Promise<boolean> {
    return (await ctx.services.providers(SERVICE).catch(() => [])).length > 0;
  }

  async function read(userId: string): Promise<BackupConfig | null> {
    const value = await ctx.kv.get(keyOf(userId));
    return value && typeof value === "object" ? (value as BackupConfig) : null;
  }

  async function write(userId: string, config: BackupConfig) {
    await ctx.kv.set(keyOf(userId), config);
  }

  function view(config: BackupConfig | null): BackupConfigView | null {
    if (!config) return null;
    const { passphraseSealed, ...rest } = config;
    return { ...rest, hasPassphrase: !!passphraseSealed };
  }

  async function save(userId: string, raw: Record<string, unknown>) {
    const old = await read(userId);
    const accountId = Number(raw.accountId);
    if (!Number.isSafeInteger(accountId) || accountId < 1) {
      throw new BackupError("Pick an object storage login");
    }
    const bucket = String(raw.bucket ?? "").trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,62}$/.test(bucket)) {
      throw new BackupError("Pick a bucket");
    }
    const schedule: BackupSchedule =
      raw.schedule === "daily" || raw.schedule === "weekly"
        ? raw.schedule
        : "off";
    const hour = Number(raw.hour ?? 3);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
      throw new BackupError("The hour must be from 0 to 23");
    }
    const keep = Number(raw.keep ?? 14);
    if (!Number.isInteger(keep) || keep < 1 || keep > 365) {
      throw new BackupError("Keep from 1 to 365 backups");
    }
    const passphrase = typeof raw.passphrase === "string" ? raw.passphrase : "";
    if (passphrase && passphrase.length < 8) {
      throw new BackupError("The passphrase needs at least 8 characters");
    }
    if (!passphrase && !old?.passphraseSealed) {
      throw new BackupError("Set a passphrase to lock the backups");
    }
    // The login and bucket must be ones this user can reach.
    const service = await files();
    if (!(await service.accounts()).some((a) => a.id === accountId)) {
      throw new BackupError("That object storage login was not found", 404);
    }
    const config: BackupConfig = {
      accountId,
      bucket,
      prefix: cleanPrefix(raw.prefix),
      schedule,
      hour,
      keep,
      passphraseSealed: passphrase
        ? await ctx.secrets.seal(passphrase)
        : old!.passphraseSealed,
      lastRunAt: old?.lastRunAt ?? null,
      lastStatus: old?.lastStatus ?? null,
      lastError: old?.lastError ?? null,
      nextRunAt: nextBackupAt(schedule, hour),
    };
    await write(userId, config);
    if (config.nextRunAt) keepAwake(ctx, "backups", true);
    return view(config)!;
  }

  /** Exports the user's hosts with their secrets, locks and uploads it. */
  async function run(userId: string): Promise<{ key: string; hosts: number }> {
    const config = await read(userId);
    if (!config) throw new BackupError("Set up the backup first", 404);
    try {
      const passphrase = await ctx.secrets.unseal(config.passphraseSealed);
      if (!passphrase)
        throw new Error("The saved passphrase could not be read");
      const service = await files();
      const exported = await ctx.hosts.exportMany();
      const key = `${config.prefix}${backupFileName()}`;
      const body = sealBackup(
        JSON.stringify({ ...exported, exportedAt: new Date().toISOString() }),
        passphrase,
      );
      await service.putText(
        config.accountId,
        config.bucket,
        key,
        body,
        "application/json",
      );
      const all = backupFiles(
        await service.list(config.accountId, config.bucket, config.prefix),
        config.prefix,
      );
      for (const old of all.slice(config.keep)) {
        await service
          .remove(config.accountId, config.bucket, old.key)
          .catch(() => {});
      }
      await write(userId, {
        ...config,
        lastRunAt: new Date().toISOString(),
        lastStatus: "success",
        lastError: null,
      });
      return { key, hosts: exported.hosts.length };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await write(userId, {
        ...config,
        lastRunAt: new Date().toISOString(),
        lastStatus: "failed",
        lastError: message.slice(0, 500),
      });
      throw error;
    }
  }

  async function list(userId: string) {
    const config = await read(userId);
    if (!config) return [];
    const service = await files();
    return backupFiles(
      await service.list(config.accountId, config.bucket, config.prefix),
      config.prefix,
    );
  }

  async function restore(
    userId: string,
    key: string,
    passphrase: string,
    overwrite: boolean,
  ) {
    const config = await read(userId);
    if (!config) throw new BackupError("Set up the backup first", 404);
    if (
      !key.startsWith(config.prefix) ||
      !FILE.test(key.slice(config.prefix.length))
    ) {
      throw new BackupError("Pick one of the backups");
    }
    const service = await files();
    const secret =
      passphrase || (await ctx.secrets.unseal(config.passphraseSealed)) || "";
    let parsed: { hosts?: unknown; credentials?: unknown };
    try {
      parsed = JSON.parse(
        openBackup(
          await service.getText(config.accountId, config.bucket, key),
          secret,
        ),
      );
    } catch (error) {
      if (error instanceof BackupPassphraseError) {
        throw new BackupError(error.message, 400);
      }
      throw error;
    }
    const hosts = Array.isArray(parsed.hosts)
      ? (parsed.hosts as Record<string, unknown>[])
      : [];
    const credentials = Array.isArray(parsed.credentials)
      ? (parsed.credentials as Record<string, unknown>[])
      : undefined;
    const total = { success: 0, updated: 0, skipped: 0, failed: 0 };
    for (let i = 0; i < hosts.length; i += IMPORT_CHUNK) {
      const result = await ctx.hosts.importMany(
        hosts.slice(i, i + IMPORT_CHUNK),
        {
          overwrite,
          credentials: i === 0 ? credentials : undefined,
        },
      );
      total.success += result.success;
      total.updated += result.updated;
      total.skipped += result.skipped;
      total.failed += result.failed;
    }
    return total;
  }

  /** Runs the scheduled backups that are due, each as its owner. */
  async function runDue(now = new Date()) {
    let scheduled = false;
    for (const name of await ctx.kv.list()) {
      if (!name.startsWith(KEY_PREFIX)) continue;
      const userId = name.slice(KEY_PREFIX.length);
      const config = await read(userId);
      if (config?.nextRunAt) scheduled = true;
      if (!config?.nextRunAt || config.nextRunAt > now.toISOString()) continue;
      await write(userId, {
        ...config,
        nextRunAt: nextBackupAt(config.schedule, config.hour, now),
      });
      try {
        await ctx.asUser(userId, () => run(userId));
      } catch (error) {
        await ctx.notify
          .send({
            title: "Hosts backup to object storage failed",
            body: error instanceof Error ? error.message : String(error),
            severity: "warning",
            category: "import-export.backup_failed",
            audience: { userId },
            dedupeKey: `import-export:backup:${userId}`,
          })
          .catch(() => {});
      }
    }
    // A scheduled backup keeps the process up so it starts on time.
    keepAwake(ctx, "backups", scheduled);
  }

  async function remove(userId: string) {
    await ctx.kv.delete(keyOf(userId));
  }

  return {
    available,
    files,
    read,
    view,
    save,
    run,
    list,
    restore,
    runDue,
    remove,
  };
}

export type Backups = ReturnType<typeof createBackups>;

/** The routes for the bucket backup, under /backup. */
export function registerBackupRoutes(
  router: Router,
  ctx: PluginContext,
  backups: Backups,
): void {
  const actor = () => ctx.currentActor()!;
  const handle =
    (fn: (req: Request) => Promise<unknown>) =>
    async (req: Request, res: Response) => {
      try {
        res.json(await fn(req));
      } catch (error) {
        if (error instanceof BackupError) {
          return res.status(error.status).json({ error: error.message });
        }
        ctx.log.warn(
          `Hosts backup failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        res
          .status(502)
          .json({ error: "The backup could not reach the bucket" });
      }
    };

  /**
   * @openapi
   * /plugin-api/import-export/backup:
   *   get:
   *     summary: Your hosts backup to object storage
   *     description: The backup setup of the signed in user without the passphrase, whether Object Storage is there, and the logins it can use.
   *     tags:
   *       - Import and Export
   *     responses:
   *       200:
   *         description: The setup.
   */
  router.get(
    "/backup",
    handle(async () => {
      const available = await backups.available();
      return {
        available,
        config: backups.view(await backups.read(actor())),
        accounts: available
          ? await (await backups.files()).accounts().catch(() => [])
          : [],
      };
    }),
  );

  /**
   * @openapi
   * /plugin-api/import-export/backup/buckets:
   *   get:
   *     summary: Buckets of an object storage login
   *     tags:
   *       - Import and Export
   *     parameters:
   *       - in: query
   *         name: accountId
   *         required: true
   *         schema:
   *           type: integer
   *     responses:
   *       200:
   *         description: The bucket names.
   */
  router.get(
    "/backup/buckets",
    handle(async (req) => ({
      buckets: await (
        await backups.files()
      ).buckets(Number(req.query.accountId)),
    })),
  );

  /**
   * @openapi
   * /plugin-api/import-export/backup:
   *   put:
   *     summary: Save the hosts backup setup
   *     description: Where backups go, how often and how many to keep. A new passphrase replaces the saved one; leave it empty to keep it.
   *     tags:
   *       - Import and Export
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               accountId:
   *                 type: integer
   *               bucket:
   *                 type: string
   *               prefix:
   *                 type: string
   *               schedule:
   *                 type: string
   *                 enum: [off, daily, weekly]
   *               hour:
   *                 type: integer
   *               keep:
   *                 type: integer
   *               passphrase:
   *                 type: string
   *     responses:
   *       200:
   *         description: The saved setup.
   */
  router.put(
    "/backup",
    handle(async (req) => ({
      config: await backups.save(
        actor(),
        (req.body ?? {}) as Record<string, unknown>,
      ),
    })),
  );

  /**
   * @openapi
   * /plugin-api/import-export/backup:
   *   delete:
   *     summary: Stop backing up to object storage
   *     description: Removes the setup. Backups already in the bucket stay.
   *     tags:
   *       - Import and Export
   *     responses:
   *       200:
   *         description: Removed.
   */
  router.delete(
    "/backup",
    handle(async () => {
      await backups.remove(actor());
      return { ok: true };
    }),
  );

  /**
   * @openapi
   * /plugin-api/import-export/backup/run:
   *   post:
   *     summary: Back up your hosts now
   *     tags:
   *       - Import and Export
   *     responses:
   *       200:
   *         description: The new backup file and how many hosts it holds.
   */
  router.post(
    "/backup/run",
    handle(async () => backups.run(actor())),
  );

  /**
   * @openapi
   * /plugin-api/import-export/backup/files:
   *   get:
   *     summary: Your backups in the bucket
   *     tags:
   *       - Import and Export
   *     responses:
   *       200:
   *         description: The backup files, newest first.
   */
  router.get(
    "/backup/files",
    handle(async () => ({ files: await backups.list(actor()) })),
  );

  /**
   * @openapi
   * /plugin-api/import-export/backup/restore:
   *   post:
   *     summary: Restore hosts from a backup
   *     description: Opens one of your backups and imports its hosts. Leave the passphrase empty to use the saved one.
   *     tags:
   *       - Import and Export
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [key]
   *             properties:
   *               key:
   *                 type: string
   *               passphrase:
   *                 type: string
   *               overwrite:
   *                 type: boolean
   *     responses:
   *       200:
   *         description: How many hosts were added, updated, skipped or failed.
   */
  router.post(
    "/backup/restore",
    handle(async (req) =>
      backups.restore(
        actor(),
        String(req.body?.key ?? ""),
        typeof req.body?.passphrase === "string" ? req.body.passphrase : "",
        req.body?.overwrite === true,
      ),
    ),
  );
}
