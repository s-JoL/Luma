import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type AgentMessage,
  type TruncationOptions,
} from "@earendil-works/pi-agent-core";
import { countTokens } from "../prompts/context.ts";

export interface ImageRef {
  type: "image_ref";
  image_id: string;
  mime_type: string;
  width?: number | null;
  height?: number | null;
  parent_image_ids?: string[];
  provider?: string | null;
  model?: string | null;
}

export function imageRef(meta: unknown): ImageRef | undefined {
  const value = meta as Record<string, unknown> | null;
  const id = typeof value?.image_id === "string" ? value.image_id : "";
  if (!/^img_[0-9a-f]{32}$/i.test(id)) return undefined;
  return {
    type: "image_ref",
    image_id: id.toLowerCase(),
    mime_type: String(value?.mime_type ?? "image/png"),
    width: (value?.width as number | null) ?? null,
    height: (value?.height as number | null) ?? null,
    parent_image_ids: Array.isArray(value?.parent_image_ids) ? (value.parent_image_ids as string[]) : [],
    provider: (value?.provider as string | null) ?? null,
    model: (value?.model as string | null) ?? null,
  };
}

export interface VideoRef {
  type: "video_ref";
  video_id: string;
  mime_type: string;
  width?: number | null;
  height?: number | null;
  duration_ms?: number | null;
  poster_image_id?: string | null;
  provider?: string | null;
  model?: string | null;
}

export function videoRef(meta: unknown): VideoRef | undefined {
  const value = meta as Record<string, unknown> | null;
  const id = typeof value?.video_id === "string" ? value.video_id : "";
  if (!/^vid_[0-9a-f]{32}$/i.test(id)) return undefined;
  return {
    type: "video_ref",
    video_id: id.toLowerCase(),
    mime_type: String(value?.mime_type ?? "video/mp4"),
    width: (value?.width as number | null) ?? null,
    height: (value?.height as number | null) ?? null,
    duration_ms: (value?.duration_ms as number | null) ?? null,
    poster_image_id: (value?.poster_image_id as string | null) ?? null,
    provider: (value?.provider as string | null) ?? null,
    model: (value?.model as string | null) ?? null,
  };
}

/**
 * Appends a reference to a persisted message's content. An image arrives as a
 * base64 part that `persistMessage` swaps for its ref, but a video is never sent
 * to the model in the first place, so its ref has nothing to replace.
 */
export function withAppendedRef(persisted: unknown, ref: VideoRef | ImageRef) {
  const record = persisted as { content?: unknown } | null;
  if (!record || typeof record !== "object") return persisted;
  const content = Array.isArray(record.content)
    ? [...record.content, ref]
    : [{ type: "text", text: String(record.content ?? "") }, ref];
  return { ...record, content };
}

/** Strips base64 payloads so an event can be logged or sent to a browser. */
export function transportSafe(value: unknown, replacement?: ImageRef): unknown {
  if (Array.isArray(value)) return value.map((item) => transportSafe(item, replacement));
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (record.type === "image" && typeof record.data === "string") {
    return (
      replacement ?? {
        type: "image_omitted",
        mime_type: record.mimeType,
        byte_length: Math.floor(record.data.length * 0.75),
      }
    );
  }
  if (value instanceof Error) return { name: value.name, message: value.message };
  return Object.fromEntries(
    Object.entries(record)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, transportSafe(item, replacement)]),
  );
}

/**
 * pi's ceiling on one tool output, reused rather than restated: whichever of
 * 2000 lines or 50 KB is hit first, always cut on a line boundary. Bytes matter
 * because the previous single character count let a Chinese result through at
 * roughly three times the byte cost of an English one of the same length.
 *
 * The two limits below start equal and are deliberately separate constants,
 * because they answer different questions. Bounding what the model re-reads is
 * recoverable — the next turn projects the same stored result again — while the
 * persisted bound throws bytes away for good, so it is the one that must not be
 * tightened casually.
 */
const PERSISTED_TOOL_RESULT: TruncationOptions = { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES };
const PROJECTED_TOOL_RESULT: TruncationOptions = { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES };

const truncate = (text: string, limits: TruncationOptions) => {
  const bounded = truncateHead(text, limits);
  if (!bounded.truncated) return text;
  const omitted = bounded.totalBytes - bounded.outputBytes;
  const reason = bounded.truncatedBy === "lines" ? `${bounded.maxLines} lines` : formatSize(bounded.maxBytes);
  return `${bounded.content}\n…[truncated at ${reason}, ${formatSize(omitted)} omitted]`;
};

export function compactToolText(value: unknown, limits: TruncationOptions): unknown {
  if (Array.isArray(value)) return value.map((item) => compactToolText(item, limits));
  if (!value || typeof value !== "object") {
    return typeof value === "string" ? truncate(value, limits) : value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, compactToolText(item, limits)]),
  );
}

/**
 * Bounds every tool result in the context sent to the model. Applied at
 * assembly rather than at the tool, so what the current turn streams to the
 * client is still the whole result.
 *
 * Only text is cut. An image part's base64 is not prose, and a truncated one is
 * a broken picture rather than a shorter one.
 */
export function boundToolResults(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((message) => {
    if ((message as { role?: string }).role !== "toolResult") return message;
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") {
      return { ...message, content: truncate(content, PROJECTED_TOOL_RESULT) } as AgentMessage;
    }
    if (!Array.isArray(content)) return message;
    return {
      ...message,
      content: content.map((part) => {
        const record = part as Record<string, unknown>;
        return record?.type === "text" && typeof record.text === "string"
          ? { ...record, text: truncate(record.text, PROJECTED_TOOL_RESULT) }
          : part;
      }),
    } as AgentMessage;
  });
}

/** Converts an in-flight message into its durable form: no base64, ever. */
export function persistMessage(message: unknown, imageRefs: ImageRef[] = []) {
  let imageIndex = 0;
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    if (record.type === "image" && typeof record.data === "string") {
      return (
        imageRefs[imageIndex++] ?? {
          type: "image_omitted",
          mime_type: record.mimeType,
          byte_length: Math.floor(record.data.length * 0.75),
        }
      );
    }
    return Object.fromEntries(
      Object.entries(record)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, visit(item)]),
    );
  };
  const persisted = visit(message);
  return (message as { role?: string } | null)?.role === "toolResult"
    ? compactToolText(persisted, PERSISTED_TOOL_RESULT)
    : persisted;
}

/** The readable text of a message, with images, tool payloads and markers dropped. */
export function messageText(message: unknown) {
  const record = message as { content?: unknown } | null;
  if (!Array.isArray(record?.content)) return typeof record?.content === "string" ? record.content : "";
  return record.content
    .filter((part) => (part as { type?: string })?.type === "text")
    .map((part) => (part as { text?: string }).text ?? "")
    .join("\n");
}

function estimateMessageTokens(message: unknown): number {
  const record = message as { content?: unknown } | null;
  if (!record) return 0;
  if (typeof record.content === "string") return countTokens(record.content) + 4;
  if (!Array.isArray(record.content)) return countTokens(JSON.stringify(record)) + 4;
  let total = 4;
  for (const part of record.content as Array<Record<string, unknown>>) {
    if (part?.type === "text") total += countTokens(String(part.text ?? ""));
    else if (part?.type === "image_ref") total += 24;
    // pi's own figure — ESTIMATED_IMAGE_CHARS 4800 over CHARS_PER_TOKEN 4 in
    // `pi-ai/utils/estimate`, which is what its compaction estimator charges.
    // Neither constant is exported, so the quotient is restated here; the point
    // is that both sides price the same history identically.
    else if (part?.type === "image") total += 1_200;
    else total += countTokens(JSON.stringify(part ?? {}));
  }
  return total;
}

/** Roles a provider is sent directly; anything else is a summary or a marker. */
const PLAIN_ROLES = new Set(["user", "assistant", "toolResult"]);

/**
 * Reduces history to fit `usableTokens`, in the order specified by the design:
 * error turns, then dead image placeholders, then whole messages from the
 * oldest end — always cutting at a user-message boundary so a turn is never
 * left half-present.
 *
 * Compaction is what normally keeps a conversation inside its window; this is
 * the fallback for when summarizing was unavailable or did not free enough. The
 * leading summary is held out of the trim, because dropping it would take away
 * the one message standing in for everything already compacted.
 */
export function pruneHistory(messages: AgentMessage[], usableTokens: number): AgentMessage[] {
  const firstPlain = messages.findIndex((message) => PLAIN_ROLES.has((message as { role?: string }).role ?? ""));
  if (firstPlain > 0) {
    return [...messages.slice(0, firstPlain), ...pruneHistory(messages.slice(firstPlain), usableTokens)];
  }

  const withoutErrors = messages.filter(
    (message) =>
      !(
        (message as { role?: string }).role === "assistant" &&
        (message as { stopReason?: string }).stopReason === "error"
      ),
  );
  const cleaned = withoutErrors.map((message) => {
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) return message;
    return {
      ...message,
      // An `image` part with no data is a broken part and goes. `image_omitted`
      // stays: it is the record of a picture that arrived without an id, and
      // `describeRefs` turns it into a line saying so. Dropping it left the
      // model unable to know the image had ever existed.
      content: content.filter((part) => {
        const record = part as Record<string, unknown>;
        return !(record.type === "image" && !record.data);
      }),
    } as AgentMessage;
  });

  if (usableTokens <= 0) return cleaned;
  const costs = cleaned.map(estimateMessageTokens);
  let total = costs.reduce((sum, cost) => sum + cost, 0);
  if (total <= usableTokens) return cleaned;

  const userStarts = cleaned
    .map((message, index) => ((message as { role?: string }).role === "user" ? index : -1))
    .filter((index) => index >= 0);

  for (const start of userStarts) {
    const dropped = costs.slice(0, start).reduce((sum, cost) => sum + cost, 0);
    if (total - dropped <= usableTokens) return cleaned.slice(start);
  }
  // Even the newest turn alone overflows; keep it and let the provider decide.
  const lastStart = userStarts.at(-1);
  return lastStart == null ? cleaned : cleaned.slice(lastStart);
}

const dimensions = (width?: number | null, height?: number | null) =>
  width && height ? ` ${width}x${height}` : "";

/** Whether this branch carries a picture the model could ask to look at. */
export function hasImageRef(messages: AgentMessage[]) {
  return messages.some((message) => {
    const content = (message as { content?: unknown }).content;
    return Array.isArray(content) && content.some((part) => (part as { type?: string }).type === "image_ref");
  });
}

/**
 * Renders the media a transcript carries as text the model can read.
 *
 * Pixels enter the context only when the model asks for them by id. The
 * alternative — deciding from the wording of a turn whether it is "about
 * images" and silently re-uploading the last few — was a keyword test that
 * chose wrong in both directions: it missed the request that never said the
 * word, and it paid for three pictures nobody had asked about. These lines are
 * what make asking possible, because they are the only way the model learns
 * that an image exists at all and what its id is.
 */
export function describeRefs(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((message) => {
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) return message;
    return {
      ...message,
      content: content.map((part) => {
        const record = part as Record<string, unknown>;
        if (record.type === "image_ref") {
          const ref = record as unknown as ImageRef;
          return {
            type: "text",
            text: `[image image_id=${ref.image_id}${dimensions(ref.width, ref.height)} ${ref.mime_type}]`,
          };
        }
        // A picture that reached the transcript without an id — a tool that
        // returned several images, or one whose id did not survive validation.
        // It cannot be looked at, and saying nothing would be worse: the model
        // would answer as though the turn had been text.
        if (record.type === "image_omitted") {
          return { type: "text", text: `[image unavailable ${String(record.mime_type ?? "image")}]` };
        }
        if (record.type === "video_ref") {
          const ref = record as unknown as VideoRef;
          const seconds = ref.duration_ms ? ` ${(ref.duration_ms / 1000).toFixed(1)}s` : "";
          return {
            type: "text",
            text: `[video video_id=${ref.video_id}${dimensions(ref.width, ref.height)}${seconds} ${ref.mime_type}]`,
          };
        }
        return part;
      }),
    } as AgentMessage;
  });
}
