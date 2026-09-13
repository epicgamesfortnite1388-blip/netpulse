export interface WsMessage {
  type: string;
  testId?: string;
  task?: string;
  pct?: number;
  message?: string;
  [key: string]: unknown;
}

type Listener = (msg: WsMessage) => void;

const MAX_CACHED_TOPICS = 500;

/**
 * Minimal in-process pub/sub connecting long-running test services
 * to connected WebSocket clients. Topics are test IDs.
 *
 * The most recent message per topic is cached so a subscriber that connects
 * after a fast test already finished still receives its terminal result
 * (without replay, the browser-side WS subscribe round-trip can lose the
 * `test:done` of tests that complete in under a second).
 */
export class RealtimeBus {
  private topics = new Map<string, Set<Listener>>();
  private last = new Map<string, WsMessage>();

  subscribe(topic: string, listener: Listener): () => void {
    let set = this.topics.get(topic);
    if (!set) {
      set = new Set();
      this.topics.set(topic, set);
    }
    set.add(listener);
    // replay the latest message so a late subscriber never misses a terminal result
    const cached = this.last.get(topic);
    if (cached) {
      try {
        listener(cached);
      } catch {
        // a broken client must never break a running test
      }
    }
    return () => {
      set?.delete(listener);
      if (set && set.size === 0) this.topics.delete(topic);
    };
  }

  publish(topic: string, msg: WsMessage): void {
    this.last.set(topic, msg);
    if (this.last.size > MAX_CACHED_TOPICS) {
      // bounded cache: evict the oldest topic so long-running sessions cannot leak
      const oldest = this.last.keys().next().value as string | undefined;
      if (oldest) this.last.delete(oldest);
    }
    const set = this.topics.get(topic);
    if (!set) return;
    for (const listener of set) {
      try {
        listener(msg);
      } catch {
        // a broken client must never break a running test
      }
    }
  }

  subscriberCount(topic: string): number {
    return this.topics.get(topic)?.size ?? 0;
  }

  /** Test hook: clear all topics and cached messages. */
  clear(): void {
    this.topics.clear();
    this.last.clear();
  }
}
