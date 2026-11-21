import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";

/** A hosts backup file: the export, sealed with a passphrase. */
export interface BackupEnvelope {
  termix: "hosts-backup";
  v: 1;
  kdf: "scrypt";
  n: number;
  salt: string;
  iv: string;
  tag: string;
  data: string;
}

const N = 1 << 15;
const KEY_BYTES = 32;

function keyFor(passphrase: string, salt: Buffer, n: number): Buffer {
  return scryptSync(passphrase, salt, KEY_BYTES, {
    N: n,
    r: 8,
    p: 1,
    maxmem: 128 * n * 8 * 2,
  });
}

export function sealBackup(plain: string, passphrase: string): string {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFor(passphrase, salt, N), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const envelope: BackupEnvelope = {
    termix: "hosts-backup",
    v: 1,
    kdf: "scrypt",
    n: N,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
  return JSON.stringify(envelope);
}

export class BackupPassphraseError extends Error {}

export function openBackup(text: string, passphrase: string): string {
  let envelope: BackupEnvelope;
  try {
    envelope = JSON.parse(text) as BackupEnvelope;
  } catch {
    throw new Error("This is not a Termix hosts backup");
  }
  if (envelope?.termix !== "hosts-backup" || envelope.v !== 1) {
    throw new Error("This is not a Termix hosts backup");
  }
  const n = Number(envelope.n);
  if (!Number.isInteger(n) || n < 1 << 14 || n > 1 << 20) {
    throw new Error("This backup is damaged");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    keyFor(passphrase, Buffer.from(envelope.salt, "base64"), n),
    Buffer.from(envelope.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  try {
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.data, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new BackupPassphraseError("The passphrase is wrong");
  }
}
