export const APP_FORMATS = [
  "termius",
  "mobaxterm",
  "putty",
  "securecrt",
  "mremoteng",
] as const;

export type AppFormat = (typeof APP_FORMATS)[number];

export interface PreviewHost {
  name: string;
  ip: string;
  port: number;
  username: string;
  folder: string[];
  connectionType: "ssh" | "telnet" | "rdp" | "vnc";
  hasPassword: boolean;
}

export interface SkippedEntry {
  name: string;
  code: "noHost" | "protocol" | "password" | "invalid";
  detail?: string;
}

export interface Preview {
  format: AppFormat;
  hosts: PreviewHost[];
  skipped: SkippedEntry[];
}

export interface AppImportResult {
  success: number;
  updated: number;
  skipped: number;
  failed: number;
  errors: string[];
}

/**
 * Text from file bytes. regedit writes UTF-16 with a byte order mark, the
 * others UTF-8, sometimes with one.
 */
export function decodeFileBytes(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  }
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(bytes.subarray(3));
  }
  // UTF-16 without a mark still has a zero byte after most ASCII letters.
  const sample = bytes.subarray(0, 200);
  let zeros = 0;
  for (let i = 1; i < sample.length; i += 2) if (sample[i] === 0) zeros++;
  if (sample.length > 8 && zeros > sample.length / 4) {
    return new TextDecoder("utf-16le").decode(bytes);
  }
  return new TextDecoder("utf-8").decode(bytes);
}

export async function readImportFiles(
  files: Iterable<File>,
): Promise<Array<{ name: string; content: string }>> {
  const out: Array<{ name: string; content: string }> = [];
  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const relative = (file as File & { webkitRelativePath?: string })
      .webkitRelativePath;
    out.push({ name: relative || file.name, content: decodeFileBytes(bytes) });
  }
  return out;
}
