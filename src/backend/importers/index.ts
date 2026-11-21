import { looksLikeCsv, parseCsvHosts } from "./csv.js";
import { looksLikeMobaXterm, parseMobaXterm } from "./mobaxterm.js";
import { looksLikeMremoteng, parseMremoteng } from "./mremoteng.js";
import { looksLikePutty, parsePutty } from "./putty.js";
import {
  looksLikeSecureCrtIni,
  looksLikeSecureCrtXml,
  parseSecureCrt,
} from "./securecrt.js";
import {
  APP_FORMATS,
  ImportFormatError,
  type AppFormat,
  type ImportFile,
  type ParseOutput,
  type ParsedHost,
} from "./types.js";

export * from "./types.js";

export function isAppFormat(value: unknown): value is AppFormat {
  return APP_FORMATS.includes(value as AppFormat);
}

/** Guesses the app from the first file's content. */
export function detectFormat(files: ImportFile[]): AppFormat | null {
  const text = files[0]?.content ?? "";
  if (looksLikeMremoteng(text)) return "mremoteng";
  if (looksLikeSecureCrtXml(text) || looksLikeSecureCrtIni(text)) {
    return "securecrt";
  }
  if (looksLikePutty(text)) return "putty";
  if (looksLikeMobaXterm(text)) return "mobaxterm";
  if (looksLikeCsv(text)) return "termius";
  return null;
}

export function parseApp(
  format: AppFormat,
  files: ImportFile[],
  password?: string,
): ParseOutput {
  switch (format) {
    case "termius":
      return parseCsvHosts(files);
    case "mobaxterm":
      return parseMobaXterm(files);
    case "putty":
      return parsePutty(files);
    case "securecrt":
      return parseSecureCrt(files);
    case "mremoteng":
      return parseMremoteng(files, password);
  }
}

export function parseAuto(
  files: ImportFile[],
  format: AppFormat | null,
  password?: string,
): ParseOutput & { format: AppFormat } {
  const picked = format ?? detectFormat(files);
  if (!picked) {
    throw new ImportFormatError(
      "unknownFormat",
      "The file is not from a supported app",
    );
  }
  return { format: picked, ...parseApp(picked, files, password) };
}

export const FOLDER_SEPARATOR = " / ";

/** A Termix bulk import row. */
export function toTermixRow(
  host: ParsedHost,
  defaultUsername: string,
): Record<string, unknown> {
  const ssh = host.connectionType === "ssh";
  const username = host.username || (ssh ? defaultUsername : "");
  return {
    name: host.name,
    ip: host.ip,
    port: host.port,
    username,
    folder: host.folder.join(FOLDER_SEPARATOR) || undefined,
    tags: host.tags,
    notes: host.notes || undefined,
    connectionType: host.connectionType,
    authType: host.password ? "password" : "none",
    ...(host.password ? { password: host.password } : {}),
    enableSsh: ssh,
    enableTerminal: ssh,
    enableFileManager: ssh,
  };
}
