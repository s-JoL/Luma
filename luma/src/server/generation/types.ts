/**
 * One interface for everything that produces pixels or frames
 * (`08-generation.md`). An adapter answers what a model can do, what parameters
 * it takes, and then does the work.
 */
import type { GenerationOp, JsonSchema, ModelSpec, Provider } from "@shared/types.ts";
import type { Store } from "../store/store.ts";

/** Source bytes are resolved before an adapter runs: asset lookup is our job. */
export interface SourceImage {
  imageId: string;
  bytes: Buffer;
  mime: string;
  width: number | null;
  height: number | null;
}

export interface GenerationRequest {
  op: GenerationOp;
  spec: ModelSpec;
  provider: Provider;
  prompt: string;
  sources: SourceImage[];
  params: Record<string, unknown>;
}

export interface GenerationContext {
  store: Store;
  /** Provider API key, empty for a local backend that needs none. */
  apiKey: string;
  signal: AbortSignal;
  /** 0..1 where the backend reports it, plus a short human note. */
  progress: (fraction: number | null, note?: string) => void;
  /** Called as soon as the backend names the work, so a restart can resume it. */
  adopt: (providerJobId: string) => void;
}

/**
 * What an adapter reports it made. Only the backend knows this much; the name,
 * the provenance and the timestamps belong to the rows the save wrote, and the
 * queue reads them back rather than asking every adapter to carry them.
 */
export interface ProducedAsset {
  assetId: string;
  kind: "image" | "video";
  mime: string;
  width: number | null;
  height: number | null;
  durationMs?: number | null;
  posterAssetId?: string | null;
}

export interface GenerationResult {
  assets: ProducedAsset[];
  providerRequestId?: string;
  /** What the backend actually ran with, when it differs from what was asked. */
  effective?: Record<string, unknown>;
}

export interface GenerationAdapter {
  /** Matches `models.api_mode`, so a row names its own adapter. */
  readonly id: string;
  /**
   * The operations this backend can run. A model row narrows this list; it can
   * never widen it, so a row cannot advertise an operation nothing implements.
   */
  readonly runs: readonly GenerationOp[];
  /** One schema, two audiences: the studio form and the model's tool. */
  schema(spec: ModelSpec, op: GenerationOp): JsonSchema;
  run(request: GenerationRequest, ctx: GenerationContext): Promise<GenerationResult>;
  /**
   * Best effort cleanup for work the backend already owns. Only needed by
   * backends that queue, which is why it is optional.
   */
  cancel?(providerJobId: string, ctx: { baseUrl: string; apiKey: string; store: Store }): Promise<void>;
}

export class GenerationError extends Error {
  constructor(
    message: string,
    readonly code = "generation_failed",
  ) {
    super(message);
  }
}

/** Shared by every adapter: a prompt is the one thing they all require. */
export const promptField = (title: string, max = 10_000): JsonSchema => ({
  type: "string",
  title,
  minLength: 1,
  maxLength: max,
});
