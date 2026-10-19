import test from 'node:test';
import assert from 'node:assert/strict';
import { lookupBoundary } from '../lib/boundaries.js';

const place = { name: 'Раменское', latitude: 55.56, longitude: 38.23, radius: 8000 };
const polygon = { type: 'Polygon', coordinates: [[[38.17, 55.48], [38.35, 55.48], [38.35, 55.61], [38.17, 55.61], [38.17, 55.48]]] };

test('uses a nearby Russian settlement polygon and rejects unrelated areas', async () => {
  const candidates = [
    { name: 'Раменское', lat: 55.56, lon: 38.23, category: 'place', type: 'city', addresstype: 'city', address: { country_code: 'ru' }, geojson: { type: 'Point', coordinates: [38.23, 55.56] } },
    { name: 'Раменское', lat: 55.56, lon: 38.23, category: 'place', type: 'city', addresstype: 'city', address: { country_code: 'ru' }, geojson: polygon }
  ];
  const fetcher = async (url, options) => {
    assert.equal(url.hostname, 'nominatim.openstreetmap.org');
    assert.equal(url.searchParams.get('countrycodes'), 'ru');
    assert.match(options.headers['User-Agent'], /GemaMap/);
    return Response.json(candidates);
  };
  assert.deepEqual(await lookupBoundary(place, fetcher), polygon);
  assert.equal(await lookupBoundary(place, async () => Response.json([{ ...candidates[1], lat: 60 }])), null);
  assert.equal(await lookupBoundary(place, async () => Response.json([{ ...candidates[1], address: { country_code: 'by' } }])), null);
});

test('administrative warnings accept only the matching Russian boundary', async () => {
  const region = { name: 'Московская область', latitude: 55.81, longitude: 36.72, radius: 100_000, areaType: 'region' };
  const candidate = { name: region.name, lat: 55.81, lon: 36.72, category: 'boundary', type: 'administrative', addresstype: 'state', address: { country_code: 'ru' }, geojson: polygon };
  const fetcher = async (url) => {
    assert.equal(url.searchParams.get('polygon_threshold'), '0.01');
    return Response.json([candidate]);
  };
  assert.deepEqual(await lookupBoundary(region, fetcher), polygon);
  assert.equal(await lookupBoundary(region, async () => Response.json([{ ...candidate, addresstype: 'city' }])), null);
  const district = { name: 'Знаменский район', latitude: 53.33, longitude: 35.64, radius: 25_000, areaType: 'district', regionName: 'Орловская область' };
  const districtResult = { ...candidate, name: district.name, lat: district.latitude, lon: district.longitude, addresstype: 'county', address: { country_code: 'ru', state: district.regionName } };
  assert.deepEqual(await lookupBoundary(district, async url => {
    assert.match(url.searchParams.get('q'), /Орловская область/);
    return Response.json([districtResult]);
  }), polygon);
  assert.equal(await lookupBoundary(district, async () => Response.json([{ ...districtResult, address: { country_code: 'ru', state: 'Тамбовская область' } }])), null);
});
