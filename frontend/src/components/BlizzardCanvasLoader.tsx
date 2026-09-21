'use client';
import dynamic from 'next/dynamic';

const BlizzardCanvas = dynamic(() => import('./BlizzardCanvas'), { ssr: false });

export default function BlizzardCanvasLoader() {
  return <BlizzardCanvas />;
}
