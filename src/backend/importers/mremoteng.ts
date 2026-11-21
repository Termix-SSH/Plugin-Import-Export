/**
 * mRemoteNG connections (confCons.xml). Passwords are AES-GCM with a key
 * from PBKDF2-HMAC-SHA1 of the master password, laid out as
 * salt(16) | nonce(16) | ciphertext | tag(16) with the salt as associated
 * data. Files from before 1.75 use AES-CBC with an MD5 key. Without a
 * master password set, mRemoteNG uses "mR3m".
 */

import crypto from "node:crypto";
import type { Element } from "@xmldom/xmldom";
import {
  ImportFormatError,
  portOf,
  type ConnectionType,
  type ImportFile,
  type ParseOutput,
} from "./types.js";
import { childElements, parseXml } from "./xml.js";

export const DEFAULT_MASTER_PASSWORD = "mR3m";

const PROTOCOLS: Record<string, ConnectionType> = {
  ssh1: "ssh",
  ssh2: "ssh",
  telnet: "telnet",
  rdp: "rdp",
  vnc: "vnc",
};

interface Cipher {
  gcm: boolean;
  iterations: number;
}

export function looksLikeMremoteng(text: string): boolean {
  return /<(?:\w+:)?Connections\b[^>]*\bConfVersion=/.test(text);
}

/** Decrypts one value, or returns null when the password does not fit. */
export function decryptValue(
  value: string,
  password: string,
  cipher: Cipher,
): string | null {
  try {
    const data = Buffer.from(value, "base64");
    if (cipher.gcm) {
      if (data.length < 48) return null;
      const salt = data.subarray(0, 16);
      const nonce = data.subarray(16, 32);
      const tag = data.subarray(data.length - 16);
      const body = data.subarray(32, data.length - 16);
      const key = crypto.pbkdf2Sync(
        // BouncyCastle keeps the low byte of each character.
        Buffer.from(password, "latin1"),
        salt,
        cipher.iterations,
        32,
        "sha1",
      );
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
      decipher.setAAD(salt);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(body), decipher.final()]).toString(
        "utf8",
      );
    }
    if (data.length < 32) return null;
    const key = crypto.createHash("md5").update(password, "utf8").digest();
    const decipher = crypto.createDecipheriv(
      "aes-128-cbc",
      key,
      data.subarray(0, 16),
    );
    return Buffer.concat([
      decipher.update(data.subarray(16)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}

function cipherOf(root: Element): Cipher {
  const engine = root.getAttribute("EncryptionEngine");
  const mode = root.getAttribute("BlockCipherMode");
  const iterations = Number.parseInt(
    root.getAttribute("KdfIterations") ?? "",
    10,
  );
  return {
    gcm: !!engine && (mode ?? "GCM").toUpperCase() === "GCM",
    iterations:
      Number.isInteger(iterations) && iterations > 0 ? iterations : 1000,
  };
}

/** The master password that opens this file. */
function masterPassword(
  root: Element,
  given: string | undefined,
  cipher: Cipher,
): string {
  const marker = root.getAttribute("Protected");
  const candidates = [DEFAULT_MASTER_PASSWORD, ...(given ? [given] : [])];
  if (!marker) return given || DEFAULT_MASTER_PASSWORD;
  for (const candidate of candidates) {
    const opened = decryptValue(marker, candidate, cipher);
    if (opened === "ThisIsNotProtected" || opened === "ThisIsProtected") {
      return candidate;
    }
  }
  throw given
    ? new ImportFormatError("wrongPassword", "The master password is wrong")
    : new ImportFormatError(
        "needsPassword",
        "This file is protected with a master password",
      );
}

function walk(
  parent: Element,
  folder: string[],
  decrypt: (value: string) => string | null,
  out: ParseOutput,
) {
  for (const node of childElements(parent, "Node")) {
    const name = node.getAttribute("Name") ?? "?";
    if (node.getAttribute("Type") === "Container") {
      walk(node, [...folder, name], decrypt, out);
      continue;
    }
    const protocol = node.getAttribute("Protocol") ?? "";
    const type = PROTOCOLS[protocol.toLowerCase()];
    if (!type) {
      out.skipped.push({ name, code: "protocol", detail: protocol });
      continue;
    }
    const host = (node.getAttribute("Hostname") ?? "").trim();
    if (!host) {
      out.skipped.push({ name, code: "noHost" });
      continue;
    }
    const sealed = node.getAttribute("Password") ?? "";
    const password = sealed ? decrypt(sealed) : "";
    if (password === null) {
      out.skipped.push({ name, code: "password" });
    }
    const domain = (node.getAttribute("Domain") ?? "").trim();
    out.hosts.push({
      name,
      ip: host,
      port: portOf(node.getAttribute("Port"), type),
      username: (node.getAttribute("Username") ?? "").trim(),
      folder,
      tags: [],
      notes: [
        (node.getAttribute("Descr") ?? "").trim(),
        domain ? `Domain: ${domain}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      connectionType: type,
      ...(password ? { password } : {}),
    });
  }
}

export function parseMremoteng(
  files: ImportFile[],
  given?: string,
): ParseOutput {
  const out: ParseOutput = { hosts: [], skipped: [] };
  for (const file of files) {
    let root = parseXml(file.content);
    const cipher = cipherOf(root);
    const password = masterPassword(root, given, cipher);
    const decrypt = (value: string) => decryptValue(value, password, cipher);
    if (root.getAttribute("FullFileEncryption")?.toLowerCase() === "true") {
      const opened = decrypt((root.textContent ?? "").trim());
      if (opened === null) {
        throw new ImportFormatError(
          "unreadable",
          "The file could not be decrypted",
        );
      }
      root = parseXml(`<Connections>${opened}</Connections>`);
    }
    walk(root, [], decrypt, out);
  }
  return out;
}
