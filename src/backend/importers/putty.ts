/**
 * PuTTY sessions from a registry export of
 * HKEY_CURRENT_USER\Software\SimonTatham\PuTTY\Sessions (regedit or
 * `reg export HKCU\Software\SimonTatham putty.reg`).
 */

import {
  portOf,
  splitUserHost,
  type ConnectionType,
  type ImportFile,
  type ParseOutput,
} from "./types.js";

const SESSION_KEY =
  /^\[HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\([^\]\\]+)\]$/i;

const PROTOCOLS: Record<string, ConnectionType> = {
  ssh: "ssh",
  telnet: "telnet",
};

export function looksLikePutty(text: string): boolean {
  return /SimonTatham\\PuTTY\\Sessions\\/i.test(text);
}

function unescapeReg(value: string): string {
  return value.replace(/\\(["\\])/g, "$1");
}

function sessionName(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function parsePutty(files: ImportFile[]): ParseOutput {
  const out: ParseOutput = { hosts: [], skipped: [] };
  for (const file of files) {
    const sessions: Array<{ name: string; values: Record<string, string> }> =
      [];
    let current: { name: string; values: Record<string, string> } | null = null;
    for (const rawLine of file.content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line.startsWith("[")) {
        const match = line.match(SESSION_KEY);
        current = match ? { name: sessionName(match[1]), values: {} } : null;
        if (current) sessions.push(current);
        continue;
      }
      if (!current) continue;
      const string = line.match(/^"([^"]+)"="((?:[^"\\]|\\.)*)"$/);
      if (string) {
        current.values[string[1]] = unescapeReg(string[2]);
        continue;
      }
      const dword = line.match(/^"([^"]+)"=dword:([0-9a-f]{1,8})$/i);
      if (dword)
        current.values[dword[1]] = String(Number.parseInt(dword[2], 16));
    }

    for (const { name, values } of sessions) {
      const hostField = (values.HostName ?? "").trim();
      if (!hostField) {
        // Default Settings and empty templates carry no host.
        if (name !== "Default Settings") {
          out.skipped.push({ name, code: "noHost" });
        }
        continue;
      }
      const protocol = (values.Protocol ?? "ssh").toLowerCase();
      const type = PROTOCOLS[protocol];
      if (!type) {
        out.skipped.push({ name, code: "protocol", detail: protocol });
        continue;
      }
      const { user, host } = splitUserHost(hostField);
      const keyFile = values.PublicKeyFile?.trim();
      out.hosts.push({
        name,
        ip: host,
        port: portOf(values.PortNumber, type),
        username: (values.UserName ?? "").trim() || user,
        folder: [],
        tags: [],
        notes: keyFile ? `Key: ${keyFile}` : "",
        connectionType: type,
      });
    }
  }
  return out;
}
