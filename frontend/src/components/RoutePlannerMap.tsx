'use client';

import { useMemo } from 'react';
import { MapContainer, TileLayer, Circle, Marker, Polyline, Tooltip, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import type { Geofence } from '@/lib/types';

/**
 * Click-to-detour route editor for a movement plan.
 *
 * The pre-flight check could tell a commander that the authorised line ran
 * through the Crevasse Zone and then offered nothing to do about it — there
 * was no route editor, no waypoints, no map in the dialog at all. In a real
 * traverse the straight line is the one option that is never taken; the party
 * walks a corridor around the field. This is that corridor.
 */

export interface Waypoint { lat: number; lng: number }

const dot = (color: string, size = 12) => L.divIcon({
  className: 'custom-icon',
  html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${color};
          border:2px solid #fff;box-shadow:0 0 0 1px rgba(15,23,42,.35)"></div>`,
  iconSize: [size, size],
  iconAnchor: [size / 2, size / 2],
});

const ORIGIN_ICON = dot('#0284c7', 14);
const DESTINATION_ICON = dot('#10b981', 14);
const WAYPOINT_ICON = dot('#f59e0b', 12);

function ClickCapture({ onAdd }: { onAdd: (wp: Waypoint) => void }) {
  useMapEvents({
    click: (e) => onAdd({ lat: +e.latlng.lat.toFixed(6), lng: +e.latlng.lng.toFixed(6) }),
  });
  return null;
}

interface Props {
  origin: Waypoint;
  destination: Waypoint;
  destinationName: string;
  /** Operator-placed detour points, in order, between origin and destination. */
  waypoints: Waypoint[];
  geofences: Geofence[];
  /** Zones the current path still crosses — drawn heavier so the hazard the
   *  warning names is the one the eye lands on. */
  breachedIds: string[];
  onAddWaypoint: (wp: Waypoint) => void;
  onMoveWaypoint: (index: number, wp: Waypoint) => void;
  onRemoveWaypoint: (index: number) => void;
}

export default function RoutePlannerMap({
  origin, destination, destinationName, waypoints, geofences, breachedIds,
  onAddWaypoint, onMoveWaypoint, onRemoveWaypoint,
}: Props) {
  const path = useMemo<[number, number][]>(
    () => [origin, ...waypoints, destination].map((p) => [p.lat, p.lng]),
    [origin, waypoints, destination]);

  const centre = useMemo<[number, number]>(
    () => [(origin.lat + destination.lat) / 2, (origin.lng + destination.lng) / 2],
    [origin, destination]);

  const bounds = useMemo(() => L.latLngBounds(path).pad(0.4), [path]);

  return (
    <MapContainer
      center={centre}
      bounds={bounds}
      scrollWheelZoom
      style={{ height: '100%', width: '100%', borderRadius: '0.75rem' }}
    >
      <TileLayer
        attribution='&copy; OpenStreetMap contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <ClickCapture onAdd={onAddWaypoint} />

      {geofences.map((g) => {
        const restricted = g.type === 'restricted';
        const breached = breachedIds.includes(g.id);
        return (
          <Circle
            key={g.id}
            center={[g.center_lat, g.center_lng]}
            radius={g.radius_m}
            pathOptions={{
              color: restricted ? '#ef4444' : g.type === 'field_camp' ? '#10b981' : '#0284c7',
              fillColor: restricted ? '#ef4444' : g.type === 'field_camp' ? '#10b981' : '#0284c7',
              fillOpacity: breached ? 0.32 : restricted ? 0.16 : 0.08,
              weight: breached ? 3 : 1.5,
            }}
          >
            <Tooltip>{g.name}{restricted ? ' · restricted' : ''}</Tooltip>
          </Circle>
        );
      })}

      <Polyline
        positions={path}
        pathOptions={{
          color: breachedIds.length > 0 ? '#ef4444' : '#0284c7',
          weight: 3,
          dashArray: breachedIds.length > 0 ? '6 6' : undefined,
        }}
      />

      <Marker position={[origin.lat, origin.lng]} icon={ORIGIN_ICON} title="Departure point">
        <Tooltip>Departure</Tooltip>
      </Marker>
      <Marker position={[destination.lat, destination.lng]} icon={DESTINATION_ICON}
              title={`Destination: ${destinationName}`}>
        <Tooltip>{destinationName}</Tooltip>
      </Marker>

      {waypoints.map((wp, i) => (
        <Marker
          key={`${wp.lat},${wp.lng},${i}`}
          position={[wp.lat, wp.lng]}
          icon={WAYPOINT_ICON}
          title={`Waypoint ${i + 1}`}
          draggable
          eventHandlers={{
            dragend: (e) => {
              const { lat, lng } = (e.target as L.Marker).getLatLng();
              onMoveWaypoint(i, { lat: +lat.toFixed(6), lng: +lng.toFixed(6) });
            },
            // Removing by clicking the pin itself keeps the editor to one
            // gesture vocabulary: click empty map to add, click a pin to drop.
            click: () => onRemoveWaypoint(i),
          }}
        >
          <Tooltip>Waypoint {i + 1} · drag to move, click to remove</Tooltip>
        </Marker>
      ))}
    </MapContainer>
  );
}
