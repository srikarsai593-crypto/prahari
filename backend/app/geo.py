import math

def haversine_distance(lat1, lon1, lat2, lon2) -> float:
    """Returns distance in meters between two coordinates."""
    R = 6371000  # Earth radius in meters
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)
    a = math.sin(delta_phi/2)**2 + math.cos(phi1) * math.cos(phi2) * math.sin(delta_lambda/2)**2
    a = min(1.0, max(0.0, a))
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1-a))
    return R * c

def check_geofences(lat, lng, geofences) -> list:
    """Returns list of geofences the point is inside."""
    results = []
    for gf in geofences:
        dist = haversine_distance(lat, lng, gf['center_lat'], gf['center_lng'])
        if dist <= gf['radius_m']:
            results.append({'id': gf['id'], 'name': gf['name'], 'type': gf['type'], 'distance_m': round(dist)})
    return results

def check_route_deviation(lat, lng, planned_waypoints, threshold_m=2000) -> bool:
    """Returns True if point is > threshold meters from nearest planned waypoint."""
    if not planned_waypoints:
        return False
    min_dist = min(haversine_distance(lat, lng, wp['lat'], wp['lng']) for wp in planned_waypoints)
    return min_dist > threshold_m
