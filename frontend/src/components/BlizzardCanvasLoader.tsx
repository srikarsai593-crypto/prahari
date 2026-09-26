'use client';
import dynamic from 'next/dynamic';

/**
 * Client-only mount for the hero blizzard.
 *
 * `ssr: false` because the canvas reads `devicePixelRatio`, `matchMedia` and
 * the host element's measured size — none of which exist on the server, and a
 * server-rendered empty canvas would only have to be thrown away on hydration.
 */
const BlizzardCanvas = dynamic(() => import('./BlizzardCanvas'), { ssr: false });

export default function BlizzardCanvasLoader() {
  return <BlizzardCanvas />;
}
