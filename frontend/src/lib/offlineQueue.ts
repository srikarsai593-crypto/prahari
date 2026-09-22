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
    const failed: QueuedRequest[] = [];
    const pending = [...this.queue];
    this.queue = []; // Clear optimistically — failed items will be re-queued at front

    for (const req of pending) {
      try {
        const response = await fetch(req.url, req.options);
        if (response.ok) {
          flushed++;
        } else {
          // Server returned an error — re-queue to retry later
          console.warn(`Flush rejected (${response.status}): ${req.description} — re-queuing`);
          failed.push(req);
        }
      } catch (e) {
        // Network failure — re-queue at front so order is preserved on next attempt
        console.error('Flush network error, re-queuing:', req.description, e);
        failed.push(req);
      }
    }

    // Re-insert failed items at the front of the queue in original order
    if (failed.length > 0) {
      this.queue = [...failed, ...this.queue];
    }

    if (flushed > 0) {
      try {
        await fetch('/api/events', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            module: 'system',
            action: `Reconnected — ${flushed} queued change${flushed !== 1 ? 's' : ''} synced${failed.length > 0 ? `, ${failed.length} re-queued` : ''}`,
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
