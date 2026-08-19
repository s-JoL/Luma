import { VECTOR_CACHE_BYTES } from "../env.ts";
import type { EmbeddingPage, Store } from "../store/store.ts";

export interface ScoredVector {
  chunkId: string;
  fileId: string;
  similarity: number;
}

/**
 * Rows read at a time when the corpus is too large to hold. Sized by bytes
 * rather than rows because a row is whatever the embedding model returns — 16 KB
 * at 4096 dimensions, 6 KB at 1536.
 */
const PAGE_BYTES = 8 * 1024 * 1024;

/**
 * Cosine search over the stored vectors.
 *
 * Vectors are unit length at write time, so a cosine is a dot product and the
 * whole search is one pass of multiply-adds. What used to make that expensive
 * was not the arithmetic but the trip to it: every search read every blob out of
 * SQLite, allocated a `Float32Array` and a wrapper object per row, then sorted
 * the entire corpus to take ten hits from the front. At the live corpus that is
 * 76 MB of copying and ten thousand allocations for one question.
 *
 * So the matrix is packed once and kept, keyed by the store's write counter, and
 * scoring runs over the flat buffer with no allocation per row and no full sort.
 * Past `VECTOR_CACHE_BYTES` nothing is kept and the same kernel runs page by
 * page instead, which costs the reads back but never the memory.
 */
export class VectorIndex {
  private cached?: { model: string; revision: number; page: EmbeddingPage };

  constructor(private readonly store: Store) {}

  search(model: string, probe: Float32Array, limit: number): ScoredVector[] {
    const { rows, dim, revision } = this.store.embeddingSummary(model);
    if (!rows || !dim) return [];
    const best = new Best(limit);
    const cached = this.matrix(model, dim, rows, revision);
    if (cached) {
      score(cached, probe, best);
    } else {
      const perPage = Math.max(1, Math.floor(PAGE_BYTES / (dim * 4)));
      for (const page of this.store.embeddingPages(model, dim, perPage)) score(page, probe, best);
    }
    return best.entries();
  }

  private matrix(model: string, dim: number, rows: number, revision: number) {
    const cached = this.cached;
    if (cached && cached.model === model && cached.revision === revision) return cached.page;
    if (rows * dim * 4 > VECTOR_CACHE_BYTES) {
      this.cached = undefined;
      return undefined;
    }
    // One page wide enough for the whole corpus, so the matrix is the read
    // itself rather than a copy of it.
    for (const page of this.store.embeddingPages(model, dim, rows)) {
      this.cached = { model, revision, page };
      return page;
    }
    return undefined;
  }
}

function score(page: EmbeddingPage, probe: Float32Array, best: Best) {
  const { data, dim, chunkIds, fileIds } = page;
  const width = Math.min(dim, probe.length);
  for (let row = 0; row < chunkIds.length; row += 1) {
    const base = row * dim;
    let sum = 0;
    for (let index = 0; index < width; index += 1) sum += data[base + index]! * probe[index]!;
    best.offer(chunkIds[row]!, fileIds[row]!, sum);
  }
}

/**
 * The best `limit` hits, without ordering the corpus to find them. A search asks
 * for at most twenty, so an insertion into a list that short is cheaper than
 * carrying a scored object per row into a sort.
 */
class Best {
  private readonly scores: number[] = [];
  private readonly chunkIds: string[] = [];
  private readonly fileIds: string[] = [];

  constructor(private readonly limit: number) {}

  offer(chunkId: string, fileId: string, similarity: number) {
    const full = this.scores.length >= this.limit;
    if (full && similarity <= this.scores[this.scores.length - 1]!) return;
    let at = this.scores.length;
    while (at > 0 && this.scores[at - 1]! < similarity) at -= 1;
    this.scores.splice(at, 0, similarity);
    this.chunkIds.splice(at, 0, chunkId);
    this.fileIds.splice(at, 0, fileId);
    if (full) {
      this.scores.pop();
      this.chunkIds.pop();
      this.fileIds.pop();
    }
  }

  entries(): ScoredVector[] {
    return this.chunkIds.map((chunkId, index) => ({
      chunkId,
      fileId: this.fileIds[index]!,
      similarity: this.scores[index]!,
    }));
  }
}
