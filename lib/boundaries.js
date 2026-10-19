import { normalizePlace } from './alerts.js';

const types = new Set(['city', 'town', 'village', 'hamlet', 'isolated_dwelling', 'locality']);

function distanceKm(aLat, aLon, bLat, bLon) {
  const radians = Math.PI / 180;
  const dLat = (bLat - aLat) * radians;
  const dLon = (bLon - aLon) * radians;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * radians) * Math.cos(bLat * radians) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function validGeometry(geometry, administrative = false) {
  if (!geometry || !['Polygon', 'MultiPolygon'].includes(geometry.type)) return false;
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  if (!Array.isArray(polygons) || !polygons.length) return false;
  let vertices = 0;
  for (const polygon of polygons) {
    if (!Array.isArray(polygon) || !polygon.length) return false;
    for (const ring of polygon) {
      if (!Array.isArray(ring) || ring.length < 4) return false;
      for (const point of ring) {
        if (!Array.isArray(point) || point.length !== 2 || !Number.isFinite(point[0]) || !Number.isFinite(point[1]) || Math.abs(point[0]) > 180 || Math.abs(point[1]) > 90 || ++vertices > (administrative ? 20_000 : 10_000)) return false;
      }
    }
  }
  return JSON.stringify(geometry).length <= (administrative ? 600_000 : 300_000);
}

export async function lookupBoundary(place, fetcher = fetch) {
  const administrative = place.areaType === 'region' || place.areaType === 'district';
  const url = new URL('https://nominatim.openstreetmap.org/search');
  const query = place.areaType === 'district' && place.regionName ? `${place.name}, ${place.regionName}, Россия` : `${place.name}, Россия`;
  url.search = new URLSearchParams({ q: query, format: 'jsonv2', countrycodes: 'ru', addressdetails: '1', polygon_geojson: '1', polygon_threshold: place.areaType === 'region' ? '0.01' : administrative ? '0.003' : '0.001', limit: '5' }).toString();
  const response = await fetcher(url, {
    headers: { 'User-Agent': 'GemaMap/0.1 (https://github.com/Surf1se/Gema_map_main)', Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error(`Boundary lookup failed: HTTP ${response.status}`);
  const results = await response.json();
  if (!Array.isArray(results)) throw new Error('Invalid boundary response');
  for (const result of results) {
    if (normalizePlace(result.name || '') !== normalizePlace(place.name)) continue;
    if (administrative) {
      if (result.category !== 'boundary' || result.type !== 'administrative') continue;
      if (place.areaType === 'region' && result.addresstype !== 'state') continue;
      if (place.areaType === 'district' && !['county', 'district', 'municipality'].includes(result.addresstype)) continue;
      if (place.areaType === 'district' && result.address?.state && place.regionName && normalizePlace(result.address.state) !== normalizePlace(place.regionName)) continue;
    } else if (!types.has(result.addresstype) && !(result.category === 'place' && types.has(result.type))) continue;
    if (result.address?.country_code !== 'ru') continue;
    const latitude = Number(result.lat), longitude = Number(result.lon);
    const maxDistance = place.areaType === 'region' ? 500 : place.areaType === 'district' ? 120 : Math.max(20, place.radius / 500);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || distanceKm(place.latitude, place.longitude, latitude, longitude) > maxDistance) continue;
    if (validGeometry(result.geojson, administrative)) return result.geojson;
  }
  return null;
}
