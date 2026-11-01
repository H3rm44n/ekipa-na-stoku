'use strict';
/* Saved ski days: every day's track and stats in IndexedDB, a run-by-run breakdown
   (Ski Tracks style: runs, lifts, altitude profile, top speed) and the list of past days. */

/* ---------- storage ---------- */
const DayDB = {
  db: null,
  open() {
    if (this.db) return this.db;
    this.db = new Promise((ok, fail) => {
      const r = indexedDB.open('ekipa', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('days', { keyPath: 'date' });
      r.onsuccess = () => ok(r.result); r.onerror = () => fail(r.error);
    });
    return this.db;
  },
  async tx(mode, fn) {
    const db = await this.open();
    return new Promise((ok, fail) => { const t = db.transaction('days', mode), st = t.objectStore('days'), r = fn(st); t.oncomplete = () => ok(r?.result); t.onerror = () => fail(t.error); });
  },
  put(rec) { return this.tx('readwrite', st => st.put(rec)).catch(() => {}); },
  get(date) { return this.tx('readonly', st => st.get(date)).catch(() => null); },
  all() { return this.tx('readonly', st => st.getAll()).catch(() => []); },
  del(date) { return this.tx('readwrite', st => st.delete(date)).catch(() => {}); },
};
const dayKeyDate = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const dayTitle = k => { const s = dayKeyDate(k).toLocaleDateString(LANG, { weekday: 'long', day: 'numeric', month: 'long' }); return s[0].toUpperCase() + s.slice(1); };

let todaySavedAt = 0;
function saveToday(force) {
  if (!dayTrack.pts.length || (!force && Date.now() - todaySavedAt < 60e3)) return;
  todaySavedAt = Date.now();
  DayDB.put({ date: dayTrack.date, st: { ...dayStats() }, pts: dayTrack.pts });
}
function archiveDay(track, st) { if (track?.pts?.length > 1) DayDB.put({ date: track.date, st: st || null, pts: track.pts }); }
// A track left over from an earlier day (app closed overnight) goes to the history.
if (typeof prevDay !== 'undefined' && prevDay.track && prevDay.track.date !== todayKey()) archiveDay(prevDay.track, prevDay.st?.date === prevDay.track.date ? prevDay.st.st : null);
setInterval(() => saveToday(), 120e3);

/* ---------- run-by-run analysis ---------- */
// Older points have no mode: call it a lift when the altitude climbs steadily, skiing when moving.
function inferMode(pts, i) {
  const a = pts[Math.max(0, i - 2)], b = pts[Math.min(pts.length - 1, i + 2)];
  const dt = (b[3] - a[3]) / 1000;
  if (dt <= 0) return 'o';
  if (a[2] != null && b[2] != null && (b[2] - a[2]) / dt > 0.6) return 'l';
  return haversine(a, b) / dt > 2 ? 's' : 'o';
}
function wayNear(lat, lon, kinds, r = 50) {
  if (!S.net) return null;
  const [x, y] = S.net.P(lat, lon);
  let best = null, bd = r;
  for (const wi of S.net.nearWays(x, y, r)) {
    const w = S.net.ways[wi];
    if (!kinds.includes(w.kind)) continue;
    for (let i = 0; i < w.pts.length - 1; i++) {
      const a = w.pts[i], b = w.pts[i + 1], dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / L2));
      const d = Math.hypot(a.x + dx * t - x, a.y + dy * t - y);
      if (d < bd) { bd = d; best = w; }
    }
  }
  return best;
}
// Name a run or lift from the ways its points sit on (the most travelled first).
function segName(pts, kind) {
  const kinds = kind === 'l' ? ['lift'] : ['piste', 'conn'];
  const tally = new Map(), step = Math.max(1, Math.floor(pts.length / 12));
  for (let i = 0; i < pts.length; i += step) {
    const w = wayNear(pts[i][0], pts[i][1], kinds);
    if (w && w.kind !== 'conn' && (w.name || w.ref)) { const k = wayLabel(w); const e = tally.get(k) || { n: 0, first: i, w }; e.n++; tally.set(k, e); }
  }
  const top = [...tally.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, kind === 'l' ? 1 : 2).sort((a, b) => a[1].first - b[1].first);
  return { label: top.map(t => t[0]).join(' → '), w: top[0]?.[1].w || null };
}
function analyzeDay(pts) {
  if (!pts || pts.length < 2) return { segs: [], runs: 0 };
  const modes = pts.map((p, i) => p[4] || inferMode(pts, i));
  // Group into stretches of one mode.
  let raw = [];
  for (let i = 0; i < pts.length; i++) {
    const last = raw[raw.length - 1];
    if (last && last.m === modes[i] && pts[i][3] - pts[i - 1][3] < 15 * 60e3) last.e = i;
    else raw.push({ m: modes[i], s: i, e: i });
  }
  // A short stop in the middle of a run (waiting for someone, a fall) is still the same run.
  for (let i = 1; i < raw.length - 1; i++) {
    const r = raw[i];
    if (r.m === 'o' && raw[i - 1].m === 's' && raw[i + 1].m === 's' && pts[r.e][3] - pts[r.s][3] < 120e3) { raw[i - 1].e = raw[i + 1].e; raw.splice(i, 2); i--; }
  }
  const segs = [];
  let runNo = 0;
  for (const r of raw) {
    // Each stretch starts where the previous one ended, so the line has no gaps.
    const p = pts.slice(Math.max(0, r.s - (r.s ? 1 : 0)), r.e + 1);
    let dist = 0, maxV = 0, hi = -Infinity, lo = Infinity;
    for (let i = 0; i < p.length; i++) {
      if (i) {
        const d = haversine(p[i - 1], p[i]), dt = (p[i][3] - p[i - 1][3]) / 1000;
        dist += d;
        if (r.m === 's' && dt >= 3 && d / dt < MAX_SPEED) maxV = Math.max(maxV, d / dt);
      }
      if (r.m === 's' && p[i][5] != null) maxV = Math.max(maxV, Math.min(p[i][5] / 10, MAX_SPEED));
      if (p[i][2] != null) { hi = Math.max(hi, p[i][2]); lo = Math.min(lo, p[i][2]); }
    }
    const t0 = p[0][3], t1 = p[p.length - 1][3], hasAlt = hi > -Infinity;
    const drop = hasAlt && p[0][2] != null && p[p.length - 1][2] != null ? p[0][2] - p[p.length - 1][2] : null;
    let m = r.m;
    if (m === 's' && (dist < 150 || (drop != null && drop < 15))) m = 'o';   // a few metres of shuffling is not a run
    if (m === 'l' && dist < 150) m = 'o';
    const seg = { m, pts: p, t0, t1, dur: (t1 - t0) / 1000, dist, maxV, drop, hi: hasAlt ? hi : null, lo: hasAlt ? lo : null };
    if (m === 's') { seg.no = ++runNo; Object.assign(seg, segName(p, 's')); }
    if (m === 'l') Object.assign(seg, segName(p, 'l'));
    const prev = segs[segs.length - 1];
    if (prev && prev.m === m && m === 'o') { prev.pts.push(...p.slice(1)); prev.t1 = t1; prev.dur = (t1 - prev.t0) / 1000; prev.dist += dist; }
    else segs.push(seg);
  }
  const sum = k => segs.reduce((a, s) => a + s[k], 0);
  const runs = segs.filter(s => s.m === 's'), lifts = segs.filter(s => s.m === 'l');
  const alts = pts.map(p => p[2]).filter(a => a != null);
  return {
    segs, runs: runs.length,
    skiM: runs.reduce((a, s) => a + s.dist, 0), liftM: lifts.reduce((a, s) => a + s.dist, 0),
    vertM: runs.reduce((a, s) => a + Math.max(0, s.drop || 0), 0),
    maxV: Math.max(0, ...runs.map(s => s.maxV)),
    skiT: runs.reduce((a, s) => a + s.dur, 0), liftT: lifts.reduce((a, s) => a + s.dur, 0),
    longest: runs.reduce((a, s) => (!a || s.dist > a.dist ? s : a), null),
    hiAlt: alts.length ? Math.max(...alts) : null,
    start: pts[0][3], end: pts[pts.length - 1][3], total: sum('dur'),
  };
}

/* ---------- day view ---------- */
const dayCache = new Map();   // date -> {pts, st}
let dayStatsCache = { key: '', a: null };
async function openDay(date) {
  S.view = { kind: 'day', date, sel: null }; S.selected = null; S.sheetOpen = true;
  if (date !== todayKey() && !dayCache.has(date)) { const rec = await DayDB.get(date); dayCache.set(date, rec || { pts: [], st: null }); }
  tick(true); drawDay(true);
}
function dayData(date) {
  if (date === todayKey()) return { pts: dayTrack.pts, st: dayStats() };
  return dayCache.get(date) || { pts: [], st: null };
}
function dayAnalysis(date) {
  const d = dayData(date), key = date + ':' + d.pts.length;
  if (dayStatsCache.key !== key) dayStatsCache = { key, a: analyzeDay(d.pts) };
  return dayStatsCache.a;
}

const dayLayer = L.layerGroup().addTo(map);
const TRACK_COLOR = '#ff2d95';   // not a piste colour, so your runs stand out on any piste
function drawDay(fit) {
  dayLayer.clearLayers();
  if (S.view?.kind !== 'day') return;
  const a = dayAnalysis(S.view.date), sel = S.view.sel, color = TRACK_COLOR;
  const all = [];
  a.segs.forEach((s, i) => {
    const ll = s.pts.map(p => [p[0], p[1]]); all.push(...ll);
    const dim = sel != null && sel !== i, on = sel === i;
    if (s.m === 's') {
      dayLayer.addLayer(L.polyline(ll, { renderer, color: '#fff', weight: on ? 10 : 7, opacity: dim ? 0.3 : 0.9, interactive: false }));
      dayLayer.addLayer(L.polyline(ll, { renderer, color, weight: on ? 6 : 4, opacity: dim ? 0.3 : 1, interactive: false }));
      dayLayer.addLayer(L.marker(ll[0], { icon: L.divIcon({ className: '', html: `<div class="runno" style="--c:${color}">${s.no}</div>`, iconSize: [22, 22] }), zIndexOffset: on ? 960 : 950, opacity: dim ? 0.4 : 1 })
        .on('click', () => { S.view.sel = i; tick(true); drawDay(true); }));
    } else if (s.m === 'l') dayLayer.addLayer(L.polyline(ll, { renderer, color: LIFT_COLOR, weight: on ? 5 : 3, dashArray: '6 6', opacity: dim ? 0.3 : 0.95, interactive: false }));
    else dayLayer.addLayer(L.polyline(ll, { renderer, color: '#7b8fa3', weight: 2, dashArray: '2 6', opacity: dim ? 0.2 : 0.7, interactive: false }));
  });
  if (!all.length || !fit) return;
  S.follow = false;
  if (sel != null && a.segs[sel]) map.fitBounds(a.segs[sel].pts.map(p => [p[0], p[1]]), { paddingTopLeft: [40, 80], paddingBottomRight: [40, sheetH() + 30], maxZoom: 16 });
  else map.fitBounds(all, { paddingTopLeft: [30, 80], paddingBottomRight: [30, sheetH() + 30], maxZoom: 15 });
}

// Altitude over the day: runs in your colour, lifts in the lift colour, the rest grey.
function profileSvg(a) {
  const pts = a.segs.flatMap(s => s.pts.filter(p => p[2] != null).map(p => [p[3], p[2], s.m]));
  if (pts.length < 2) return '';
  const W = 320, H = 84, t0 = pts[0][0], t1 = pts[pts.length - 1][0] || t0 + 1;
  const lo = Math.min(...pts.map(p => p[1])), hi = Math.max(...pts.map(p => p[1])), span = Math.max(hi - lo, 50);
  const X = t => ((t - t0) / (t1 - t0 || 1)) * W, Y = h => H - 12 - ((h - lo) / span) * (H - 22);
  const col = { s: TRACK_COLOR, l: LIFT_COLOR, o: '#9aabbb' };
  let paths = '', cur = null, d = '';
  for (const [t, h, m] of pts) {
    if (m !== cur) { if (d) paths += `<path d="${d}" stroke="${col[cur]}" />`; d = `M${X(t).toFixed(1)},${Y(h).toFixed(1)}`; cur = m; }
    else d += `L${X(t).toFixed(1)},${Y(h).toFixed(1)}`;
  }
  if (d) paths += `<path d="${d}" stroke="${col[cur]}" />`;
  return `<svg class="prof" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${t('h.prof', { lo, hi })}">
    <g fill="none" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke">${paths}</g>
    <text x="2" y="10" font-size="10" fill="currentColor" opacity=".6">${hi} m</text><text x="2" y="${H - 1}" font-size="10" fill="currentColor" opacity=".6">${lo} m</text>
    <text x="${W - 2}" y="${H - 1}" font-size="10" fill="currentColor" opacity=".6" text-anchor="end">${hhmm(t0)}–${hhmm(t1)}</text></svg>`;
}

function dayViewHtml() {
  const date = S.view.date, today = date === todayKey(), d = dayData(date), a = dayAnalysis(date);
  // Live counters for today (they use the GPS speed); for saved days the stored ones, else the track.
  const st = d.st && (d.st.skiM || d.st.liftM) ? d.st : null;
  const skiM = st ? st.skiM : a.skiM, liftM = st ? st.liftM : a.liftM, maxV = Math.max(st?.maxV || 0, a.maxV), vert = st ? st.vertM : a.vertM;
  const head = `<div class="dhead daynav"><button class="close" data-act="dayprev" aria-label="${t('h.prev')}">‹</button>
    <div class="t"><b>${today ? t('h.today') : esc(dayTitle(date))}</b><span>${today ? esc(dayTitle(date)) : ''}${a.start ? `${today ? ' · ' : ''}${hhmm(a.start)}–${hhmm(a.end)}` : ''}</span></div>
    <button class="close" data-act="daynext" aria-label="${t('h.next')}"${today ? ' disabled' : ''}>›</button><button class="close" data-act="back" aria-label="${t('a.close')}">×</button></div>`;
  if (a.segs.length === 0) return `<div class="detail">${head}<div class="empty">${today ? t('h.emptyToday') : t('h.emptyDay')}</div>
    <div class="actions"><button class="btn" data-act="days">${t('s.days')}</button></div></div>`;
  const nums = `<div class="nums">
      <div><b>${km(skiM)}</b><span>${t('s.skiKm')}</span></div><div><b>${km(liftM)}</b><span>${t('s.liftKm')}</span></div>
      <div><b>${maxV ? Math.round(maxV * 3.6) : '–'}</b><span>${t('s.maxKmh')}</span></div><div><b>${a.runs}</b><span>${t('s.runs')}</span></div>
      <div><b>${fmt0(vert)}</b><span>${t('h.vert')}</span></div><div><b>${fmtHM(a.skiT)}</b><span>${t('h.skiT')}</span></div>
      <div><b>${fmtHM(a.liftT)}</b><span>${t('h.liftT')}</span></div><div><b>${a.hiAlt != null ? fmt0(a.hiAlt) : '–'}</b><span>${t('h.hiAlt')}</span></div></div>`;
  const sel = S.view.sel;
  const items = a.segs.map((s, i) => {
    const on = sel === i ? ' on' : '';
    if (s.m === 's') return `<li class="run${on}" data-act="seg" data-i="${i}"><span class="tm">${hhmm(s.t0)}</span>
      <span class="nm"><b>${t('h.run', { n: s.no })}${s.label ? ': ' + esc(s.label) : ''}</b><span>${fmtDist(s.dist)}${s.drop != null ? ' · ' + t('h.drop', { m: Math.round(s.drop) }) : ''} · ${fmtMin(s.dur)}</span></span>
      <span class="mx">${s.maxV ? Math.round(s.maxV * 3.6) + '<small> km/h</small>' : ''}</span></li>`;
    if (s.m === 'l') return `<li class="lift${on}" data-act="seg" data-i="${i}"><span class="tm">${hhmm(s.t0)}</span>
      <span class="nm"><b>${esc(s.label || t('h.lift'))}</b><span>${s.w ? esc(LIFT_PL[s.w.sub] || t('way.lift')) + ' · ' : ''}${fmtMin(s.dur)}${s.hi != null ? ' · ' + t('h.upTo', { m: s.hi }) : ''}</span></span><span class="mx"></span></li>`;
    return s.dur >= 300 ? `<li class="rest"><span class="tm">${hhmm(s.t0)}</span><span class="nm"><b>${esc(restName(s))}</b><span>${fmtMin(s.dur)}</span></span><span class="mx"></span></li>` : '';
  }).join('');
  const best = a.longest ? `<p class="small">${t('h.longest', { n: a.longest.no, d: fmtDist(a.longest.dist) })}</p>` : '';
  return `<div class="detail">${head}${nums}<div class="box">${profileSvg(a)}</div>${best}<ol class="tl">${items}</ol>
    <div class="actions"><button class="btn sm" data-act="dayall">${t('h.all')}</button><button class="btn sm" data-act="daygpx">${t('h.gpx')}</button><button class="btn sm" data-act="days">${t('s.days')}</button></div></div>`;
}
function restName(s) {
  const mid = s.pts[Math.floor(s.pts.length / 2)], poi = S.net?.nearPoi(mid[0], mid[1], 120);
  return poi ? t('h.breakAt', { name: poi.name }) : t('h.break');
}
function fmtHM(sec) { const m = Math.round(sec / 60); return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}` : `${m} min`; }

/* ---------- list of days ---------- */
let daysList = null;
async function openDays() {
  saveToday(true);
  S.view = { kind: 'days' }; S.selected = null; S.sheetOpen = true; dayLayer.clearLayers();
  tick(true);
  const recs = await DayDB.all();
  daysList = recs.filter(r => r.pts?.length > 1).map(r => {
    const a = analyzeDay(r.pts), st = r.st && (r.st.skiM || r.st.liftM) ? r.st : null;
    return { date: r.date, skiM: st ? st.skiM : a.skiM, vertM: st ? st.vertM : a.vertM, maxV: Math.max(st?.maxV || 0, a.maxV), runs: a.runs, skiT: a.skiT };
  }).sort((x, y) => dayKeyDate(y.date) - dayKeyDate(x.date));
  tick(true);
}
function daysViewHtml() {
  const head = `<div class="dhead"><div class="t"><b>${t('s.days')}</b><span>${t('h.listSub')}</span></div><button class="close" data-act="back" aria-label="${t('a.close')}">×</button></div>`;
  if (!daysList) return `<div class="detail">${head}<p class="small">${t('h.loading')}</p></div>`;
  if (!daysList.length) return `<div class="detail">${head}<div class="empty">${t('h.noDays')}</div></div>`;
  const tot = daysList.reduce((a, d) => ({ km: a.km + d.skiM, v: a.v + d.vertM, mx: Math.max(a.mx, d.maxV), runs: a.runs + d.runs }), { km: 0, v: 0, mx: 0, runs: 0 });
  return `<div class="detail">${head}
    <div class="box"><h3>${t('h.season')}</h3><div class="nums"><div><b>${daysList.length}</b><span>${t('h.days')}</span></div><div><b>${km(tot.km)}</b><span>${t('s.skiKm')}</span></div><div><b>${km(tot.v)}</b><span>${t('h.kmDown')}</span></div><div><b>${tot.mx ? Math.round(tot.mx * 3.6) : '–'}</b><span>${t('s.maxKmh')}</span></div></div></div>
    <div class="daylist">${daysList.map(d => `<button class="dayrow" data-act="day" data-d="${esc(d.date)}"><span><b>${d.date === todayKey() ? t('h.today') : esc(dayTitle(d.date))}</b><br><span>${t('h.row', { km: km(d.skiM), runs: d.runs, v: fmt0(d.vertM) })}</span></span><span class="mx">${d.maxV ? Math.round(d.maxV * 3.6) + ' km/h' : ''}</span></button>`).join('')}</div></div>`;
}

/* ---------- wiring ---------- */
HOOK.view = () => S.view?.kind === 'day' ? dayViewHtml() : S.view?.kind === 'days' ? daysViewHtml() : '';
HOOK.meClick = () => openDay(todayKey());
HOOK.act.day = el => openDay(el.dataset.d);
HOOK.act.days = openDays;
HOOK.act.seg = el => { const i = +el.dataset.i; S.view.sel = S.view.sel === i ? null : i; tick(true); drawDay(true); };
HOOK.act.dayall = () => { S.view.sel = null; tick(true); drawDay(true); };
HOOK.act.daygpx = () => exportGpx({ date: S.view.date, pts: dayData(S.view.date).pts });
async function stepDay(dir) {
  const recs = (await DayDB.all()).map(r => r.date);
  if (!recs.includes(todayKey())) recs.push(todayKey());
  recs.sort((a, b) => dayKeyDate(a) - dayKeyDate(b));
  const i = recs.indexOf(S.view.date), next = recs[i + dir];
  if (next) openDay(next); else toast(t(dir < 0 ? 'h.oldest' : 'h.last'));
}
HOOK.act.dayprev = () => stepDay(-1);
HOOK.act.daynext = () => stepDay(1);
// Today's view follows new points; leaving the view clears the drawing.
let dayDrawnLen = 0;
HOOK.tick.push(() => {
  if (S.view?.kind !== 'day') { if (dayLayer.getLayers().length) dayLayer.clearLayers(); return; }
  if (S.view.date === todayKey() && dayTrack.pts.length !== dayDrawnLen) { dayDrawnLen = dayTrack.pts.length; drawDay(); }
});
