import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const input = resolve(process.argv[2] || '.data/geonames/RU.txt');
const output = resolve(process.argv[3] || 'data/ru-places.json');
const rows = [];
for (const line of readFileSync(input, 'utf8').split('\n')) {
  if (!line) continue;
  const fields = line.split('\t');
  if (fields[6] !== 'P' || fields[8] !== 'RU') continue;
  const names = [...new Set(fields[3].split(',').filter(name => /^[А-ЯЁа-яё][А-ЯЁа-яё -]*$/.test(name)))];
  if (!names.length) continue;
  rows.push([Number(fields[0]), Number(fields[4]), Number(fields[5]), Number(fields[14]) || 0, fields[10], names]);
}
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(rows));
console.log(`Saved ${rows.length} populated places to ${output}`);
