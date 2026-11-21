export const APP_FORMATS = [
  "termius",
  "mobaxterm",
  "putty",
  "securecrt",
  "mremoteng",
] as const;

export type AppFormat = (typeof APP_FORMATS)[number];

export type ConnectionType = "ssh" | "telnet" | "rdp" | "vnc";

export interface ImportFile {
  /** File name, or its path inside a picked folder. */
  name: string;
  content: string;
}

/** One host read from another app, before it becomes a Termix row. */
export interface ParsedHost {
  name: string;
  ip: string;
  port: number;
  username: string;
  /** Folder path parts, outermost first. */
  folder: string[];
  tags: string[];
  notes: string;
  connectionType: ConnectionType;
  password?: string;
}

/** Why an entry was left out. The UI turns the code into text. */
export interface SkippedEntry {
  name: string;
  code: "noHost" | "protocol" | "password" | "invalid";
  detail?: string;
}

export interface ParseOutput {
  hosts: ParsedHost[];
  skipped: SkippedEntry[];
}

export class ImportFormatError extends Error {
  constructor(
    readonly code:
      "needsPassword" | "wrongPassword" | "unreadable" | "unknownFormat",
    message: string,
  ) {
    super(message);
    this.name = "ImportFormatError";
  }
}

export const DEFAULT_PORTS: Record<ConnectionType, number> = {
  ssh: 22,
  telnet: 23,
  rdp: 3389,
  vnc: 5900,
};

/** A port from text, or the protocol's default. */
export function portOf(value: unknown, type: ConnectionType): number {
  const port = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(port) && port > 0 && port < 65536
    ? port
    : DEFAULT_PORTS[type];
}

/** Splits a folder path on any of the given separators. */
export function folderParts(path: string, separators = /[\\/]/): string[] {
  return path
    .split(separators)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** "user@host" in a host field, as PuTTY and others allow. */
export function splitUserHost(host: string): { user: string; host: string } {
  const at = host.lastIndexOf("@");
  return at > 0
    ? { user: host.slice(0, at), host: host.slice(at + 1) }
    : { user: "", host };
}
