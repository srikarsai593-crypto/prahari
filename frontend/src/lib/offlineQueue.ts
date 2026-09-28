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

/**
 * Client-error statuses that are about the *moment*, not the request.
 *
 * 401 means the session lapsed while the console was offline; 403 that the
 * active station changed under it; 429 that the station is throttling. None of
 * them are a judgement on the queued work, and all of them clear without the
 * operator rewriting anything — so the work waits rather than being discarded.
 */
const RETRYABLE_STATUSES = new Set([401, 403, 408, 429]);

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
 * Nothing about the operator's identity is persisted. A replay carries the
 * session cookie the browser already holds, so a queue drained after the
 * session expired fails cleanly with a 401 rather than replaying under a stale
 * credential that was sitting in localStorage.
 */
class OfflineQueue {
  private queue: QueuedRequest[] = [];
  private _isOffline = false;
  private _blackout = false;
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
  /** True only while an operator is holding the link down deliberately. */
  get isBlackout() { return this._blackout; }
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

  /**
   * Operator-forced outage — the SATCOM blackout drill.
   *
   * Distinct from `setOffline`, which is the console's own reading of the
   * link. A blackout is deliberate, so it has to survive the socket's own
   * reconnect attempts: the WebSocket provider watches this flag and stays
   * down while it is set, rather than racing the operator back online. It is
   * also named separately in the badge, so nobody walks past a console mid
   * drill and reports a real satellite failure.
   *
   * Deliberately not persisted. A blackout is a demonstration of what the
   * console does during an outage, and coming back to a reloaded page still
   * severed — with no memory of why — is a worse failure than losing the
   * drill state.
   */
  setBlackout(on: boolean): Promise<FlushResult> {
    this._blackout = on;
    return this.setOffline(on);
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
            // The session cookie rides on this. Without it every replay is
            // anonymous, and a 401 in the branch below would discard the
            // operator's offline work as "permanently rejected".
            credentials: 'include',
            body: req.body,
          });

          if (response.ok) {
            this.queue.shift();
            flushed++;
          } else if (RETRYABLE_STATUSES.has(response.status)) {
            // Not a verdict on the request: the console is signed out, or the
            // station is throttling. Both clear on their own, and dropping
            // queued work over either one loses what an operator did offline.
            req.attempts++;
            req.lastError = `HTTP ${response.status}`;
            break;
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
          credentials: 'include',
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
