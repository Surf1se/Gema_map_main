import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const regionLine = /(?:область|обл\.|регион|край|республика|автономный округ)/iu;
const dangerLine = /^(?:ракетн[а-яё]*\s+опасност[ьи]|опасност[ьи]\s+(?:по\s+)?(?:бпла|ракет[а-яё]*|беспилотник[а-яё]*)|тревога\s+по\s+бпла)\s*[.!]?$/iu;
const clearLine = /^отбой(?:\s+(?:(?:ракетн[а-яё]*)?\s*опасност[ьи](?:\s+по\s+бпла)?|по\s+бпла))?\s*[.!]?$/iu;
const inlineStatus = /^(.*?)\s*[-–—]\s*(опасност[ьи]\s+по\s+бпла|ракетн[а-яё]*\s+опасност[ьи]|отбой(?:\s+опасност[ьи]\s+по\s+бпла)?)(?:\s+и\s+в\s+направлении\s+[А-ЯЁа-яё -]+)?\s*[.!]?$/iu;

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

const regions = new Map(JSON.parse(readFileSync(join(import.meta.dirname, '..', 'data', 'ru-regions.json'), 'utf8'))
  .flatMap(([code, names]) => names.map(name => [normalizePlace(name), code])));

function placeName(line) {
  return line.replace(/^(?:(?:МО|ГО|г\.о\.|г\.|город|с\.|село|п\.|пос\.|посёлок|поселок)\s*)+/iu, '').replace(/[.!:,;]+$/u, '').trim();
}

function resolvePlace(line, index, regionCodes) {
  const name = placeName(line);
  if (!name || regionLine.test(name) || name.length > 60) return null;
  const options = index.get(normalizePlace(name));
  if (!options?.length) return null;
  const regional = regionCodes.length === 1 ? options.filter(place => place.region === regionCodes[0]) : [];
  const candidates = regional.length ? regional : options;
  const sorted = [...candidates].sort((a, b) => b.population - a.population);
  if (sorted.length > 1 && !regional.length && (sorted[0].population < 10_000 || sorted[0].population < sorted[1].population * 5)) return null;
  return { ...sorted[0], name, radius: sorted[0].population >= 500_000 ? 12_000 : sorted[0].population >= 100_000 ? 8_000 : sorted[0].population >= 10_000 ? 5_000 : 3_000 };
}

export function parsePost(text, index) {
  const lines = String(text || '').split(/\r?\n/u).map(line => line.replace(/^[^\p{L}\p{N}]+/u, '').trim()).filter(Boolean);
  const statuses = lines.map(line => {
    const inline = line.match(inlineStatus);
    return { status: inline ? inline[2] : line, subject: inline?.[1] || '' };
  });
  const clearIndex = statuses.findIndex(({ status }) => clearLine.test(status));
  const statusIndex = clearIndex >= 0 ? clearIndex : statuses.findIndex(({ status }) => dangerLine.test(status));
  if (statusIndex < 0) return { kind: 'ignore' };
  const kind = clearIndex >= 0 ? 'clear' : 'danger';
  const candidates = [...lines.slice(0, statusIndex), statuses[statusIndex].subject, ...lines.slice(statusIndex + 1, statusIndex + 3)];
  const segments = candidates.flatMap(line => line.split(/[,;]/u).map(part => part.trim())).filter(Boolean);
  const regionCodes = [...new Set(segments.map(line => regions.get(normalizePlace(line.replace(/^вся территория\s+/iu, '')))).filter(Boolean))];
  const places = [];
  for (const segment of segments) {
    const line = segment.replace(/\s+и\s+близлежащие.*$/iu, '').trim();
    const place = resolvePlace(line, index, regionCodes);
    if (place && !places.some(item => item.id === place.id)) places.push(place);
  }
  return kind === 'danger' && !places.length ? { kind: 'ignore' } : { kind, place: places[0] || null, places, regions: regionCodes };
}

export function nextMoscowReset(timestamp) {
  const day = new Date(timestamp);
  const reset = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 5);
  return timestamp < reset ? reset : reset + 86_400_000;
}
