/**
 * MobaXterm sessions: an exported .mxtsessions file, MobaXterm.ini or a
 * .mobaconf configuration. Sessions sit in [Bookmarks] sections, each with
 * a SubRep folder, one session per line:
 *   name=#109#0%host%22%user%...#MobaFont%...
 */

import {
  folderParts,
  portOf,
  type ConnectionType,
  type ImportFile,
  type ParseOutput,
} from "./types.js";

const TYPES: Record<string, ConnectionType> = {
  "109": "ssh",
  "140": "ssh",
  "98": "telnet",
  "91": "rdp",
  "128": "vnc",
};

const TYPE_NAMES: Record<string, string> = {
  "99": "Rlogin",
  "100": "Shell",
  "130": "FTP",
  "131": "Serial",
  "132": "File",
  "133": "Browser",
  "135": "Mosh",
  "136": "AWS S3",
  "137": "WSL",
  "77": "Xdmcp",
};

const KEY_FILE = /\.(ppk|pem|key)$|id_(rsa|ed25519|ecdsa|dsa)/i;

export function looksLikeMobaXterm(text: string): boolean {
  return /^\s*\[Bookmarks(_\d+)?\]/m.test(text);
}

export function parseMobaXterm(files: ImportFile[]): ParseOutput {
  const out: ParseOutput = { hosts: [], skipped: [] };
  for (const file of files) {
    let inBookmarks = false;
    let folder: string[] = [];
    for (const rawLine of file.content.split(/\r?\n/)) {
      const line = rawLine.trim();
      const section = line.match(/^\[(.+)\]$/);
      if (section) {
        inBookmarks = /^Bookmarks(_\d+)?$/i.test(section[1]);
        folder = [];
        continue;
      }
      if (!inBookmarks || !line.includes("=")) continue;
      const eq = line.indexOf("=");
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1);
      if (/^SubRep$/i.test(key)) {
        folder = folderParts(value, /\\/);
        continue;
      }
      if (/^ImgNum$/i.test(key) || !value.startsWith("#")) continue;

      const parts = value.split("#");
      const typeCode = parts[1] ?? "";
      const type = TYPES[typeCode];
      if (!type) {
        out.skipped.push({
          name: key,
          code: "protocol",
          detail: TYPE_NAMES[typeCode] ?? typeCode,
        });
        continue;
      }
      const fields = (parts[2] ?? "").split("%");
      const host = (fields[1] ?? "").trim();
      if (!host) {
        out.skipped.push({ name: key, code: "noHost" });
        continue;
      }
      const keyFile =
        type === "ssh" ? fields.find((f) => KEY_FILE.test(f)) : undefined;
      out.hosts.push({
        name: key,
        ip: host,
        port: portOf(fields[2], type),
        username: type === "vnc" ? "" : (fields[3] ?? "").trim(),
        folder,
        tags: [],
        notes: keyFile ? `Key: ${keyFile}` : "",
        connectionType: type,
      });
    }
  }
  return out;
}
