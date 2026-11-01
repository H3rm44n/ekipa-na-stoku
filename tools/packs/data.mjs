// Pistes, lifts and huts for one resort from OpenStreetMap (Overpass), in the app's compact format.
// usage: node tools/packs/data.mjs <id>   (reads tools/packs/resorts.json, writes docs/packs/<id>.json)
import fs from 'node:fs';
const resorts = JSON.parse(fs.readFileSync('tools/packs/resorts.json', 'utf8'));
const r = resorts.find(x => x.id === process.argv[2]);
if (!r) throw new Error('unknown resort ' + process.argv[2]);
const src = fs.readFileSync('docs/net.js', 'utf8');
const { compact } = new Function('t', 'LANG', 'fmt1', src + '\nreturn { compact };')(k => k, 'en', String);
const [s, w, n, e] = r.bbox;
const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];
async function overpass(q) {
  for (let round = 0; round < 4; round++) for (const url of ENDPOINTS) {
    try {
      const res = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'ekipa-pack-builder' } });
      if (res.ok) return (await res.json()).elements;
    } catch {}
    await new Promise(ok => setTimeout(ok, 5000));
  }
  throw new Error('Overpass unavailable');
}
const ski = await overpass(`[out:json][timeout:120];(way["piste:type"~"^(downhill|connection)$"](${s},${w},${n},${e});way["aerialway"](${s},${w},${n},${e}););out geom qt;`);
const poiEl = await overpass(`[out:json][timeout:90];(nwr["amenity"~"^(restaurant|bar|cafe|pub|fast_food|biergarten)$"](${s},${w},${n},${e});nwr["tourism"~"^(alpine_hut|wilderness_hut)$"](${s},${w},${n},${e}););out center tags qt;`);
const pois = [];
for (const el of poiEl) {
  const tg = el.tags || {}, lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
  if (lat == null || !tg.name) continue;
  let kind = { bar: 'bar', pub: 'bar', biergarten: 'bar', cafe: 'cafe' }[tg.amenity] || 'food';
  if (/hut/.test(tg.tourism || '') || /rifugio|malga|baita|hütte|hutte|schronisko|refuge|chalet|bait/i.test(tg.name)) kind = 'hut';
  pois.push([kind, tg.name.slice(0, 50), +lat.toFixed(6), +lon.toFixed(6)]);
}
const net = compact(ski);
fs.writeFileSync(`docs/packs/${r.id}.json`, JSON.stringify({ v: 1, id: r.id, made: new Date().toISOString().slice(0, 10), bbox: r.bbox, net, pois }));
console.log(r.id, 'ways', net.length, 'pois', pois.length);
