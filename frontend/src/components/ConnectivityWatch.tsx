'use client';

import { useEffect } from 'react';
import { offlineQueue } from '@/lib/offlineQueue';
import { registerServiceWorker } from '@/lib/serviceWorker';

/**
 * Wires the console to the browser's own view of connectivity, and installs
 * the offline cache.
 *
 * Renders nothing. It exists as a component because both jobs need to run in
 * the browser once, after hydration, and a module-level side effect would run
 * during the server render too.
 */
export function ConnectivityWatch() {
  useEffect(() => offlineQueue.watchBrowserConnectivity(), []);
  useEffect(() => { void registerServiceWorker(); }, []);
  return null;
}
