import dynamic from 'next/dynamic';

import type { Personnel, Incident } from '@/lib/types';

export interface MapViewProps {
  personnel?: Personnel[];
  incidents?: Incident[];
  routes?: Array<{ path: [number, number][]; type: 'planned' | 'actual' }>;
}

// Leaflet touches `window` at import time, so the map can only load in the
// browser.
const MapViewInner = dynamic(() => import('./MapViewInner'), {
  ssr: false,
  loading: () => (
    <div className="w-full h-full bg-arctic-50 rounded-xl flex items-center justify-center
                    text-frost-muted text-xs animate-pulse">
      Loading map…
    </div>
  ),
});

export const MapView = (props: MapViewProps) => <MapViewInner {...props} />;
