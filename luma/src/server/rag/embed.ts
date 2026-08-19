import type { EmbeddingCapability } from "@shared/types.ts";

export interface EmbeddingClientOptions {
  baseUrl: string;
  model: string;
  apiKey: string;
  dimensions?: number | null;
}

/**
 * OpenAI documents 2,048 inputs and 300,000 tokens per `/embeddings` request;
 * LibreChat's rag_api batches 500. 256 chunks is about 100k tokens at the 1500
 * character chunk size, which leaves headroom for a gateway that caps lower
 * than OpenAI — and a batch that fails takes the whole file with it, so the
 * ceiling is deliberately well short of the documented one.
 */
const BATCH_SIZE = 256;

const TIMEOUT_MS = 120_000;

class EmbeddingError extends Error {}

/** Minimal OpenAI-compatible `/embeddings` client. */
class EmbeddingClient {
  constructor(private readonly options: EmbeddingClientOptions) {}

  get model() {
    return this.options.model;
  }

  async embed(inputs: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    const output: Float32Array[] = [];
    for (let start = 0; start < inputs.length; start += BATCH_SIZE) {
      const batch = inputs.slice(start, start + BATCH_SIZE);
      try {
        output.push(...(await this.embedBatch(batch, signal)));
      } catch (error) {
        // The failure is recorded against the file, and one rejected batch fails
        // all of it — so the message has to say how much was asked for at once,
        // which is what distinguishes a gateway's own input cap from a bad key.
        const detail = error instanceof Error ? error.message : String(error);
        throw new EmbeddingError(
          `${detail} (batch of ${batch.length} at input ${start} of ${inputs.length})`,
        );
      }
    }
    return output;
  }

  private async embedBatch(batch: string[], signal?: AbortSignal) {
    const body: Record<string, unknown> = { model: this.options.model, input: batch };
    if (this.options.dimensions) body.dimensions = this.options.dimensions;
    const idle = new AbortController().signal;
    const response = await fetch(`${this.options.baseUrl.replace(/\/$/, "")}/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.options.apiKey}`,
      },
      body: JSON.stringify(body),
      // Composed, not chosen: the caller's cancellation and the per-batch
      // deadline are different things, and taking one as the other meant a
      // cancellable request had no timeout at all.
      signal: AbortSignal.any([signal ?? idle, AbortSignal.timeout(TIMEOUT_MS)]),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new EmbeddingError(
        `Embedding request failed (${response.status})${detail ? `: ${detail.slice(0, 300)}` : ""}`,
      );
    }
    const payload = (await response.json()) as { data?: Array<{ embedding: number[]; index?: number }> };
    const rows = payload.data ?? [];
    if (rows.length !== batch.length) {
      throw new EmbeddingError(`Embedding provider returned ${rows.length} vectors for ${batch.length} inputs`);
    }
    const sorted = rows.every((row) => typeof row.index === "number")
      ? [...rows].sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
      : rows;
    return sorted.map((row) => normalizeVector(Float32Array.from(row.embedding)));
  }
}

/** Stored vectors are unit length, so cosine similarity reduces to a dot product. */
export function normalizeVector(vector: Float32Array) {
  let sum = 0;
  for (const value of vector) sum += value * value;
  const norm = Math.sqrt(sum);
  if (!norm) return vector;
  const output = new Float32Array(vector.length);
  for (let index = 0; index < vector.length; index++) output[index] = vector[index]! / norm;
  return output;
}

export function createEmbeddingClient(
  capability: EmbeddingCapability,
  apiKey: string | undefined,
): EmbeddingClient | undefined {
  if (!capability.enabled || !apiKey || !capability.baseUrl || !capability.model) return undefined;
  return new EmbeddingClient({
    baseUrl: capability.baseUrl,
    model: capability.model,
    apiKey,
    dimensions: capability.dimensions,
  });
}
