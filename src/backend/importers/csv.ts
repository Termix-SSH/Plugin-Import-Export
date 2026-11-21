/**
 * Termius CSV, as its import template and the community exporters write
 * it (Groups, Label, Tags, Hostname/IP, Protocol, Port, Username, Password),
 * and any other host CSV with similar headers.
 */

import {
  folderParts,
  portOf,
  splitUserHost,
  type ConnectionType,
  type ImportFile,
  type ParseOutput,
} from "./types.js";

type Column =
  | "name"
  | "host"
  | "port"
  | "user"
  | "password"
  | "folder"
  | "tags"
  | "protocol"
  | "notes"
  | "key";

const ALIASES: Record<Column, string[]> = {
  name: ["label", "name", "alias", "title", "session", "sessionname"],
  host: [
    "hostnameip",
    "hostname",
    "host",
    "ip",
    "ipaddress",
    "address",
    "server",
  ],
  port: ["port", "sshport"],
  user: ["username", "user", "login"],
  password: ["password", "pass"],
  folder: ["groups", "group", "folder", "path", "directory"],
  tags: ["tags", "tag", "labels"],
  protocol: ["protocol", "type", "connectiontype"],
  notes: ["notes", "note", "description", "comment", "comments"],
  key: ["sshkey", "key", "keyfile", "identityfile", "privatekey"],
};

/** RFC 4180 rows. Quoted cells may hold commas, quotes and newlines. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const input = text.replace(/^﻿/, "");
  const delimiter = detectDelimiter(input);
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell === "") {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && input[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((value) => value.trim() !== "")) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }
  row.push(cell);
  if (row.some((value) => value.trim() !== "")) rows.push(row);
  return rows;
}

function detectDelimiter(text: string): string {
  const header = text.split(/\r?\n/, 1)[0] ?? "";
  const counts = [",", ";", "\t"].map(
    (d) => [d, header.split(d).length] as const,
  );
  return counts.sort((a, b) => b[1] - a[1])[0][0];
}

function normalize(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Which column holds what, from the header row. */
export function mapHeader(header: string[]): Partial<Record<Column, number>> {
  const map: Partial<Record<Column, number>> = {};
  const normalized = header.map(normalize);
  for (const column of Object.keys(ALIASES) as Column[]) {
    for (const alias of ALIASES[column]) {
      const index = normalized.indexOf(alias);
      if (index !== -1 && !Object.values(map).includes(index)) {
        map[column] = index;
        break;
      }
    }
  }
  return map;
}

export function looksLikeCsv(text: string): boolean {
  const rows = parseCsv(text.split(/\r?\n/, 1)[0] ?? "");
  return rows.length > 0 && mapHeader(rows[0]).host !== undefined;
}

function protocolOf(value: string): ConnectionType | null {
  const p = value.trim().toLowerCase();
  if (!p || p.includes("ssh") || p === "mosh" || p === "sftp") return "ssh";
  if (p.includes("telnet")) return "telnet";
  if (p.includes("rdp")) return "rdp";
  if (p.includes("vnc")) return "vnc";
  return null;
}

export function parseCsvHosts(files: ImportFile[]): ParseOutput {
  const out: ParseOutput = { hosts: [], skipped: [] };
  for (const file of files) {
    const [header, ...rows] = parseCsv(file.content);
    if (!header) continue;
    const map = mapHeader(header);
    const cell = (row: string[], column: Column) =>
      map[column] === undefined ? "" : (row[map[column]!] ?? "").trim();
    for (const row of rows) {
      const raw = cell(row, "host");
      const name = cell(row, "name") || raw;
      if (!raw) {
        out.skipped.push({ name: name || "?", code: "noHost" });
        continue;
      }
      const protocolText = cell(row, "protocol");
      const type = protocolOf(protocolText);
      if (!type) {
        out.skipped.push({ name, code: "protocol", detail: protocolText });
        continue;
      }
      const { user, host } = splitUserHost(raw);
      const key = cell(row, "key");
      const notes = [cell(row, "notes"), key ? `Key: ${key}` : ""]
        .filter(Boolean)
        .join("\n");
      const password = cell(row, "password");
      out.hosts.push({
        name,
        ip: host,
        port: portOf(cell(row, "port"), type),
        username: cell(row, "user") || user,
        folder: folderParts(cell(row, "folder"), /\//),
        tags: cell(row, "tags")
          .split(/[,;]/)
          .map((tag) => tag.trim())
          .filter(Boolean),
        notes,
        connectionType: type,
        ...(password ? { password } : {}),
      });
    }
  }
  return out;
}
