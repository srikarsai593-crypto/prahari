import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerServiceWorker } from './serviceWorker';

/**
 * The cache itself is browser behaviour and is not simulated here. What is
 * worth pinning is the policy around it: that it never installs in front of
 * the dev server, that it clears a worker left behind by a production build
 * on the same origin, and that a console whose cache will not install still
 * boots.
 */

const original = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker');

function stubServiceWorker(impl: Partial<ServiceWorkerContainer>) {
  Object.defineProperty(navigator, 'serviceWorker', {
    value: impl, configurable: true, writable: true,
  });
}

beforeEach(() => { vi.restoreAllMocks(); });

afterEach(() => {
  if (original) Object.defineProperty(navigator, 'serviceWorker', original);
  vi.unstubAllEnvs();
});

describe('registerServiceWorker', () => {
  it('installs the cache in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const register = vi.fn().mockResolvedValue({});
    stubServiceWorker({ register, getRegistrations: vi.fn() } as never);

    await registerServiceWorker();

    expect(register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
  });

  it('never installs in front of the dev server', async () => {
    /** A worker serving cached HTML over `next dev` breaks hot reload in a
     *  way that looks like the edit did not save. */
    vi.stubEnv('NODE_ENV', 'development');
    const register = vi.fn();
    stubServiceWorker({ register, getRegistrations: vi.fn().mockResolvedValue([]) } as never);

    await registerServiceWorker();

    expect(register).not.toHaveBeenCalled();
  });

  it('clears a worker a production build left on the same origin', async () => {
    /** Otherwise a developer switching to `npm run dev` keeps being served
     *  the cached shell by a worker nothing on the page installed. */
    vi.stubEnv('NODE_ENV', 'development');
    const unregister = vi.fn().mockResolvedValue(true);
    stubServiceWorker({
      register: vi.fn(),
      getRegistrations: vi.fn().mockResolvedValue([{ unregister }]),
    } as never);

    await registerServiceWorker();

    expect(unregister).toHaveBeenCalled();
  });

  it('does not take the console down when the cache will not install', async () => {
    /** A console that cannot cache still works; one that crashes on boot
     *  because the cache would not install does not. */
    vi.stubEnv('NODE_ENV', 'production');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubServiceWorker({
      register: vi.fn().mockRejectedValue(new Error('registration blocked')),
      getRegistrations: vi.fn(),
    } as never);

    await expect(registerServiceWorker()).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalled();
  });

  it('does nothing where the browser has no service workers at all', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    Object.defineProperty(navigator, 'serviceWorker', {
      value: undefined, configurable: true, writable: true,
    });
    await expect(registerServiceWorker()).resolves.toBeUndefined();
  });
});
