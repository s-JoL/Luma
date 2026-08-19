/**
 * A generation handed from one screen to another. The studio owns the form that
 * renders a generation model's schema, so "draw this again with one thing changed"
 * — asked from a transcript, or from a tile in the gallery — means putting the
 * parameters somewhere the studio will find them and then going there.
 *
 * sessionStorage rather than a query string, because the parameters include a
 * prompt of a few thousand characters and a list of source ids: more than a URL
 * should carry, and this hand-off is not meant to outlive the tab.
 */
import type { GenerationOp } from "@shared/types.ts";

const KEY = "luma.studio.draft";

/** Announces a draft to a studio that is already on screen, where navigating does nothing. */
const EVENT = "luma:studio-draft";

export interface StudioDraft {
  modelId: string;
  op: GenerationOp;
  params: Record<string, unknown>;
  /** Source ids, kept apart from `params` exactly as a job row keeps them. */
  sources?: string[];
}

export function handToStudio(draft: StudioDraft) {
  sessionStorage.setItem(KEY, JSON.stringify(draft));
  if (window.location.pathname !== "/studio") {
    window.history.pushState({}, "", "/studio");
    // What the app listens on for a route change it did not initiate itself.
    window.dispatchEvent(new PopStateEvent("popstate"));
  }
  window.dispatchEvent(new Event(EVENT));
}

/**
 * Read once. A draft left behind would reappear the next time the studio opened,
 * silently overwriting whatever the reader had typed by then.
 */
export function takeStudioDraft(): StudioDraft | undefined {
  const raw = sessionStorage.getItem(KEY);
  if (!raw) return undefined;
  sessionStorage.removeItem(KEY);
  try {
    return JSON.parse(raw) as StudioDraft;
  } catch {
    return undefined;
  }
}

export function onStudioDraft(listener: () => void) {
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
