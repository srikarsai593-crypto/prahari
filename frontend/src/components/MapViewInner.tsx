'use client';
import { useEffect, useState } from 'react';
import { MapContainer, TileLayer, Circle, Marker, Polyline, Popup } from 'react-leaflet';
import L from 'leaflet';

// Icons
const createPulseIcon = (color: string) => L.divIcon({
  className: 'custom-icon',
  html: `<div class="pulse-dot" style="background-color: ${color}; color: ${color};"></div>`,
  iconSize: [12, 12],
  iconAnchor: [6, 6]
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

export default function MapViewInner({ 
  personnel = [], 
  incidents = [], 
  routes = [] 
}: { 
  personnel?: any[], 
  incidents?: any[], 
  routes?: any[] 
}) {
  return (
    <MapContainer center={[-70.767, 11.731]} zoom={12} className="w-full h-full rounded-xl z-0">
      <TileLayer
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution='&copy; OpenStreetMap contributors'
        className="map-tiles"
      />
      
      {/* Geofences / Stations */}
      <Circle center={[-70.767, 11.731]} radius={2000} pathOptions={{ color: '#3B82F6', fillColor: '#3B82F6', fillOpacity: 0.1 }}>
        <Popup>Maitri Station</Popup>
      </Circle>
      <Circle center={[-70.85, 11.95]} radius={1500} pathOptions={{ color: '#22C55E', fillColor: '#22C55E', fillOpacity: 0.1 }}>
        <Popup>Camp Alpha</Popup>
      </Circle>
      <Circle center={[-70.82, 11.88]} radius={800} pathOptions={{ color: '#EF4444', fillColor: '#EF4444', fillOpacity: 0.15 }}>
        <Popup>Crevasse / Restricted Zone</Popup>
      </Circle>
      
      {/* Personnel */}
      {personnel.map(p => (
        <Marker key={p.id} position={[p.current_lat || -70.767, p.current_lng || 11.731]} icon={createPulseIcon(getStatusColor(p.status))}>
          <Popup>
            <div className="font-bold">{p.name}</div>
            <div className="text-sm">{p.role}</div>
            <div className={`status-badge status-${getStatusBadge(p.status)} mt-1`}>
              {p.status.toUpperCase()}
            </div>
          </Popup>
        </Marker>
      ))}

      {/* Routes */}
      {routes.map((r, i) => (
        <Polyline key={i} positions={r.path} pathOptions={{ color: r.type === 'planned' ? '#94A3B8' : '#3B82F6', dashArray: r.type === 'planned' ? '5, 10' : undefined, weight: 3 }} />
      ))}

      {/* Incidents */}
      {incidents.map(inc => {
        const lat = inc.location_lat ?? inc.location?.lat;
        const lng = inc.location_lng ?? inc.location?.lng;
        const radius = inc.affected_radius_m ?? inc.radius ?? 1000;
        if (typeof lat !== 'number' || typeof lng !== 'number') return null;

        return (
          <Circle key={inc.id} center={[lat, lng]} radius={radius} pathOptions={{ color: '#EF4444', fillColor: '#EF4444', fillOpacity: 0.2 }}>
            <Popup>
              <div className="font-bold text-red-500">INCIDENT</div>
              <div>{inc.type}</div>
            </Popup>
          </Circle>
        );
      })}
    </MapContainer>
  );
}
