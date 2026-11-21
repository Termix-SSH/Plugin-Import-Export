import { describe, expect, it } from "vitest";
import { decodeFileBytes } from "../../src/frontend/app-import";

const utf16le = (text: string, bom = true) => {
  const body = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i++) {
    body[i * 2] = text.charCodeAt(i) & 0xff;
    body[i * 2 + 1] = text.charCodeAt(i) >> 8;
  }
  return bom ? new Uint8Array([0xff, 0xfe, ...body]) : body;
};

describe("decodeFileBytes", () => {
  const reg =
    "Windows Registry Editor Version 5.00\r\n[HKEY_CURRENT_USER\Software]";

  it("reads a regedit export written as UTF-16", () => {
    expect(decodeFileBytes(utf16le(reg))).toBe(reg);
  });

  it("reads UTF-16 without a byte order mark", () => {
    expect(decodeFileBytes(utf16le(reg, false))).toBe(reg);
  });

  it("reads UTF-8 with and without a mark", () => {
    const bytes = new TextEncoder().encode("Label,Host\nü,1");
    expect(decodeFileBytes(bytes)).toBe("Label,Host\nü,1");
    expect(decodeFileBytes(new Uint8Array([0xef, 0xbb, 0xbf, ...bytes]))).toBe(
      "Label,Host\nü,1",
    );
  });
});
