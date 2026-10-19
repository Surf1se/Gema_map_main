import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const regionLine = /(?:область|обл\.|регион|край|республика|автономный округ)/iu;
const dangerLine = /^(?:ракетн[а-яё]*\s+опасност[ьи]|опасност[ьи]\s+(?:по\s+)?(?:бпла|ракет[а-яё]*|беспилотник[а-яё]*))\s*[.!]?$/iu;
const clearLine = /^отбой(?:\s+(?:(?:ракетн[а-яё]*)?\s*опасност[ьи](?:\s+по\s+бпла)?|по\s+бпла))?\s*[.!]?$/iu;

export const normalizePlace = value => value.toLocaleLowerCase('ru').replaceAll('ё', 'е').replace(/\s+/g, ' ').trim();

export function createPlaceIndex(rows) {
  const index = new Map();
  for (const [id, latitude, longitude, population, region, names] of rows) {
    const place = { id, latitude, longitude, population, region };
    for (const name of names) {
      const key = normalizePlace(name);
      if (!index.has(key)) index.set(key, []);
      index.get(key).push(place);
    }
  }
  return index;
}

export function loadPlaceIndex() {
  return createPlaceIndex(JSON.parse(readFileSync(join(import.meta.dirname, '..', 'data', 'ru-places.json'), 'utf8')));
}

function placeName(line) {
  return line.replace(/^(?:(?:МО|ГО|г\.о\.|г\.|город|с\.|село|п\.|пос\.|посёлок|поселок)\s*)+/iu, '').replace(/[.!:,;]+$/u, '').trim();
}

function resolvePlace(line, index, moscowRegion) {
  const name = placeName(line);
  if (!name || regionLine.test(name) || name.length > 60) return null;
  const options = index.get(normalizePlace(name));
  if (!options?.length) return null;
  const regional = moscowRegion ? options.filter(place => place.region === '47') : [];
  const candidates = regional.length ? regional : options;
  const sorted = [...candidates].sort((a, b) => b.population - a.population);
  if (sorted.length > 1 && !moscowRegion && (sorted[0].population < 10_000 || sorted[0].population < sorted[1].population * 5)) return null;
  return { ...sorted[0], name, radius: sorted[0].population >= 500_000 ? 12_000 : sorted[0].population >= 100_000 ? 8_000 : sorted[0].population >= 10_000 ? 5_000 : 3_000 };
}

export function parsePost(text, index) {
  const lines = String(text || '').split(/\r?\n/u).map(line => line.replace(/^[^\p{L}\p{N}]+/u, '').trim()).filter(Boolean);
  const clearIndex = lines.findIndex(line => clearLine.test(line));
  const statusIndex = clearIndex >= 0 ? clearIndex : lines.findIndex(line => dangerLine.test(line));
  if (statusIndex < 0) return { kind: 'ignore' };
  const kind = clearIndex >= 0 ? 'clear' : 'danger';
  const moscowRegion = lines.some(line => /московск[а-яё]+\s+област/iu.test(line));
  const candidates = [...lines.slice(0, statusIndex), ...lines.slice(statusIndex + 1, statusIndex + 3)];
  let place = null;
  for (const line of candidates) {
    place = resolvePlace(line, index, moscowRegion);
    if (place) break;
  }
  return kind === 'danger' && !place ? { kind: 'ignore' } : { kind, place };
}

export function nextMoscowReset(timestamp) {
  const day = new Date(timestamp);
  const reset = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 5);
  return timestamp < reset ? reset : reset + 86_400_000;
}
