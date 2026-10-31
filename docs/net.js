'use strict';
/* Ski network: pistes + lifts from OpenStreetMap, as a directed graph.
   OSM convention: downhill pistes are drawn top -> bottom, aerialways bottom -> top. */

const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
const LIFT_TYPES = 'cable_car|gondola|mixed_lift|chair_lift|drag_lift|t-bar|j-bar|platter|rope_tow|magic_carpet';
const LIFT_SPEED = { cable_car: 8, gondola: 5, mixed_lift: 5, chair_lift: 4.2, drag_lift: 3, 't-bar': 3, 'j-bar': 3, platter: 3, rope_tow: 2.5, magic_carpet: 1 };
const PISTE_SPEED = { novice: 7, easy: 8, intermediate: 7.5, advanced: 6.5, expert: 6, freeride: 5 };
const LIFT_QUEUE = 120;   // s, waiting + boarding
const WALK_SPEED = 1.0;   // m/s, clicking in / shuffling over
const LINK_R = 60;        // m, how far apart two ways can be and still count as connected
const TOWN_R = 400;       // m, walk from a piste bottom to another lift's base station (resort villages)

const LIFT_PL = { cable_car: 'kolej linowa', gondola: 'gondola', mixed_lift: 'gondola/krzesło', chair_lift: 'krzesełko', drag_lift: 'orczyk', 't-bar': 'orczyk', 'j-bar': 'orczyk', platter: 'talerzyk', rope_tow: 'wyciąg linowy', magic_carpet: 'taśma' };
const DIFF_PL = { novice: 'zielona', easy: 'niebieska', intermediate: 'czerwona', advanced: 'czarna', expert: 'czarna', freeride: 'freeride' };

async function fetchSkiData(bbox) {
  const [s, w, n, e] = bbox;
  const q = `[out:json][timeout:90];(way["piste:type"~"^(downhill|connection)$"](${s},${w},${n},${e});way["aerialway"~"^(${LIFT_TYPES})$"](${s},${w},${n},${e}););out geom qt;`;
  let lastErr;
  for (const url of OVERPASS) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 60000);
      const r = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: ctl.signal });
      clearTimeout(timer);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      return compact(j.elements || []);
    } catch (err) { lastErr = err; }
  }
  throw lastErr || new Error('Overpass niedostępny');
}

// Small storable form: one array per way.
function compact(elements) {
  const out = [];
  for (const el of elements) {
    if (el.type !== 'way' || !el.geometry || !el.nodes || el.geometry.length !== el.nodes.length) continue;
    const t = el.tags || {};
    let kind, sub = '';
    if (t.aerialway && LIFT_SPEED[t.aerialway]) { kind = 'lift'; sub = t.aerialway; }
    else if (t['piste:type'] === 'connection') kind = 'conn';
    else if (t['piste:type'] === 'downhill') kind = 'piste';
    else continue;
    const closed = el.nodes[0] === el.nodes[el.nodes.length - 1];
    if (kind === 'piste' && (closed || t.area === 'yes')) kind = 'area';
    const ll = [];
    for (const g of el.geometry) ll.push(+g.lat.toFixed(6), +g.lon.toFixed(6));
    out.push([
      el.id, kind, t.name || t['piste:name'] || t['aerialway:name'] || '',
      t['piste:ref'] || t.ref || '', t['piste:difficulty'] || '', sub,
      +(t['aerialway:duration'] || 0) || 0, t.oneway === 'no' ? 1 : 0, el.nodes, ll,
    ]);
  }
  return out;
}

class SkiNet {
  constructor(data, center) {
    this.lat0 = center[0]; this.lon0 = center[1];
    this.kx = Math.cos(this.lat0 * Math.PI / 180) * 111320; this.ky = 110574;
    this.nodes = new Map(); this.ways = [];
    this.nodeGrid = new Map(); this.wayGrid = new Map(); this.G = 100;
    for (const a of data) this._addWay(a);
    this._index();
    this._edges();
  }
  // Lift mid-span nodes are not places you can get on or off.
  stop(n) { return n.ways.some(wi => { const w = this.ways[wi]; return w.kind !== 'lift' || w.pts[0] === n || w.pts[w.pts.length - 1] === n; }); }
  P(lat, lon) { return [(lon - this.lon0) * this.kx, (lat - this.lat0) * this.ky]; }
  LL(x, y) { return [this.lat0 + y / this.ky, this.lon0 + x / this.kx]; }

  _addWay([id, kind, name, ref, diff, sub, dur, twoWay, ids, ll]) {
    const wi = this.ways.length, pts = [], cum = [0];
    for (let i = 0; i < ids.length; i++) {
      let n = this.nodes.get(ids[i]);
      if (!n) {
        const lat = ll[2 * i], lon = ll[2 * i + 1], [x, y] = this.P(lat, lon);
        n = { id: ids[i], lat, lon, x, y, out: [], ways: [] };
        this.nodes.set(n.id, n);
      }
      n.ways.push(wi); pts.push(n);
      if (i) cum.push(cum[i - 1] + Math.hypot(n.x - pts[i - 1].x, n.y - pts[i - 1].y));
    }
    const len = cum[cum.length - 1];
    let speed;
    if (kind === 'lift') speed = dur > 0 ? Math.max(1, len / (dur * 60)) : LIFT_SPEED[sub] || 4;
    else if (kind === 'conn') speed = 3;
    else speed = PISTE_SPEED[diff] || 7;
    this.ways.push({ wi, id, kind, name, ref, diff, sub, twoWay: !!twoWay, pts, cum, len, speed });
  }

  _cell(x, y) { return Math.floor(x / this.G) + ',' + Math.floor(y / this.G); }
  _index() {
    for (const n of this.nodes.values()) {
      const k = this._cell(n.x, n.y);
      (this.nodeGrid.get(k) || this.nodeGrid.set(k, []).get(k)).push(n);
    }
    // Ways are indexed along their length so a long cable-car span is still findable mid-air.
    for (const w of this.ways) {
      for (let i = 0; i < w.pts.length - 1; i++) {
        const a = w.pts[i], b = w.pts[i + 1], L = Math.hypot(b.x - a.x, b.y - a.y), steps = Math.max(1, Math.ceil(L / 40));
        for (let s = 0; s <= steps; s++) {
          const k = this._cell(a.x + (b.x - a.x) * s / steps, a.y + (b.y - a.y) * s / steps);
          let set = this.wayGrid.get(k); if (!set) this.wayGrid.set(k, set = new Set());
          set.add(w.wi);
        }
      }
    }
  }
  nearNodes(x, y, r) {
    const out = [], c0 = Math.floor((x - r) / this.G), c1 = Math.floor((x + r) / this.G), r0 = Math.floor((y - r) / this.G), r1 = Math.floor((y + r) / this.G);
    for (let cx = c0; cx <= c1; cx++) for (let cy = r0; cy <= r1; cy++) {
      const arr = this.nodeGrid.get(cx + ',' + cy); if (!arr) continue;
      for (const n of arr) { const d = Math.hypot(n.x - x, n.y - y); if (d <= r) out.push([n, d]); }
    }
    return out;
  }
  nearWays(x, y, r) {
    const out = new Set(), c0 = Math.floor((x - r) / this.G), c1 = Math.floor((x + r) / this.G), r0 = Math.floor((y - r) / this.G), r1 = Math.floor((y + r) / this.G);
    for (let cx = c0; cx <= c1; cx++) for (let cy = r0; cy <= r1; cy++) {
      const s = this.wayGrid.get(cx + ',' + cy); if (s) for (const wi of s) out.add(wi);
    }
    return out;
  }

  _edges() {
    const add = (a, b, cost, wi, d) => a.out.push({ to: b, cost, w: wi, d });
    for (const w of this.ways) {
      if (w.kind === 'area') continue;
      for (let i = 0; i < w.pts.length - 1; i++) {
        const a = w.pts[i], b = w.pts[i + 1], d = w.cum[i + 1] - w.cum[i];
        let c = d / w.speed;
        if (w.kind === 'lift' && i === 0) c += LIFT_QUEUE;
        add(a, b, c, w.wi, d);
        if (w.kind === 'conn' || w.twoWay) add(b, a, d / w.speed, w.wi, d);
      }
    }
    // Walk links between way ends and nearby nodes of other ways (lift stations rarely share nodes with pistes).
    const liftBases = this.ways.filter(w => w.kind === 'lift').map(w => w.pts[0]);
    for (const w of this.ways) {
      if (w.kind !== 'piste' && w.kind !== 'conn') continue;
      const end = w.pts[w.pts.length - 1];
      for (const b of liftBases) {
        const d = Math.hypot(b.x - end.x, b.y - end.y);
        if (d <= LINK_R || d > TOWN_R || end.out.some(e => e.to === b)) continue;
        add(end, b, d / WALK_SPEED + 30, -1, d); add(b, end, d / WALK_SPEED + 30, -1, d);
      }
    }
    for (const w of this.ways) {
      if (w.kind === 'area') continue;
      for (const end of [w.pts[0], w.pts[w.pts.length - 1]]) {
        const best = new Map();
        for (const [n, d] of this.nearNodes(end.x, end.y, LINK_R)) {
          if (n === end || !this.stop(n)) continue;
          for (const owi of n.ways) {
            if (owi === w.wi || this.ways[owi].kind === 'area') continue;
            const cur = best.get(owi);
            if (!cur || d < cur[1]) best.set(owi, [n, d]);
          }
        }
        for (const [n, d] of best.values()) {
          if (end.out.some(e => e.to === n)) continue;
          const c = d < 8 ? d : d / WALK_SPEED + 10;
          add(end, n, c, -1, d); add(n, end, c, -1, d);
        }
      }
    }
  }

  // Metres to the nearest piste or lift (0 inside a piste area), Infinity if none within r.
  distToNet(lat, lon, r = 150) {
    const [x, y] = this.P(lat, lon);
    let best = Infinity;
    for (const wi of this.nearWays(x, y, r)) {
      const w = this.ways[wi];
      if (w.kind === 'area') { if (inPoly(x, y, w.pts)) return 0; continue; }
      for (let i = 0; i < w.pts.length - 1; i++) {
        const a = w.pts[i], b = w.pts[i + 1], dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / L2));
        best = Math.min(best, Math.hypot(a.x + dx * t - x, a.y + dy * t - y));
      }
    }
    return best;
  }

  // Best way under a position, weighted by distance and by how well the heading matches the way's direction.
  snap(lat, lon, hdg, spd) {
    const [x, y] = this.P(lat, lon);
    let best = null, area = null;
    for (const wi of this.nearWays(x, y, 80)) {
      const w = this.ways[wi];
      if (w.kind === 'area') { if (!area && inPoly(x, y, w.pts)) area = w; continue; }
      for (let i = 0; i < w.pts.length - 1; i++) {
        const a = w.pts[i], b = w.pts[i + 1], dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / L2));
        const d = Math.hypot(a.x + dx * t - x, a.y + dy * t - y);
        if (d > 70) continue;
        let score = d;
        const segB = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
        if (hdg != null && spd > 1) {
          let diff = angDiff(hdg, segB);
          if (w.kind === 'conn' || w.twoWay) diff = Math.min(diff, 180 - diff);
          score += diff / 180 * 55;
          if (w.kind === 'lift') score += (diff < 35 && spd < 9) ? -10 : 20;
        } else if (w.kind === 'lift') score += 25;
        if (!best || score < best.score) best = { w, i, t, d, score, along: w.cum[i] + t * (w.cum[i + 1] - w.cum[i]), x: a.x + dx * t, y: a.y + dy * t };
      }
    }
    if (best) best.area = area;
    return best || (area ? { area } : null);
  }

  // Ways you can continue on from node `n` (shared node or short walk), except `exceptWi`.
  continuations(n, exceptWi) {
    const found = new Map();
    const consider = (node, extra) => {
      for (const wi of node.ways) {
        if (wi === exceptWi) continue;
        const w = this.ways[wi]; if (w.kind === 'area') continue;
        const idx = w.pts.indexOf(node);
        if (idx < 0 || idx === w.pts.length - 1) continue;
        if (w.kind === 'lift' && idx > 0) continue;
        const cur = found.get(wi);
        if (!cur || extra < cur.extra) found.set(wi, { w, idx, extra });
      }
    };
    consider(n, 0);
    for (const e of n.out) if (e.w === -1) consider(e.to, e.cost);
    return [...found.values()].sort((a, b) => (a.w.kind === 'lift' ? 0 : 1) - (b.w.kind === 'lift' ? 0 : 1) || a.extra - b.extra).slice(0, 4);
  }

  dijkstra(sources, maxCost = 5400) {
    const dist = new Map(), prev = new Map(), heap = new Heap();
    for (const s of sources) if (!dist.has(s.node.id) || s.cost < dist.get(s.node.id)) {
      dist.set(s.node.id, s.cost); prev.set(s.node.id, { from: null, w: s.w ?? -2, d: s.d || 0 }); heap.push(s.cost, s.node);
    }
    while (heap.size) {
      const [c, n] = heap.pop();
      if (c > dist.get(n.id) || c > maxCost) continue;
      for (const e of n.out) {
        const nc = c + e.cost;
        if (nc < (dist.get(e.to.id) ?? Infinity)) { dist.set(e.to.id, nc); prev.set(e.to.id, { from: n, w: e.w, d: e.d }); heap.push(nc, e.to); }
      }
    }
    return { dist, prev };
  }
}

class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(k, v) { const a = this.a; a.push([k, v]); let i = a.length - 1; while (i) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; } }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) { a[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < a.length && a[l][0] < a[m][0]) m = l; if (r < a.length && a[r][0] < a[m][0]) m = r; if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; } }
    return top;
  }
}

function inPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
function angDiff(a, b) { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; }
function haversine(a, b) {
  const R = 6371000, r = Math.PI / 180, dLat = (b[0] - a[0]) * r, dLon = (b[1] - a[1]) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function bearing(a, b) {
  const r = Math.PI / 180, y = Math.sin((b[1] - a[1]) * r) * Math.cos(b[0] * r);
  const x = Math.cos(a[0] * r) * Math.sin(b[0] * r) - Math.sin(a[0] * r) * Math.cos(b[0] * r) * Math.cos((b[1] - a[1]) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
}

function wayLabel(w) {
  if (!w) return '';
  if (w.kind === 'lift') return (w.name || w.ref || 'wyciąg') + (w.name && w.ref && w.ref !== w.name ? ` (${w.ref})` : '');
  if (w.kind === 'conn') return w.name || 'łącznik';
  const n = w.name && w.ref && w.name !== w.ref ? `${w.ref} ${w.name}` : (w.name || (w.ref ? `trasa ${w.ref}` : 'trasa bez nazwy'));
  return n;
}
function wayBadge(w) {
  if (!w) return { cls: 'walk', txt: 'PIESZO' };
  if (w.kind === 'lift') return { cls: 'lift', txt: (LIFT_PL[w.sub] || 'wyciąg').toUpperCase() };
  if (w.kind === 'conn') return { cls: 'conn', txt: 'ŁĄCZNIK' };
  const cls = { novice: 'easy', easy: 'easy', intermediate: 'inter', advanced: 'adv', expert: 'adv', freeride: 'free' }[w.diff] || 'inter';
  return { cls, txt: w.ref ? 'TRASA ' + w.ref : 'TRASA' };
}

// Heading + speed from a track of [lat, lon, tMs], looking ~15-60 s back.
function motion(track, gpsSpd) {
  if (!track || track.length < 2) return { spd: gpsSpd > 0 ? gpsSpd : 0, hdg: null };
  const last = track[track.length - 1];
  let ref = null;
  for (let i = track.length - 2; i >= 0; i--) { if (last[2] - track[i][2] >= 15000) { ref = track[i]; break; } }
  if (!ref) ref = track[0];
  if (last[2] - ref[2] > 90000) { // gap: use the nearest older point inside 90 s if any
    for (let i = track.length - 2; i >= 0; i--) if (last[2] - track[i][2] <= 90000) ref = track[i]; else break;
  }
  const dt = (last[2] - ref[2]) / 1000;
  if (dt < 3) return { spd: gpsSpd > 0 ? gpsSpd : 0, hdg: null };
  const d = haversine(ref, last);
  return { spd: d / dt, hdg: d > 12 ? bearing(ref, last) : null };
}

/* Where is a friend heading?
   Returns state, a short Polish description, the predicted path, options after the current way,
   and candidate meeting nodes with the time (s from now) the friend should pass them. */
function predict(net, f, now = Date.now()) {
  const age = (now - f.t) / 1000;
  const pos = [f.pos[0], f.pos[1]];
  const m = motion(f.track, f.pos[4]);
  const res = { age, m, state: 'unknown', text: '', where: '', path: [], options: [], cand: [], eta: null, endLL: null };
  const moving = m.spd > 0.9;
  const ACT_TXT = { pre: 'jeszcze nie wyszedł(a) na stok', done: 'skończył(a) jazdę', off: 'poza stokiem' };
  if (!net) {
    res.state = moving ? 'move' : 'stop';
    res.text = moving ? `jedzie ${kmh(m.spd)}` : 'stoi';
    return res;
  }
  const sn = net.snap(pos[0], pos[1], m.hdg, m.spd);
  res.snap = sn;
  res.where = sn?.w && sn.d < 45 ? wayLabel(sn.w) : sn?.area ? wayLabel(sn.area) : '';
  const nearestNode = () => { const [x, y] = net.P(pos[0], pos[1]); const nn = net.nearNodes(x, y, 250).filter(a => net.stop(a[0])).sort((a, b) => a[1] - b[1])[0]; return nn; };

  if (age > 900) {
    res.state = 'lost'; res.text = 'brak sygnału' + (res.where ? ` · ostatnio: ${res.where}` : '');
    const nn = nearestNode(); if (nn) res.cand.push({ node: nn[0], t: 0, hold: true });
    return res;
  }
  // Away from every piste and lift, or the phone itself says the day has not started / is over.
  const offNet = net.distToNet(pos[0], pos[1], 200) > 150;
  if (offNet || ((f.act === 'pre' || f.act === 'done') && !moving)) {
    res.state = f.act === 'pre' || f.act === 'done' ? f.act : 'off';
    const poi = net.nearPoi(pos[0], pos[1], 70);
    res.text = ACT_TXT[res.state] + (poi ? ` · ${POI_AT[poi.kind]} ${poi.name}` : !offNet && res.where ? ` · ${res.where}` : '') + (offNet && moving && m.spd > 8 ? ` · w drodze ${kmh(m.spd)}` : '');
    const [x, y] = net.P(pos[0], pos[1]);
    const nn = net.nearNodes(x, y, 900).filter(a => net.stop(a[0])).sort((a, b) => a[1] - b[1])[0];
    if (nn) res.cand.push({ node: nn[0], t: 0, hold: true });
    return res;
  }

  if (sn?.w && sn.d < 45 && (moving || (sn.w.kind === 'lift' && m.spd > 0.4))) {
    const w = sn.w, onLift = w.kind === 'lift';
    const speed = onLift ? (m.spd > 0.8 ? Math.min(m.spd, 9) : w.speed) : Math.max(m.spd, 3.5);
    const remaining = Math.max(0, w.len - sn.along);
    // Time already elapsed since the fix was taken also moves them along.
    const shift = Math.min(age, 120) * speed;
    const along0 = Math.min(w.len, sn.along + shift);
    const eta = Math.max(0, (w.len - along0) / speed);
    const startLL = alongLL(net, w, along0);
    res.path = [startLL];
    for (let k = sn.i + 1; k < w.pts.length; k++) {
      if (w.cum[k] <= along0) continue;
      const t = (w.cum[k] - along0) / speed;
      res.path.push([w.pts[k].lat, w.pts[k].lon]);
      if (!onLift || k === w.pts.length - 1) res.cand.push({ node: w.pts[k], t, hold: false });
    }
    const end = w.pts[w.pts.length - 1];
    res.eta = eta; res.endLL = [end.lat, end.lon];
    res.state = onLift ? 'lift' : 'piste';
    res.text = onLift
      ? `jedzie wyciągiem ${wayLabel(w)} · na górze ${eta < 60 ? 'za chwilę' : 'za ' + fmtMin(eta)}`
      : `zjeżdża: ${wayLabel(w)} · koniec trasy ${eta < 60 ? 'za chwilę' : 'za ' + fmtMin(eta)}`;
    // Lift top / piste bottom is where people pause: let a meeting wait there a bit.
    if (res.cand.length) res.cand[res.cand.length - 1].slack = onLift ? 60 : 90;
    addOptions(net, res, end, w.wi, eta);
    return res;
  }

  if (moving && m.hdg != null) {
    res.state = 'move';
    const dist = m.spd * 45, r = Math.PI / 180;
    const dLat = Math.cos(m.hdg * r) * dist / 110574, dLon = Math.sin(m.hdg * r) * dist / (111320 * Math.cos(pos[0] * r));
    res.path = [pos, [pos[0] + dLat, pos[1] + dLon]];
    res.text = `jedzie ${kmh(m.spd)}` + (res.where ? ` · ${res.where}` : '');
    const nn = nearestNode(); if (nn) res.cand.push({ node: nn[0], t: 0, slack: 60 });
    return res;
  }

  // Standing still. Near a lift bottom station? Probably queueing.
  res.state = 'stop';
  const [x, y] = net.P(pos[0], pos[1]);
  let liftBase = null;
  for (const [n, d] of net.nearNodes(x, y, 70)) for (const wi of n.ways) {
    const w = net.ways[wi];
    if (w.kind === 'lift' && w.pts[0] === n && (!liftBase || d < liftBase.d)) liftBase = { w, n, d };
  }
  const poi = net.nearPoi(pos[0], pos[1], 70);
  if (poi) res.poi = poi;
  const label = poi && f.status !== 'wait' ? `${POI_AT[poi.kind]} ${poi.name}` : { hut: 'w schronisku', wait: 'czeka na was', done: 'kończy jazdę' }[f.status];
  const nn = nearestNode();
  if (nn) res.cand.push({ node: nn[0], t: 0, hold: f.status === 'wait' || f.status === 'hut', slack: 180 });
  if (liftBase && !label) {
    res.text = `stoi przy wyciągu ${wayLabel(liftBase.w)} · pewnie zaraz wjedzie`;
    res.options.push({ w: liftBase.w, path: liftLL(liftBase.w, 0), t0: 0 });
    pushWayCand(net, res, liftBase.w, 0, LIFT_QUEUE * 0.5);
  } else {
    res.text = (label || 'stoi') + (res.where ? ` · ${res.where}` : '');
    if (!label && res.snap?.w && res.snap.d < 45) addOptions(net, res, res.snap.w.pts[Math.min(res.snap.i + 1, res.snap.w.pts.length - 1)], -99, 0, res.snap.w);
  }
  return res;
}

function alongLL(net, w, along) {
  let i = 0; while (i < w.cum.length - 2 && w.cum[i + 1] < along) i++;
  const seg = w.cum[i + 1] - w.cum[i] || 1, t = Math.max(0, Math.min(1, (along - w.cum[i]) / seg));
  const a = w.pts[i], b = w.pts[i + 1];
  return [a.lat + (b.lat - a.lat) * t, a.lon + (b.lon - a.lon) * t];
}
function liftLL(w, idx, maxLen = 1800) {
  const out = [];
  for (let k = idx; k < w.pts.length; k++) { out.push([w.pts[k].lat, w.pts[k].lon]); if (w.cum[k] - w.cum[idx] > maxLen) break; }
  return out;
}
function pushWayCand(net, res, w, idx, t0, maxLen = 2500) {
  for (let k = idx + 1; k < w.pts.length; k++) {
    const d = w.cum[k] - w.cum[idx]; if (d > maxLen && w.kind !== 'lift') break;
    if (w.kind === 'lift' && k < w.pts.length - 1) continue;
    res.cand.push({ node: w.pts[k], t: t0 + d / w.speed + (w.kind === 'lift' ? LIFT_QUEUE * 0.5 : 0), slack: k === w.pts.length - 1 ? 60 : 0, opt: true });
  }
}
function addOptions(net, res, endNode, curWi, eta, onlyWay) {
  const opts = onlyWay ? [{ w: onlyWay, idx: onlyWay.pts.indexOf(endNode), extra: 0 }] : net.continuations(endNode, curWi);
  for (const o of opts) {
    if (o.idx < 0) continue;
    res.options.push({ w: o.w, path: liftLL(o.w, o.idx), t0: eta + o.extra });
    pushWayCand(net, res, o.w, o.idx, eta + o.extra);
  }
}

// Where can this person start from on the network? (on a lift: its top; on a piste: next node; else short walk)
function startSources(net, me) {
  const mm = motion(me.track, me.pos[4]);
  const sn = net.snap(me.pos[0], me.pos[1], mm.hdg, mm.spd);
  const [x, y] = net.P(me.pos[0], me.pos[1]);
  const sources = [];
  if (sn?.w && sn.d < 40 && sn.w.kind === 'lift' && mm.spd > 0.6) {
    const w = sn.w, end = w.pts[w.pts.length - 1];
    sources.push({ node: end, cost: (w.len - sn.along) / w.speed, w: w.wi, d: w.len - sn.along });
    return sources;
  }
  if (sn?.w && sn.d < 40 && sn.w.kind !== 'lift' && sn.i + 1 < sn.w.pts.length) {
    const w = sn.w, k = sn.i + 1;
    sources.push({ node: w.pts[k], cost: (w.cum[k] - sn.along) / w.speed, w: w.wi, d: w.cum[k] - sn.along });
  }
  // Standing or walking: you can stomp over to anything close (in a village up to ~10 min on foot).
  const onPiste = sn?.w && sn.d < 40 && mm.spd > 2;
  for (const [n, d] of net.nearNodes(x, y, onPiste ? 150 : 700)) if (net.stop(n)) sources.push({ node: n, cost: d / WALK_SPEED + (d > 15 ? 10 : 0), w: -1, d });
  return sources;
}

// Turn a Dijkstra result into a drawable line and grouped, human-sized steps.
function buildRoute(net, me, prev, target) {
  const chain = [];
  let cur = target;
  while (cur) { const p = prev.get(cur.id); chain.push({ node: cur, w: p ? p.w : -2, d: p ? p.d : 0 }); cur = p ? p.from : null; }
  chain.reverse();
  const line = [[me.pos[0], me.pos[1]], ...chain.map(c => [c.node.lat, c.node.lon])];
  const steps = [];
  for (const c of chain) {
    const wi = c.w;
    if (wi === -2 && !c.d) continue;
    const key = wi < 0 ? -1 : wi;
    const last = steps[steps.length - 1];
    const same = last && (last.wi === key || (key >= 0 && last.w && last.w.kind !== 'lift' && net.ways[key].kind !== 'lift' && wayLabel(last.w) === wayLabel(net.ways[key])));
    if (same) last.d += c.d;
    else steps.push({ wi: key, w: key >= 0 ? net.ways[key] : null, d: c.d });
  }
  // Fold tiny piste/walk bits into the neighbouring steps.
  const clean = [];
  for (const s of steps) {
    if (s.w?.kind !== 'lift' && s.d < 60 && clean.length) { clean[clean.length - 1].d += s.d; continue; }
    if (!s.w && s.d < 25) continue;
    clean.push(s);
  }
  for (const s of clean) s.t = s.w ? s.d / s.w.speed + (s.w.kind === 'lift' ? LIFT_QUEUE : 0) : s.d / WALK_SPEED;
  return { line, steps: clean };
}

/* Route from me to the best place to catch the friend.
   A node is reachable "in time" if I get there before the friend passes (plus slack where people pause). */
function planMeet(net, me, pred) {
  if (!net || !me || !pred || !pred.cand.length) return null;
  const sources = startSources(net, me);
  if (!sources.length) return { error: 'Jesteś poza siecią tras – podejdź bliżej stoku lub wyciągu.' };
  const { dist, prev } = net.dijkstra(sources);
  let best = null, late = null;
  for (const c of pred.cand) {
    const myT = dist.get(c.node.id); if (myT == null) continue;
    const slack = c.hold ? Infinity : (c.slack || 30);
    const meetT = Math.max(myT, c.t);
    if (myT <= c.t + slack) { if (!best || meetT < best.meetT || (meetT === best.meetT && myT < best.myT)) best = { c, myT, meetT }; }
    else { const l = myT - c.t; if (!late || l < late.lateBy) late = { c, myT, meetT: myT, lateBy: l }; }
  }
  const pick = best || late;
  if (!pick) return { error: 'Nie znalazłem drogi po trasach do tego miejsca.' };
  const { line, steps } = buildRoute(net, me, prev, pick.c.node);
  return { node: pick.c.node, myT: pick.myT, friendT: pick.c.t, meetT: pick.meetT, inTime: !!best, lateBy: best ? 0 : pick.lateBy, steps, line };
}

/* Route from a person to a fixed point (meeting place, hut). The last bit off the network is walked. */
function routeToPoint(net, me, lat, lon) {
  if (!net || !me?.pos) return null;
  const direct = haversine([me.pos[0], me.pos[1]], [lat, lon]);
  if (direct < 60) return { here: true, myT: 0, steps: [], line: [[me.pos[0], me.pos[1]], [lat, lon]], dist: direct };
  const sources = startSources(net, me);
  const [x, y] = net.P(lat, lon);
  const ends = net.nearNodes(x, y, 400).filter(a => net.stop(a[0]));
  if (!sources.length || !ends.length) {
    // Off the network on both or either side: just walk.
    if (direct < 1500) return { myT: direct / WALK_SPEED, steps: [{ w: null, d: direct, t: direct / WALK_SPEED }], line: [[me.pos[0], me.pos[1]], [lat, lon]], dist: direct, walkOnly: true };
    return { error: !sources.length ? 'Jesteś poza siecią tras – podejdź bliżej stoku lub wyciągu.' : 'To miejsce jest daleko od tras i wyciągów.' };
  }
  const { dist, prev } = net.dijkstra(sources, 3 * 3600);
  let best = null;
  for (const [n, d] of ends) { const t = dist.get(n.id); if (t == null) continue; const tt = t + d / WALK_SPEED; if (!best || tt < best.t) best = { n, d, t: tt }; }
  if (!best) return { error: 'Nie znalazłem drogi po trasach do tego miejsca.' };
  const r = buildRoute(net, me, prev, best.n);
  if (best.d > 25) { r.steps.push({ w: null, d: best.d, t: best.d / WALK_SPEED }); r.line.push([lat, lon]); }
  return { myT: best.t, steps: r.steps, line: r.line, node: best.n, dist: direct };
}

/* Huts, bars and restaurants near the pistes. */
const POI_PL = { hut: 'schronisko', bar: 'bar', cafe: 'kawiarnia', food: 'restauracja' };
const POI_AT = { hut: 'w schronisku', bar: 'w barze', cafe: 'w kawiarni', food: 'w restauracji' };
async function fetchPois(bbox) {
  const [s, w, n, e] = bbox;
  const q = `[out:json][timeout:60];(nwr["amenity"~"^(restaurant|bar|cafe|pub|fast_food|biergarten)$"](${s},${w},${n},${e});nwr["tourism"~"^(alpine_hut|wilderness_hut)$"](${s},${w},${n},${e}););out center tags qt;`;
  let lastErr;
  for (const url of OVERPASS) {
    try {
      const r = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const out = [];
      for (const el of (await r.json()).elements || []) {
        const t = el.tags || {}, lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
        if (lat == null || !t.name) continue;
        let kind = { bar: 'bar', pub: 'bar', biergarten: 'bar', cafe: 'cafe' }[t.amenity] || 'food';
        if (/hut/.test(t.tourism || '') || /rifugio|malga|baita|hütte|hutte|schronisko|refuge|chalet|bait/i.test(t.name)) kind = 'hut';
        out.push([kind, t.name.slice(0, 50), +lat.toFixed(6), +lon.toFixed(6)]);
      }
      return out;
    } catch (err) { lastErr = err; }
  }
  throw lastErr || new Error('Overpass niedostępny');
}
SkiNet.prototype.setPois = function (list) {
  this.pois = [];
  for (const [kind, name, lat, lon] of list) {
    const [x, y] = this.P(lat, lon);
    if (this.distToNet(lat, lon, 350) > 300) continue;   // keep places by the slopes, not every pizzeria in town
    this.pois.push({ kind, name, lat, lon, x, y });
  }
};
SkiNet.prototype.nearPoi = function (lat, lon, r = 60) {
  if (!this.pois) return null;
  const [x, y] = this.P(lat, lon);
  let best = null;
  for (const p of this.pois) { const d = Math.hypot(p.x - x, p.y - y); if (d <= r && (!best || d < best.d)) best = { ...p, d }; }
  return best;
};

function kmh(ms) { return Math.round(ms * 3.6) + ' km/h'; }
function fmtMin(s) { if (s < 60) return '<1 min'; const m = Math.round(s / 60); return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`; }
function fmtDist(d) { return d < 1000 ? `${Math.round(d / 10) * 10} m` : `${(d / 1000).toFixed(1).replace('.', ',')} km`; }
