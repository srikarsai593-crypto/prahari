/**
 * Registration for the offline cache.
 *
 * Only in production. A service worker that serves cached HTML in front of
 * `next dev` breaks hot reload in a way that looks like the edit did not
 * save, and debugging that costs more than the cache saves.
 */
export async function registerServiceWorker(): Promise<void> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;

  if (process.env.NODE_ENV !== 'production') {
    // A worker registered by an earlier production build outlives the build
    // that installed it, so a developer switching to `npm run dev` on the
    // same origin keeps being served the cached shell. Clear it.
    const existing = await navigator.serviceWorker.getRegistrations().catch(() => []);
    await Promise.all(existing.map((registration) => registration.unregister()));
    return;
  }

  try {
    await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  } catch (error) {
    // A console that cannot cache still works; one that crashes on boot
    // because the cache would not install does not.
    console.warn('Offline cache unavailable', error);
  }
}
