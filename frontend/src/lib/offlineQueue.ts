export interface QueuedRequest {
  url: string;
  options: RequestInit;
  timestamp: number;
  description: string;
}

class OfflineQueue {
  private queue: QueuedRequest[] = [];
  private _isOffline: boolean = false;
  private listeners: Set<() => void> = new Set();

  get isOffline() { return this._isOffline; }
  get pendingCount() { return this.queue.length; }

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private notify() {
    this.listeners.forEach(fn => fn());
  }

  setOffline(offline: boolean) {
    this._isOffline = offline;
    this.notify();
  }

  enqueue(url: string, options: RequestInit, description: string) {
    this.queue.push({ url, options, timestamp: Date.now(), description });
    this.notify();
  }

  async flush(): Promise<number> {
    let flushed = 0;
    const pending = [...this.queue];
    this.queue = [];
    for (const req of pending) {
      try {
        await fetch(req.url, req.options);
        flushed++;
      } catch (e) {
        console.error('Failed to flush:', req.description, e);
      }
    }
    if (flushed > 0) {
      try {
        await fetch('/api/events', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            module: 'system',
            action: `Reconnected — ${flushed} queued changes synced`,
            actor: 'offline_queue'
          })
        });
      } catch (e) { console.error('Failed to log reconnect event', e); }
    }
    this.notify();
    return flushed;
  }

  getPending(): QueuedRequest[] {
    return [...this.queue];
  }
}

export const offlineQueue = new OfflineQueue();
