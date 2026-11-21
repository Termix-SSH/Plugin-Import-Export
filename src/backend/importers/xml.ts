import { DOMParser, type Element } from "@xmldom/xmldom";
import { ImportFormatError } from "./types.js";

/** Parses XML or throws an unreadable error. External entities are never loaded. */
export function parseXml(text: string): Element {
  try {
    const doc = new DOMParser().parseFromString(
      text.replace(/^﻿/, ""),
      "text/xml",
    );
    const root = doc.documentElement;
    if (!root) throw new Error("No root element");
    return root;
  } catch (error) {
    throw new ImportFormatError(
      "unreadable",
      `The file is not valid XML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Direct child elements, optionally with one tag name. */
export function childElements(parent: Element, localName?: string): Element[] {
  const out: Element[] = [];
  for (let node = parent.firstChild; node; node = node.nextSibling) {
    if (node.nodeType !== 1) continue;
    const element = node as Element;
    if (!localName || element.localName === localName) out.push(element);
  }
  return out;
}
