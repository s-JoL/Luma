import type { FileSearchMode } from "@shared/types.ts";
import { SECRET, type Config } from "../config.ts";
import type { SecretVault } from "../crypto/secrets.ts";
import type { Store } from "../store/store.ts";
import { chunkPages } from "./chunk.ts";
import { createEmbeddingClient, normalizeVector } from "./embed.ts";
import { extract, isExtractable } from "./extract.ts";
import { VectorIndex } from "./vectors.ts";

/** Reciprocal-rank-fusion constant, matching the previous hybrid ranker. */
const RRF_K = 60;

export interface SearchHit {
  chunkId: string;
  id: string;
  name: string;
  excerpt: string;
  page: number | null;
  chunk: number;
  semanticScore: number | null;
  matchType: "keyword" | "semantic" | "hybrid";
  retrievalScore: number;
}

export interface SearchResult {
  mode: FileSearchMode;
  results: SearchHit[];
  index: { total: number; ready: number };
}

/**
 * In-process retrieval. Chunks and vectors live in the same SQLite file as
 * everything else, so there is no second service to start, authenticate, or
 * keep in sync.
 */
export class Retrieval {
  private readonly vectors: VectorIndex;

  constructor(
    private readonly store: Store,
    private readonly config: Config,
    private readonly vault: SecretVault,
  ) {
    this.vectors = new VectorIndex(store);
  }

  private client() {
    return createEmbeddingClient(this.config.capabilities().embedding, this.vault.get(SECRET.embedding));
  }

  embeddingAvailable() {
    return Boolean(this.client());
  }

  async indexFile(file: { id: string; name: string; mime: string; diskPath: string }) {
    // A deduplicated upload hands the caller back the row that already held those
    // bytes, so the id this was called with can belong to no row at all — and
    // chunks written against it would fail their foreign key.
    if (!this.store.getFile(file.id)) return { chunks: 0, embedded: 0 };
    if (!isExtractable(file.name, file.mime)) {
      this.store.setFileEmbeddingStatus(file.id, "none");
      return { chunks: 0, embedded: 0 };
    }
    this.store.setFileEmbeddingStatus(file.id, "pending");
    try {
      const capability = this.config.capabilities().embedding;
      const extraction = await extract(file.diskPath, file.name, file.mime);
      const chunks = chunkPages(extraction.pages, capability.chunkSize, capability.chunkOverlap);
      this.store.replaceChunks(file.id, chunks);
      if (extraction.pageCount != null) {
        this.store.db.run("UPDATE files SET page_count = ? WHERE id = ?", extraction.pageCount, file.id);
      }
      if (!chunks.length) {
        this.store.setFileEmbeddingStatus(file.id, "failed", "No extractable text");
        return { chunks: 0, embedded: 0 };
      }
      const client = this.client();
      if (!client) {
        // Keyword search still works, so a missing embedding key degrades the
        // feature instead of rejecting the upload.
        this.store.setFileEmbeddingStatus(file.id, "failed", "Embedding provider is not configured");
        return { chunks: chunks.length, embedded: 0 };
      }
      const vectors = await client.embed(chunks.map((chunk) => chunk.text));
      this.store.replaceEmbeddings(
        file.id,
        client.model,
        vectors.map((vector, index) => ({ chunkId: `${file.id}:chunk:${chunks[index]!.idx}`, vector })),
      );
      this.store.setFileEmbeddingStatus(file.id, "ready");
      return { chunks: chunks.length, embedded: vectors.length };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.setFileEmbeddingStatus(file.id, "failed", message);
      throw error;
    }
  }

  /**
   * The ceiling is 50 rather than the default 10 so that an HTTP caller asking
   * for 30 gets 30: a limit that is silently clamped to a third of what was
   * asked for is worse than one that is not offered. The tool's own default
   * stays at 10 — LibreChat asks for 4 and Open WebUI 3–5, but they are feeding
   * far smaller windows than the 256k–1M ones here.
   */
  async searchFiles(query: string, mode: FileSearchMode, limit = 10): Promise<SearchResult> {
    const normalized = query.trim();
    const resultLimit = Math.min(50, Math.max(1, limit));
    const index = this.store.fileIndexSummary();
    if (!normalized) return { mode, results: [], index };

    // Three times the answer from each half, not twice: reciprocal rank fusion
    // earns its keep on what one retriever ranks deep and the other ranks high,
    // and a passage neither list reaches cannot be fused at all.
    const keyword = mode === "semantic" ? [] : this.keywordSearch(normalized, resultLimit * 3);
    const semantic = mode === "keyword" ? [] : await this.semanticSearch(normalized, resultLimit * 3);

    const merged = new Map<string, SearchHit>();
    keyword.forEach((hit, rank) => {
      merged.set(hit.chunkId, { ...hit, matchType: "keyword", retrievalScore: 1 / (RRF_K + rank + 1) });
    });
    semantic.forEach((hit, rank) => {
      const previous = merged.get(hit.chunkId);
      merged.set(hit.chunkId, {
        ...previous,
        ...hit,
        matchType: previous ? "hybrid" : "semantic",
        retrievalScore: (previous?.retrievalScore ?? 0) + 1 / (RRF_K + rank + 1),
      });
    });

    // Identical text, not an identical chunk id, is what costs the agent its
    // context: a library that predates content-addressed uploads holds documents
    // stored twice, and their chunks are different rows saying the same thing.
    const ordered = [...merged.values()].sort((left, right) => right.retrievalScore - left.retrievalScore);
    const seen = new Set<string>();
    const results: SearchHit[] = [];
    for (const hit of ordered) {
      if (seen.has(hit.excerpt)) continue;
      seen.add(hit.excerpt);
      results.push(hit);
      if (results.length === resultLimit) break;
    }
    return { mode, results, index };
  }

  private keywordSearch(query: string, limit: number): SearchHit[] {
    const rows = this.store.keywordChunks(query, limit);
    const names = new Map(
      this.store.fileSummaries([...new Set(rows.map((row) => row.fileId))]).map((file) => [file.id, file.name]),
    );
    return rows
      .filter((row) => names.has(row.fileId))
      .map((row) => ({
        chunkId: row.id,
        id: row.fileId,
        name: names.get(row.fileId)!,
        excerpt: row.text,
        page: row.page,
        chunk: row.idx,
        semanticScore: null,
        matchType: "keyword" as const,
        retrievalScore: 0,
      }));
  }

  private async semanticSearch(query: string, limit: number): Promise<SearchHit[]> {
    const client = this.client();
    if (!client) return [];
    const [queryVector] = await client.embed([query]);
    if (!queryVector) return [];
    const scored = this.vectors.search(client.model, normalizeVector(queryVector), limit);
    if (!scored.length) return [];
    const chunks = new Map(this.store.chunksByIds(scored.map((row) => row.chunkId)).map((row) => [row.id, row]));
    const names = new Map(
      this.store.fileSummaries([...new Set(scored.map((row) => row.fileId))]).map((file) => [file.id, file.name]),
    );
    return scored.flatMap((row) => {
      const chunk = chunks.get(row.chunkId);
      const name = names.get(row.fileId);
      if (!chunk || !name) return [];
      return [
        {
          chunkId: row.chunkId,
          id: row.fileId,
          name,
          excerpt: chunk.text,
          page: chunk.page,
          chunk: chunk.idx,
          // Distance, so callers compute relevance the same way they did
          // against pgvector: relevance = 1 - semanticScore.
          semanticScore: 1 - row.similarity,
          matchType: "semantic" as const,
          retrievalScore: 0,
        } satisfies SearchHit,
      ];
    });
  }
}
