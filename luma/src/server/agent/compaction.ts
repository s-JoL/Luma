import {
  compact,
  DEFAULT_COMPACTION_SETTINGS,
  estimateContextTokens,
  prepareCompaction,
  shouldCompact,
  buildSessionContext,
  type CompactionSettings,
  type Entry,
  type Session,
  type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { Model, Models, RetryPolicy } from "@earendil-works/pi-ai";
import { describeRefs } from "./messages.ts";
import { LANE } from "./sessions.ts";

/**
 * Headroom for the model's own reply. A fraction of the context window is the
 * wrong shape for this: 5% of grok-4.6's 500k window is 25k in front of a model
 * whose `maxTokens` is 65,536, so the input side was authorised to fill 475k and
 * the request could only overflow. What the model may emit is the only number
 * that bounds it, and pi's own 16,384 is the floor for a row that understates it.
 */
export const contextReserve = (maxTokens: number) =>
  Math.max(maxTokens, DEFAULT_COMPACTION_SETTINGS.reserveTokens);

/**
 * Thresholds scaled to the model in front of us. pi's defaults reserve 16k
 * tokens and retain 20k, which is right for a 200k window and nonsense for a
 * 32k one, where they would reserve half the context and try to retain more
 * than exists. The caps keep large models on the upstream defaults.
 *
 * The reservation is the output budget rather than a share of the window, so
 * compaction fires earlier on a model that can emit 65k than pi's 16,384 default
 * would have it — which is the point, because that output has to fit too. Half
 * the window is the ceiling: past that there is no room left to summarise into.
 */
function compactionSettings(contextWindow: number, maxTokens: number, enabled = true): CompactionSettings {
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, Math.round(value)));
  return {
    enabled,
    reserveTokens: clamp(contextReserve(maxTokens), 1_024, contextWindow * 0.5),
    keepRecentTokens: clamp(contextWindow * 0.25, 2_048, DEFAULT_COMPACTION_SETTINGS.keepRecentTokens),
  };
}

/**
 * Summarising is an ordinary provider call and fails like one, but unlike a turn
 * it runs outside the retrying wrapper, so a single transient 502 used to drop
 * into `onError` and leave the run on a merely-pruned context that was still
 * over budget. `baseDelayMs` is pi's own harness default.
 */
const SUMMARY_RETRY: RetryPolicy = { enabled: true, maxRetries: 3, baseDelayMs: 1_000 };

export interface CompactionOutcome {
  entryId: string;
  summary: string;
  tokensBefore: number;
}

/**
 * Replaces the older half of a conversation with a written summary once it stops
 * fitting in the context window.
 *
 * This is what a long conversation needs instead of dropping its oldest turns:
 * the model keeps a description of what happened and why, and the reader keeps
 * every original message, because the summary is a new entry in the tree rather
 * than a deletion from it.
 *
 * Returns undefined when the conversation still fits, when there is nothing old
 * enough to summarize, or when the summary call fails — in which case the run
 * continues on the trimmed context, which is worse but not broken.
 */
export async function compactIfNeeded(options: {
  session: Session;
  entries: Entry[];
  models: Models;
  model: Model<never>;
  contextWindow: number;
  /** The model's own output budget, which the reservation is sized from. */
  maxTokens: number;
  enabled?: boolean;
  thinkingLevel?: ThinkingLevel;
  signal?: AbortSignal;
  onError?: (message: string) => void;
}): Promise<CompactionOutcome | undefined> {
  const settings = compactionSettings(options.contextWindow, options.maxTokens, options.enabled ?? true);
  if (!settings.enabled || !options.entries.length) return undefined;

  const tokens = estimateContextTokens(buildSessionContext(options.entries).messages).tokens;
  if (!shouldCompact(tokens, options.contextWindow, settings)) return undefined;

  // Nothing to do when the newest entry is already a compaction, or when the
  // retained tail alone accounts for the whole branch.
  const preparation = prepareCompaction(options.entries, settings);
  if (!preparation.ok || !preparation.value) return undefined;

  // The summariser is an ordinary model call, so what it is sent has to be
  // projected the same way a turn is. Handing it raw `image_ref` parts made
  // every provider adapter map them to an image block with undefined data, so
  // summarising failed — silently, into `onError` — for exactly the
  // conversations that grow long enough to need it. `retainedTail` is left
  // alone: it is persisted and projected again on the way out.
  const prepared = {
    ...preparation.value,
    messagesToSummarize: describeRefs(preparation.value.messagesToSummarize),
    turnPrefixMessages: describeRefs(preparation.value.turnPrefixMessages),
  };

  const result = await compact(
    prepared,
    options.models,
    options.model as Model<never>,
    undefined,
    options.signal,
    options.thinkingLevel,
    SUMMARY_RETRY,
  );
  if (!result.ok) {
    options.onError?.(result.error.message);
    return undefined;
  }

  const { summary, retainedTail, tokensBefore, details, usage } = result.value;
  const entry = await options.session.appendEntry(
    {
      type: "compaction",
      id: options.session.idGenerator.next(),
      summary,
      retainedTail,
      tokensBefore,
      ...(details === undefined ? {} : { details }),
      ...(usage === undefined ? {} : { usage }),
    },
    LANE,
  );
  // Summarizing costs tokens like any other call, so it belongs in the ledger.
  if (usage) {
    await options.session.appendRecord({
      type: "usage",
      id: options.session.idGenerator.next(),
      lane: LANE,
      usage,
      cause: "compaction",
      runId: entry.id,
      entryId: entry.id,
      attempt: 1,
      stopReason: "stop",
    });
  }
  return { entryId: entry.id, summary, tokensBefore };
}
