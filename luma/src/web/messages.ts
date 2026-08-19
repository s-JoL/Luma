/**
 * Turns the persisted message log into something renderable. Assistant work
 * spanning several model calls (text → tool → text) is folded into a single
 * visual turn, which is how the conversation actually reads.
 */
import type { Approval, JobRecord, StoredMessage } from "@shared/types.ts";

export interface TextPart {
  kind: "text";
  text: string;
}

export interface ThinkingPart {
  kind: "thinking";
  text: string;
}

export interface ImagePart {
  kind: "image";
  imageId: string;
}

export interface VideoPart {
  kind: "video";
  videoId: string;
  posterImageId?: string;
  durationMs?: number;
}

export interface ToolPart {
  kind: "tool";
  callId: string;
  name: string;
  args: unknown;
  result: string;
  isError: boolean;
  running: boolean;
}

/**
 * A destructive call waiting on the reader. It sits in the transcript where the
 * tool block will go, so the question appears in the flow of work rather than
 * in a modal that hides what led to it.
 */
export interface ApprovalPart {
  kind: "approval";
  approval: Approval;
}

/**
 * A generation this turn started. The run stream carries the whole job row on
 * every `job.progress`, so the transcript can show the same queue card the
 * studio does instead of a spinner that says nothing for two minutes.
 */
export interface JobPart {
  kind: "job";
  jobId: string;
  job: JobRecord;
}

export type Part = TextPart | ThinkingPart | ImagePart | VideoPart | ToolPart | ApprovalPart | JobPart;

export interface Turn {
  id: string;
  /** Sequence of the turn's first message — the rewind point for edit and regenerate. */
  seq: number;
  role: "user" | "assistant";
  parts: Part[];
  error?: string;
}

export interface Citation {
  label: string;
  url?: string;
  detail?: string;
}

/**
 * Tool output marks sources with `\ue202turn0file1`-style anchors. Models echo
 * them back either as the six literal characters `\ue202` or as the U+E202
 * codepoint itself, so both spellings have to resolve to the same source.
 */
const ANCHOR_BODY = "turn(\\d+)(file|search|news|image|video)(\\d+)";
export const CITATION_PATTERN = new RegExp(`(?:\\\\ue202|\\ue202)${ANCHOR_BODY}`, "gi");

/**
 * The wrappers that come with those anchors: U+E200/U+E201 bracket a run of
 * sources, U+E203/U+E204 bracket the sentence they support. They carry no text
 * of their own, and a browser draws an unassigned private-use codepoint as a
 * tofu box, so they are removed before rendering.
 */
export const CITATION_MARKUP_PATTERN = /\\ue20[0134]|[\ue200\ue201\ue203\ue204]/gi;

/** Collapses either spelling of an anchor onto the key `collectCitations` stores. */
export function citationKey(anchor: string) {
  return anchor.replace(/^(?:\\ue202|\ue202)/i, "\\ue202").toLowerCase();
}

const REASONING_MARKER = /\n*__ENCRYPTED_REASONING__[\s\S]*$/;

function partsOf(content: unknown): Array<Record<string, unknown>> {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  return Array.isArray(content) ? (content as Array<Record<string, unknown>>) : [];
}

/** Media the tools appended to the message, in either role's content. */
function pushMedia(parts: Part[], part: Record<string, unknown>) {
  if (part.type === "image_ref") parts.push({ kind: "image", imageId: String(part.image_id) });
  if (part.type === "video_ref") {
    parts.push({
      kind: "video",
      videoId: String(part.video_id),
      posterImageId: part.poster_image_id ? String(part.poster_image_id) : undefined,
      durationMs: Number(part.duration_ms) || undefined,
    });
  }
}

function pushText(parts: Part[], text: string) {
  if (!text) return;
  const last = parts.at(-1);
  if (last?.kind === "text") last.text += text;
  else parts.push({ kind: "text", text });
}

/**
 * Every picture once. The tool result is where a generated image reliably is, so
 * that is what the transcript shows; the model is also asked to place the image
 * in its answer, and where it did, the standalone copy is the second one and
 * goes. Videos are never referenced from prose, so they are always the
 * standalone copy.
 */
const INLINE_IMAGE = /image:\/\/(img_[0-9a-f]{32})/gi;

function withoutRepeatedImages(parts: Part[]): Part[] {
  if (!parts.some((part) => part.kind === "image")) return parts;
  const prose = parts.map((part) => (part.kind === "text" ? part.text : "")).join("\n");
  const inlined = new Set([...prose.matchAll(INLINE_IMAGE)].map((match) => match[1]!.toLowerCase()));
  if (!inlined.size) return parts;
  return parts.filter((part) => part.kind !== "image" || !inlined.has(part.imageId.toLowerCase()));
}

export function buildTurns(messages: StoredMessage[]): Turn[] {
  const turns: Turn[] = [];
  const toolIndex = new Map<string, ToolPart>();

  for (const message of messages) {
    const content = (message.content as { content?: unknown } | null)?.content ?? message.content;
    const raw = message.content as Record<string, unknown> | null;

    if (message.role === "user") {
      const turn: Turn = { id: message.id, seq: message.seq, role: "user", parts: [] };
      for (const part of partsOf(content)) {
        if (part.type === "text") pushText(turn.parts, String(part.text ?? ""));
        pushMedia(turn.parts, part);
      }
      turns.push(turn);
      continue;
    }

    if (message.role === "toolResult") {
      const tool = toolIndex.get(String(raw?.toolCallId ?? ""));
      if (!tool) continue;
      tool.running = false;
      tool.isError = Boolean(raw?.isError);
      tool.result = partsOf(content)
        .filter((part) => part.type === "text")
        .map((part) => String(part.text ?? ""))
        .join("\n");
      // What the tool actually produced. The model is asked to embed the
      // picture in its answer and usually does, but a run where it only
      // described the picture used to show no picture at all, so the tool
      // result is where the transcript takes it from.
      const turn = turns.at(-1);
      if (turn?.role === "assistant") for (const part of partsOf(content)) pushMedia(turn.parts, part);
      continue;
    }

    if (message.role !== "assistant") continue;

    let turn = turns.at(-1);
    if (!turn || turn.role !== "assistant") {
      turn = { id: message.id, seq: message.seq, role: "assistant", parts: [] };
      turns.push(turn);
    }
    if (raw?.stopReason === "error") turn.error = String(raw.errorMessage ?? "模型请求失败");

    for (const part of partsOf(content)) {
      if (part.type === "text") pushText(turn.parts, String(part.text ?? ""));
      if (part.type === "thinking") {
        const text = String(part.thinking ?? "").replace(REASONING_MARKER, "").trim();
        if (text) turn.parts.push({ kind: "thinking", text });
      }
      if (part.type === "toolCall") {
        const tool: ToolPart = {
          kind: "tool",
          callId: String(part.id ?? ""),
          name: String(part.name ?? "tool"),
          args: part.arguments,
          result: "",
          isError: false,
          running: true,
        };
        toolIndex.set(tool.callId, tool);
        turn.parts.push(tool);
      }
      pushMedia(turn.parts, part);
    }
  }

  for (const turn of turns) turn.parts = withoutRepeatedImages(turn.parts);
  return turns;
}

/**
 * Live turn assembled from run events. The persisted log replaces it once the
 * run settles, so this only has to be good enough to watch in real time.
 */
export class LiveTurn {
  parts: Part[] = [];
  error = "";
  private readonly tools = new Map<string, ToolPart>();
  private readonly approvals = new Map<string, ApprovalPart>();
  private readonly jobs = new Map<string, JobPart>();
  /** Last handed-out copy of each part, reused while that part is unchanged. */
  private readonly copies: Part[] = [];

  /** Tool calls already visible in the transcript, skipped when reattaching. */
  constructor(private readonly known: Set<string> = new Set()) {}

  /**
   * Re-adds questions asked while this client was closed. The stream replays
   * them too when the resume point is early enough, which is why this goes
   * through the same idempotent path rather than pushing parts directly.
   */
  seedApprovals(approvals: Approval[]) {
    for (const approval of approvals) this.apply("tool.approval.required", { approval });
  }

  apply(type: string, data: Record<string, unknown>) {
    if (type === "message.delta") {
      const event = data.assistantMessageEvent as { type?: string; delta?: string } | undefined;
      if (event?.type === "text_delta" && event.delta) pushText(this.parts, event.delta);
      if (event?.type === "thinking_delta" && event.delta) {
        const last = this.parts.at(-1);
        if (last?.kind === "thinking") last.text += event.delta;
        else this.parts.push({ kind: "thinking", text: event.delta });
      }
    }

    // The approval is keyed by tool call id, so when the call finally runs its
    // tool block replaces the card in place instead of stacking beneath it.
    if (type === "tool.approval.required" || type === "tool.approval.resolved") {
      const approval = data.approval as Approval | undefined;
      if (!approval) return;
      const existing = this.approvals.get(approval.id);
      if (existing) existing.approval = approval;
      else {
        const part: ApprovalPart = { kind: "approval", approval };
        this.approvals.set(approval.id, part);
        this.parts.push(part);
      }
    }

    // The event's payload is the job row itself. A card that succeeded is
    // dropped rather than kept: its picture arrives moments later as an image
    // part, and showing both means the reader sees the same result twice.
    if (type === "job.progress") {
      const job = data as unknown as JobRecord;
      if (!job?.id) return;
      const existing = this.jobs.get(job.id);
      if (job.status === "succeeded") {
        if (existing) {
          this.parts.splice(this.parts.indexOf(existing), 1);
          this.jobs.delete(job.id);
          this.copies.length = 0;
        }
        return;
      }
      if (existing) existing.job = job;
      else {
        const part: JobPart = { kind: "job", jobId: job.id, job };
        this.jobs.set(job.id, part);
        this.parts.push(part);
      }
    }

    if (type === "tool.execution.start") {
      const callId = String(data.toolCallId ?? "");
      if (this.known.has(callId)) return;
      // An approved call is about to show its own block; drop the question.
      const asked = this.approvals.get(callId);
      if (asked) {
        this.parts.splice(this.parts.indexOf(asked), 1);
        this.approvals.delete(callId);
        this.copies.length = 0;
      }
      const tool: ToolPart = {
        kind: "tool",
        callId,
        name: String(data.toolName ?? "tool"),
        args: data.args,
        result: "",
        isError: false,
        running: true,
      };
      this.tools.set(callId, tool);
      this.parts.push(tool);
    }

    if (type === "tool.execution.end") {
      const tool = this.tools.get(String(data.toolCallId ?? ""));
      if (tool) {
        tool.running = false;
        tool.isError = Boolean(data.isError);
        const result = data.result as { content?: unknown } | undefined;
        tool.result = partsOf(result?.content)
          .filter((part) => part.type === "text")
          .map((part) => String(part.text ?? ""))
          .join("\n");
        // The base64 has already been swapped for a ref server-side, so this is
        // the same picture the settled transcript will show — and it shows now,
        // rather than when the model gets around to mentioning it.
        for (const part of partsOf(result?.content)) pushMedia(this.parts, part);
      }
    }

    if (type === "message.end") {
      const message = data.message as Record<string, unknown> | undefined;
      if (message?.role === "assistant" && message.stopReason === "error") {
        this.error = String(message.errorMessage ?? "模型请求失败");
      }
    }
  }

  /**
   * A snapshot is taken on every delta, so only the part that actually moved
   * gets a new object. Handing back the same reference for everything else is
   * what lets the already-rendered tool blocks and finished paragraphs skip
   * re-rendering — and re-parsing their Markdown — sixty times a second.
   */
  snapshot(): Turn {
    const parts = withoutRepeatedImages(this.parts).map((part, index) => {
      const cached = this.copies[index];
      if (cached && sameShape(cached, part)) return cached;
      const copy = { ...part } as Part;
      this.copies[index] = copy;
      return copy;
    });
    return { id: "live", seq: -1, role: "assistant", parts, error: this.error || undefined };
  }
}

function sameShape(a: Part, b: Part) {
  const left = a as unknown as Record<string, unknown>;
  const right = b as unknown as Record<string, unknown>;
  const keys = Object.keys(right);
  return keys.length === Object.keys(left).length && keys.every((key) => Object.is(left[key], right[key]));
}

/**
 * Builds the anchor → source map by re-reading tool output, so citations keep
 * resolving after a reload without persisting a second copy of the sources.
 */
export function collectCitations(turns: Turn[]): Map<string, Citation> {
  const citations = new Map<string, Citation>();
  for (const turn of turns) {
    for (const part of turn.parts) {
      if (part.kind !== "tool" || !part.result) continue;
      for (const block of part.result.split(/\n(?=#|File:)/)) {
        const anchor = block.match(/Anchor:\s*((?:\\ue202|\ue202)turn\d+(?:file|search|news|image|video)\d+)/i);
        if (!anchor?.[1]) continue;
        const file = block.match(/Anchor:\s*(?:\\ue202|\ue202)turn\d+file\d+\s*\(([^)]+)\)/i);
        const url = block.match(/^URL:\s*(\S+)$/m)?.[1];
        const title = block.match(/^#\s*(?:Search|News)\s*\d+:\s*"?([^"\n]*)"?/m)?.[1];
        citations.set(citationKey(anchor[1]), {
          label: file?.[1] ?? (url ? hostOf(url) : (title ?? "source")),
          url,
          detail: title ?? file?.[1],
        });
      }
    }
  }
  return citations;
}

function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * Every file a user turn carried, by id. Edit and regenerate re-send exactly
 * this list, so narrowing it to images is how an attachment that was not a
 * picture used to disappear from the replayed turn.
 */
export function attachmentIdsOf(turn: Turn) {
  const ids: string[] = [];
  for (const part of turn.parts) {
    if (part.kind === "image") ids.push(part.imageId);
    if (part.kind === "video") ids.push(part.videoId);
  }
  return ids;
}

export function toolCallIds(turns: Turn[]) {
  const ids = new Set<string>();
  for (const turn of turns) {
    for (const part of turn.parts) if (part.kind === "tool") ids.add(part.callId);
  }
  return ids;
}

/** Plain text of a turn, with citation markers dropped so it pastes cleanly. */
export function turnText(turn: Turn) {
  return turn.parts
    .filter((part): part is TextPart => part.kind === "text")
    .map((part) => part.text)
    .join("")
    .replace(CITATION_PATTERN, "")
    .replace(CITATION_MARKUP_PATTERN, "");
}
