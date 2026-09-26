import math

EARTH_RADIUS_M = 6371000


def haversine_distance(lat1, lon1, lat2, lon2) -> float:
    """Great-circle distance in metres between two coordinates."""
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)
    a = math.sin(delta_phi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(delta_lambda / 2) ** 2
    a = min(1.0, max(0.0, a))
    return EARTH_RADIUS_M * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def check_geofences(lat, lng, geofences) -> list:
    """Every geofence whose disc contains the point, nearest centre first."""
    results = []
    for gf in geofences:
        dist = haversine_distance(lat, lng, gf['center_lat'], gf['center_lng'])
        if dist <= gf['radius_m']:
            results.append({'id': gf['id'], 'name': gf['name'], 'type': gf['type'],
                            'distance_m': round(dist)})
    results.sort(key=lambda g: g['distance_m'])
    return results


def _local_xy(lat, lng, lat_ref):
    """Project to local metres using an equirectangular approximation.

    Valid over the few-kilometre spans a traverse leg covers, and it keeps the
    segment maths in ordinary Euclidean space.
    """
    x = math.radians(lng) * math.cos(math.radians(lat_ref)) * EARTH_RADIUS_M
    y = math.radians(lat) * EARTH_RADIUS_M
    return x, y


def distance_to_segment_m(lat, lng, a: dict, b: dict) -> float:
    """Perpendicular (cross-track) distance from a point to the segment a-b."""
    lat_ref = (a['lat'] + b['lat']) / 2
    px, py = _local_xy(lat, lng, lat_ref)
    ax, ay = _local_xy(a['lat'], a['lng'], lat_ref)
    bx, by = _local_xy(b['lat'], b['lng'], lat_ref)

    dx, dy = bx - ax, by - ay
    seg_len_sq = dx * dx + dy * dy
    if seg_len_sq == 0:                       # degenerate segment
        return haversine_distance(lat, lng, a['lat'], a['lng'])

    # Projection parameter, clamped so the foot of the perpendicular stays on
    # the segment rather than running off its extension.
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / seg_len_sq))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def distance_from_route_m(lat, lng, planned_waypoints) -> float | None:
    """Shortest distance from the point to the authorised route corridor."""
    if not planned_waypoints:
        return None
    if len(planned_waypoints) == 1:
        wp = planned_waypoints[0]
        return haversine_distance(lat, lng, wp['lat'], wp['lng'])
    return min(distance_to_segment_m(lat, lng, a, b)
               for a, b in zip(planned_waypoints, planned_waypoints[1:]))


def check_route_deviation(lat, lng, planned_waypoints, threshold_m=2000) -> bool:
    """True when the point lies further than threshold_m from the route corridor.

    Measured against the route's *segments*, not its vertices. Vertex distance
    raised a false "off route" alert for anyone walking exactly the authorised
    line whenever two waypoints were more than 2 x threshold apart.
    """
    distance = distance_from_route_m(lat, lng, planned_waypoints)
    return distance is not None and distance > threshold_m
