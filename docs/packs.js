'use strict';
/* Resort packs: each resort is one download (vector map, terrain, pistes + huts) that then works offline.
   Files are built by tools/packs and listed in packs/catalog.json. Downloaded files live in IndexedDB,
   and the map reads them through PMTiles straight from the stored blobs. */

const PackDB = {
  db: null,
  open() {
    return this.db || (this.db = new Promise((ok, fail) => {
      const r = indexedDB.open('ekipa-packs', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('files');
      r.onsuccess = () => ok(r.result); r.onerror = () => fail(r.error);
    }));
  },
  async run(mode, fn) {
    const db = await this.open();
    return new Promise((ok, fail) => { const tx = db.transaction('files', mode), req = fn(tx.objectStore('files')); tx.oncomplete = () => ok(req?.result); tx.onerror = () => fail(tx.error); });
  },
  get(k) { return this.run('readonly', s => s.get(k)).catch(() => null); },
  put(k, v) { return this.run('readwrite', s => s.put(v, k)).catch(() => null); },
  del(k) { return this.run('readwrite', s => s.delete(k)).catch(() => null); },
  keys() { return this.run('readonly', s => s.getAllKeys()).catch(() => []); },
};

let CATALOG = null;
async function loadCatalog() {
  try {
    const r = await fetch('packs/catalog.json', { cache: 'no-cache' });
    if (r.ok) { CATALOG = await r.json(); LS.set('ek.catalog', CATALOG); }
  } catch {}
  if (!CATALOG) CATALOG = LS.get('ek.catalog', []);
  return CATALOG;
}
const resortById = id => CATALOG?.find(r => r.id === id) || null;
const fileKey = (r, kind) => `${r.id}:${kind}:${r.version}`;
// Inside a resort's area (with a margin), used to suggest switching.
function resortAt(lat, lon, margin = 0.02) {
  return CATALOG?.find(r => lat > r.bbox[0] - margin && lat < r.bbox[2] + margin && lon > r.bbox[1] - margin && lon < r.bbox[3] + margin) || null;
}

async function packFile(r, kind, onBytes) {
  const key = fileKey(r, kind);
  let blob = await PackDB.get(key);
  if (blob) return blob;
  const res = await fetch('packs/' + r.files[kind]);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  blob = await res.blob();
  onBytes?.(blob.size);
  await PackDB.put(key, blob);
  return blob;
}
async function isDownloaded(r) {
  const keys = new Set(await PackDB.keys());
  return ['data', 'base', 'dem'].every(k => keys.has(fileKey(r, k)));
}
// Removes a resort's files (all versions), or only outdated versions when keepCurrent is set.
async function deletePack(r, keepCurrent) {
  for (const k of await PackDB.keys()) if (String(k).startsWith(r.id + ':') && (!keepCurrent || !k.endsWith(':' + r.version))) await PackDB.del(k);
}

// PMTiles reads byte ranges; here they come from the stored blob.
class BlobSource {
  constructor(blob, key) { this.blob = blob; this.key = key; }
  getKey() { return this.key; }
  async getBytes(offset, length) { return { data: await this.blob.slice(offset, offset + length).arrayBuffer() }; }
}
const pmProtocol = new pmtiles.Protocol();
maplibregl.addProtocol('pmtiles', pmProtocol.tile);

// Everything a resort needs, downloaded once: returns its pistes/huts data and registers its map files.
async function openPack(r, onProgress) {
  let got = 0;
  const step = n => { got += n; onProgress?.(got); };
  const [data, base, dem] = await Promise.all([packFile(r, 'data', step), packFile(r, 'base', step), packFile(r, 'dem', step)]);
  pmProtocol.add(new pmtiles.PMTiles(new BlobSource(base, `${r.id}-base`)));
  pmProtocol.add(new pmtiles.PMTiles(new BlobSource(dem, `${r.id}-dem`)));
  deletePack(r, true);
  return JSON.parse(await data.text());
}

/* ---------- ski map style ---------- */
// Protomaps basemap layers (OpenStreetMap data) in a light winter look, with hill shading from Copernicus DEM.
// Our pistes, lifts and labels are drawn on top by the app.
const STYLE_LANGS = new Set(['en', 'de', 'it', 'fr', 'es', 'pt', 'nl', 'pl', 'cs', 'sk', 'sl', 'hr', 'hu', 'ro', 'sv', 'da', 'fi', 'et', 'lv', 'lt', 'el', 'bg', 'ga', 'mt']);
function skiStyle(r) {
  const flavor = { ...basemaps.namedFlavor('light'), background: '#eef2f4', earth: '#f6f8f9', park_a: '#e3eedf', park_b: '#dfeadb', wood_a: '#d5e6d0', wood_b: '#cfe2c9', scrub_a: '#e4ecdf', scrub_b: '#e0e9da', glacier: '#ffffff', water: '#a9cfe6' };
  let layers = basemaps.layers('base', flavor, { lang: STYLE_LANGS.has(LANG) ? LANG : 'en' });
  layers = layers.filter(l => !['pois', 'roads_shields', 'roads_oneway'].includes(l.id));
  for (const l of layers) if (l.layout?.['icon-image']) delete l.layout['icon-image'];   // we draw our own huts and markers
  const at = layers.findIndex(l => l['source-layer'] === 'roads' || l['source-layer'] === 'buildings');
  layers.splice(at < 0 ? layers.length : at, 0, {
    id: 'hillshade', type: 'hillshade', source: 'dem',
    paint: { 'hillshade-exaggeration': 0.45, 'hillshade-shadow-color': '#4f6274', 'hillshade-highlight-color': '#ffffff', 'hillshade-accent-color': '#7b8fa3' },
  });
  const root = location.href.replace(/[#?].*$/, '').replace(/[^/]*$/, '');
  return {
    version: 8,
    glyphs: root + 'map/glyphs/{fontstack}/{range}.pbf',
    sources: {
      base: { type: 'vector', url: `pmtiles://${r.id}-base`, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · <a href="https://protomaps.com">Protomaps</a>' },
      dem: { type: 'raster-dem', url: `pmtiles://${r.id}-dem`, encoding: 'terrarium', tileSize: 256, attribution: 'Copernicus DEM' },
    },
    layers,
  };
}
const EMPTY_STYLE = { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#eef2f4' } }] };
