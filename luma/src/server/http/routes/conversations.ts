import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { StoredEvent } from "@shared/types.ts";
import { rewindConversation } from "../../agent/projection.ts";
import { searchConversations } from "../../agent/search.ts";
import type { Services } from "../../services.ts";
import { readJson } from "../body.ts";
import { fail, failFromError } from "../errors.ts";

const HEARTBEAT_MS = 15_000;
const POLL_TIMEOUT_MS = 25_000;
const TERMINAL = new Set(["run.completed", "run.failed", "run.cancelled"]);

/**
 * Keyed replay so a phone retrying a dropped POST cannot start two runs. A
 * retry follows within seconds, so the window only has to outlive a reconnect;
 * the cap keeps a long-lived server from holding every key it has ever seen.
 */
const IDEMPOTENCY_LIMIT = 512;
const idempotency = new Map<string, { runId: string; seq: number }>();

function rememberIdempotency(key: string, response: { runId: string; seq: number }) {
  idempotency.set(key, response);
  while (idempotency.size > IDEMPOTENCY_LIMIT) {
    const oldest = idempotency.keys().next();
    if (oldest.done) break;
    idempotency.delete(oldest.value);
  }
}

export function conversationRoutes(services: Services) {
  const app = new Hono();
  const { store, config, runtime, bus } = services;

  app.get("/conversations", (context) => {
    const limit = Math.min(200, Math.max(1, Number(context.req.query("limit") ?? 50)));
    const cursor = context.req.query("cursor");
    const items = store.listConversations(limit, cursor ? Number(cursor) : undefined);
    const nextCursor = items.length === limit ? String(items.at(-1)!.updatedAt) : null;
    return context.json({ items, nextCursor });
  });

  app.post("/conversations", async (context) => {
    const body = await readJson<{ modelId: string; title: string }>(context);
    const wanted = typeof body.modelId === "string" ? body.modelId : "";
    const spec = wanted ? store.getModel(wanted) : undefined;
    const modelId = spec?.enabled && spec.configured ? wanted : config.defaultModelId();
    if (!modelId) return fail(context, 422, "no_model", "Configure a model before starting a conversation");
    return context.json(store.createConversation(modelId, body.title || "New conversation"), 201);
  });

  /**
   * Registered before `/conversations/:id`, which would otherwise claim the
   * literal path and read "search" as a conversation id.
   */
  app.get("/conversations/search", async (context) => {
    const query = (context.req.query("q") ?? "").trim();
    if (!query) return context.json({ items: [] });
    const limit = Math.min(50, Math.max(1, Number(context.req.query("limit") ?? 20)));
    const items = await searchConversations(store, services.sessions, query, limit, context.req.raw.signal);
    return context.json({ items });
  });

  app.get("/conversations/:id", (context) => {
    const conversation = store.getConversation(context.req.param("id"));
    if (!conversation) return fail(context, 404, "not_found", "Conversation not found");
    const run = store.activeRun(conversation.id);
    return context.json({
      ...conversation,
      // Everything up to the last persisted message is already in the
      // transcript, so a reattaching client only replays from there.
      activeRun: run ? { ...run, resumeSeq: store.lastPersistedEventSeq(run.id) } : null,
    });
  });

  app.patch("/conversations/:id", async (context) => {
    const id = context.req.param("id");
    if (!store.getConversation(id)) return fail(context, 404, "not_found", "Conversation not found");
    const body = await readJson<{ title: string; modelId: string }>(context);
    if (typeof body.title === "string" && body.title.trim()) store.setConversationTitle(id, body.title.trim());
    if (body.modelId) {
      const spec = store.getModel(body.modelId);
      if (spec?.enabled && spec.configured) store.setConversationModel(id, body.modelId);
    }
    return context.json(store.getConversation(id));
  });

  app.delete("/conversations/:id", async (context) => {
    const id = context.req.param("id");
    if (runtime.isActive(id)) return fail(context, 409, "run_active", "Stop the active run first");
    store.deleteConversation(id);
    // The transcript's source of truth lives in the session store, so deleting
    // the rows alone would leave the tree behind to grow forever.
    await services.sessions.forget(id);
    return context.body(null, 204);
  });

  /**
   * Two different questions share this path because clients ask both about the
   * same resource. `after` is "what changed since I last looked" and returns
   * everything newer, which is how the web client tops up a conversation it is
   * already showing. `limit` (with `before` to walk further) is "give me the
   * end of this transcript", which is how a client opens one it has never seen.
   */
  app.get("/conversations/:id/messages", (context) => {
    const id = context.req.param("id");
    if (!store.getConversation(id)) return fail(context, 404, "not_found", "Conversation not found");

    const limit = context.req.query("limit");
    const before = context.req.query("before");
    if (limit === undefined && before === undefined) {
      const after = Number(context.req.query("after") ?? -1);
      return context.json({ items: store.storedMessages(id, after), nextCursor: null });
    }

    const size = Number(limit ?? 50);
    if (!Number.isFinite(size) || size <= 0) return fail(context, 400, "invalid", "limit must be a positive number");
    const cursor = before === undefined ? null : Number(before);
    if (cursor !== null && !Number.isFinite(cursor)) return fail(context, 400, "invalid", "before must be a sequence");
    return context.json(store.messagePage(id, cursor, size));
  });

  app.post("/conversations/:id/runs", async (context) => {
    const conversationId = context.req.param("id");
    const conversation = store.getConversation(conversationId);
    if (!conversation) return fail(context, 404, "not_found", "Conversation not found");

    const key = context.req.header("idempotency-key");
    if (key && idempotency.has(key)) return context.json(idempotency.get(key), 202);

    const body = await readJson<{
      text: string;
      attachments: string[];
      modelId: string;
      /** Edit and regenerate replay a turn: drop it, then send this text in its place. */
      fromSeq: number;
    }>(context);
    const text = (body.text ?? "").trim();
    if (!text) return fail(context, 400, "empty_message", "Message text is required");
    if (runtime.isActive(conversationId)) {
      return fail(context, 409, "run_active", "This conversation already has an active run");
    }

    const asked = body.modelId ? store.getModel(body.modelId) : undefined;
    const modelId = asked?.enabled && asked.configured ? asked.id : conversation.modelId;
    try {
      services.registry.resolve(modelId);
    } catch (error) {
      return failFromError(context, error);
    }
    if (modelId !== conversation.modelId) store.setConversationModel(conversationId, modelId);

    // Only after the model resolves, so a rejected run leaves history intact.
    const fromSeq = body.fromSeq;
    if (typeof fromSeq === "number" && Number.isInteger(fromSeq) && fromSeq >= 0) {
      await rewindConversation(store, services.sessions, conversationId, fromSeq);
    }

    const run = store.createRun(conversationId, modelId);
    const seq = Number(store.db.get<{ seq: number }>("SELECT COALESCE(MAX(seq), 0) AS seq FROM events")?.seq ?? 0);
    const response = { runId: run.id, seq };
    if (key) rememberIdempotency(key, response);

    void runtime
      .start(run.id, conversationId, { message: text, modelId, attachments: body.attachments })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        store.setRunStatus(run.id, "failed", message);
        bus.publish(store.addEvent(run.id, conversationId, "run.failed", { message }));
      });

    return context.json(response, 202);
  });

  /**
   * Picks the answer back up where it stopped. A stopped or finished turn
   * leaves an assistant message last, which the agent loop cannot resume from,
   * so the nudge below is sent as an ordinary user message and shows up in the
   * transcript — the same thing the reader would have typed. Only a run that
   * died between a tool result and the next model call resumes silently.
   */
  app.post("/conversations/:id/continue", (context) => {
    const conversationId = context.req.param("id");
    const conversation = store.getConversation(conversationId);
    if (!conversation) return fail(context, 404, "not_found", "Conversation not found");
    if (runtime.isActive(conversationId)) {
      return fail(context, 409, "run_active", "This conversation already has an active run");
    }
    if (!store.messageCount(conversationId)) {
      return fail(context, 400, "empty_conversation", "Nothing to continue");
    }
    try {
      services.registry.resolve(conversation.modelId);
    } catch (error) {
      return failFromError(context, error);
    }

    const run = store.createRun(conversationId, conversation.modelId);
    const seq = Number(store.db.get<{ seq: number }>("SELECT COALESCE(MAX(seq), 0) AS seq FROM events")?.seq ?? 0);

    void runtime
      .start(run.id, conversationId, {
        message: "继续，接着上面写，不要重复。",
        modelId: conversation.modelId,
        continue: true,
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        store.setRunStatus(run.id, "failed", message);
        bus.publish(store.addEvent(run.id, conversationId, "run.failed", { message }));
      });

    return context.json({ runId: run.id, seq }, 202);
  });

  app.post("/conversations/:id/stop", (context) => {
    const stopped = runtime.stop(context.req.param("id"));
    if (!stopped) return fail(context, 409, "no_active_run", "Nothing is running");
    return context.body(null, 204);
  });

  app.post("/conversations/:id/steer", async (context) => {
    const body = await readJson<{ text: string }>(context);
    const text = (body.text ?? "").trim();
    if (!text) return fail(context, 400, "empty_message", "Steering text is required");
    if (!runtime.steer(context.req.param("id"), text)) {
      return fail(context, 409, "no_active_run", "Nothing is running");
    }
    return context.body(null, 204);
  });

  app.get("/runs/:id", (context) => {
    const run = store.getRun(context.req.param("id"));
    if (!run) return fail(context, 404, "not_found", "Run not found");
    return context.json(run);
  });

  /**
   * What a client asks for after a refresh or a reconnect. The stream carries
   * the same information live, but a client that was away while the question
   * was asked has no event to replay it from.
   */
  app.get("/conversations/:id/approvals", (context) => {
    const id = context.req.param("id");
    if (!store.getConversation(id)) return fail(context, 404, "not_found", "Conversation not found");
    return context.json({
      items: context.req.query("status") === "all" ? store.conversationApprovals(id) : store.pendingApprovals(id),
    });
  });

  /** Every question waiting anywhere, so a cold app start can surface them. */
  app.get("/approvals", (context) => context.json({ items: store.pendingApprovals() }));

  /**
   * The only way a destructive coding call is ever authorised. Deciding twice
   * is not an error: the second caller is told the settled state, which is what
   * makes a double-tap and a retried request both harmless.
   */
  app.post("/approvals/:id", async (context) => {
    const id = context.req.param("id");
    const existing = store.getApproval(id);
    if (!existing) return fail(context, 404, "not_found", "Approval not found");

    const body = await readJson<{ approved: boolean }>(context);
    if (typeof body.approved !== "boolean") {
      return fail(context, 400, "invalid", "approved must be true or false");
    }

    // The row is the decision; notifying only wakes the parked tool call early
    // instead of letting it discover the change on its next read.
    const settled = store.decideApproval(id, body.approved ? "approved" : "rejected");
    runtime.approvals.notify(id);
    return context.json(settled ?? store.getApproval(id));
  });

  app.get("/runs/:id/events", async (context) => {
    const runId = context.req.param("id");
    const run = store.getRun(runId);
    if (!run) return fail(context, 404, "not_found", "Run not found");
    const after = Number(context.req.header("last-event-id") ?? context.req.query("after") ?? 0);

    if (context.req.query("mode") === "poll") {
      const events = await pollEvents(services, runId, after);
      return context.json({
        events,
        done: isSettled(store.getRun(runId)?.status) && !events.some((event) => !TERMINAL.has(event.type)),
      });
    }

    return streamSSE(context, async (stream) => {
      let cursor = after;
      let closed = false;
      const queue: StoredEvent[] = [];
      let wake: (() => void) | undefined;

      const push = (event: StoredEvent) => {
        if (event.runId !== runId || event.seq <= cursor) return;
        queue.push(event);
        wake?.();
      };
      const unsubscribe = bus.subscribe(run.conversationId, push);
      stream.onAbort(() => {
        closed = true;
        unsubscribe();
        wake?.();
      });

      try {
        for (const event of store.eventsSince(runId, cursor)) queue.push(event);
        while (!closed) {
          while (queue.length) {
            const event = queue.shift()!;
            if (event.seq <= cursor) continue;
            cursor = event.seq;
            await stream.writeSSE({ id: String(event.seq), event: event.type, data: JSON.stringify(event) });
            if (TERMINAL.has(event.type)) return;
          }
          const status = store.getRun(runId)?.status;
          if (isSettled(status) && !store.eventsSince(runId, cursor).length) return;
          await new Promise<void>((resolve) => {
            wake = resolve;
            setTimeout(resolve, HEARTBEAT_MS);
          });
          wake = undefined;
          if (!closed && !queue.length) await stream.writeSSE({ data: "", event: "heartbeat" });
        }
      } finally {
        unsubscribe();
      }
    });
  });

  return app;
}

const isSettled = (status?: string) =>
  status === "completed" || status === "failed" || status === "cancelled";

/** Long-poll fallback for clients that cannot hold an SSE connection open. */
async function pollEvents(services: Services, runId: string, after: number) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const events = services.store.eventsSince(runId, after);
    if (events.length) return events;
    if (isSettled(services.store.getRun(runId)?.status)) return [];
    if (Date.now() >= deadline) return [];
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}
