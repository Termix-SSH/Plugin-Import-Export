/**
 * SecureCRT sessions: the XML from Tools, Export Settings, or the session
 * .ini files from its Config/Sessions folder.
 */

import type { Element } from "@xmldom/xmldom";
import {
  folderParts,
  portOf,
  type ConnectionType,
  type ImportFile,
  type ParseOutput,
} from "./types.js";
import { childElements, parseXml } from "./xml.js";

const PROTOCOLS: Record<string, ConnectionType> = {
  ssh2: "ssh",
  ssh1: "ssh",
  telnet: "telnet",
  "telnet/ssl": "telnet",
  rdp: "rdp",
};

const SKIPPED_KEYS = new Set(["Default", "__FolderData__"]);

export function looksLikeSecureCrtXml(text: string): boolean {
  return /<VanDyke\b/.test(text);
}

export function looksLikeSecureCrtIni(text: string): boolean {
  return /^S:"Hostname"=/m.test(text);
}

type Values = Record<string, string>;

function toHost(
  name: string,
  folder: string[],
  values: Values,
  out: ParseOutput,
) {
  const host = (values.Hostname ?? "").trim();
  if (!host) {
    out.skipped.push({ name, code: "noHost" });
    return;
  }
  const protocolName = (values["Protocol Name"] ?? "SSH2").trim();
  const type = PROTOCOLS[protocolName.toLowerCase()];
  if (!type) {
    out.skipped.push({ name, code: "protocol", detail: protocolName });
    return;
  }
  const port =
    type === "ssh"
      ? (values["[SSH2] Port"] ?? values["[SSH1] Port"] ?? values.Port)
      : (values.Port ?? values["[Telnet] Port"]);
  const keyFile = (
    values["Identity Filename V2"] ??
    values["Identity Filename"] ??
    ""
  )
    .split(":")
    .pop()
    ?.trim();
  out.hosts.push({
    name,
    ip: host,
    port: portOf(port, type),
    username: (values.Username ?? "").trim(),
    folder,
    tags: [],
    notes: [
      (values.Description ?? "").trim(),
      values["Use Global Public Key"] !== "1" && keyFile
        ? `Key: ${keyFile}`
        : "",
    ]
      .filter(Boolean)
      .join("\n"),
    connectionType: type,
  });
}

function valuesOf(key: Element): Values {
  const values: Values = {};
  for (const child of childElements(key)) {
    if (child.localName === "key") continue;
    const name = child.getAttribute("name");
    if (!name) continue;
    if (child.localName === "array") {
      values[name] = childElements(child)
        .map((item) => item.textContent ?? "")
        .join("\n");
    } else {
      values[name] = child.textContent ?? "";
    }
  }
  return values;
}

function walk(key: Element, folder: string[], out: ParseOutput) {
  for (const child of childElements(key, "key")) {
    const name = child.getAttribute("name") ?? "";
    if (!name || SKIPPED_KEYS.has(name)) continue;
    const values = valuesOf(child);
    if ("Hostname" in values || "Protocol Name" in values) {
      toHost(name, folder, values, out);
    } else {
      walk(child, [...folder, name], out);
    }
  }
}

export function parseSecureCrt(files: ImportFile[]): ParseOutput {
  const out: ParseOutput = { hosts: [], skipped: [] };
  for (const file of files) {
    if (looksLikeSecureCrtXml(file.content)) {
      const root = parseXml(file.content);
      const sessions = childElements(root, "key").find(
        (key) => key.getAttribute("name") === "Sessions",
      );
      if (sessions) walk(sessions, [], out);
      continue;
    }
    // One session per .ini, named after the file; its folder is the path.
    const path = folderParts(file.name);
    const fileName = path.pop() ?? file.name;
    const name = fileName.replace(/\.ini$/i, "");
    if (SKIPPED_KEYS.has(name)) continue;
    const sessionsAt = path.findIndex(
      (part) => part.toLowerCase() === "sessions",
    );
    const folder = sessionsAt === -1 ? path : path.slice(sessionsAt + 1);
    const values: Values = {};
    for (const line of file.content.split(/\r?\n/)) {
      const match = line.match(/^([SD]):"([^"]+)"=(.*)$/);
      if (!match) continue;
      values[match[2]] =
        match[1] === "D" ? String(Number.parseInt(match[3], 16)) : match[3];
    }
    toHost(name, folder, values, out);
  }
  return out;
}
