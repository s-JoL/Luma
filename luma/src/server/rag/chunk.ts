import type { ExtractedPage } from "./extract.ts";

export interface Chunk {
  idx: number;
  page: number | null;
  text: string;
}

/**
 * Where a chunk is allowed to end, from the largest structure to the smallest.
 *
 * The ladder used to be a list of literal characters — `。`, `！`, `，`, `. `,
 * `; ` — which meant a document written in Chinese or English split on meaning
 * and a document written in Hindi, Arabic or Thai split mid-word on spaces,
 * because nobody had added `।` or `؟` to the list. Asking Unicode which
 * characters end a sentence covers every script at once and does not need a
 * maintainer to notice a new one.
 *
 * Every tier is a zero-width lookbehind, so splitting is lossless: the boundary
 * character stays with the text it terminates. Overlap semantics still match
 * LangChain's RecursiveCharacterTextSplitter, which is what LibreChat's RAG
 * service used.
 */
const SEPARATORS: RegExp[] = [
  /(?<=\n[ \t]*\n)/u,
  /(?<=\n)/u,
  /(?<=\p{Sentence_Terminal})(?!\p{Sentence_Terminal})/u,
  /(?<=\p{Terminal_Punctuation})(?!\p{Terminal_Punctuation})/u,
  /(?<=\s)(?!\s)/u,
];

function splitText(text: string, chunkSize: number, chunkOverlap: number): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= chunkSize) return [trimmed];
  return recursiveSplit(trimmed, SEPARATORS, chunkSize, Math.min(chunkOverlap, Math.floor(chunkSize / 2)));
}

function recursiveSplit(text: string, separators: RegExp[], size: number, overlap: number): string[] {
  const [separator, ...rest] = separators;
  // The ladder is never called empty; splitting by character is the terminating
  // case either way, and `hardSplit` below is what actually reaches it.
  const pieces = separator ? text.split(separator).filter(Boolean) : [...text];
  const output: string[] = [];
  let buffer: string[] = [];
  let bufferLength = 0;

  const flush = () => {
    const joined = buffer.join("").trim();
    if (joined) output.push(joined);
    if (!overlap) {
      buffer = [];
      bufferLength = 0;
      return;
    }
    // Carry back at most `overlap` characters. Taking pieces until the budget
    // was *reached* rather than while it still fit meant one long sentence could
    // be retained whole to satisfy a 120-character overlap, and every chunk
    // after it started that far over — 1.8x the document embedded, and chunks
    // wide enough to fail an embedding model's per-item limit. A last piece
    // longer than the overlap simply carries nothing, which is what LangChain's
    // splitter does too.
    let keptLength = 0;
    const kept: string[] = [];
    for (let index = buffer.length - 1; index >= 0; index--) {
      const piece = buffer[index]!;
      if (keptLength + piece.length > overlap) break;
      kept.unshift(piece);
      keptLength += piece.length;
    }
    buffer = kept;
    bufferLength = keptLength;
  };

  for (const piece of pieces) {
    if (piece.length > size) {
      if (bufferLength) flush();
      output.push(...(rest.length ? recursiveSplit(piece, rest, size, overlap) : hardSplit(piece, size, overlap)));
      continue;
    }
    if (bufferLength + piece.length > size && bufferLength) flush();
    buffer.push(piece);
    bufferLength += piece.length;
  }
  // The carried overlap can be the whole of a small buffer, in which case the
  // tail repeats the chunk before it verbatim. That one case is worth removing;
  // the blanket "drop any chunk equal to its predecessor" that used to sit here
  // also deleted a document's genuinely repeated lines — table rows, per-page
  // boilerplate, repeated contract clauses — and left the file looking indexed.
  const tail = buffer.join("").trim();
  if (tail && tail !== output.at(-1)) output.push(tail);
  return output;
}

/**
 * Last resort for text with no boundary of any kind: a long CJK paragraph, a
 * base64 blob. Cut by code point rather than by UTF-16 unit, or an emoji or a
 * CJK Extension-B character lands half in each chunk and the embedding provider
 * rejects the batch, which marks the whole file unindexed.
 */
function hardSplit(text: string, size: number, overlap: number) {
  const points = [...text];
  const step = Math.max(1, size - overlap);
  const output: string[] = [];
  for (let start = 0; start < points.length; start += step) {
    output.push(points.slice(start, start + size).join(""));
    if (start + size >= points.length) break;
  }
  return output;
}

export function chunkPages(pages: ExtractedPage[], chunkSize: number, chunkOverlap: number): Chunk[] {
  const chunks: Chunk[] = [];
  for (const page of pages) {
    for (const text of splitText(page.text, chunkSize, chunkOverlap)) {
      chunks.push({ idx: chunks.length, page: page.page, text });
    }
  }
  return chunks;
}
