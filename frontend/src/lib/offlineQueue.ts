export interface QueuedRequest {
  id: string;
  url: string;
  method: string;
  /** Serialisable body. A RequestInit is not JSON-safe, so we store the parts. */
  body?: string;
  timestamp: number;
  description: string;
  attempts: number;
  lastError?: string;
}

const STORAGE_KEY = 'prahari_offline_queue_v2';

/** Cap the queue so a long outage cannot exhaust localStorage. */
const MAX_QUEUE_LENGTH = 200;
/** Give up on a request that the server keeps rejecting. */
const MAX_ATTEMPTS = 5;

type QueueListener = () => void;

export interface FlushResult {
  /** Mutations successfully replayed to the server. */
  flushed: number;
  /** Mutations still queued after this run. */
  failed: number;
  /** Mutations the server refused permanently and that were discarded. */
  dropped: number;
}

const NOTHING_TO_FLUSH: FlushResult = { flushed: 0, failed: 0, dropped: 0 };

/**
 * Durable queue for mutations made while the station link is down.
 *
 * Headers are NOT persisted. They are rebuilt at flush time from the current
 * credentials — a stored key would both go stale and sit in localStorage.
 */
class OfflineQueue {
  private queue: QueuedRequest[] = [];
  private _isOffline = false;
  private _flushing = false;
  /** The in-flight replay, so concurrent callers observe one real result. */
  private _flushPromise: Promise<FlushResult> | null = null;
  private listeners = new Set<QueueListener>();
  private headerFactory: () => Record<string, string> =
    () => ({ 'Content-Type': 'application/json' });

  constructor() {
    if (typeof window === 'undefined') return;
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) this.queue = parsed;
      }
    } catch {
      this.queue = [];
    }
  }

  /** Called once at startup so replays carry live credentials. */
  setHeaderFactory(fn: () => Record<string, string>) {
    this.headerFactory = fn;
  }

  get isOffline() { return this._isOffline; }
  get pendingCount() { return this.queue.length; }
  get isFlushing() { return this._flushing; }

  subscribe(fn: QueueListener) {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private notify() { this.listeners.forEach((fn) => fn()); }

  private persist() {
    if (typeof window === 'undefined') return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.queue));
    } catch (e) {
      console.error('Failed to persist offline queue', e);
    }
  }

  /**
   * Set link state. Coming back online drains the queue without the caller
   * having to remember to ask, and resolves with what that drain actually did.
   *
   * It used to start the flush and discard the promise, so a caller that then
   * ran its own `flush()` to report the outcome always saw zero — the queue was
   * already empty, or the second call collided with the first. The console told
   * the operator "0 queued changes synced" every time changes had in fact synced.
   */
  setOffline(offline: boolean): Promise<FlushResult> {
    const wasOffline = this._isOffline;
    this._isOffline = offline;
    this.notify();
    if (wasOffline && !offline && this.queue.length > 0) return this.flush();
    return Promise.resolve(NOTHING_TO_FLUSH);
  }

  enqueue(url: string, options: RequestInit, description: string) {
    if (this.queue.length >= MAX_QUEUE_LENGTH) {
      console.warn('Offline queue full — dropping oldest entry');
      this.queue.shift();
    }
    this.queue.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      url,
      method: (options.method || 'POST').toUpperCase(),
      body: typeof options.body === 'string' ? options.body : undefined,
      timestamp: Date.now(),
      description,
      attempts: 0,
    });
    this.persist();
    this.notify();
  }

  /**
   * Replay queued mutations in order.
   *
   * Order is preserved and the run stops at the first network failure: later
   * requests may depend on earlier ones, so replaying out of order can corrupt
   * state. A 4xx is permanent (bad payload), so it is dropped with a log rather
   * than retried forever.
   */
  flush(): Promise<FlushResult> {
    // Join the run already in progress rather than reporting a hollow zero.
    if (this._flushPromise) return this._flushPromise;
    this._flushPromise = this.replay().finally(() => { this._flushPromise = null; });
    return this._flushPromise;
  }

  private async replay(): Promise<FlushResult> {
    this._flushing = true;
    this.notify();

    let flushed = 0;
    let dropped = 0;
    const headers = this.headerFactory();

    try {
      while (this.queue.length > 0) {
        const req = this.queue[0];
        try {
          const response = await fetch(req.url, {
            method: req.method,
            headers,
            body: req.body,
          });

          if (response.ok) {
            this.queue.shift();
            flushed++;
          } else if (response.status >= 400 && response.status < 500) {
            // Permanent: replaying will never succeed. Drop it, but keep the
            // reason so the operator can see what was lost.
            console.error(`Dropping "${req.description}" — server rejected it `
              + `(${response.status}). It will not be retried.`);
            this.queue.shift();
            dropped++;
          } else {
            req.attempts++;
            req.lastError = `HTTP ${response.status}`;
            if (req.attempts >= MAX_ATTEMPTS) {
              console.error(`Dropping "${req.description}" after ${req.attempts} attempts.`);
              this.queue.shift();
              dropped++;
            } else {
              break; // server-side problem — stop and retry the whole run later
            }
          }
        } catch (e) {
          req.attempts++;
          req.lastError = e instanceof Error ? e.message : 'network error';
          break; // still offline — preserve order, retry later
        }
      }
    } finally {
      this._flushing = false;
      this.persist();
      this.notify();
    }

    if (flushed > 0) {
      // Report the counts and let the backend compose the audit line. The
      // general-purpose POST /events this used to call let the browser write
      // any module, actor and message it liked into the station's record.
      let station: string | null = null;
      try { station = localStorage.getItem('prahari_active_station'); } catch { /* blocked */ }
      try {
        await fetch('/api/events/sync-report', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            flushed,
            dropped,
            pending: this.queue.length,
            ...(station ? { station } : {}),
          }),
        });
      } catch (e) {
        console.error('Failed to log reconnect event', e);
      }
    }

    return { flushed, failed: this.queue.length, dropped };
  }

  getPending(): QueuedRequest[] { return [...this.queue]; }

  clear() {
    this.queue = [];
    this.persist();
    this.notify();
  }
}

export const offlineQueue = new OfflineQueue();
