import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const regionLine = /(?:область|обл\.|регион|край|республика|автономный округ)/iu;
const dangerPhrase = String.raw`(?:ракетн[а-яё]*\s+опас(?:н|тн)ост[ьи]|рокетн[а-яё]*\s+опас(?:н|тн)ост[ьи]|опас(?:н|тн)ост[ьи]\s+(?:по\s+)?(?:бпла|ракет[а-яё]*|рокет[а-яё]*|беспилотник[а-яё]*)|тревога\s+по\s+бпла|работа\s+пво\s+по\s+бпла|сбитие\s+бпла|фиксаци(?:я|и)\s+(?:группы\s+)?бпла|фиксация\s+реактивной\s+цели|(?:внимание[!,:]?\s+)?массовые\s+фиксации(?:\s+бпла)?|внимание\s+(?:по\s+бпла|к\s+возможному\s+массовому\s+нал[её]ту\s+бпла)|приготовит(?:ь)?ся\s+к\s+возможной\s+массовой\s+атак[еи]\s+бпла|угроза(?:\s+(?:по\s+)?(?:бпла|ракет[а-яё]*|рокет[а-яё]*))?)`;
const dangerLine = new RegExp(`^${dangerPhrase}(?:(?:\\s+(?:и\\s+)?в(?:\\s+направлении)?(?:\\s+(.+?))?)|(?:\\s*:\\s*(.+?)))?\\s*[.!]?$`, 'iu');
const recordedLine = /^(?:бпла\s+)?зафиксировали(?:\s+бпла)?\s+в\s+(.+?)\s*[.!]?$/iu;
const movementLine = /^(?:(?:бпла|фиксаци(?:я|и)\s+бпла)\s+)?из\s+(.+?)\s+в\s+направлении\s+(.+?)\s*[.!]?$/iu;
const clearLine = /^отбой(?:\s+(?:(?:ракетн[а-яё]*)?\s*опас(?:н|тн)ост[ьи](?:\s+по\s+бпла)?|по\s+бпла))?\s*[.!]?$/iu;
const inlineStatus = /^(.*?)\s*[-–—]\s*(.+)$/u;

export const normalizePlace = value => value.toLocaleLowerCase('ru').replaceAll('ё', 'е').replace(/\s+/g, ' ').trim();

export function createPlaceIndex(rows) {
  const index = new Map();
  for (const [id, latitude, longitude, population, region, names] of rows) {
    const place = { id, latitude, longitude, population, region, areaType: 'settlement' };
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
const regionNames = new Map(JSON.parse(readFileSync(join(import.meta.dirname, '..', 'data', 'ru-regions.json'), 'utf8'))
  .map(([code, names]) => [code, names.find(name => /(?:ская область|ский край|^Республика )/iu.test(name)) || names[0]]));
export const regionNameForCode = code => regionNames.get(code);
const administrativeIndex = new Map();
for (const [id, latitude, longitude, areaType, region, names] of JSON.parse(readFileSync(join(import.meta.dirname, '..', 'data', 'ru-admins.json'), 'utf8'))) {
  const area = { id, latitude, longitude, areaType, region, population: 0 };
  for (const name of names) {
    const key = normalizePlace(name);
    if (!administrativeIndex.has(key)) administrativeIndex.set(key, []);
    if (!administrativeIndex.get(key).some(existing => existing.id === id)) administrativeIndex.get(key).push(area);
  }
}

function placeName(line) {
  return line.replace(/^(?:(?:МО|ГО|город|село|посёлок|поселок)\s+|(?:г\.о\.|г\.|с\.|п\.|пос\.)\s*)+/iu, '').replace(/[.!:,;]+$/u, '').trim().replace(/^[«"“']+|[»"”']+$/gu, '').trim();
}

function locationForms(line, locative = false) {
  const name = placeName(line);
  if (!locative) return [name];
  const forms = [name];
  const variants = [
    [/ской области$/iu, 'ская область'],
    [/ском крае$/iu, 'ский край'],
    [/ском районе$/iu, 'ский район'],
    [/е$/iu, ''], [/е$/iu, 'а'], [/е$/iu, 'о'],
    [/ом$/iu, 'ое'], [/ом$/iu, 'ый'],
    [/ах$/iu, 'ы'], [/ы$/iu, 'а'], [/а$/iu, ''],
    [/ого$/iu, 'ое'], [/ого$/iu, 'ый']
  ];
  for (const [ending, replacement] of variants) if (ending.test(name)) forms.push(name.replace(ending, replacement));
  return forms;
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

function resolveAdministrative(line, regionCodes) {
  const name = placeName(line);
  const options = administrativeIndex.get(normalizePlace(name));
  if (!options?.length) return null;
  const regional = regionCodes.length === 1 ? options.filter(area => area.region === regionCodes[0]) : [];
  const candidates = regional.length ? regional : options;
  if (candidates.length !== 1) return null;
  const area = candidates[0];
  return { ...area, name, radius: area.areaType === 'region' ? 100_000 : 25_000 };
}

export function parsePost(text, index) {
  const lines = String(text || '').split(/\r?\n/u).map(line => line.replace(/^[^\p{L}\p{N}]+/u, '').trim()).filter(Boolean);
  const statuses = lines.map(line => {
    const inline = line.match(inlineStatus);
    const status = inline ? inline[2] : line;
    const recorded = status.match(recordedLine);
    const movement = status.match(movementLine);
    const danger = status.match(dangerLine);
    return { status, subject: movement?.[1] || inline?.[1] || '', subjectLocative: Boolean(movement), destination: movement?.[2] || recorded?.[1] || danger?.[1] || danger?.[2] || '', locative: Boolean(movement || recorded) || /\sв\s+(?!направлении(?:\s|$))/iu.test(status) || /\sв\s+направлении(?:\s|$)/iu.test(status) };
  });
  const clearIndex = statuses.findIndex(({ status }) => clearLine.test(status));
  const statusIndex = clearIndex >= 0 ? clearIndex : statuses.findIndex(({ status }) => dangerLine.test(status) || recordedLine.test(status) || movementLine.test(status));
  if (statusIndex < 0) return { kind: 'ignore' };
  const kind = clearIndex >= 0 ? 'clear' : 'danger';
  const directional = kind === 'danger' && /(?:^|\s)в\s+направлении(?:\s|$)/iu.test(statuses[statusIndex].status);
  const following = lines.slice(statusIndex + 1, statusIndex + 3);
  const destination = statuses[statusIndex].destination || (directional ? following.shift() || '' : '');
  const candidates = [...lines.slice(0, statusIndex).map(text => ({ text })), { text: statuses[statusIndex].subject, locative: statuses[statusIndex].subjectLocative }, ...following.map(text => ({ text }))];
  const segments = candidates.flatMap(line => line.text.split(/[,;]/u).map(part => ({ text: part.trim(), locative: line.locative || /^в\s+/iu.test(part.trim()) }))).filter(part => part.text);
  const destinationParts = destination.split(/[,;]/u).map(part => ({ text: part.trim(), locative: statuses[statusIndex].locative })).filter(part => part.text);
  const forms = segment => locationForms(segment.text.replace(/^в\s+/iu, '').replace(/^вся территория\s+/iu, ''), segment.locative);
  const regionCodes = [...new Set([...segments, ...destinationParts].flatMap(segment => forms(segment).map(name => regions.get(normalizePlace(name)))).filter(Boolean))];
  const settlements = [], districts = [], regionAreas = [];
  function resolveSegment(segment) {
    const names = forms({ ...segment, text: segment.text.replace(/\s+и\s+близлежащие.*$/iu, '') });
    return names.map(name => resolvePlace(name, index, regionCodes) || resolveAdministrative(name, regionCodes)).find(Boolean);
  }
  function addArea(segment) {
    const area = resolveSegment(segment);
    if (!area) return;
    const group = area.areaType === 'settlement' ? settlements : area.areaType === 'district' ? districts : regionAreas;
    if (!group.some(item => item.id === area.id)) group.push(area);
  }
  for (const segment of segments) addArea(segment);
  const origin = settlements.length === 1 ? settlements[0] : null;
  const targets = directional ? destinationParts.map(resolveSegment).filter(Boolean) : [];
  const target = targets.length === 1 ? targets[0] : null;
  const direction = origin && target && origin.id !== target.id
    ? { from: { id: origin.id, name: origin.name, latitude: origin.latitude, longitude: origin.longitude }, to: { id: target.id, name: target.name, latitude: target.latitude, longitude: target.longitude } }
    : null;
  if (!settlements.length && !districts.length) for (const segment of destinationParts) addArea(segment);
  const places = settlements.length ? settlements : districts.length ? districts : regionAreas;
  return kind === 'danger' && !places.length ? { kind: 'ignore' } : { kind, place: places[0] || null, places, regions: regionCodes, direction };
}

export function nextMoscowReset(timestamp) {
  const day = new Date(timestamp);
  const reset = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 5);
  return timestamp < reset ? reset : reset + 86_400_000;
}
