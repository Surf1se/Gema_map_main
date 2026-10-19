import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const input = resolve(process.argv[2] || '.data/geonames/RU.txt');
const output = resolve(process.argv[3] || 'data/ru-places.json');
const regionOutput = resolve(process.argv[4] || 'data/ru-regions.json');
const adminOutput = resolve(process.argv[5] || 'data/ru-admins.json');
const rows = [];
const regions = [];
const admins = [];
const russianNames = value => [...new Set(value.split(',').map(name => name.replace(/\u0301/gu, '').trim())
  .filter(name => /^[А-ЯЁа-яё -]+$/u.test(name)))];
for (const line of readFileSync(input, 'utf8').split('\n')) {
  if (!line) continue;
  const fields = line.split('\t');
  if (fields[8] !== 'RU') continue;
  if (fields[7] === 'ADM1') {
    const names = russianNames(fields[3]).filter(name => /(?:область|край|республика|автономный округ)$/iu.test(name) || /^Республика /iu.test(name));
    if (names.length) {
      regions.push([fields[10], names]);
      admins.push([Number(fields[0]), Number(fields[4]), Number(fields[5]), 'region', fields[10], names]);
    }
  }
  if (fields[7] === 'ADM2') {
    const names = russianNames(fields[3]).filter(name => / район$/iu.test(name));
    if (names.length) admins.push([Number(fields[0]), Number(fields[4]), Number(fields[5]), 'district', fields[10], names]);
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
mkdirSync(dirname(adminOutput), { recursive: true });
writeFileSync(adminOutput, JSON.stringify(admins));
console.log(`Saved ${rows.length} populated places to ${output}`);
console.log(`Saved ${regions.length} regions to ${regionOutput}`);
console.log(`Saved ${admins.length} regions and districts to ${adminOutput}`);
