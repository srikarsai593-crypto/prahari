'use client';
import { useEffect, useState } from 'react';
import { MapContainer, TileLayer, Circle, Marker, Polyline, Popup } from 'react-leaflet';
import L from 'leaflet';
import type { Geofence, Personnel, Incident } from '@/lib/types';

// ── Icons ─────────────────────────────────────────────────────────────────────
const createPulseIcon = (color: string) => L.divIcon({
  className: 'custom-icon',
  html: `<div class="pulse-dot" style="background-color: ${color}; color: ${color};"></div>`,
  iconSize: [12, 12],
  iconAnchor: [6, 6],
});

const getStatusColor = (status: string) => {
  if (['safe', 'normal', 'at_station', 'field', 'returned'].includes(status)) return '#22C55E';
  if (['warning', 'overdue', 'in_transit', 'planned'].includes(status)) return '#F59E0B';
  if (['danger', 'deviated', 'sos'].includes(status)) return '#EF4444';
  return '#3B82F6';
};

const getStatusBadge = (status: string) => {
  if (['at_station', 'field', 'returned', 'safe', 'normal'].includes(status)) return 'safe';
  if (['deviated', 'sos', 'danger'].includes(status)) return 'danger';
  if (['in_transit', 'planned'].includes(status)) return 'info';
  return 'warning';
};

// ── Geofence appearance ───────────────────────────────────────────────────────
const geofenceStyle = (type: string) => {
  switch (type) {
    case 'station':    return { color: '#3B82F6', fillColor: '#3B82F6', fillOpacity: 0.08 };
    case 'field_camp': return { color: '#22C55E', fillColor: '#22C55E', fillOpacity: 0.10 };
    case 'restricted': return { color: '#EF4444', fillColor: '#EF4444', fillOpacity: 0.16 };
    default:           return { color: '#94A3B8', fillColor: '#94A3B8', fillOpacity: 0.08 };
  }
};

// ── Component ─────────────────────────────────────────────────────────────────
interface MapViewProps {
  personnel?: Personnel[];
  incidents?: Incident[];
  routes?: Array<{ path: [number, number][]; type: 'planned' | 'actual' }>;
}

export default function MapViewInner({ personnel = [], incidents = [], routes = [] }: MapViewProps) {
  const [geofences, setGeofences] = useState<Geofence[]>([]);

  useEffect(() => {
    fetch('/api/geofences')
      .then(r => r.ok ? r.json() : [])
      .then((data: Geofence[]) => setGeofences(Array.isArray(data) ? data : []))
      .catch(() => setGeofences([]));
  }, []);

  return (
    <MapContainer center={[-70.767, 11.731]} zoom={12} className="w-full h-full rounded-xl z-0">
      <TileLayer
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution="&copy; OpenStreetMap contributors"
        className="map-tiles"
      />

      {/* ── Geofences — fetched dynamically from DB ── */}
      {geofences.map(gf => (
        <Circle
          key={gf.id}
          center={[gf.center_lat, gf.center_lng]}
          radius={gf.radius_m}
          pathOptions={geofenceStyle(gf.type)}
        >
          <Popup>
            <div className="font-bold">{gf.name}</div>
            <div className="text-xs text-gray-500 capitalize">{gf.type.replace('_', ' ')}</div>
            <div className="text-xs">Radius: {gf.radius_m.toLocaleString()}m</div>
          </Popup>
        </Circle>
      ))}

      {/* ── Personnel markers ── */}
      {personnel.map(p => (
        <Marker
          key={p.id}
          position={[p.current_lat ?? -70.767, p.current_lng ?? 11.731]}
          icon={createPulseIcon(getStatusColor(p.status))}
        >
          <Popup>
            <div className="font-bold">{p.name}</div>
            <div className="text-sm">{p.role}</div>
            <div className={`status-badge status-${getStatusBadge(p.status)} mt-1`}>
              {p.status.toUpperCase()}
            </div>
            {p.overdue && (
              <div className="text-xs text-amber-600 font-semibold mt-1">⚠ OVERDUE</div>
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
            color: r.type === 'planned' ? '#94A3B8' : '#3B82F6',
            dashArray: r.type === 'planned' ? '5, 10' : undefined,
            weight: 3,
          }}
        />
      ))}

      {/* ── Incident zones ── */}
      {incidents.map(inc => {
        const lat = inc.location_lat;
        const lng = inc.location_lng;
        const radius = inc.affected_radius_m ?? 1000;
        if (typeof lat !== 'number' || typeof lng !== 'number') return null;
        return (
          <Circle key={inc.id} center={[lat, lng]} radius={radius} pathOptions={{ color: '#EF4444', fillColor: '#EF4444', fillOpacity: 0.2 }}>
            <Popup>
              <div className="font-bold text-red-500">INCIDENT — {inc.type.toUpperCase()}</div>
              <div className="text-xs">Severity: {inc.severity}</div>
              <div className="text-xs">Status: {inc.status}</div>
            </Popup>
          </Circle>
        );
      })}
    </MapContainer>
  );
}
