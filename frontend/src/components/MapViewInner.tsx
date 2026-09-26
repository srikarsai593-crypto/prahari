'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Crosshair } from 'lucide-react';
import { MapContainer, TileLayer, Circle, Marker, Polyline, Popup, useMap } from 'react-leaflet';
import L from 'leaflet';
import { api } from '@/lib/api';
import { useStation } from '@/components/StationProvider';
import type { Geofence, Personnel, Incident } from '@/lib/types';

// ── Icons ─────────────────────────────────────────────────────────────────────
const createPulseIcon = (color: string) => L.divIcon({
  className: 'custom-icon',
  html: `<div class="pulse-dot" style="background-color: ${color}; color: ${color};"></div>`,
  iconSize: [12, 12],
  iconAnchor: [6, 6],
});

// Portal status spectrum: Nominal Emerald, Alert Amber, Emergency Red, Polar Blue.
const getStatusColor = (status: string) => {
  if (['safe', 'normal', 'at_station', 'field', 'returned'].includes(status)) return '#10b981';
  if (['warning', 'overdue', 'in_transit', 'planned'].includes(status)) return '#f59e0b';
  if (['danger', 'deviated', 'sos'].includes(status)) return '#ef4444';
  return '#0284c7';
};

const getStatusBadge = (status: string) => {
  if (['at_station', 'field', 'returned', 'safe', 'normal'].includes(status)) return 'safe';
  if (['deviated', 'sos', 'danger'].includes(status)) return 'danger';
  if (['in_transit', 'planned'].includes(status)) return 'info';
  return 'warning';
};

const geofenceStyle = (type: string) => {
  switch (type) {
    case 'station':    return { color: '#0284c7', fillColor: '#0284c7', fillOpacity: 0.08, weight: 1.5 };
    case 'field_camp': return { color: '#10b981', fillColor: '#10b981', fillOpacity: 0.10, weight: 1.5 };
    case 'restricted': return { color: '#ef4444', fillColor: '#ef4444', fillOpacity: 0.16, weight: 1.5 };
    default:           return { color: '#94a3b8', fillColor: '#94a3b8', fillOpacity: 0.08, weight: 1.5 };
  }
};

/**
 * Frames the map on what the caller is showing — once per context, not per fix.
 *
 * Two failures this replaces. The map used to be pinned to Maitri's
 * coordinates, so switching the console to Bharati listed Bharati's crew beside
 * a map of Antarctica 4,000 km away. Then the fit key included every personnel
 * position, so during GPS playback it re-framed every two seconds and fought
 * the operator's own panning.
 *
 * `contextKey` changes only when the *subject* changes — the station, which
 * people and incidents are on screen, which routes are drawn — never when a
 * tracked position moves. An explicit Recentre control covers the rest.
 */
function FitToContent({
  points, contextKey, recentreToken,
}: { points: [number, number][]; contextKey: string; recentreToken: number }) {
  const map = useMap();
  const latest = useRef(points);
  latest.current = points;

  const fit = useCallback(() => {
    const pts = latest.current;
    if (pts.length === 0) return;
    if (pts.length === 1) {
      map.setView(pts[0], 12, { animate: false });
      return;
    }
    map.fitBounds(L.latLngBounds(pts).pad(0.25), { animate: false });
  }, [map]);

  useEffect(() => { fit(); }, [contextKey, fit]);
  useEffect(() => { if (recentreToken > 0) fit(); }, [recentreToken, fit]);

  return null;
}

/** Puts the viewport back on the current subject after the operator has panned. */
function RecentreControl({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      data-compact
      onClick={onClick}
      title="Recentre on the active station and everything being tracked"
      className="absolute top-3 right-3 z-[500] inline-flex items-center gap-1.5 px-2.5 py-1.5
                 rounded-md border border-frost-border bg-white/95 shadow-card text-2xs
                 font-mono font-bold tracking-caps uppercase text-arctic-800
                 hover:border-arctic-600 hover:text-arctic-700 transition-colors"
    >
      <Crosshair size={13} aria-hidden="true" /> Recentre
    </button>
  );
}

interface MapViewProps {
  personnel?: Personnel[];
  incidents?: Incident[];
  routes?: Array<{ path: [number, number][]; type: 'planned' | 'actual' }>;
}

export default function MapViewInner({
  personnel = [], incidents = [], routes = [],
}: MapViewProps) {
  const { station } = useStation();
  const [geofences, setGeofences] = useState<Geofence[]>([]);
  const [recentreToken, setRecentreToken] = useState(0);

  useEffect(() => {
    api.listGeofences()
      .then((data: Geofence[]) => setGeofences(Array.isArray(data) ? data : []))
      .catch(() => setGeofences([]));
  }, []);

  // Only draw geofences within reach of the active station: the table holds
  // every station's zones, and plotting all of them makes the fitted bounds
  // span two continents.
  const localGeofences = useMemo(
    () => geofences.filter(
      (gf) => Math.abs(gf.center_lat - station.lat) < 2 && Math.abs(gf.center_lng - station.lng) < 6),
    [geofences, station],
  );

  // Everything the viewport should contain, station included so the map is
  // never empty while positions are still loading.
  const focusPoints = useMemo<[number, number][]>(() => {
    const pts: [number, number][] = [[station.lat, station.lng]];
    personnel.forEach((p) => {
      if (p.current_lat != null && p.current_lng != null) pts.push([p.current_lat, p.current_lng]);
    });
    incidents.forEach((i) => {
      if (typeof i.location_lat === 'number' && typeof i.location_lng === 'number') {
        pts.push([i.location_lat, i.location_lng]);
      }
    });
    routes.forEach((r) => r.path.forEach((pt) => pts.push(pt)));
    return pts;
  }, [station, personnel, incidents, routes]);

  // The subject of the map: which station, who and what is plotted, and how
  // many waypoints each route has. Deliberately excludes coordinates — a GPS
  // fix moving is not a new subject, and re-framing on every tick made the map
  // unusable during playback.
  const contextKey = useMemo(() => [
    station.id,
    personnel.filter((p) => p.current_lat != null).map((p) => p.id).sort().join(','),
    incidents.map((i) => i.id).sort().join(','),
    routes.map((r) => r.path.length).join(','),
  ].join('|'), [station.id, personnel, incidents, routes]);

  return (
    <div className="relative w-full h-full">
    <MapContainer
      center={[station.lat, station.lng]}
      zoom={12}
      className="w-full h-full rounded-md z-0"
    >
      <TileLayer
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution="&copy; OpenStreetMap contributors"
        className="map-tiles"
      />

      <FitToContent points={focusPoints} contextKey={contextKey}
                    recentreToken={recentreToken} />

      {/* ── Geofences ── */}
      {localGeofences.map((gf) => (
        <Circle
          key={gf.id}
          center={[gf.center_lat, gf.center_lng]}
          radius={gf.radius_m}
          pathOptions={geofenceStyle(gf.type)}
        >
          <Popup>
            <div className="font-bold">{gf.name}</div>
            <div className="text-xs capitalize" style={{ color: '#64748b' }}>
              {gf.type.replace('_', ' ')}
            </div>
            <div className="text-xs">Radius: {gf.radius_m.toLocaleString()} m</div>
          </Popup>
        </Circle>
      ))}

      {/* ── Personnel ── */}
      {personnel
        .filter((p) => p.current_lat != null && p.current_lng != null)
        .map((p) => (
          <Marker
            key={p.id}
            position={[p.current_lat!, p.current_lng!]}
            icon={createPulseIcon(getStatusColor(p.effective_status ?? p.status))}
          >
            <Popup>
              <div className="font-bold">{p.name}</div>
              <div className="text-sm">{p.role}</div>
              <div className={`status-badge status-${getStatusBadge(p.status)}`}
                   style={{ marginTop: 4 }}>
                {(p.effective_status ?? p.status).replace('_', ' ')}
              </div>
              {p.overdue && (
                <div className="text-xs" style={{ color: '#b45309', fontWeight: 600, marginTop: 4 }}>
                  Overdue — {p.overdue_reason ?? 'expected arrival has passed'}
                </div>
              )}
            </Popup>
          </Marker>
        ))}

      {/* ── Routes ── */}
      {routes.map((r, i) => (
        <Polyline
          key={i}
          positions={r.path}
          pathOptions={{
            color: r.type === 'planned' ? '#94a3b8' : '#ef4444',
            dashArray: r.type === 'planned' ? '5, 10' : undefined,
            weight: 3,
          }}
        />
      ))}

      {/* ── Incident zones ── */}
      {incidents.map((inc) => {
        const { location_lat: lat, location_lng: lng } = inc;
        if (typeof lat !== 'number' || typeof lng !== 'number') return null;
        return (
          <Circle
            key={inc.id}
            center={[lat, lng]}
            radius={inc.affected_radius_m ?? 1000}
            pathOptions={{ color: '#dc2626', fillColor: '#ef4444', fillOpacity: 0.18, weight: 2 }}
          >
            <Popup>
              <div className="font-bold" style={{ color: '#dc2626' }}>
                Incident — {inc.type.replace('_', ' ').toUpperCase()}
              </div>
              <div className="text-xs">Severity: {inc.severity}</div>
              <div className="text-xs">Status: {inc.status}</div>
              {inc.unaccounted_count != null && (
                <div className="text-xs">Unaccounted: {inc.unaccounted_count}</div>
              )}
            </Popup>
          </Circle>
        );
      })}
    </MapContainer>
      <RecentreControl onClick={() => setRecentreToken((n) => n + 1)} />
    </div>
  );
}
