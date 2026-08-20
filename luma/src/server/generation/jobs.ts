/**
 * The generation queue.
 *
 * One local GPU cannot serve two workflows at once and a hosted API can serve
 * several, so concurrency is per backend rather than global. A job's whole state
 * is its row, so there is no event log to replay: `watch` exists for clients
 * that want to be told rather than poll, and losing a notification costs a
 * client nothing but a slower update.
 */
import type { GeneratedAsset, GenerationOp, JobInput, JobRecord, ModelSpec } from "@shared/types.ts";
import type { SecretVault } from "../crypto/secrets.ts";
import type { Store } from "../store/store.ts";
import { jobProviderId } from "../store/store.ts";
import {
  apiKeyFor,
  defaultOp,
  generationAdapter,
  providerFor,
  resolveSources,
  sourceIdsFrom,
  supportsOp,
} from "./index.ts";
import { GenerationError, type ProducedAsset } from "./types.ts";

/** A local backend renders one at a time; a hosted one is limited by politeness. */
const CONCURRENCY: Record<string, number> = { "comfy-workflow": 1, default: 3 };

type Listener = (job: JobRecord) => void;

export class Jobs {
  private readonly running = new Map<string, AbortController>();
  private readonly queues = new Map<string, string[]>();
  private readonly listeners = new Set<Listener>();

  constructor(
    private readonly store: Store,
    private readonly vault: SecretVault,
  ) {}

  watch(listener: Listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private announce(id: string) {
    const job = this.store.getJob(id);
    if (!job) return;
    for (const listener of this.listeners) {
      try {
        listener(job);
      } catch {
        // A client that throws while being told must not fail the render.
      }
    }
  }

  /** Validates the request against the model, then queues it. */
  submit(input: JobInput): JobRecord {
    const spec = this.store.getModel(input.modelId);
    if (!spec) throw new GenerationError(`Unknown model: ${input.modelId}`, "not_found");
    if (!spec.enabled) throw new GenerationError(`${spec.name} is disabled`, "not_configured");
    const adapter = generationAdapter(spec);
    if (!adapter) throw new GenerationError(`${spec.name} has no generation adapter`, "not_configured");
    const op = input.op ?? defaultOp(spec);
    if (!op) throw new GenerationError(`${spec.name} declares no operations`, "not_configured");
    if (!supportsOp(spec, op)) throw new GenerationError(`${spec.name} cannot do ${op}`, "invalid_request");

    const params = input.params ?? {};
    const prompt = String(params.prompt ?? "").trim();
    if (!prompt) throw new GenerationError("prompt is required", "invalid_request");
    const sources = sourceIdsFrom(params, input.sources ?? []);
    if ((op === "image_to_image" || op === "image_to_video") && !sources.length) {
      throw new GenerationError("This operation needs a source image", "invalid_request");
    }

    const job = this.store.createJob({
      kind: spec.kind === "video" ? "video" : "image",
      op,
      modelId: spec.id,
      modelName: spec.name,
      conversationId: input.conversationId ?? null,
      params,
      sources,
    });
    this.enqueue(spec.apiMode, job.id);
    this.announce(job.id);
    return job;
  }

  private enqueue(lane: string, id: string) {
    const queue = this.queues.get(lane) ?? [];
    queue.push(id);
    this.queues.set(lane, queue);
    this.pump(lane);
  }

  private laneLoad(lane: string) {
    let count = 0;
    for (const id of this.running.keys()) {
      const job = this.store.getJob(id);
      const spec = job ? this.store.getModel(job.modelId) : undefined;
      if (spec?.apiMode === lane) count += 1;
    }
    return count;
  }

  private pump(lane: string) {
    const limit = CONCURRENCY[lane] ?? CONCURRENCY.default!;
    const queue = this.queues.get(lane) ?? [];
    while (queue.length && this.laneLoad(lane) < limit) {
      const id = queue.shift()!;
      const job = this.store.getJob(id);
      if (!job || job.status === "cancelled") continue;
      void this.execute(id).finally(() => this.pump(lane));
    }
    this.queues.set(lane, queue);
  }

  /** Cancels a job whether it is queued, running, or already gone. */
  async cancel(id: string) {
    const job = this.store.getJob(id);
    if (!job) return undefined;
    if (job.status === "succeeded" || job.status === "failed" || job.status === "cancelled") return job;
    const controller = this.running.get(id);
    controller?.abort();
    const settled = this.store.settleJob(id, "cancelled", { error: "Cancelled" });
    const providerId = jobProviderId(this.store, id);
    const spec = this.store.getModel(job.modelId);
    const adapter = spec ? generationAdapter(spec) : undefined;
    if (providerId && spec && adapter?.cancel) {
      // Best effort: the backend owns the work, and telling it to stop is the
      // only way a cancel actually frees a GPU or stops a meter.
      await adapter
        .cancel(providerId, {
          baseUrl: this.store.getProvider(spec.providerId)?.baseUrl ?? "",
          apiKey: apiKeyFor(this.vault, spec),
          store: this.store,
        })
        .catch(() => undefined);
    }
    this.announce(id);
    return settled;
  }

  private async execute(id: string) {
    const job = this.store.getJob(id);
    if (!job) return;
    const spec = this.store.getModel(job.modelId);
    const adapter = spec ? generationAdapter(spec) : undefined;
    if (!spec || !adapter) {
      this.store.settleJob(id, "failed", { error: "The model this job used is gone" });
      this.announce(id);
      return;
    }

    const controller = new AbortController();
    this.running.set(id, controller);
    this.store.markJobRunning(id);
    this.announce(id);

    try {
      const request = {
        op: job.op,
        spec,
        provider: providerFor(this.store, spec),
        prompt: String(job.params.prompt ?? ""),
        sources: resolveSources(this.store, job.sources),
        params: job.params,
      };
      const context = {
        store: this.store,
        apiKey: apiKeyFor(this.vault, spec),
        signal: controller.signal,
        progress: (fraction: number | null, note?: string) => {
          this.store.setJobProgress(id, fraction, note ?? null);
          this.announce(id);
        },
        adopt: (providerJobId: string) => {
          this.store.setJobProviderId(id, providerJobId);
          this.announce(id);
        },
      };

      const existing = jobProviderId(this.store, id);
      const result =
        existing && job.kind === "video" && adapter.resume
          ? await adapter.resume(request, context, existing)
          : await adapter.run(request, context);
      this.settleSucceeded(id, result.assets);
    } catch (error) {
      const cancelled =
        controller.signal.aborted || (error instanceof GenerationError && error.code === "cancelled");
      if (this.store.getJob(id)?.status === "cancelled") return;
      this.store.settleJob(id, cancelled ? "cancelled" : "failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      this.announce(id);
    } finally {
      this.running.delete(id);
    }
  }

  /**
   * A job's whole state is its row, so the row has to answer everything a client
   * would otherwise have to fetch: the filename lives in `files`, the provenance
   * and the poster in the asset tables. A client that only saw the job used to
   * have to invent them, which is a gallery tile with no name until a reload.
   * Read back the same way the gallery listing reads it, field for field.
   */
  private describe(asset: ProducedAsset): GeneratedAsset {
    const file = this.store.getFile(asset.assetId);
    const video = asset.kind === "video" ? this.store.getVideoAsset(asset.assetId) : undefined;
    const record = video ?? this.store.getImageAsset(asset.assetId);
    return {
      id: asset.assetId,
      assetId: asset.assetId,
      kind: asset.kind,
      mime: file?.mime ?? record?.mime ?? asset.mime,
      width: file?.width ?? record?.width ?? asset.width,
      height: file?.height ?? record?.height ?? asset.height,
      name: file?.name ?? null,
      provider: record?.provider ?? file?.source ?? null,
      model: record?.model ?? null,
      parents: record?.parentImageIds ?? [],
      createdAt: file?.createdAt ?? record?.createdAt ?? Date.now(),
      durationMs: video?.durationMs ?? asset.durationMs ?? null,
      posterAssetId: video?.posterImageId ?? asset.posterAssetId ?? null,
    };
  }

  private settleSucceeded(id: string, assets: ProducedAsset[]) {
    this.store.settleJob(id, "succeeded", { assets: assets.map((asset) => this.describe(asset)) });
    this.announce(id);
  }

  /**
   * Runs a job to completion for a caller that wants one call rather than a
   * subscription: the studio's synchronous run and the agent's tools both want
   * to hand back a finished picture.
   */
  async run(input: JobInput): Promise<JobRecord> {
    const job = this.submit(input);
    return this.await(job.id);
  }

  await(id: string, onUpdate?: Listener): Promise<JobRecord> {
    const current = this.store.getJob(id);
    if (!current) return Promise.reject(new GenerationError(`Unknown job: ${id}`, "not_found"));
    if (current.status === "succeeded" || current.status === "failed" || current.status === "cancelled") {
      return Promise.resolve(current);
    }
    return new Promise((resolve) => {
      const stop = this.watch((job) => {
        if (job.id !== id) return;
        onUpdate?.(job);
        if (job.status === "succeeded" || job.status === "failed" || job.status === "cancelled") {
          stop();
          resolve(job);
        }
      });
    });
  }

  /**
   * Restart recovery. A render the backend already owns is rejoined, because a
   * cloud video outlives our process and paying twice for the same minute would
   * be our fault. One we never handed off is requeued; one that was mid-flight
   * locally is failed, since a ComfyUI prompt we lost track of cannot be
   * reattached to a progress stream.
   */
  recover() {
    let rejoined = 0;
    let requeued = 0;
    let failed = 0;
    for (const job of this.store.unsettledJobs()) {
      const spec = this.store.getModel(job.modelId);
      if (!spec || !generationAdapter(spec)) {
        this.store.settleJob(job.id, "failed", { error: "The model this job used is gone" });
        failed += 1;
        continue;
      }
      const providerId = jobProviderId(this.store, job.id);
      if (job.status === "queued") {
        this.enqueue(spec.apiMode, job.id);
        requeued += 1;
        continue;
      }
      if (providerId && job.kind === "video") {
        this.enqueue(spec.apiMode, job.id);
        rejoined += 1;
        continue;
      }
      this.store.settleJob(job.id, "failed", { error: "Interrupted by a restart" });
      failed += 1;
    }
    return { rejoined, requeued, failed };
  }

  /** Cancels everything in flight, so shutdown does not leave a GPU busy. */
  async close() {
    await Promise.all([...this.running.keys()].map((id) => this.cancel(id)));
  }
}

export type { GenerationOp, JobRecord, ModelSpec };
