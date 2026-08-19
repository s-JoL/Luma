import type { StoredEvent } from "@shared/types.ts";

type Listener = (event: StoredEvent) => void;

/**
 * In-process fan-out for live events. Durability lives in the `events` table;
 * this only saves connected clients a database poll.
 */
export class EventBus {
  private readonly byConversation = new Map<string, Set<Listener>>();

  subscribe(conversationId: string, listener: Listener) {
    let listeners = this.byConversation.get(conversationId);
    if (!listeners) {
      listeners = new Set();
      this.byConversation.set(conversationId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.byConversation.delete(conversationId);
    };
  }

  publish(event: StoredEvent) {
    const listeners = this.byConversation.get(event.conversationId);
    if (!listeners) return;
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // A broken client connection must not interrupt the run.
      }
    }
  }

  subscriberCount(conversationId: string) {
    return this.byConversation.get(conversationId)?.size ?? 0;
  }
}
