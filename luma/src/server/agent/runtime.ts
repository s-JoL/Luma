import { Agent, buildSessionContext, convertToLlm, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { SECRET, type Config } from "../config.ts";
import type { SecretVault } from "../crypto/secrets.ts";
import type { EventBus } from "../events/bus.ts";
import type { Jobs } from "../generation/jobs.ts";
import { encodeForModel, registerGeneratedImage } from "../images.ts";
import type { McpPool } from "../mcp/pool.ts";
import { ApprovalRegistry, describeRisk, rejectionMessage } from "./approvals.ts";
import { describeModelError } from "./errors.ts";
import { applyModelParameters } from "../models/params.ts";
import type { ModelRegistry } from "../models/registry.ts";
import {
  buildModelSystemPrompt,
  composeStaticPrompt,
  countTokens,
  renderPromptIdentity,
  resolveModelSystemPrompt,
} from "../prompts/context.ts";
import type { Retrieval } from "../rag/retrieval.ts";
import type { Store } from "../store/store.ts";
import { codingTools } from "../tools/coding.ts";
import { fileSearchTool } from "../tools/file-search.ts";
import { generationTools } from "../tools/generation.ts";
import { memoryTools } from "../tools/memory.ts";
import { loadSkillLibrary, skillCatalogue, skillTools } from "../tools/skills.ts";
import { viewImageTool } from "../tools/vision.ts";
import { webSearchTool } from "../tools/web-search.ts";
import { compactIfNeeded, contextReserve } from "./compaction.ts";
import {
  boundToolResults,
  compactToolText,
  describeRefs,
  hasImageRef,
  imageRef,
  persistMessage,
  pruneHistory,
  transportSafe,
  videoRef,
  withAppendedRef,
  type ImageRef,
  type VideoRef,
} from "./messages.ts";
import { resolveProfile, skillsAllowed } from "./profile.ts";
import { adoptTranscript } from "./projection.ts";
import { LANE, type ConversationSession, type Sessions } from "./sessions.ts";
import { fallbackTitle, generateTitle } from "./title.ts";

/**
 * How long a settled run keeps its text deltas. Polling clients read in bursts,
 * so deltas must outlive the run itself or a short answer can finish and be
 * pruned between two polls.
 */
const DELTA_RETENTION_MS = 120_000;

export interface StartInput {
  message: string;
  modelId?: string;
  attachments?: string[];
  /**
   * Resume the existing transcript instead of adding `message` to it. The
   * agent loop can only pick up after a user or tool-result message, which is
   * exactly what an interrupted run leaves behind; anywhere else the prompt
   * text is used as an ordinary nudge.
   */
  continue?: boolean;
}

/**
 * A stopped run unwinds before its partial assistant message is persisted, so
 * the transcript ends on whatever preceded it. That is precisely the shape
 * `Agent.continue()` accepts, and resuming there costs no extra turn.
 */
function canResume(history: AgentMessage[]) {
  const role = (history.at(-1) as { role?: string } | undefined)?.role;
  return role === "user" || role === "toolResult";
}

interface ActiveRun {
  /**
   * Absent while the run is still preparing. Summarizing a long conversation is
   * itself a model call, so a run has to be stoppable before its loop exists.
   */
  agent?: Agent;
  runId: string;
  /** `agent.abort()` unwinds cleanly, so the intent has to be recorded here. */
  aborted: boolean;
  /**
   * Signals work that outlives a single tool call. `agent.abort()` unwinds the
   * loop but cannot reach a preflight gate parked on a person's decision, which
   * would otherwise keep a stopped run alive for its full approval timeout.
   */
  cancel: AbortController;
}

export class Runtime {
  private readonly active = new Map<string, ActiveRun>();
  /** Wakes a parked preflight the moment its decision is recorded. */
  readonly approvals = new ApprovalRegistry();

  constructor(
    private readonly store: Store,
    private readonly config: Config,
    private readonly vault: SecretVault,
    private readonly registry: ModelRegistry,
    private readonly retrieval: Retrieval,
    private readonly mcp: McpPool,
    private readonly bus: EventBus,
    private readonly sessions: Sessions,
    private readonly jobs: Jobs,
  ) {}

  isActive(conversationId: string) {
    return this.active.has(conversationId);
  }

  activeCount() {
    return this.active.size;
  }

  private emit(runId: string, conversationId: string, type: string, data: unknown) {
    this.bus.publish(this.store.addEvent(runId, conversationId, type, data));
  }

  async start(runId: string, conversationId: string, input: StartInput) {
    const conversation = this.store.getConversation(conversationId);
    if (!conversation) throw new Error("Conversation not found");
    if (this.active.has(conversationId)) throw new Error("Conversation already has an active run");

    const { spec, provider, model } = this.registry.resolve(input.modelId ?? conversation.modelId);
    const resolved = resolveProfile(this.store, this.config, conversation);
    const capabilities = resolved.capabilities;
    const prompts = resolved.prompts;

    const uploadImageRefs: ImageRef[] = [];
    const media: Array<{ type: "image"; data: string; mimeType: string }> = [];
    const attachmentDocuments: Array<{ id: string; name: string }> = [];
    for (const fileId of input.attachments ?? []) {
      const file = this.store.getFile(fileId);
      if (!file) continue;
      if (file.mime.startsWith("image/")) {
        const encoded = await encodeForModel(file.id, file.diskPath, file.mime);
        if (!encoded) continue;
        media.push({ type: "image", ...encoded });
        uploadImageRefs.push({
          type: "image_ref",
          image_id: file.id,
          mime_type: file.mime,
          width: file.width,
          height: file.height,
          parent_image_ids: [],
          provider: file.source,
          model: null,
        });
      } else {
        attachmentDocuments.push({ id: file.id, name: file.name });
      }
    }

    const staticPrompt = renderPromptIdentity(
      resolveModelSystemPrompt(composeStaticPrompt(prompts.globalPrompt, prompts.toolPrompt), spec.systemPrompt),
      spec.name,
      provider.name,
    );

    const attachedIds = new Set(attachmentDocuments.map((file) => file.id));
    const searchableFiles = [
      ...attachmentDocuments.map((file) => ({ ...file, currentRequest: true })),
      ...this.store.searchableFiles().filter((file) => !attachedIds.has(file.id)).map((file) => ({
        ...file,
        currentRequest: false,
      })),
    ];

    // Read from disk each run so adding a skill takes effect on the next turn.
    const skills = await loadSkillLibrary();

    const systemPrompt = buildModelSystemPrompt({
      staticPrompt,
      memories: this.store.listMemories(),
      searchableFiles,
      memoryEnabled: capabilities.memory.enabled,
      memoryTokenLimit: capabilities.memory.tokenLimit,
      filesEnabled: capabilities.files.enabled && capabilities.files.searchEnabled,
      webEnabled: capabilities.web.enabled,
      skillCatalogue: skillsAllowed(resolved) ? skillCatalogue(skills) : "",
    });

    const uploads = uploadImageRefs.map((image) => ({
      id: image.image_id,
      mime: image.mime_type,
      width: image.width ?? null,
      height: image.height ?? null,
    }));

    // Server order is stable, so tool order is too, which is what keeps the
    // provider's prompt cache warm across turns.
    const mcpTools = this.mcp
      .currentTools()
      .filter((tool) => !resolved.mcpServers || this.mcp.serverOf(tool.name, resolved.mcpServers));

    const tools: AgentTool[] = [];
    if (capabilities.files.enabled && capabilities.files.searchEnabled) {
      tools.push(fileSearchTool(this.retrieval, capabilities.files.mode));
    }
    if (capabilities.web.enabled) {
      tools.push(webSearchTool(() => this.vault.get(SECRET.tavily), capabilities.web.provider));
    }
    tools.push(...codingTools(capabilities.coding));
    tools.push(
      ...generationTools({
        jobs: this.jobs,
        store: this.store,
        conversationId,
        image: resolved.image,
        edit: resolved.edit,
        video: resolved.video,
        uploads,
        onProgress: (job) => this.emit(runId, conversationId, "job.progress", job),
      }),
    );
    tools.push(...mcpTools);
    tools.push(...memoryTools(this.store, capabilities.memory));
    if (skillsAllowed(resolved)) tools.push(...skillTools(skills));

    let modelCallIndex = 0;
    let toolCallIndex = 0;
    const toolIndexes = new Map<string, number>();
    const toolImages = new Map<string, ImageRef>();
    const toolVideos = new Map<string, VideoRef>();
    let terminalError = "";

    const cancel = new AbortController();
    const entry: ActiveRun = { runId, aborted: false, cancel };
    this.active.set(conversationId, entry);
    this.store.setRunStatus(runId, "running");
    this.emit(runId, conversationId, "run.started", { modelId: spec.id, model: spec.name });

    let titlePromise = Promise.resolve();
    let agent: Agent | undefined;
    // Held outside the try so a failure after the tree opens can still close the
    // run's operation. Everything that can throw belongs inside, or a failure
    // would leave the conversation marked active with no run to stop.
    let openSession: ConversationSession | undefined;

    try {
      // A conversation written before the session store is replayed into its
      // tree once, so upgrading does not cost the model its memory.
      await adoptTranscript(this.store, this.sessions, conversationId);
      const session = await this.sessions.session(conversationId);
      openSession = session;
      // A hard restart leaves the previous run's operation open, and the lane
      // refuses to start a second one while that is true.
      await this.sessions.recover(conversationId);

      const compacted = await compactIfNeeded({
        session,
        entries: await this.sessions.entries(conversationId),
        models: this.registry.runtime,
        model,
        contextWindow: spec.contextWindow,
        maxTokens: spec.maxTokens,
        thinkingLevel: spec.thinkingLevel ?? undefined,
        signal: cancel.signal,
        onError: (message) => console.warn(`[compaction] ${message}`),
      });
      if (compacted) {
        this.emit(runId, conversationId, "context.compacted", {
          summary: compacted.summary,
          tokensBefore: compacted.tokensBefore,
        });
      }

      const entries = await this.sessions.entries(conversationId);
      // What the model is sent: the branch, with everything before the newest
      // compaction replaced by its summary.
      const history = buildSessionContext(entries).messages;
      const isFirstTurn = entries.length === 0;

      // Offered when there is something to look at and a model that can look:
      // a text-only model would call it and have the part stripped on the way
      // to the provider, and a conversation with no picture in it can only get
      // an error back. Images attached to this turn arrive as pixels already.
      if (spec.input.includes("image") && hasImageRef(history)) tools.push(viewImageTool(this.store));
      const usableTokens = this.contextBudget(spec.contextWindow, spec.maxTokens, systemPrompt, tools);

      await session.appendRecord({
        type: "operation_started",
        id: runId,
        lane: LANE,
        sourceLeafId: await session.getLeafId(),
        intent: {
          kind: "run",
          originalPrompt: [{ role: "user", content: input.message, timestamp: Date.now() } as AgentMessage],
          initialMessages: [],
        },
      });

      agent = new Agent({
        initialState: {
          systemPrompt,
          model,
          thinkingLevel: spec.thinkingLevel ?? (spec.reasoning ? "medium" : "off"),
          tools: tools as never,
          messages: history,
        },
        streamFn: this.registry.streamSimple,
        // Summaries are custom-role messages. The agent's default converter drops
        // every role it does not recognise, which would silently throw away the
        // summary a compacted conversation depends on.
        convertToLlm,
        // Bounded before the budget is applied, so the pruner counts what will
        // actually be sent rather than the tool's full output.
        transformContext: async (messages) => describeRefs(pruneHistory(boundToolResults(messages), usableTokens)),
        sessionId: conversationId,
        steeringMode: "one-at-a-time",
        followUpMode: "one-at-a-time",
        toolExecution: "parallel",
        onPayload: (payload) => applyModelParameters(payload, spec) as never,
        beforeToolCall: async ({ toolCall, args }) =>
          this.gate(runId, conversationId, capabilities.coding.workspace, toolCall, args, cancel.signal),
      });
      entry.agent = agent;

      // The agent awaits every listener, so tree writes stay in event order.
      agent.subscribe(async (event) => {
        if (event.type === "message_start" && (event.message as { role?: string }).role === "assistant") {
          modelCallIndex += 1;
        }
        if (event.type === "tool_execution_start") {
          toolCallIndex += 1;
          toolIndexes.set(event.toolCallId, toolCallIndex);
        }

        let payload: unknown = event;
        if (event.type === "message_end") {
          const message = event.message as { role?: string; toolCallId?: string; content?: unknown };
          const refs =
            message.role === "toolResult"
              ? ([toolImages.get(String(message.toolCallId))].filter(Boolean) as ImageRef[])
              : message.role === "user"
                ? uploadImageRefs
                : [];
          const video = message.role === "toolResult" ? toolVideos.get(String(message.toolCallId)) : undefined;
          // A video is never sent to the model, so its ref has no base64 part to
          // replace and has to be appended instead.
          const stored = video
            ? withAppendedRef(persistMessage(event.message, refs), video)
            : persistMessage(event.message, refs);
          // The tree is written first and the transcript row records which entry
          // it came from, which is what lets a rewind translate a client
          // sequence number back into a point in the tree.
          const entryId = await session.appendMessage(stored as AgentMessage);
          const messageId = this.store.addMessage(conversationId, stored, entryId);
          payload = { ...event, message: stored, messageId };

          const usage = (event.message as { usage?: Usage }).usage;
          if (message.role === "assistant" && usage) {
            await session.appendRecord({
              type: "usage",
              id: session.idGenerator.next(),
              lane: LANE,
              usage,
              cause: "assistant",
              runId,
              entryId,
              attempt: 1,
              stopReason: "stop",
            });
          }
          if (message.role === "assistant" && (event.message as { stopReason?: string }).stopReason === "error") {
            // Kept raw: the catch below is the single place that turns a provider
            // failure into prose, and describing it twice throws the first
            // description away in favour of the generic fallback.
            terminalError = (event.message as { errorMessage?: string }).errorMessage || "模型请求失败";
          }
        }
        if (event.type === "tool_execution_end") {
          const meta = (event.result as { details?: { structuredContent?: unknown } } | undefined)?.details
            ?.structuredContent;
          const ref = imageRef(meta);
          if (ref) toolImages.set(event.toolCallId, ref);
          const video = videoRef(meta);
          if (video) toolVideos.set(event.toolCallId, video);
          registerGeneratedImage(this.store, meta);
          // Third, smaller ceiling: what a browser is shown of a tool result,
          // which never has to be complete because the transcript row is.
          payload = compactToolText(transportSafe(event, ref), { maxBytes: 6_000 });
        }

        const shouldStore =
          event.type === "message_update" ||
          event.type === "tool_execution_start" ||
          event.type === "tool_execution_end" ||
          (event.type === "message_end" &&
            ["user", "assistant"].includes((event.message as { role?: string }).role ?? ""));
        if (!shouldStore) return;

        const type = event.type === "message_update" ? "message.delta" : event.type.replaceAll("_", ".");
        const safe =
          event.type === "message_update"
            ? { assistantMessageEvent: transportSafe(event.assistantMessageEvent) }
            : transportSafe(payload);
        this.emit(runId, conversationId, type, {
          ...(safe as Record<string, unknown>),
          modelCallIndex,
          toolCallIndex: "toolCallId" in event ? toolIndexes.get(event.toolCallId) : undefined,
        });
      });

      titlePromise = isFirstTurn && prompts.titleEnabled
        ? this.scheduleTitle(runId, conversationId, spec.id, prompts.titleModelId, input.message)
        : Promise.resolve();

      if (input.continue && canResume(history)) await agent.continue();
      else await agent.prompt(input.message.trim(), media);
      if (entry.aborted) throw new Error("Run stopped by the user");
      if (terminalError) throw new Error(terminalError);
      // The terminal event closes every client stream, so anything that still
      // needs to reach the client — the generated title — must land first.
      await titlePromise;
      await this.finishOperation(openSession, runId, "completed");
      this.store.setRunStatus(runId, "completed");
      this.emit(runId, conversationId, "run.completed", {});
    } catch (error) {
      await titlePromise.catch(() => undefined);
      const raw = error instanceof Error ? error.message : String(error);
      // Cancellation is knowable from the run's own state and the error's type;
      // reading it out of the message text guessed wrong whenever a provider
      // happened to use the word.
      const cancelled =
        entry.aborted || cancel.signal.aborted || (error instanceof Error && error.name === "AbortError");
      const status = cancelled ? "cancelled" : "failed";
      const message = status === "cancelled" ? raw : describeModelError(raw, spec.name, error);
      await this.finishOperation(openSession, runId, status === "cancelled" ? "aborted" : "failed", message);
      this.store.setRunStatus(runId, status, message);
      this.emit(runId, conversationId, `run.${status}`, { message });
    } finally {
      this.active.delete(conversationId);
      cancel.abort();
      // A run cannot end with a question still on screen: whatever was waiting
      // for a decision is gone, so the card has to stop offering one.
      for (const pending of this.store.pendingApprovals(conversationId)) {
        if (pending.runId !== runId) continue;
        const settled = this.store.decideApproval(pending.id, "expired");
        this.approvals.notify(pending.id);
        if (settled) this.emit(runId, conversationId, "tool.approval.resolved", { approval: settled });
      }
      this.store.pruneSettledTransientEvents(DELTA_RETENTION_MS);
      this.store.reclaimStorage();
    }
  }

  /**
   * Closes the run's operation in the tree. Deliberately silent on failure: the
   * outcome is already recorded in `runs`, and losing the log record must not
   * turn a finished answer into a failed run.
   */
  private async finishOperation(
    session: ConversationSession | undefined,
    runId: string,
    outcome: "completed" | "aborted" | "failed",
    message?: string,
  ) {
    if (!session) return;
    try {
      await session.appendRecord({
        type: "operation_finished",
        id: session.idGenerator.next(),
        lane: LANE,
        runId,
        outcome,
        ...(message ? { error: { code: outcome, message } } : {}),
      });
    } catch (error) {
      console.warn(`[session] ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Preflight for one tool call. Ordinary calls fall straight through; a
   * destructive one is held until a person answers. Returning a blocked result
   * rather than throwing is what turns a refusal into an ordinary tool result
   * the model can read and reason about, instead of an error it might retry.
   */
  private async gate(
    runId: string,
    conversationId: string,
    workspace: string,
    toolCall: { name: string; id: string },
    args: unknown,
    signal: AbortSignal,
  ) {
    const risk = describeRisk(toolCall.name, (args ?? {}) as Record<string, unknown>, workspace);
    if (!risk) return undefined;

    const approval = this.store.requestApproval({
      id: toolCall.id,
      runId,
      conversationId,
      toolName: toolCall.name,
      action: risk.action,
      summary: risk.summary,
      detail: risk.detail,
    });
    if (approval.status === "pending") {
      this.emit(runId, conversationId, "tool.approval.required", { approval });
    }

    const settled = await this.approvals.wait(this.store, approval.id, signal);
    this.emit(runId, conversationId, "tool.approval.resolved", { approval: settled });
    return settled.status === "approved" ? undefined : { block: true as const, reason: rejectionMessage(settled) };
  }

  /**
   * Fires the naming call alongside the main run so the sidebar updates while
   * the answer is still streaming. The call carries its own system prompt, not
   * the conversation's: the persona answers a naming request the way it answers
   * a turn, and what reached the sidebar was its preamble or its tool call.
   */
  private async scheduleTitle(
    runId: string,
    conversationId: string,
    conversationModelId: string,
    titleModelId: string,
    userText: string,
  ) {
    const modelId = titleModelId && this.store.getModel(titleModelId)?.enabled ? titleModelId : conversationModelId;
    try {
      const generated = await generateTitle({
        registry: this.registry,
        modelId,
        userText,
        assistantText: "",
      });
      const title = generated || fallbackTitle(userText);
      if (!title) return;
      this.store.setConversationTitle(conversationId, title);
      this.emit(runId, conversationId, "conversation.title", { title });
    } catch (error) {
      // A conversation without a generated title is harmless, but a silent
      // failure here is hard to notice, so it is logged.
      console.error("[title]", error instanceof Error ? error.message : error);
    }
  }

  private contextBudget(contextWindow: number, maxTokens: number, systemPrompt: string, tools: AgentTool[]) {
    const budget = Math.max(1024, contextWindow - contextReserve(maxTokens));
    // Schema tokens are counted after `intent` injection, which is already
    // present in the tool definitions at this point.
    const toolTokens = tools.reduce(
      (total, tool) => total + countTokens(`${tool.name}${tool.description ?? ""}${JSON.stringify(tool.parameters)}`),
      0,
    );
    return Math.max(1024, budget - countTokens(systemPrompt) - toolTokens);
  }

  stop(conversationId: string) {
    const entry = this.active.get(conversationId);
    if (!entry) return false;
    entry.aborted = true;
    // Cancels preparation — summarizing a long conversation is itself a model
    // call — and then the loop, if it got that far.
    entry.cancel.abort();
    entry.agent?.abort();
    return true;
  }

  steer(conversationId: string, text: string) {
    const entry = this.active.get(conversationId);
    if (!entry?.agent) return false;
    entry.agent.steer({ role: "user", content: text, timestamp: Date.now() } as AgentMessage);
    return true;
  }
}
