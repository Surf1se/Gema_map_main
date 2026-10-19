import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const input = resolve(process.argv[2] || '.data/geonames/RU.txt');
const output = resolve(process.argv[3] || 'data/ru-places.json');
const regionOutput = resolve(process.argv[4] || 'data/ru-regions.json');
const rows = [];
const regions = [];
for (const line of readFileSync(input, 'utf8').split('\n')) {
  if (!line) continue;
  const fields = line.split('\t');
  if (fields[8] !== 'RU') continue;
  if (fields[7] === 'ADM1') {
    const names = [...new Set(fields[3].split(',').filter(name => /^[А-ЯЁа-яё -]+$/u.test(name) && (/(?:область|край|республика|автономный округ)$/iu.test(name) || /^Республика /iu.test(name))))];
    if (names.length) regions.push([fields[10], names]);
  }
  if (fields[6] !== 'P' || fields[8] !== 'RU') continue;
  const names = [...new Set(fields[3].split(',').filter(name => /^[А-ЯЁа-яё][А-ЯЁа-яё -]*$/.test(name)))];
  if (!names.length) continue;
  rows.push([Number(fields[0]), Number(fields[4]), Number(fields[5]), Number(fields[14]) || 0, fields[10], names]);
}
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(rows));
mkdirSync(dirname(regionOutput), { recursive: true });
writeFileSync(regionOutput, JSON.stringify(regions));
console.log(`Saved ${rows.length} populated places to ${output}`);
console.log(`Saved ${regions.length} regions to ${regionOutput}`);
