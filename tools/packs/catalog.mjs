// Writes docs/packs/catalog.json from tools/packs/resorts.json and the built pack files.
import fs from 'node:fs';
import crypto from 'node:crypto';
const resorts = JSON.parse(fs.readFileSync('tools/packs/resorts.json', 'utf8'));
const out = resorts.map(r => {
  const files = { data: `${r.id}.json`, base: `${r.id}-base.pmtiles`, dem: `${r.id}-dem.pmtiles` };
  const h = crypto.createHash('sha256'); let size = 0;
  for (const f of Object.values(files)) { const b = fs.readFileSync(`docs/packs/${f}`); h.update(b); size += b.length; }
  return { id: r.id, name: r.name, country: r.country, center: r.center, bbox: r.bbox, files, size, version: h.digest('hex').slice(0, 12) };
});
fs.writeFileSync('docs/packs/catalog.json', JSON.stringify(out, null, 1));
console.log(out.map(r => `${r.id} ${(r.size / 1e6).toFixed(1)} MB ${r.version}`).join('\n'));
