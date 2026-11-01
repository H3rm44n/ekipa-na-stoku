'use strict';
/* Day stats (km on pistes vs lifts, vertical drop, runs, top speed), the group ranking and today's track. */

const MAX_SPEED = 36;        // m/s (~130 km/h): anything above is a GPS glitch
const STAT_ACC = 30;         // m, fixes worse than this don't count towards distance
const SPEED_ACC = 20;        // m, ... or towards top speed

function dayStats() {
  if (!S.day.st) S.day.st = { skiM: 0, liftM: 0, vertM: 0, runs: 0, maxV: 0, maxAt: 0 };
  return S.day.st;
}
const ST = { last: null, lastV: null, altAnchor: null, liftSince: 0, wasLift: false };

function statsOnPos(p, now) {
  if (S.me?.demo) return;                       // demo position is set by hand
  const st = dayStats();
  const state = S.myPred?.state;
  const onLift = state === 'lift';
  // A finished lift ride (longer than a minute) means one more run down.
  if (onLift && !ST.wasLift) ST.liftSince = now;
  if (!onLift && ST.wasLift && now - ST.liftSince > 60e3) st.runs++;
  ST.wasLift = onLift;

  const acc = p[3] ?? 999, last = ST.last;
  if (last && acc <= STAT_ACC && last.acc <= STAT_ACC && S.gpsMode !== 'idle' && S.gpsMode !== 'saver') {
    const d = haversine(last.ll, p), dt = (now - last.t) / 1000;
    if (dt > 0 && d > 2 && d / dt < MAX_SPEED) {
      if (onLift) st.liftM += d;
      else if (S.act === 'ski' && (state === 'piste' || state === 'move')) {
        st.skiM += d;
        // Vertical drop with a 3 m dead band so GPS altitude noise doesn't add up.
        if (p[2] != null) {
          if (ST.altAnchor == null || p[2] > ST.altAnchor) ST.altAnchor = p[2];
          else if (ST.altAnchor - p[2] >= 3) { st.vertM += ST.altAnchor - p[2]; ST.altAnchor = p[2]; }
        }
      }
    }
    // Top speed: Doppler speed from the GPS chip, only on the slope, only with a good fix, no impossible jumps.
    let v = p[4] != null && p[4] >= 0 ? p[4] : (dt >= 2 ? d / dt : null);
    if (v != null && !onLift && S.act === 'ski' && acc <= SPEED_ACC && v < MAX_SPEED) {
      if (ST.lastV != null && Math.abs(v - ST.lastV) < 10 && v > st.maxV) { st.maxV = v; st.maxAt = now; }
      ST.lastV = v;
    }
  }
  if (onLift) ST.altAnchor = null;
  ST.last = { ll: [p[0], p[1]], t: now, acc };
  LS.set('ek.day', S.day);
  trackPush(p, now);
}

/* ---------- today's track ---------- */
// Point: [lat, lon, alt, time, mode, speed*10]; mode l = lift, s = skiing, o = other (standing, walking, hut).
let dayTrack = LS.get('ek.track', null);
const prevDay = { track: dayTrack, st: LS.get('ek.day', null) };   // yesterday's track goes to the history (history.js)
if (!dayTrack || dayTrack.date !== todayKey()) dayTrack = { date: todayKey(), pts: [] };
let trackDirty = 0;
function trackMode() {
  const state = S.myPred?.state;
  if (state === 'lift') return 'l';
  return S.act === 'ski' && (state === 'piste' || state === 'move') ? 's' : 'o';
}
function trackPush(p, now) {
  if (dayTrack.date !== todayKey()) { if (typeof archiveDay === 'function') archiveDay(dayTrack, { ...dayStats() }); dayTrack = { date: todayKey(), pts: [] }; }
  if ((p[3] ?? 999) > 50) return;
  const last = dayTrack.pts[dayTrack.pts.length - 1], mode = trackMode();
  if (last && last[4] === mode && haversine(last, p) < 15 && now - last[3] < 60e3) return;
  const v = p[4] != null && p[4] >= 0 && p[4] < MAX_SPEED ? Math.round(p[4] * 10) : null;
  dayTrack.pts.push([+p[0].toFixed(6), +p[1].toFixed(6), p[2] == null ? null : Math.round(p[2]), now, mode, v]);
  if (dayTrack.pts.length > 12000) dayTrack.pts.splice(0, 1000);
  if (++trackDirty >= 10) { trackDirty = 0; saveTrack(); }
}
function saveTrack() { LS.set('ek.track', dayTrack); if (typeof saveToday === 'function') saveToday(); }
window.addEventListener('pagehide', saveTrack);
document.addEventListener('visibilitychange', () => { if (document.hidden) saveTrack(); });

async function exportGpx(track = dayTrack) {
  if (track.pts.length < 2) { toast(t('t.noTrack')); return; }
  const pts = track.pts.map(p => `<trkpt lat="${p[0]}" lon="${p[1]}">${p[2] != null ? `<ele>${p[2]}</ele>` : ''}<time>${new Date(p[3]).toISOString()}</time></trkpt>`).join('');
  const gpx = `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="Ekipa na Stoku" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>Narty ${track.date}</name><trkseg>${pts}</trkseg></trk></gpx>`;
  const name = `narty-${track.date}.gpx`;
  const file = new File([gpx], name, { type: 'application/gpx+xml' });
  try { if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: name }); return; } } catch (e) { if (e?.name === 'AbortError') return; }
  const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = name; document.body.append(a); a.click(); a.remove();
}

/* ---------- sharing + display ---------- */
const km = m => fmt1(m / 1000);
HOOK.out.push(() => { const st = dayStats(); return { sd: S.day.date, st: [Math.round(st.skiM), Math.round(st.liftM), Math.round(st.vertM), st.runs, Math.round(st.maxV * 10)] }; });
HOOK.friend.push((f, m) => {
  if (m.sd === todayKey() && Array.isArray(m.st)) { const [a, b, c, d, e] = m.st.map(Number); f.st = { skiM: a, liftM: b, vertM: c, runs: d, maxV: e / 10 }; }
  else f.st = null;
});
HOOK.pos.push(statsOnPos);

function myDayCard() {
  const st = dayStats();
  const has = st.skiM + st.liftM > 0;
  return `<div class="card stats"><div class="card-h"><b>${t('s.myDay')}</b><span class="small">${has ? '' : t('s.fromFirst')}</span></div>
    <div class="nums">
      <div><b>${km(st.skiM)}</b><span>${t('s.skiKm')}</span></div>
      <div><b>${km(st.liftM)}</b><span>${t('s.liftKm')}</span></div>
      <div><b>${st.maxV ? Math.round(st.maxV * 3.6) : '–'}</b><span>${t('s.maxKmh')}</span></div>
      <div><b>${st.runs}</b><span>${t('s.runs')}</span></div>
    </div>
    <div class="small">${t('s.vertTotal', { v: fmt0(st.vertM), k: km(st.skiM + st.liftM) })}</div>
    <div class="actions"><button class="btn sm primary" data-act="day" data-d="${todayKey()}">${t('s.dayView')}</button><button class="btn sm" data-act="days">${t('s.days')}</button></div></div>`;
}

HOOK.rank = () => {
  const me = { id: 'me', name: t('r.you', { name: displayName(S.me) }), color: S.me.color, st: dayStats() };
  const rows = [me, ...visibleFriends().filter(f => f.st)];
  if (rows.length < 2 && !(me.st.skiM + me.st.liftM)) return myDayCard() + `<div class="empty">${t('r.empty')}</div>`;
  const leader = key => rows.reduce((a, b) => (b.st[key] > (a?.st[key] || 0) ? b : a), null);
  const kmL = leader('skiM'), vL = leader('maxV'), vertL = leader('vertM');
  rows.sort((a, b) => b.st.skiM - a.st.skiM);
  const badge = (txt, who) => who && who.st ? `<div class="lead"><span>${txt}</span><b style="color:${who.color}">${esc(who.name)}</b></div>` : '';
  return myDayCard() + `<div class="leads">${badge(t('r.mostKm'), kmL)}${badge(t('r.fastest'), vL)}${badge(t('r.mostVert'), vertL)}</div>
  <div class="tablewrap"><table class="rank"><thead><tr><th></th><th>${t('r.who')}</th><th>${t('r.runsKm')}</th><th>${t('r.liftsKm')}</th><th>${t('r.max')}</th><th>${t('r.count')}</th></tr></thead><tbody>
  ${rows.map((r, i) => `<tr${r.id === 'me' ? ' class="me"' : ''}><td>${i + 1}</td><td><span class="dotc" style="background:${r.color}"></span>${esc(r.name)}</td><td>${km(r.st.skiM)} km</td><td>${km(r.st.liftM)} km</td><td>${r.st.maxV ? Math.round(r.st.maxV * 3.6) + ' km/h' : '–'}</td><td>${r.st.runs}</td></tr>`).join('')}
  </tbody></table></div><p class="note">${t('r.note')}</p>`;
};
