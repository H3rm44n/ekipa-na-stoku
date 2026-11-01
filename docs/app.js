'use strict';
/* Ekipa na Stoku – app shell: map, GPS, encrypted sharing over MQTT, crew list, meeting planner. */

const $ = s => document.querySelector(s);
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const RESORT = { name: 'Madonna di Campiglio · Pinzolo · Folgarida-Marilleva', center: [46.2297, 10.8263], bbox: [46.13, 10.68, 46.36, 10.97] };
// Message servers. For the App Store build put a private broker first (url + username/password).
const BROKERS = [{ url: 'wss://broker.hivemq.com:8884/mqtt' }, { url: 'wss://broker.emqx.io:8084/mqtt' }];
const COLORS = ['#ff6b00', '#d6249f', '#16a34a', '#0f766e', '#eab308', '#0891b2', '#a16207', '#e11d48'];
const OLD_COLORS = ['#7c3aed'];   // still accepted from friends on older versions
// Lifts get their own colour so they never look like a black piste.
const LIFT_COLOR = '#7b2fbe';
const STATUSES = ['ride', 'wait', 'hut', 'done'].map(k => [k, t('st.' + k)]);
const MAX_AGE_SHOW = 8 * 3600e3;
// How often a position goes out per GPS mode. Fewer sends = radio sleeps more = less battery.
const MODE_PUB = { active: 8000, lift: 15000, idle: 45000, saver: 180000 };
const MODE_PL = tmap(['active', 'lift', 'idle', 'saver'], 'mode.');
const ACT_PL = tmap(['pre', 'ski', 'off', 'done'], 'myact.');
const todayKey = () => { const d = new Date(); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
function loadDay() { const d = LS.get('ek.day', null); return d && d.date === todayKey() ? d : { date: todayKey(), skied: 0, lastOn: 0 }; }
const displayName = m => (m?.nick || '').trim() || (m?.first || '').trim() || (m?.name || '').trim() || '?';
const fullName = m => [m?.first, m?.last].map(v => (v || '').trim()).filter(Boolean).join(' ');

const S = {
  me: LS.get('ek.me', null),          // {id,name,color,group,status,share,wake,demo}
  myPos: null, myTrack: [], lastPub: 0,
  friends: new Map(),                 // id -> {id,name,color,status,t,pos,track,demo?}
  preds: new Map(),
  net: null, netMeta: LS.get('ek.netmeta', null),
  selected: null, plan: null, planAt: 0,
  sheetOpen: false, gpsError: null, follow: true,
  gpsMode: 'active', modeAt: 0, wakeUntil: 0, stillSince: 0, stillRef: null,
  day: loadDay(), act: 'pre', myPred: null, auth: null, batt: null,
};
// Older profiles had a single name: treat it as the first name.
if (S.me && !S.me.nick && !S.me.first && S.me.name) { S.me.first = S.me.name; }
let G = null; // {topic,key}
// Extension points used by stats.js and social.js.
const HOOK = {
  out: [],        // () => fields merged into my position message
  friend: [],     // (friend, rawMsg, previous) after a friend update
  topic: {},      // kind -> (id, payload) for /<kind>/<id> messages other than positions
  pos: [],        // (pos, now) after my position updates
  tick: [],       // (force) on every UI refresh
  top: [],        // () => HTML cards above the crew list
  act: {},        // data-act name -> (element) for clicks in the sheet
  netReady: [],   // () after the piste network loads
  longpress: null,// (latlng) long-press on the map
  rank: null,     // () => HTML for the ranking tab
  view: null,     // () => HTML for a full-sheet view (S.view set), e.g. my day
  meClick: null,  // () tap on my own marker
  leave: [],      // () before leaving the group
};
async function pubTopic(kind, id, obj, retain = true) {
  if (!G) return;
  const data = obj == null ? new Uint8Array(0) : await seal(obj);
  for (const c of conns) if (c.connected) c.publish(`${G.topic}/${kind}/${id}`, data, { qos: 0, retain });
}

/* ---------- map ---------- */
const map = L.map('map', { zoomControl: false, preferCanvas: true, tap: true }).setView(RESORT.center, 13);
// Base maps. With a MapTiler key (App Store build) both maps come from MapTiler under its terms;
// without one: OpenTopoMap (CC-BY-SA, light use) and Esri imagery.
const MAPTILER_KEY = '';
const OSM_ATTR = `<a href="https://www.openstreetmap.org/copyright">${t('map.osm')}</a>`;
const baseLayers = MAPTILER_KEY ? [
  [t('map.topo'), L.tileLayer(`https://api.maptiler.com/maps/winter-v2/256/{z}/{x}/{y}.png?key=${MAPTILER_KEY}`, { maxZoom: 18, attribution: `© MapTiler ${OSM_ATTR}` })],
  [t('map.sat'), L.tileLayer(`https://api.maptiler.com/maps/satellite/256/{z}/{x}/{y}.jpg?key=${MAPTILER_KEY}`, { maxZoom: 19, attribution: `© MapTiler ${OSM_ATTR}` })],
] : [
  [t('map.topo'), L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { subdomains: 'abc', maxZoom: 17, maxNativeZoom: 17, attribution: `${OSM_ATTR}, SRTM · © OpenTopoMap (CC-BY-SA)` })],
  [t('map.sat'), L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Esri, Maxar, Earthstar Geographics' })],
];
let baseIdx = LS.get('ek.base', 0) % baseLayers.length;
baseLayers[baseIdx][1].addTo(map);
const renderer = L.canvas({ padding: 0.3, tolerance: 8 });
const netLayer = L.layerGroup().addTo(map);
const arrowLayer = L.layerGroup().addTo(map);
const labelLayer = L.layerGroup().addTo(map);
const predLayer = L.layerGroup().addTo(map);
const routeLayer = L.layerGroup().addTo(map);
const markerLayer = L.layerGroup().addTo(map);
const markers = new Map();
let meMarker = null, meAcc = null;

map.on('dragstart', () => { S.follow = false; });
map.on('contextmenu', e => {
  if (HOOK.longpress) HOOK.longpress(e.latlng);
  else if (S.me?.demo) { setMyPos([e.latlng.lat, e.latlng.lng, null, 5, 0, null], true); toast(t('t.demoPos')); }
});

$('#btnLayers').onclick = () => {
  map.removeLayer(baseLayers[baseIdx][1]);
  baseIdx = (baseIdx + 1) % baseLayers.length;
  baseLayers[baseIdx][1].addTo(map); baseLayers[baseIdx][1].bringToBack();
  LS.set('ek.base', baseIdx); toast(t('t.map', { name: baseLayers[baseIdx][0] }));
};
$('#btnMe').onclick = () => {
  if (S.myPos) { S.follow = true; map.setView([S.myPos[0], S.myPos[1]], Math.max(map.getZoom(), 15)); }
  else toast(S.gpsError || t('t.waitGps'));
};
$('#btnFit').onclick = fitAll;
function fitAll() {
  const pts = [...visibleFriends()].map(f => [f.pos[0], f.pos[1]]);
  if (S.myPos) pts.push([S.myPos[0], S.myPos[1]]);
  if (!pts.length) { map.setView(RESORT.center, 13); return; }
  S.follow = false;
  if (pts.length === 1) map.setView(pts[0], 15);
  else map.fitBounds(pts, { padding: [60, 60], maxZoom: 16 });
}

/* ---------- ski network ---------- */
const DIFF_COLOR = { novice: '#16a34a', easy: '#1d6fe0', intermediate: '#d42a2a', advanced: '#111', expert: '#111', freeride: '#e08a00' };
function drawNet() {
  netLayer.clearLayers();
  if (!S.net) return;
  for (const w of S.net.ways) {
    const ll = w.pts.map(p => [p.lat, p.lon]);
    let layer;
    if (w.kind === 'area') layer = L.polygon(ll, { renderer, stroke: false, fillColor: DIFF_COLOR[w.diff] || '#888', fillOpacity: 0.12, interactive: false });
    else if (w.kind === 'lift') {
      const drag = w.sub.includes('bar') || w.sub.includes('drag') || w.sub === 'platter' || w.sub === 'rope_tow';
      netLayer.addLayer(L.polyline(ll, { renderer, color: '#fff', weight: 6, opacity: 0.85, interactive: false }));
      layer = L.polyline(ll, { renderer, color: LIFT_COLOR, weight: 3, opacity: 1, dashArray: drag ? '5 5' : null });
    }
    else if (w.kind === 'conn') layer = L.polyline(ll, { renderer, color: '#7b8fa3', weight: 2, dashArray: '4 4', opacity: 0.8 });
    else layer = L.polyline(ll, { renderer, color: DIFF_COLOR[w.diff] || '#d42a2a', weight: 3.5, opacity: 0.85 });
    if (w.kind !== 'area') {
      const b = wayBadge(w);
      layer.bindPopup(`<b>${esc(wayLabel(w))}</b><br><span style="color:#567">${esc(w.kind === 'lift' ? liftKind(w) : (w.ref ? t('pop.ref', { ref: w.ref }) + ' · ' : '') + (DIFF_PL[w.diff] || b.txt.toLowerCase()))} · ${fmtDist(w.len)}${w.kind === 'lift' ? ' · ' + t('pop.ride', { t: fmtMin(w.len / w.speed) }) : ''}</span>`);
    }
    netLayer.addLayer(layer);
  }
}

// Small chevrons along each piste pointing downhill (lifts: uphill), sized in screen pixels.
function drawArrows() {
  arrowLayer.clearLayers();
  if (!S.net) return;
  const z = map.getZoom();
  if (z < 14) return;
  const mpp = 156543.03 * Math.cos(S.net.lat0 * Math.PI / 180) / 2 ** z;   // metres per pixel
  const gap = 85 * mpp, arm = 6 * mpp, view = map.getBounds().pad(0.2);
  const lines = { };
  for (const w of S.net.ways) {
    if (w.kind === 'area' || w.kind === 'conn' || w.len < gap * 0.8) continue;
    const color = w.kind === 'lift' ? LIFT_COLOR : (DIFF_COLOR[w.diff] || '#d42a2a');
    const out = lines[color] || (lines[color] = []);
    for (let d = gap / 2; d < w.len; d += gap) {
      let i = 0; while (i < w.cum.length - 2 && w.cum[i + 1] < d) i++;
      const a = w.pts[i], b = w.pts[i + 1], L = w.cum[i + 1] - w.cum[i] || 1, t = (d - w.cum[i]) / L;
      const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t;
      const ux = (b.x - a.x) / L, uy = (b.y - a.y) / L;   // unit vector in travel direction
      const tip = S.net.LL(x + ux * arm * 0.6, y + uy * arm * 0.6);
      if (!view.contains(tip)) continue;
      const c = Math.cos(0.6), sn = Math.sin(0.6);
      const l1 = S.net.LL(x - arm * (ux * c - uy * sn), y - arm * (uy * c + ux * sn));
      const l2 = S.net.LL(x - arm * (ux * c + uy * sn), y - arm * (uy * c - ux * sn));
      out.push([l1, tip, l2]);
    }
  }
  for (const [color, segs] of Object.entries(lines)) {
    if (!segs.length) continue;
    arrowLayer.addLayer(L.polyline(segs, { renderer, color: '#fff', weight: 5, opacity: 0.85, lineCap: 'round', lineJoin: 'round', interactive: false }));
    arrowLayer.addLayer(L.polyline(segs, { renderer, color, weight: 2.5, opacity: 1, lineCap: 'round', lineJoin: 'round', interactive: false }));
  }
}

// Piste numbers (like the signs on the slope) and lift types, placed so they don't pile up.
const LIFT_SHORT = tmap(Object.keys(LIFT_SPEED), 'ls.');
const DIFF_CLS = { novice: 'nov', easy: 'easy', intermediate: 'inter', advanced: 'adv', expert: 'adv', freeride: 'free' };
function drawLabels() {
  labelLayer.clearLayers();
  if (!S.net) return;
  const z = map.getZoom();
  if (z < 14) return;
  const view = map.getBounds().pad(0.1), placed = [], byText = new Map();
  const free = (p, r) => placed.every(q => Math.hypot(q.x - p.x, q.y - p.y) > r);
  const at = (w, d) => alongLL(S.net, w, Math.max(0, Math.min(w.len, d)));
  const ways = S.net.ways.filter(w => w.kind === 'lift' || (w.kind === 'piste' && (w.ref || (z >= 16 && w.name))));
  ways.sort((a, b) => b.len - a.len);   // long ways first get the best spots
  for (const w of ways) {
    const lift = w.kind === 'lift';
    let html, key;
    if (lift) {
      key = 'L' + w.wi;
      const kind = LIFT_SHORT[w.sub] || t('ls.lift'), occ = w.occ > 1 && /chair|mixed/.test(w.sub) ? ' ' + w.occ : '';
      const ride = Math.max(1, Math.round(w.len / w.speed / 60));
      html = `<div class="lbl lift"><b>${kind}${occ}</b> · ${ride} min${z >= 16 && w.name ? ' · ' + esc(w.name) : ''}</div>`;
    } else {
      key = 'P' + (w.ref || w.name);
      const txt = w.ref || w.name;
      html = `<div class="lbl pref ${DIFF_CLS[w.diff] || 'inter'}${w.ref ? '' : ' nm'}">${esc(txt)}</div>`;
    }
    const step = lift ? Infinity : 1400 * 2 ** (15 - z);
    const spots = []; for (let d = Math.min(w.len / 2, step / 2); d < w.len; d += step) spots.push(d);
    for (const d of spots) {
      const ll = at(w, d);
      if (!view.contains(ll)) continue;
      const p = map.latLngToContainerPoint(ll);
      const same = byText.get(key) || [];
      if (!lift && same.some(q => Math.hypot(q.x - p.x, q.y - p.y) < 220)) continue;
      if (!free(p, lift ? 52 : 30)) continue;
      placed.push(p); same.push(p); byText.set(key, same);
      labelLayer.addLayer(L.marker(ll, { icon: L.divIcon({ className: 'lblwrap', html, iconSize: null }), interactive: false, keyboard: false, zIndexOffset: -100 }));
    }
  }
}
map.on('zoomend moveend', () => { if (!document.hidden) { drawArrows(); drawLabels(); } });

let bundled = null;
function bundledResort() { return bundled || (bundled = fetch('data/skirama.json').then(r => (r.ok ? r.json() : null)).catch(() => null)); }
async function loadNet(bbox, center, label, force) {
  const key = 'ek.net2:' + bbox.join(',');
  try { for (const k of Object.keys(localStorage)) if (k.startsWith('ek.net:')) LS.del(k); } catch {}   // old format without lift details
  let data = !force && LS.get(key, null);
  // The home resort ships with the app (works offline, no wait for OpenStreetMap); "reload" fetches fresh data.
  if (!data && !force && bbox.join() === RESORT.bbox.join()) data = (await bundledResort())?.net || null;
  if (!data) {
    showBanner(t('b.loadNet'));
    try { data = await fetchSkiData(bbox); }
    catch (err) {
      showBanner(t('b.netFail'), t('b.retry'), () => loadNet(bbox, center, label, true));
      return;
    }
    if (!LS.set(key, data)) { for (const k of Object.keys(localStorage)) if (k.startsWith('ek.net2:') && k !== key) LS.del(k); LS.set(key, data); }
  }
  S.net = new SkiNet(data, center);
  for (const h of HOOK.netReady) try { h(); } catch (err) { console.error(err); }
  S.netMeta = { bbox, center, label }; LS.set('ek.netmeta', S.netMeta);
  hideBanner();
  drawNet(); drawArrows(); drawLabels();
  const lifts = S.net.ways.filter(w => w.kind === 'lift').length, pistes = S.net.ways.filter(w => w.kind === 'piste').length;
  $('#stNet').textContent = t('st.net', { label, p: pistes, l: lifts });
  if (S.me?.demo) startDemo();
  tick(true);
}

/* ---------- crypto + MQTT ---------- */
const te = new TextEncoder(), td = new TextDecoder();
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
async function deriveGroup(code) {
  code = code.trim().toLowerCase();
  const topic = 'ekipa-narty/v1/' + hex(await crypto.subtle.digest('SHA-256', te.encode('ekipa-topic:' + code))).slice(0, 32);
  const base = await crypto.subtle.importKey('raw', te.encode(code), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: te.encode('ekipa-narty-salt-v1'), iterations: 150000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return { topic, key };
}
async function seal(obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, G.key, te.encode(JSON.stringify(obj))));
  const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12); return out;
}
async function unseal(u8) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: u8.slice(0, 12) }, G.key, u8.slice(12));
  return JSON.parse(td.decode(pt));
}

const conns = [];
function connect() {
  disconnect();
  if (typeof mqtt === 'undefined') { setConn(); return; }
  for (const { url, username, password } of BROKERS) {
    const c = mqtt.connect(url, { username, password, clientId: 'ek_' + S.me.id.slice(0, 10) + '_' + Math.random().toString(36).slice(2, 6), reconnectPeriod: 4000, connectTimeout: 12000, keepalive: 60, clean: true });
    c.on('connect', () => { c.subscribe(G.topic + '/+/+', { qos: 0 }); setConn(); publish(true); });
    c.on('close', setConn); c.on('offline', setConn); c.on('error', () => {});
    c.on('message', (topic, payload) => onMessage(topic, payload));
    conns.push(c);
  }
  setConn();
}
function disconnect() { while (conns.length) { try { conns.pop().end(true); } catch {} } }
function setConn() {
  const up = conns.filter(c => c.connected).length;
  $('#connDot').className = 'dot ' + (up === 0 ? 'off' : up < conns.length ? 'half' : 'on');
  $('#connTxt').textContent = up ? t('conn.on') : t('conn.off');
}
$('#connChip').onclick = () => {
  const up = conns.filter(c => c.connected).length;
  toast(up ? t('t.conn', { up, all: conns.length }) : t('t.noconn'));
};

async function onMessage(topic, payload) {
  const parts = topic.split('/'), id = parts.pop(), kind = parts.pop();
  if (kind !== 'p') { HOOK.topic[kind]?.(id, payload); return; }
  if (!payload || payload.length === 0) { S.friends.delete(id); tick(); return; }
  let m; try { m = await unseal(new Uint8Array(payload)); } catch { return; }
  if (!m || m.id !== id || !Array.isArray(m.p)) return;
  if (id === S.me.id) return;
  const cur = S.friends.get(id);
  if (cur && cur.t >= m.t) return;
  S.friends.set(id, { id, name: String(m.n || '?').slice(0, 20), full: String(m.fn || '').slice(0, 40), act: ['pre', 'ski', 'off', 'done'].includes(m.a) ? m.a : null, color: COLORS.includes(m.c) || OLD_COLORS.includes(m.c) ? m.c : COLORS[0], status: m.s || 'ride', t: +m.t || 0, pos: m.p.map(Number), track: Array.isArray(m.tr) ? m.tr.map(p => p.map(Number)) : [] });
  for (const h of HOOK.friend) try { h(S.friends.get(id), m, cur); } catch (err) { console.error(err); }
  tick();
}

async function publish(force) {
  if (!G || !S.me || S.me.share === false || !S.myPos) return;
  const now = Date.now();
  if ((S.me.hideUntil || 0) > now) return;
  if (!force && now - S.lastPub < MODE_PUB[S.gpsMode]) return;
  S.lastPub = now;
  const p = S.myPos.map((v, i) => v == null || !isFinite(v) ? null : +(+v).toFixed(i < 2 ? 6 : 1));
  const msg = { v: 1, id: S.me.id, n: displayName(S.me), fn: fullName(S.me), a: S.act, c: S.me.color, s: S.me.status, t: now, p, tr: S.myTrack.slice(-20) };
  for (const h of HOOK.out) Object.assign(msg, h());
  const data = await seal(msg);
  for (const c of conns) if (c.connected) c.publish(G.topic + '/p/' + S.me.id, data, { qos: 0, retain: true });
}
function clearMine() { if (G && S.me) for (const c of conns) if (c.connected) c.publish(G.topic + '/p/' + S.me.id, new Uint8Array(0), { qos: 0, retain: true }); }
// Heartbeat keeps "last seen" fresh, at most as often as the current mode allows.
setInterval(() => { if (Date.now() - S.lastPub > Math.max(60000, MODE_PUB[S.gpsMode])) publish(true); }, 30000);

/* ---------- GPS ---------- */
// In the iPhone app GPS comes from our own native module (ios/App/App/SkiLocation.swift),
// which keeps reporting with the screen locked and lowers GPS power when you are not riding.
const NATIVE = !!window.Capacitor?.isNativePlatform?.();
const Loc = NATIVE ? window.Capacitor.registerPlugin('SkiLocation') : null;
let watchId = null, nativeListeners = false;
function startGps() {
  if (S.me?.demo) return;
  if (NATIVE) { startNativeGps(); return; }
  if (!('geolocation' in navigator)) { S.gpsError = t('gps.noBrowser'); showBanner(S.gpsError); return; }
  if (watchId != null) return;
  showBanner(t('gps.wait'));
  watchId = navigator.geolocation.watchPosition(p => {
    S.gpsError = null;
    const c = p.coords;
    setMyPos([c.latitude, c.longitude, c.altitude, c.accuracy, c.speed, c.heading]);
  }, err => {
    S.gpsError = err.code === 1 ? t('gps.deniedWeb') : t('gps.weak');
    if (!S.myPos || err.code === 1) showBanner(S.gpsError);
  }, { enableHighAccuracy: true, maximumAge: 3000, timeout: 30000 });
}
function stopGps() {
  if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  if (NATIVE) Loc.stop().catch(() => {});
}
async function startNativeGps() {
  if (!nativeListeners) {
    nativeListeners = true;
    Loc.addListener('location', l => { S.gpsError = null; setMyPos([l.latitude, l.longitude, l.altitude, l.accuracy, l.speed, l.bearing]); });
    Loc.addListener('error', e => {
      if (e.code !== 'NOT_AUTHORIZED') return;
      S.gpsError = t('gps.deniedIos');
      showBanner(S.gpsError, t('b.settings'), () => Loc.openSettings());
    });
    Loc.addListener('auth', a => { S.auth = a.status; if (a.status === 'whenInUse') askAlways(); });
  }
  if (!S.myPos) showBanner(t('gps.wait'));
  try { const r = await Loc.start({ mode: S.gpsMode }); S.auth = r.auth; if (r.auth === 'whenInUse') askAlways(); }
  catch (e) { S.gpsError = t('gps.fail', { e: e?.message || e }); showBanner(S.gpsError); }
}
// "Always" lets the phone report from a pocket. iOS shows its own prompt once; after that only Settings can change it.
let alwaysNagged = false;
function askAlways() {
  if (!LS.get('ek.askedAlways', false)) { LS.set('ek.askedAlways', true); Loc.requestAlways().catch(() => {}); return; }
  if (alwaysNagged) return;
  alwaysNagged = true;
  setTimeout(() => {
    showBanner(t('gps.always'), t('b.settings'), () => { hideBanner(); Loc.openSettings(); });
    setTimeout(() => hideBannerIf('Zawsze'), 12000);
  }, 4000);
}

/* ---------- day state + battery-aware GPS modes ---------- */
// pre: not on the slope yet today · ski: on/near pistes · off: left the slope mid-day · done: finished for the day
function updateActivity() {
  if (S.day.date !== todayKey()) S.day = { date: todayKey(), skied: 0, lastOn: 0 };
  const p = S.myPos; if (!p || !S.net) return false;
  const now = Date.now(), near = S.net.distToNet(p[0], p[1], 160) <= 120;
  const m = motion(S.myTrack, p[4]);
  if (near) {
    S.day.lastOn = now;
    if (!S.day.skied && (m.spd > 2 || S.myPred?.state === 'lift')) S.day.skied = now;
  }
  LS.set('ek.day', S.day);
  const prev = S.act;
  if (S.me.status === 'done') S.act = 'done';
  else if (near) S.act = S.day.skied ? 'ski' : 'pre';
  else if (!S.day.skied) S.act = 'pre';
  else S.act = (now - S.day.lastOn > 45 * 60e3 && new Date().getHours() >= 15) ? 'done' : 'off';
  return prev !== S.act;
}
function chooseMode() {
  const now = Date.now();
  if (S.me?.demo) return 'active';
  if (now < S.wakeUntil) return 'active';
  if (S.act === 'pre' || S.act === 'done') return 'saver';
  if (S.act === 'off') return now - S.day.lastOn > 15 * 60e3 ? 'saver' : 'idle';
  if (S.myPred?.state === 'lift') return 'lift';
  if (S.stillSince && now - S.stillSince > 120e3) return 'idle';
  return S.me?.eco ? 'lift' : 'active';
}
function setGpsMode(force) {
  const want = chooseMode(), now = Date.now();
  if (want === S.gpsMode && !force) return;
  // Step down slowly (avoid flapping), step up to full accuracy at once.
  if (!force && want !== 'active' && now - S.modeAt < 30000) return;
  S.gpsMode = want; S.modeAt = now;
  if (NATIVE) Loc.setMode({ mode: want }).catch(() => {});
}

// Battery log (iPhone app only): one sample every 5 minutes, used to show real drain in %/h.
let lastBatt = 0;
async function sampleBattery(force) {
  if (!NATIVE || (!force && Date.now() - lastBatt < 5 * 60e3)) return;
  lastBatt = Date.now();
  try {
    const b = await Loc.battery(); S.batt = b;
    if (b.level < 0) return;
    const log = LS.get('ek.batt', []).filter(x => Date.now() - x[0] < 24 * 3600e3);
    log.push([Date.now(), +b.level.toFixed(3), b.state === 'unplugged' ? 0 : 1, S.gpsMode]);
    LS.set('ek.batt', log.slice(-300));
  } catch {}
}
function batteryRate() {
  const log = LS.get('ek.batt', []);
  let i = log.length - 1; if (i < 1) return null;
  while (i > 0 && !log[i - 1][2] && !log[i][2]) i--;   // walk back over the current unplugged stretch
  const a = log[i], b = log[log.length - 1], h = (b[0] - a[0]) / 3600e3;
  if (b[2] || h < 0.5) return null;
  return { perHour: Math.max(0, (a[1] - b[1]) * 100 / h), hours: h };
}
setInterval(() => { sampleBattery(); if (S.myPos) { updateActivity(); setGpsMode(); } }, 60000);

function setMyPos(p, manual) {
  const first = !S.myPos;
  const now = Date.now();
  // A fix arriving in saver mode means you moved a few hundred metres: look closely for a few minutes.
  if (S.gpsMode === 'saver' && S.myPos && haversine(S.myPos, p) > 150) S.wakeUntil = now + 180e3;
  S.myPos = p;
  const last = S.myTrack[S.myTrack.length - 1];
  if (manual) S.myTrack = [];
  if (!last || now - last[2] >= 4000 || manual) { S.myTrack.push([+p[0].toFixed(6), +p[1].toFixed(6), now]); if (S.myTrack.length > 40) S.myTrack.shift(); }
  if (first || manual) { hideBannerIf('GPS'); if (first) map.setView([p[0], p[1]], Math.max(map.getZoom(), 15)); }
  else if (S.follow && !S.selected && !map.getBounds().pad(-0.2).contains([p[0], p[1]])) map.panTo([p[0], p[1]]);
  // Standing still? (speed from GPS, or under 25 m from where you stopped)
  const spd = p[4] != null && p[4] >= 0 ? p[4] : motion(S.myTrack).spd;
  if (spd > 1.2 || (S.stillRef && haversine(S.stillRef, p) > 25)) { S.stillSince = 0; S.stillRef = null; }
  else if (!S.stillSince) { S.stillSince = now; S.stillRef = [p[0], p[1]]; }
  if (S.net) S.myPred = predict(S.net, { t: now, pos: p, track: S.myTrack, status: S.me?.status, act: S.act }, now);
  const actChanged = updateActivity();
  for (const h of HOOK.pos) try { h(p, now); } catch (err) { console.error(err); }
  const prevMode = S.gpsMode;
  setGpsMode();
  publish(manual || actChanged || (prevMode !== S.gpsMode && S.gpsMode === 'active'));
  sampleBattery();
  drawMe();
}
function drawMe() {
  if (!S.myPos || document.hidden) return;
  const ll = [S.myPos[0], S.myPos[1]];
  if (!meMarker) {
    meMarker = L.marker(ll, { icon: L.divIcon({ className: '', html: '<div class="me"></div>', iconSize: [22, 22] }), zIndexOffset: 1000, keyboard: false }).addTo(map).bindTooltip(t('me.tip'), { direction: 'top', offset: [0, -10] });
    meMarker.on('click', () => HOOK.meClick?.());
    meAcc = L.circle(ll, { radius: S.myPos[3] || 10, renderer, color: '#1a73e8', weight: 1, fillOpacity: 0.08, interactive: false }).addTo(map);
  } else { meMarker.setLatLng(ll); meAcc.setLatLng(ll).setRadius(Math.min(S.myPos[3] || 10, 300)); }
}

/* ---------- wake lock ---------- */
let wakeLock = null;
async function applyWake() {
  try {
    if (S.me?.wake && document.visibilityState === 'visible' && 'wakeLock' in navigator) { if (!wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } }
    else if (wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch { wakeLock = null; }
}
document.addEventListener('visibilitychange', () => { applyWake(); if (document.visibilityState === 'visible') { drawMe(); publish(true); tick(true); } });

/* ---------- demo bots ---------- */
let demoTimer = null;
// Bots near you plus a few in the other parts of the Skirama (Pinzolo, Folgarida-Marilleva).
const BOT_NAMES = [['Ania', '#d6249f'], ['Marek', '#16a34a'], ['Zosia', '#7c3aed'], ['Tomek', '#eab308'],
  ['Kasia', '#0891b2', [46.172, 10.778], 'Pinzolo'], ['Piotr', '#ea580c', [46.165, 10.762], 'Pinzolo'],
  ['Ola', '#db2777', [46.300, 10.865], 'Folgarida'], ['Bartek', '#65a30d', [46.322, 10.812], 'Marilleva']];
function startDemo() {
  stopDemo();
  if (!S.net) return;
  if (!S.myPos) setMyPos([46.2298, 10.8268, 1520, 8, 0, null], true);
  const liftsNear = ([lat, lon]) => {
    const [cx, cy] = S.net.P(lat, lon);
    return S.net.ways.filter(w => w.kind === 'lift' && w.len > 300).sort((a, b) => Math.hypot(a.pts[0].x - cx, a.pts[0].y - cy) - Math.hypot(b.pts[0].x - cx, b.pts[0].y - cy)).slice(0, 8);
  };
  const lifts = liftsNear(S.myPos);
  if (!lifts.length) return;
  const bots = BOT_NAMES.map(([name, color, anchor], i) => {
    const near = anchor ? liftsNear(anchor) : lifts;
    const w = near[i % Math.min(near.length, 3)] || lifts[i % lifts.length];
    return { id: 'demo-' + i, name, color, w, along: (i * 0.23 % 0.8) * w.len, wait: 0, track: [], home: near.length ? near : lifts };
  });
  const step = () => {
    const now = Date.now(), dt = 2;
    for (const b of bots) {
      if (b.wait > 0) b.wait -= dt;
      else {
        b.along += b.w.speed * (b.w.kind === 'lift' ? 1 : 1.2) * dt;
        if (b.along >= b.w.len) {
          const opts = S.net.continuations(b.w.pts[b.w.pts.length - 1], b.w.wi).filter(o => o.w.len > 120);
          const o = opts.length ? opts[Math.floor(Math.random() * opts.length)] : null;
          if (o) { b.w = o.w; b.along = o.w.cum[o.idx]; b.wait = o.w.kind === 'lift' ? 20 : 4; }
          else { b.w = b.home[Math.floor(Math.random() * b.home.length)]; b.along = 0; b.wait = 10; }
        }
      }
      const ll = alongLL(S.net, b.w, Math.min(b.along, b.w.len));
      const last = b.track[b.track.length - 1];
      if (!last || now - last[2] >= 4000) { b.track.push([ll[0], ll[1], now]); if (b.track.length > 20) b.track.shift(); }
      b.st = b.st || { skiM: 2000 + Math.random() * 6000, liftM: 3000 + Math.random() * 5000, vertM: 800 + Math.random() * 1500, runs: 3 + (Math.random() * 6 | 0), maxV: 14 + Math.random() * 8 };
      if (b.wait <= 0) { if (b.w.kind === 'lift') b.st.liftM += b.w.speed * dt; else { b.st.skiM += b.w.speed * 1.2 * dt; b.st.maxV = Math.max(b.st.maxV, b.w.speed * 1.2 + Math.random() * 6); } }
      S.friends.set(b.id, { id: b.id, name: b.name, color: b.color, status: 'ride', t: now, pos: [ll[0], ll[1], null, 6, b.wait > 0 ? 0 : b.w.speed, null], track: b.track.slice(), act: 'ski', demo: true, st: b.st });
    }
    tick();
  };
  for (let i = 0; i < 12; i++) { // warm up so tracks have history
    for (const b of bots) { b.along = Math.min(b.along + b.w.speed * 2, b.w.len - 1); const ll = alongLL(S.net, b.w, b.along); b.track.push([ll[0], ll[1], Date.now() - (12 - i) * 4000]); }
  }
  step();
  demoTimer = setInterval(step, 2000);
}
function stopDemo() { if (demoTimer) clearInterval(demoTimer); demoTimer = null; for (const id of [...S.friends.keys()]) if (id.startsWith('demo-')) S.friends.delete(id); }

/* ---------- render ---------- */
function visibleFriends() { const now = Date.now(); return [...S.friends.values()].filter(f => now - f.t < MAX_AGE_SHOW); }
function initials(n) { return (n || '?').trim().slice(0, 2).toUpperCase(); }
function agoTxt(ts) { const s = (Date.now() - ts) / 1000; if (s < 45) return t('ago.now'); if (s < 3600) return t('ago.min', { n: Math.round(s / 60) }); return t('ago.h', { n: Math.floor(s / 3600) }); }
function distTo(f) { return S.myPos ? haversine([S.myPos[0], S.myPos[1]], [f.pos[0], f.pos[1]]) : null; }

let lastFull = 0;
function tick(force) {
  if (document.hidden) return;   // nothing to draw in the background: save CPU
  const now = Date.now();
  const fr = visibleFriends();
  for (const f of fr) S.preds.set(f.id, predict(S.net, f, now));
  drawMarkers(fr);
  drawPredictions(fr);
  for (const h of HOOK.tick) try { h(force); } catch (err) { console.error(err); }
  if (S.selected && (force || now - S.planAt > 5000)) computePlan();
  renderSheet(fr, force);
  lastFull = now;
}
setInterval(() => tick(), 5000);

function drawMarkers(fr) {
  const seen = new Set();
  for (const f of fr) {
    seen.add(f.id);
    const p = S.preds.get(f.id), stale = p && p.age > 180, sel = S.selected === f.id;
    const hdg = p?.m?.hdg, showHd = hdg != null && p.m.spd > 1 && !stale;
    const html = `<div class="fm${stale ? ' stale' : ''}${sel ? ' sel' : ''}" style="color:${f.color}">${!stale && p?.age < 30 ? '<div class="pulse"></div>' : ''}${showHd ? `<div class="hd" style="transform:rotate(${hdg}deg)"></div>` : ''}<div class="c" style="background:${f.color}">${esc(initials(f.name))}</div><div class="lbl">${esc(f.name)}</div></div>`;
    let mk = markers.get(f.id);
    const ll = [f.pos[0], f.pos[1]];
    if (!mk) {
      mk = L.marker(ll, { icon: L.divIcon({ className: '', html, iconSize: [38, 38], iconAnchor: [19, 19] }), zIndexOffset: 500 });
      mk.on('click', () => select(f.id));
      mk._html = html; markerLayer.addLayer(mk); markers.set(f.id, mk);
    } else {
      mk.setLatLng(ll);
      if (mk._html !== html) { mk.setIcon(L.divIcon({ className: '', html, iconSize: [38, 38], iconAnchor: [19, 19] })); mk._html = html; }
    }
    mk.setZIndexOffset(sel ? 900 : 500);
  }
  for (const [id, mk] of markers) if (!seen.has(id)) { markerLayer.removeLayer(mk); markers.delete(id); }
}

function drawPredictions(fr) {
  predLayer.clearLayers();
  if (S.view) return;   // my day / history on the map: keep it clean
  for (const f of fr) {
    const p = S.preds.get(f.id); if (!p || p.age > 900) continue;
    const sel = S.selected === f.id;
    if (p.path.length > 1) {
      predLayer.addLayer(L.polyline(p.path, { renderer, color: '#fff', weight: sel ? 8 : 6, opacity: 0.8, interactive: false }));
      predLayer.addLayer(L.polyline(p.path, { renderer, color: f.color, weight: sel ? 5 : 3.5, dashArray: '8 7', opacity: 0.95, interactive: false }));
    }
    if (p.endLL) predLayer.addLayer(L.circleMarker(p.endLL, { renderer, radius: sel ? 7 : 5, color: '#fff', weight: 2, fillColor: f.color, fillOpacity: 1, interactive: false }));
    if (sel) for (const o of p.options) {
      predLayer.addLayer(L.polyline(o.path, { renderer, color: f.color, weight: 3, dashArray: '2 7', opacity: 0.75, interactive: false }));
    }
  }
}

function computePlan() {
  S.planAt = Date.now();
  routeLayer.clearLayers();
  const f = S.friends.get(S.selected);
  if (!f || !S.net || !S.myPos) { S.plan = null; return; }
  const me = { pos: S.myPos, track: S.myTrack };
  S.plan = planMeet(S.net, me, S.preds.get(f.id));
  if (S.plan?.line) {
    routeLayer.addLayer(L.polyline(S.plan.line, { renderer, color: '#fff', weight: 10, opacity: 0.9, interactive: false }));
    routeLayer.addLayer(L.polyline(S.plan.line, { renderer, color: '#ff6b00', weight: 6, opacity: 1, interactive: false }));
    routeLayer.addLayer(L.marker([S.plan.node.lat, S.plan.node.lon], { icon: L.divIcon({ className: '', html: '<div class="meet"></div>', iconSize: [30, 30] }), interactive: false, zIndexOffset: 800 }));
  }
}

function select(id) {
  S.selected = id; S.view = null; S.sheetOpen = true;
  const f = S.friends.get(id);
  tick(true);
  if (f) {
    const pts = [[f.pos[0], f.pos[1]]];
    if (S.plan?.line) pts.push(...S.plan.line);
    else if (S.myPos) pts.push([S.myPos[0], S.myPos[1]]);
    S.follow = false;
    map.fitBounds(pts, { paddingTopLeft: [40, 80], paddingBottomRight: [40, sheetH() + 40], maxZoom: 16 });
  }
}
function deselect() { S.selected = null; S.plan = null; S.view = null; routeLayer.clearLayers(); tick(true); }

const arrowSvg = deg => `<svg class="arrow" viewBox="0 0 24 24" style="transform:rotate(${deg}deg)"><path d="M12 3l6 16-6-4-6 4z" fill="currentColor"/></svg>`;
function sheetH() { return $('#sheet').getBoundingClientRect().height; }

function renderSheet(fr, force) {
  const body = $('#sheetBody');
  const scrollEl = body.querySelector('.list,.detail'), scroll = scrollEl ? scrollEl.scrollTop : 0;
  $('#sheet').classList.toggle('open', S.sheetOpen);
  let html;
  if (S.view && HOOK.view) html = HOOK.view();
  else if (S.selected && S.friends.has(S.selected)) html = detailHtml(S.friends.get(S.selected));
  else { S.selected = null; html = listHtml(fr); }
  const typing = document.activeElement?.tagName === 'INPUT' && document.activeElement.closest('#sheetBody');
  if (html !== renderSheet.last && !typing && !(Date.now() < (renderSheet.holdUntil || 0) && !force)) {
    renderSheet.last = html; body.innerHTML = html;
    const ns = body.querySelector('.list,.detail'); if (ns) ns.scrollTop = scroll;
  }
  document.documentElement.style.setProperty('--sheet-h', sheetH() + 'px');
}

function statusTag(s, act) {
  const tag = (k, c = '') => `<span class="tag ${c}">${t('tag.' + k)}</span>`;
  if (act === 'pre' || act === 'off' || act === 'done') return tag(act);
  if (s === 'wait') return tag('wait', 'wait'); if (s === 'hut') return tag('hut'); if (s === 'done') return tag('done'); return ''; }

function listHtml(fr) {
  const status = '';
  const away = f => (f.act === 'pre' || f.act === 'done') ? 1 : 0;
  fr.sort((a, b) => away(a) - away(b) || (distTo(a) ?? 1e9) - (distTo(b) ?? 1e9));
  let rows = fr.map(f => {
    const p = S.preds.get(f.id) || {}, d = distTo(f), stale = p.age > 180;
    const brg = S.myPos ? bearing([S.myPos[0], S.myPos[1]], [f.pos[0], f.pos[1]]) : 0;
    return `<button class="row${S.selected === f.id ? ' sel' : ''}" data-id="${esc(f.id)}">
      <div class="av" style="background:${f.color};color:${f.color}"><span style="color:#fff">${esc(initials(f.name))}</span></div>
      <div style="min-width:0"><div class="nm"><b>${esc(f.name)}</b>${statusTag(f.status, f.act)}${f.demo ? `<span class="tag">${t('tag.demo')}</span>` : ''}${stale ? `<span class="tag stale">${t('tag.stale')}</span>` : ''}</div>
      <div class="st">${esc(p.text || '')}</div></div>
      <div class="rt">${d != null ? `<div class="d">${arrowSvg(brg)} ${fmtDist(d)}</div>` : ''}<div class="ago">${agoTxt(f.t)}</div></div></button>`;
  }).join('');
  if (!fr.length) rows = `<div class="empty">${t('list.empty', { code: esc(S.me?.group || '') })}<br><br><button class="btn" data-act="demo">${t('list.demo')}</button></div>`;
  const tabs = `<div class="tabs" role="tablist"><button data-act="tab" data-tab="crew" class="${S.tab !== 'rank' ? 'on' : ''}">${t('tab.crew')} <span class="count">${fr.length}</span></button><button data-act="tab" data-tab="rank" class="${S.tab === 'rank' ? 'on' : ''}">${t('tab.rank')}</button></div>`;
  if (S.tab === 'rank' && HOOK.rank) return tabs + `<div class="list">${HOOK.rank()}</div>`;
  const top = HOOK.top.map(h => { try { return h(); } catch (err) { console.error(err); return ''; } }).join('');
  return tabs + `<h2 class="me-line"><span>${S.myPos ? t('me.line', { act: ACT_PL[S.act] }) + (S.me?.share === false ? ' · ' + t('me.noshare') : (S.me?.hideUntil || 0) > Date.now() ? ' · ' + t('me.hidden', { t: hhmm(S.me.hideUntil) }) : '') : t('me.nopos')}</span></h2>${status}<div class="list">${top}${rows}${HOOK.listEnd?.() || ''}</div>`;
}

function detailHtml(f) {
  const p = S.preds.get(f.id) || {}, d = distTo(f), plan = S.plan;
  const opts = (p.options || []).map(o => { const b = wayBadge(o.w); return `<span style="display:inline-flex;gap:6px;align-items:center"><span class="pb ${b.cls}">${esc(b.txt)}</span><span style="font-size:13px">${esc(wayLabel(o.w))}</span></span>`; }).join('');
  let planHtml = '';
  if (!S.myPos) planHtml = `<p class="small">${t('d.gpsOff', { name: esc(f.name) })}</p>`;
  else if (!S.net) planHtml = `<p class="small">${t('d.loadingNet')}</p>`;
  else if (!plan) planHtml = `<p class="small">${t('d.calc')}</p>`;
  else if (plan.error) planHtml = `<p class="small">${esc(plan.error)}</p>`;
  else {
    const where = nodeLabel(plan.node);
    const head = plan.inTime
      ? (plan.friendT < 30 && plan.myT < 60 ? t('d.together') : where ? t('d.meetAt', { where: esc(where), t: fmtMin(plan.meetT) }) : t('d.meetRun', { t: fmtMin(plan.meetT) }))
      : where ? t('d.late', { where: esc(where), t: fmtMin(plan.lateBy), name: esc(f.name) }) : t('d.lateNo', { t: fmtMin(plan.lateBy), name: esc(f.name) });
    const sub = plan.inTime ? t('d.sub', { me: fmtMin(plan.myT), name: esc(f.name), them: plan.friendT < 30 ? t('d.there') : fmtMin(plan.friendT) }) : t('d.subMe', { me: fmtMin(plan.myT) });
    const steps = stepsHtml(plan.steps);
    planHtml = `<div class="big">${head}</div><div class="small" style="margin-top:2px">${sub}</div>${steps ? `<ol class="steps">${steps}</ol>` : ''}`;
  }
  return `<div class="detail">
    <div class="dhead"><div class="av" style="background:${f.color};color:${f.color}"><span style="color:#fff">${esc(initials(f.name))}</span></div>
      <div class="t"><b>${esc(f.name)}</b>${f.full && f.full !== f.name ? `<span style="display:block">${esc(f.full)}</span>` : ''}<span>${d != null ? fmtDist(d) + ' od Ciebie · ' : ''}${agoTxt(f.t)}${p.m?.spd > 1 ? ' · ' + kmh(p.m.spd) : ''}</span></div>
      <button class="close" data-act="back" aria-label="${t('a.backList')}">×</button></div>
    <div class="box"><h3>${t('d.where')}</h3><div class="big" style="font-size:18px">${esc(p.text || '–')}</div>
      ${opts ? `<div class="small" style="margin-top:8px">${t('d.then')}</div><div class="opts">${opts}</div>` : ''}</div>
    <div class="box"><h3>${t('d.route', { name: esc(f.name) })}</h3>${planHtml}</div>
    <div class="actions"><button class="btn primary" data-act="navfriend" data-id="${esc(f.id)}">${t('d.guide', { name: esc(f.name) })}</button><button class="btn dark" data-act="center">${t('d.showMap')}</button><button class="btn" data-act="back">${t('d.all')}</button></div>
  </div>`;
}
function nodeLabel(n) {
  if (!S.net) return '';
  const ws = n.ways.map(i => S.net.ways[i]).filter(w => w.kind !== 'area');
  const liftStart = ws.find(w => w.kind === 'lift' && w.pts[0] === n), liftEnd = ws.find(w => w.kind === 'lift' && w.pts[w.pts.length - 1] === n);
  if (liftStart) return t('node.bottom', { name: wayLabel(liftStart) });
  if (liftEnd) return t('node.top', { name: wayLabel(liftEnd) });
  const near = n.out.filter(e => e.w === -1).map(e => e.to.ways.map(i => S.net.ways[i])).flat();
  const nl = near.find(w => w.kind === 'lift' && w.pts[0] && n.out.some(e => e.to === w.pts[0]));
  if (nl) return t('node.bottom', { name: wayLabel(nl) });
  const bottom = ws.find(w => w.kind === 'piste' && w.pts[w.pts.length - 1] === n);
  if (bottom) return t('node.runEnd', { name: wayLabel(bottom) });
  const p = ws.find(w => w.kind === 'piste') || ws[0];
  return p ? wayLabel(p) : '';
}

$('#sheetBody').addEventListener('click', e => {
  const row = e.target.closest('[data-id]'); if (row) { select(row.dataset.id); return; }
  const st = e.target.closest('[data-status]');
  if (st) { setStatus(st.dataset.status); return; }
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'back') deselect();
  else if (act === 'center') { const f = S.friends.get(S.selected); if (f) { S.follow = false; map.setView([f.pos[0], f.pos[1]], 16); } }
  else if (act === 'demo') { S.me.demo = true; saveMe(); applyMode(); }
  else if (act === 'tab') { S.tab = e.target.closest('[data-tab]').dataset.tab; tick(true); }
  else if (HOOK.act[act]) HOOK.act[act](e.target.closest('[data-act]'));
});
// My status lives in the right-hand column under SOS; the choices open in a small menu.
function setStatus(k) {
  S.me.status = k; saveMe(); publish(true);
  $('#stMenu').hidden = true; renderStatusBtn(); tick(true);
  toast(t('t.status', { s: (STATUSES.find(x => x[0] === k) || STATUSES[0])[1] }));
}
function renderStatusBtn() {
  const my = S.me?.status || 'ride';
  $('#stLabel').textContent = (STATUSES.find(x => x[0] === my) || STATUSES[0])[1];
  $('#btnStatus').className = 'rbtn st ' + my;
  $('#btnStatus').setAttribute('aria-expanded', String(!$('#stMenu').hidden));
  $('#stMenu').innerHTML = STATUSES.map(([k, l]) => `<button role="menuitem" data-st="${k}" class="${my === k ? 'on' : ''}">${l}</button>`).join('');
}
$('#btnStatus').onclick = () => { $('#stMenu').hidden = !$('#stMenu').hidden; renderStatusBtn(); };
$('#stMenu').onclick = e => { const b = e.target.closest('[data-st]'); if (b) setStatus(b.dataset.st); };
map.on('click', () => { if (!$('#stMenu').hidden) { $('#stMenu').hidden = true; renderStatusBtn(); } });
if (S.me) renderStatusBtn();

// Drag the handle to make the sheet taller or shorter (the size is remembered); a tap toggles it as before.
const sheetEl = $('#sheet'), handleEl = $('#handle');
let sheetDrag = null;
function setSheetH(h) {
  h = Math.max(76, Math.min(innerHeight - 110, h));
  sheetEl.style.height = h + 'px'; sheetEl.classList.add('sized');
  document.documentElement.style.setProperty('--sheet-h', h + 'px');
}
handleEl.addEventListener('pointerdown', e => { sheetDrag = { y: e.clientY, h: sheetH(), moved: false }; try { handleEl.setPointerCapture(e.pointerId); } catch {} });
handleEl.addEventListener('pointermove', e => {
  if (!sheetDrag) return;
  const dy = sheetDrag.y - e.clientY;
  if (Math.abs(dy) > 6) sheetDrag.moved = true;
  if (sheetDrag.moved) { e.preventDefault(); setSheetH(sheetDrag.h + dy); }
});
const endDrag = () => {
  if (!sheetDrag) return;
  if (sheetDrag.moved) { handleEl.dataset.dragged = '1'; S.sheetOpen = true; LS.set('ek.sheetH', sheetH() / innerHeight); renderSheet(visibleFriends(), true); }
  sheetDrag = null;
};
handleEl.addEventListener('pointerup', endDrag);
handleEl.addEventListener('pointercancel', endDrag);
handleEl.onclick = () => {
  if (handleEl.dataset.dragged) { delete handleEl.dataset.dragged; return; }
  sheetEl.classList.remove('sized'); sheetEl.style.height = ''; LS.del('ek.sheetH');
  S.sheetOpen = !S.sheetOpen; renderSheet(visibleFriends(), true);
};
{ const r = LS.get('ek.sheetH', null); if (r) { S.sheetOpen = true; setSheetH(r * innerHeight); } }
addEventListener('resize', () => { const r = LS.get('ek.sheetH', null); if (r && sheetEl.classList.contains('sized')) setSheetH(r * innerHeight); });
// The list refreshes in the background; don't let a refresh swap the row under a finger mid-tap.
['pointerdown', 'touchstart'].forEach(ev => $('#sheetBody').addEventListener(ev, () => { renderSheet.holdUntil = Date.now() + 700; }, { passive: true }));

/* ---------- banner / toast ---------- */
let bannerAct = null;
function showBanner(txt, btn, fn) { const b = $('#banner'); b.innerHTML = esc(txt) + (btn ? `<button>${esc(btn)}</button>` : ''); b.hidden = false; bannerAct = fn; }
function hideBanner() { $('#banner').hidden = true; }
function hideBannerIf(word) { if ($('#banner').textContent.includes(word)) hideBanner(); }
$('#banner').onclick = e => { if (e.target.tagName === 'BUTTON' && bannerAct) bannerAct(); };
let toastT;
function toast(msg) { const el = $('#toast'); el.textContent = msg; el.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { el.hidden = true; }, 2600); }

/* ---------- setup + settings ---------- */
function colorPicker(el, cur, onPick) {
  el.innerHTML = COLORS.map(c => `<button type="button" style="background:${c}" data-c="${c}" aria-label="Kolor ${c}" class="${c === cur ? 'on' : ''}"></button>`).join('');
  el.onclick = e => { const b = e.target.closest('[data-c]'); if (!b) return; el.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); onPick(b.dataset.c); };
}
const WORDS = ['spinale', 'groste', 'pradalago', 'cinque-laghi', 'zeledria', 'folgarida', 'pinzolo', 'brenta', 'pista', 'gondola', 'polenta', 'grappa'];
function genCode() { const a = crypto.getRandomValues(new Uint32Array(2)); return WORDS[a[0] % WORDS.length] + '-' + (1000 + a[1] % 9000); }
function saveMe() { LS.set('ek.me', S.me); }

function openSetup() {
  const fromLink = (location.hash.match(/^#g-([a-z0-9-]{3,40})$/) || [])[1];
  let color = COLORS[Math.floor(Math.random() * COLORS.length)];
  colorPicker($('#inColors'), color, c => { color = c; });
  let generated = fromLink ? '' : genCode();   // a new code made here = a new group, so this person becomes its admin
  $('#inGroup').value = fromLink || generated;
  $('#btnGen').onclick = () => { $('#inGroup').value = generated = genCode(); };
  $('#setup').hidden = false;
  if (!NATIVE) setTimeout(() => $('#inNick').focus(), 50);
  $('#setupForm').onsubmit = async e => {
    e.preventDefault();
    const nick = $('#inNick').value.trim(), first = $('#inFirst').value.trim(), last = $('#inLast').value.trim();
    const group = $('#inGroup').value.trim().toLowerCase();
    if (!nick && !first) { toast(t('t.nick')); $('#inNick').focus(); return; }
    if (group.length < 4) { toast(t('t.code4')); return; }
    if (!$('#inTerms').checked) { toast(t('t.terms')); return; }
    S.me = { id: crypto.randomUUID ? crypto.randomUUID() : hex(crypto.getRandomValues(new Uint8Array(16))), nick, first, last, color, group, status: 'ride', share: true, wake: true, demo: false, founder: group === generated, terms: Date.now() };
    saveMe();
    $('#setup').hidden = true;
    await start();
  };
}

function openSettings() {
  let color = S.me.color;
  $('#stNick').value = S.me.nick || ''; $('#stFirst').value = S.me.first || ''; $('#stLast').value = S.me.last || '';
  $('#stEco').checked = !!S.me.eco;
  renderBattery(); sampleBattery(true).then(renderBattery);
  colorPicker($('#stColors'), color, c => { color = c; });
  $('#stGroup').textContent = S.me.group;
  $('#stWake').checked = !!S.me.wake; $('#stShare').checked = S.me.share !== false; $('#stDemo').checked = !!S.me.demo;
  $('#settings').hidden = false;
  $('#btnSave').onclick = () => {
    const nick = $('#stNick').value.trim(), first = $('#stFirst').value.trim();
    if (!nick && !first) { toast(t('t.nick')); return; }
    S.me.nick = nick; S.me.first = first; S.me.last = $('#stLast').value.trim(); delete S.me.name;
    S.me.eco = $('#stEco').checked; setGpsMode(true);
    S.me.color = color; S.me.wake = $('#stWake').checked;
    const share = $('#stShare').checked; if (!share && S.me.share !== false) clearMine(); S.me.share = share;
    const demo = $('#stDemo').checked, modeChanged = demo !== !!S.me.demo; S.me.demo = demo;
    saveMe(); applyWake(); publish(true);
    $('#settings').hidden = true;
    if (modeChanged) applyMode();
    tick(true); toast(t('t.saved'));
  };
}
function renderBattery() {
  const el = $('#stBatt');
  const mode = t('bat.mode', { mode: MODE_PL[S.gpsMode], act: ACT_PL[S.act] });
  if (!NATIVE) { el.innerHTML = mode + '<br>' + t('bat.web'); return; }
  const b = S.batt, r = batteryRate();
  const lvl = b && b.level >= 0 ? t('bat.lvl', { n: Math.round(b.level * 100) }) + (b.state === 'charging' ? ' ' + t('bat.charging') : '') + (b.lowPower ? ' · ' + t('bat.low') : '') + '.' : '';
  const rate = r ? t('bat.rate', { r: fmt1(r.perHour), t: fmtMin(r.hours * 3600) }) : t('bat.wait');
  const auth = b?.auth === 'whenInUse' ? '<br>' + t('bat.whenInUse') : b?.auth === 'always' ? '<br>' + t('bat.always') : '';
  el.innerHTML = `${mode}<br>${lvl} ${rate}${auth}`;
}
$('#btnSettings').onclick = openSettings;
$('#settings').addEventListener('click', e => { if (e.target.id === 'settings' || e.target.closest('[data-close]')) $('#settings').hidden = true; });
const WEB_URL = 'https://h3rm44n.github.io/ekipa-na-stoku/';
$('#btnLeave').onclick = () => {
  const b = $('#btnLeave');
  if (!b.dataset.confirm) { b.dataset.confirm = '1'; b.textContent = t('leave.confirm'); setTimeout(() => { delete b.dataset.confirm; b.textContent = t('leave'); }, 4000); return; }
  clearMine(); for (const h of HOOK.leave) try { h(); } catch {} setTimeout(() => { disconnect(); stopGps(); stopDemo(); LS.del('ek.me'); location.hash = ''; location.reload(); }, 600);
};
$('#btnNetResort').onclick = () => { $('#settings').hidden = true; loadNet(RESORT.bbox, RESORT.center, 'Madonna di Campiglio', true); };
$('#btnNetHere').onclick = () => {
  $('#settings').hidden = true;
  const c = map.getCenter(), dLat = 0.09, dLon = 0.12;
  const bbox = [c.lat - dLat, c.lng - dLon, c.lat + dLat, c.lng + dLon].map(v => +v.toFixed(3));
  loadNet(bbox, [c.lat, c.lng], t('net.view'), true);
};

function applyMode() {
  if (S.me.demo) { stopGps(); hideBannerIf('GPS'); startDemo(); }
  else { stopDemo(); S.myPos = null; S.myTrack = []; startGps(); }
  tick(true);
}

async function start() {
  renderStatusBtn();
  G = await deriveGroup(S.me.group);
  connect();
  applyWake();
  let meta = S.netMeta || { bbox: RESORT.bbox, center: RESORT.center, label: 'Madonna di Campiglio' };
  if (meta.label === 'Madonna di Campiglio' && meta.bbox.join() !== RESORT.bbox.join()) meta = { ...meta, bbox: RESORT.bbox };   // area grew to Pinzolo + Folgarida
  if (!S.me.demo) startGps();
  tick(true);
  loadNet(meta.bbox, meta.center, meta.label);
}

// In the iPhone app the help/privacy pages open in Safari instead of replacing the app screen.
if (NATIVE) document.addEventListener('click', e => { const a = e.target.closest('a[href$=".html"]'); if (a) { e.preventDefault(); location.href = WEB_URL + a.getAttribute('href'); } });

/* ---------- boot ---------- */
applyI18n();
langSelect($('#stLang')); langSelect($('#inLang'));
if (!NATIVE && 'serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
if (NATIVE) { document.documentElement.classList.add('native'); $('#stWake').closest('label').hidden = true; }
if (!NATIVE && !window.isSecureContext) showBanner(t('b.https'));
if (S.me && S.me.group) {
  const fromLink = (location.hash.match(/^#g-([a-z0-9-]{3,40})$/) || [])[1];
  if (fromLink && fromLink !== S.me.group) { S.me.group = fromLink; saveMe(); toast(t('t.joined', { code: fromLink })); }
  start();
} else openSetup();
