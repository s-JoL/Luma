/**
 * The generation queue over HTTP.
 *
 * A job's whole state is its row, so `GET /jobs/:id` answers a reconnect
 * completely and the stream is only a way to be told sooner. That is why there is
 * no `Last-Event-ID` here and no event log behind it: unlike a run, a job has no
 * incremental content that a client could miss (`03-generation.md §Jobs`).
 */
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { JobInput, JobRecord, JobStatus } from "@shared/types.ts";
import type { Services } from "../../services.ts";
import { readJson } from "../body.ts";
import { fail, failFromError } from "../errors.ts";

const HEARTBEAT_MS = 15_000;
const SETTLED = new Set<JobStatus>(["succeeded", "failed", "cancelled"]);
const STATUSES = new Set<JobStatus>(["queued", "running", ...SETTLED]);

export function jobRoutes(services: Services) {
  const app = new Hono();
  const { store, jobs } = services;

  app.get("/jobs", (context) => {
    const asked = context.req.query("status") ?? "";
    return context.json({
      items: store.listJobs({
        status: STATUSES.has(asked as JobStatus) ? (asked as JobStatus) : undefined,
        conversationId: context.req.query("conversationId") ?? undefined,
        limit: Number(context.req.query("limit") ?? 50),
      }),
    });
  });

  app.post("/jobs", async (context) => {
    const body = await readJson<JobInput>(context);
    const modelId = body.modelId;
    if (!modelId) return fail(context, 400, "invalid", "modelId is required");
    try {
      const job = jobs.submit({ ...body, modelId });
      return context.json(job, 202);
    } catch (error) {
      return failFromError(context, error);
    }
  });

  app.get("/jobs/:id", (context) => {
    const job = store.getJob(context.req.param("id"));
    if (!job) return fail(context, 404, "not_found", "Job not found");
    return context.json(job);
  });

  app.post("/jobs/:id/cancel", async (context) => {
    const job = await jobs.cancel(context.req.param("id"));
    if (!job) return fail(context, 404, "not_found", "Job not found");
    return context.json(job);
  });

  app.get("/jobs/:id/events", (context) => {
    const id = context.req.param("id");
    const current = store.getJob(id);
    if (!current) return fail(context, 404, "not_found", "Job not found");

    return streamSSE(context, async (stream) => {
      let closed = false;
      const queue: JobRecord[] = [current];
      let wake: (() => void) | undefined;

      const unsubscribe = jobs.watch((job) => {
        if (job.id !== id) return;
        queue.push(job);
        wake?.();
      });
      stream.onAbort(() => {
        closed = true;
        unsubscribe();
        wake?.();
      });

      try {
        while (!closed) {
          while (queue.length) {
            const job = queue.shift()!;
            await stream.writeSSE({ event: `job.${job.status}`, data: JSON.stringify(job) });
            if (SETTLED.has(job.status)) return;
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
            setTimeout(resolve, HEARTBEAT_MS);
          });
          wake = undefined;
          if (!closed && !queue.length) {
            const latest = store.getJob(id);
            if (latest && SETTLED.has(latest.status)) {
              await stream.writeSSE({ event: `job.${latest.status}`, data: JSON.stringify(latest) });
              return;
            }
            await stream.writeSSE({ data: "", event: "heartbeat" });
          }
        }
      } finally {
        unsubscribe();
      }
    });
  });

  return app;
}
