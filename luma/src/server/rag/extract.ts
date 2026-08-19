import fs from "node:fs/promises";

export interface ExtractedPage {
  page: number | null;
  text: string;
}

export interface Extraction {
  pages: ExtractedPage[];
  pageCount: number | null;
}

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** Media whose bytes are never text, so there is nothing to try. */
const OPAQUE = ["image/", "audio/", "video/", "font/", "model/"];

const extensionOf = (name: string) => name.split(".").pop()?.toLowerCase() ?? "";

/**
 * Whether it is worth trying to read this file as a document.
 *
 * There used to be a list of forty extensions here, which meant a `.vue`, a
 * `.rst` or a `.kt` was silently unsearchable until someone thought to add it.
 * The list is unnecessary: text is a property of the bytes, and `decodeText`
 * below can simply look. Only genuinely opaque media is ruled out in advance,
 * because for those the answer is knowable without reading anything.
 */
export function isExtractable(_name: string, mime: string) {
  return !OPAQUE.some((prefix) => mime.startsWith(prefix));
}

/**
 * The file's text, or empty when the bytes are not text at all.
 *
 * Strict UTF-8 decoding is the test, plus a NUL check, since a NUL byte is the
 * oldest and most reliable sign that a file is binary. A caller that gets ""
 * treats the file as having no extractable content, which is the truth.
 */
function decodeText(bytes: Buffer) {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
    return text.includes("\u0000") ? "" : text;
  } catch {
    return "";
  }
}

/** Splits a document into page-tagged text. Non-paginated formats yield one page with `page: null`. */
export async function extract(diskPath: string, name: string, mime: string): Promise<Extraction> {
  if (mime === "application/pdf" || extensionOf(name) === "pdf") return extractPdf(diskPath);
  if (mime === DOCX || extensionOf(name) === "docx") return extractDocx(diskPath);
  const text = normalize(decodeText(await fs.readFile(diskPath)));
  return { pages: text ? [{ page: null, text }] : [], pageCount: null };
}

async function extractPdf(diskPath: string): Promise<Extraction> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(await fs.readFile(diskPath));
  const document = await pdfjs.getDocument({ data, useSystemFonts: true, isEvalSupported: false }).promise;
  const pages: ExtractedPage[] = [];
  try {
    for (let index = 1; index <= document.numPages; index++) {
      const page = await document.getPage(index);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ");
      page.cleanup();
      const normalized = normalize(text);
      if (normalized) pages.push({ page: index, text: normalized });
    }
    return { pages, pageCount: document.numPages };
  } finally {
    await document.destroy();
  }
}

async function extractDocx(diskPath: string): Promise<Extraction> {
  const mammoth = await import("mammoth");
  const result = await mammoth.extractRawText({ path: diskPath });
  return { pages: [{ page: null, text: normalize(result.value) }], pageCount: null };
}

function normalize(text: string) {
  return text
    .replaceAll("\r\n", "\n")
    .replaceAll("\u0000", "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}
