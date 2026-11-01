'use strict';
/* Meetings with RSVP + guidance, SOS, hiding, huts on the map, notifications. */

const hhmm = t => new Date(t).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });

/* ---------- notifications ---------- */
const Notif = NATIVE ? window.Capacitor.registerPlugin('LocalNotifications') : null;
let notifAsked = false, notifId = 1;
async function askNotifications() {
  if (notifAsked) return; notifAsked = true;
  try { if (Notif) await Notif.requestPermissions(); else if ('Notification' in window && Notification.permission === 'default') await Notification.requestPermission(); } catch {}
}
// Toast when the app is open; a system notification when it is in the background.
function notify(title, body, important) {
  if (!document.hidden) { toast(`${title}: ${body}`); if (important && navigator.vibrate) navigator.vibrate([200, 100, 200]); return; }
  try {
    if (Notif) Notif.schedule({ notifications: [{ id: notifId++, title, body, sound: important ? 'default' : undefined }] });
    else if ('Notification' in window && Notification.permission === 'granted') new Notification(title, { body });
  } catch {}
}

/* ---------- meetings ---------- */
S.meets = new Map();                       // id -> {id, by, n, lat, lon, place, at, note, t}
S.resp = LS.get('ek.resp', {});            // my answers: meetId -> 'y' | 'n'
S.nav = null;                              // {lat, lon, label, at?, meetId?}
const seenMeets = new Set(LS.get('ek.seenMeets', []));

HOOK.topic.m = async (id, payload) => {
  if (!payload || payload.length === 0) {
    const had = S.meets.get(id); S.meets.delete(id);
    if (had && had.by !== S.me.id) notify('Spotkanie odwołane', had.place);
    if (S.nav?.meetId === id) stopNav();
    tick(true); return;
  }
  let m; try { m = await unseal(new Uint8Array(payload)); } catch { return; }
  if (!m || m.id !== id || typeof m.lat !== 'number') return;
  if (Date.now() > m.at + 2 * 3600e3) return;          // stale invitation
  const isNew = !S.meets.has(id);
  S.meets.set(id, m);
  if (isNew && m.by !== S.me.id && !seenMeets.has(id)) {
    seenMeets.add(id); LS.set('ek.seenMeets', [...seenMeets].slice(-50));
    notify(m.k === 'z' ? `${m.n} zwołuje zbiórkę` : `${m.n} zaprasza na spotkanie`, `${m.place} o ${hhmm(m.at)}`, true);
    S.sheetOpen = true;
  }
  tick(true);
};
HOOK.out.push(() => {
  const mr = {};
  for (const [id, v] of Object.entries(S.resp)) if (S.meets.has(id)) mr[id] = v;
  return { mr };
});
HOOK.friend.push((f, m) => { f.mr = m.mr && typeof m.mr === 'object' ? m.mr : {}; });

// k: 'z' = zbiórka (gather the whole crew now), otherwise a planned meeting.
async function createMeet(lat, lon, place, at, note, k) {
  const id = Math.random().toString(36).slice(2, 10);
  const m = { id, by: S.me.id, n: displayName(S.me), lat: +lat.toFixed(6), lon: +lon.toFixed(6), place: place.slice(0, 60), at, note: (note || '').slice(0, 100), t: Date.now(), k: k === 'z' ? 'z' : undefined };
  S.meets.set(id, m);
  S.resp[id] = 'y'; LS.set('ek.resp', S.resp);
  await pubTopic('m', id, m, true);
  publish(true);
  startNav({ lat: m.lat, lon: m.lon, label: m.place, at, meetId: id });
  toast(k === 'z' ? 'Zwołano zbiórkę' : 'Wysłano zaproszenie do ekipy');
}
function answer(id, v) {
  S.resp[id] = v; LS.set('ek.resp', S.resp); publish(true);
  const m = S.meets.get(id);
  if (v === 'y' && m) startNav({ lat: m.lat, lon: m.lon, label: m.place, at: m.at, meetId: id });
  if (v === 'n' && S.nav?.meetId === id) stopNav();
  tick(true);
}

/* ---------- guidance to a point ---------- */
const navLayer = L.layerGroup().addTo(map);
let navRoute = null, navAt = 0, arrivedFor = null;
function startNav(target) { S.nav = target; navAt = 0; arrivedFor = null; S.selected = null; S.sheetOpen = true; updateNav(true); fitNav(); tick(true); }
function stopNav() { S.nav = null; navRoute = null; navLayer.clearLayers(); tick(true); }
function fitNav() {
  if (!S.nav) return;
  const pts = [[S.nav.lat, S.nav.lon]];
  if (navRoute?.line) pts.push(...navRoute.line); else if (S.myPos) pts.push([S.myPos[0], S.myPos[1]]);
  S.follow = false;
  map.fitBounds(pts, { paddingTopLeft: [40, 80], paddingBottomRight: [40, sheetH() + 40], maxZoom: 16 });
}
// Following a friend: the target moves, so re-plan the interception every few seconds.
function updateFriendNav() {
  const f = S.friends.get(S.nav.friendId);
  if (!f) { navRoute = { error: 'Ta osoba zniknęła z mapy (ukryła się albo straciła zasięg).' }; return; }
  S.nav.lat = f.pos[0]; S.nav.lon = f.pos[1]; S.nav.label = f.name;
  if (!S.myPos || !S.net) { navRoute = null; return; }
  const dist = haversine([S.myPos[0], S.myPos[1]], [f.pos[0], f.pos[1]]);
  if (dist < 60) { navRoute = { here: true, dist, friend: f }; }
  else {
    const plan = planMeet(S.net, { pos: S.myPos, track: S.myTrack }, S.preds.get(f.id));
    if (plan && !plan.error) navRoute = { ...plan, dist, friend: f };
    else { const r = routeToPoint(S.net, { pos: S.myPos, track: S.myTrack }, f.pos[0], f.pos[1]); navRoute = r ? { ...r, dist, friend: f, direct: true } : null; }
  }
  if (navRoute?.here && arrivedFor !== S.nav) { arrivedFor = S.nav; notify(`Jesteś przy: ${f.name}`, 'Dojechałeś do znajomego'); }
  if (navRoute?.node && !navRoute.direct) navLayer.addLayer(L.marker([navRoute.node.lat, navRoute.node.lon], { icon: L.divIcon({ className: '', html: '<div class="meet"></div>', iconSize: [30, 30] }), interactive: false, zIndexOffset: 800 }));
}
function updateNav(force) {
  if (!S.nav || (!force && Date.now() - navAt < 5000)) return;
  navAt = Date.now();
  navLayer.clearLayers();
  if (S.nav.friendId) { updateFriendNav(); drawNavLine(); return; }
  navLayer.addLayer(L.marker([S.nav.lat, S.nav.lon], { icon: L.divIcon({ className: '', html: `<div class="flag"><span>${S.nav.at ? hhmm(S.nav.at) : 'cel'}</span></div>`, iconSize: [12, 40], iconAnchor: [2, 40] }), interactive: false, zIndexOffset: 850 }));
  if (!S.myPos || !S.net) { navRoute = null; return; }
  navRoute = routeToPoint(S.net, { pos: S.myPos, track: S.myTrack }, S.nav.lat, S.nav.lon);
  if (navRoute?.here && arrivedFor !== S.nav) { arrivedFor = S.nav; notify('Jesteś na miejscu', S.nav.label); }
  drawNavLine();
}
function drawNavLine() {
  if (navRoute?.line && !navRoute.here) {
    navLayer.addLayer(L.polyline(navRoute.line, { renderer, color: '#fff', weight: 10, opacity: 0.9, interactive: false }));
    navLayer.addLayer(L.polyline(navRoute.line, { renderer, color: '#ff6b00', weight: 6, opacity: 1, interactive: false }));
  }
}
HOOK.tick.push(force => { updateNav(force); drawMeets(); drawSos(); });

function stepsHtml(steps) {
  return steps.map(s => { const b = wayBadge(s.w); return `<li><span class="pb ${b.cls}">${esc(b.txt)}</span><span>${s.w ? esc(s.w.kind === 'lift' ? 'Wjedź: ' + wayLabel(s.w) : 'Zjedź: ' + wayLabel(s.w)) : 'Przejdź / przejedź'}</span><span class="meta">${fmtDist(s.d)} · ${fmtMin(s.t)}</span></li>`; }).join('');
}
function navCard() {
  if (!S.nav) return '';
  const r = navRoute, n = S.nav;
  if (n.friendId) return friendNavCard(r, n);
  let body;
  if (!S.myPos) body = '<p class="small">Czekam na Twoją pozycję GPS…</p>';
  else if (!r) body = '<p class="small">Liczę drogę…</p>';
  else if (r.error) body = `<p class="small">${esc(r.error)}</p>`;
  else if (r.here) body = '<div class="big">Jesteś na miejscu</div>';
  else {
    const arrive = Date.now() + r.myT * 1000;
    const slack = n.at ? Math.round((n.at - arrive) / 60000) : null;
    const when = n.at ? (slack >= 0 ? `zdążysz, zapas ${slack} min` : `spóźnisz się ok. ${-slack} min`) : '';
    body = `<div class="big">${fmtMin(r.myT)} · ${fmtDist(r.dist)}</div><div class="small">Będziesz ok. ${hhmm(arrive)}${when ? ' · ' + when : ''}</div><ol class="steps">${stepsHtml(r.steps)}</ol>`;
  }
  return `<div class="card nav"><div class="card-h"><b>Prowadzę do: ${esc(n.label)}</b><button class="close" data-act="navstop" aria-label="Zakończ prowadzenie">×</button></div>${body}
    <div class="actions"><button class="btn sm" data-act="navfit">Pokaż na mapie</button><button class="btn sm danger" data-act="navstop">Zakończ prowadzenie</button></div></div>`;
}
function friendNavCard(r, n) {
  const f = S.friends.get(n.friendId), name = esc(n.label);
  let body;
  if (!S.myPos) body = '<p class="small">Czekam na Twoją pozycję GPS…</p>';
  else if (!r) body = '<p class="small">Liczę drogę…</p>';
  else if (r.error) body = `<p class="small">${esc(r.error)}</p>`;
  else if (r.here) body = `<div class="big">Jesteś przy: ${name}</div>`;
  else {
    const where = r.node && !r.direct ? nodeLabel(r.node) : '';
    const head = r.direct ? `Dojazd ${fmtMin(r.myT)}`
      : r.inTime ? (r.friendT < 30 ? `${name} stoi · dojedziesz za ${fmtMin(r.myT)}` : `Spotkanie${where ? ' przy: ' + esc(where) : ''} za ${fmtMin(r.meetT)}`)
      : `Spóźnisz się ok. ${fmtMin(r.lateBy)}${where ? ' · miejsce: ' + esc(where) : ''}`;
    const sub = (r.via ? `Jeśli pojedzie: <b>${esc(wayLabel(r.via))}</b> · ` : '') + `Teraz ${fmtDist(r.dist)} od Ciebie · ${esc(S.preds.get(n.friendId)?.text || '')}`;
    const late = !r.direct && !r.inTime ? `<div class="actions"><button class="btn sm primary" data-act="qmsend" data-x="${name}, poczekaj na mnie!">Poproś, żeby poczekał(a)</button></div>` : '';
    body = `<div class="big">${head}</div><div class="small">${sub}</div><ol class="steps">${stepsHtml(r.steps || [])}</ol>${late}`;
  }
  return `<div class="card nav"><div class="card-h"><span style="display:flex;align-items:center;gap:8px">${f ? `<span class="dotc" style="background:${f.color}"></span>` : ''}<b>Prowadzę do: ${name}</b></span><button class="close" data-act="navstop" aria-label="Zakończ prowadzenie">×</button></div>${body}
    <div class="actions"><button class="btn sm" data-act="navfit">Pokaż na mapie</button><button class="btn sm danger" data-act="navstop">Zakończ prowadzenie</button></div><span class="small">Trasa odświeża się, gdy ${name} się przemieszcza.</span></div>`;
}
function startFriendNav(id) { const f = S.friends.get(id); if (f) startNav({ friendId: id, label: f.name, lat: f.pos[0], lon: f.pos[1] }); }
// "Dokąd jechać?": a person, a hut, a lift's bottom station or its top. In "zbiórka" mode the chosen
// place becomes a gathering for the whole crew instead of guidance just for me.
let pickOpen = false, pickTab = 'friend', pickMode = 'me', pickQ = '';
HOOK.act.navpick = () => { pickOpen = !pickOpen; tick(true); };
HOOK.act.pickclose = () => { pickOpen = false; tick(true); };
HOOK.act.picktab = el => { pickTab = el.dataset.t; pickQ = ''; tick(true); };
HOOK.act.pickmode = el => { pickMode = el.dataset.m; tick(true); };
HOOK.act.navfriend = el => {
  pickOpen = false;
  const f = S.friends.get(el.dataset.id);
  if (pickMode === 'gather' && f) { pickMode = 'me'; openMeetForm(f.pos[0], f.pos[1], placeName(f.pos[0], f.pos[1]) || 'przy: ' + f.name, 'z'); return; }
  startFriendNav(el.dataset.id);
};
HOOK.act.navto = el => {
  pickOpen = false;
  const lat = +el.dataset.lat, lon = +el.dataset.lon, name = el.dataset.name;
  if (pickMode === 'gather') { pickMode = 'me'; openMeetForm(lat, lon, name, 'z'); return; }
  startNav({ lat, lon, label: name });
};
function pickRef() { return S.myPos ? [S.myPos[0], S.myPos[1]] : [map.getCenter().lat, map.getCenter().lng]; }
function pickPlaces() {
  const ref = pickRef(), out = [];
  if (pickTab === 'hut') for (const p of S.net?.pois || []) { if (p.kind === 'hut' || p.kind === 'food') out.push({ name: p.name, sub: POI_PL[p.kind], lat: p.lat, lon: p.lon }); }
  else if (S.net) {
    const seen = new Set();
    for (const w of S.net.ways) {
      if (w.kind !== 'lift' || w.len < 150) continue;
      const n = pickTab === 'top' ? w.pts[w.pts.length - 1] : w.pts[0], name = wayLabel(w);
      if (seen.has(name + pickTab)) continue; seen.add(name + pickTab);
      out.push({ name: (pickTab === 'top' ? 'Góra: ' : 'Dół: ') + name, sub: liftKind(w) + ' · jazda ' + fmtMin(w.len / w.speed), lat: n.lat, lon: n.lon });
    }
  }
  const q = pickQ.trim().toLowerCase();
  return out.filter(p => !q || p.name.toLowerCase().includes(q)).map(p => ({ ...p, d: haversine(ref, [p.lat, p.lon]) })).sort((a, b) => a.d - b.d).slice(0, 30);
}
document.addEventListener('input', e => { if (e.target.id === 'pickQ') { pickQ = e.target.value; const box = $('#pickList'); if (box) box.innerHTML = pickListHtml(); } });
function pickListHtml() {
  if (pickTab === 'friend') {
    const fr = visibleFriends().filter(f => f.id !== S.nav?.friendId).sort((a, b) => (distTo(a) ?? 1e9) - (distTo(b) ?? 1e9));
    if (!fr.length) return '<p class="small">Nikogo jeszcze nie widać na mapie.</p>';
    return fr.map(f => { const d = distTo(f); return `<button class="pick" data-act="navfriend" data-id="${esc(f.id)}"><span class="av sm" style="background:${f.color};color:${f.color}"><span style="color:#fff">${esc(initials(f.name))}</span></span><span class="pn"><b>${esc(f.name)}</b><span>${esc(S.preds.get(f.id)?.text || '')}</span></span><span class="pd">${d != null ? fmtDist(d) : ''}</span></button>`; }).join('');
  }
  const list = pickPlaces();
  if (!list.length) return `<p class="small">${pickTab === 'hut' && !S.net?.pois ? 'Wczytuję schroniska…' : 'Nic nie znaleziono.'}</p>`;
  const glyph = pickTab === 'hut' ? 'S' : pickTab === 'top' ? '▲' : '▼';
  return list.map(p => `<button class="pick" data-act="navto" data-lat="${p.lat}" data-lon="${p.lon}" data-name="${esc(p.name)}"><span class="picon ${pickTab}">${glyph}</span><span class="pn"><b>${esc(p.name)}</b><span>${esc(p.sub)}</span></span><span class="pd">${fmtDist(p.d)}</span></button>`).join('');
}
function pickCard() {
  if (!pickOpen) return '';
  const tabs = [['friend', 'Osoba'], ['hut', 'Schronisko'], ['lift', 'Wyciąg'], ['top', 'Szczyt']];
  return `<div class="card pickcard"><div class="card-h"><b>${pickMode === 'gather' ? 'Gdzie zbiórka?' : 'Dokąd jechać?'}</b><button class="close" data-act="pickclose" aria-label="Zamknij">×</button></div>
    <div class="seg"><button data-act="pickmode" data-m="me" class="${pickMode === 'me' ? 'on' : ''}">Prowadź mnie</button><button data-act="pickmode" data-m="gather" class="${pickMode === 'gather' ? 'on' : ''}">Zbiórka ekipy</button></div>
    <div class="seg small4">${tabs.map(([k, l]) => `<button data-act="picktab" data-t="${k}" class="${pickTab === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    ${pickTab !== 'friend' ? `<input type="search" id="pickQ" placeholder="Szukaj po nazwie" value="${esc(pickQ)}" autocomplete="off">` : ''}
    ${pickMode === 'gather' ? '<p class="small">Wybierz miejsce – cała ekipa dostanie wezwanie i trasę dojazdu.</p>' : ''}
    <div class="picks" id="pickList">${pickListHtml()}</div></div>`;
}
HOOK.act.navstop = stopNav;
HOOK.act.navfit = fitNav;

function meetCards() {
  const now = Date.now();
  return [...S.meets.values()].filter(m => now < m.at + 45 * 60e3).sort((a, b) => a.at - b.at).map(m => {
    const mine = m.by === S.me.id, my = S.resp[m.id], z = m.k === 'z';
    const people = visibleFriends().map(f => {
      const v = f.mr?.[m.id] || (f.id === m.by ? 'y' : null);
      const here = f.pos && haversine([f.pos[0], f.pos[1]], [m.lat, m.lon]) < 80;
      let eta = '';
      if (here) eta = ' · na miejscu ✓';
      else if (v === 'y' && S.net && f.pos) { const r = routeToPoint(S.net, { pos: f.pos, track: f.track }, m.lat, m.lon); if (r && !r.error) eta = r.here ? ' · na miejscu ✓' : ` · ${fmtMin(r.myT)}`; }
      return `<span class="who ${v === 'y' || here ? 'yes' : v === 'n' ? 'no' : ''}" style="--c:${f.color}">${esc(f.name)}${here ? eta : v === 'y' ? (z ? ' jedzie' : ' będzie') + eta : v === 'n' ? ' nie da rady' : ' ?'}</span>`;
    }).join('');
    const mins = Math.round((m.at - now) / 60000);
    return `<div class="card meet${z ? ' gather' : ''}"><div class="card-h"><b>${z ? 'Zbiórka' : 'Spotkanie'} ${hhmm(m.at)}</b><span class="small">${mins > 0 ? `za ${fmtMin(mins * 60)}` : 'teraz'}</span></div>
      <div class="big">${esc(m.place)}</div><div class="small">${mine ? (z ? 'Twoja zbiórka' : 'Twoje zaproszenie') : (z ? 'zwołuje ' : 'od ') + esc(m.n)}${m.note ? ' · ' + esc(m.note) : ''}</div>
      <div class="whos">${people || '<span class="small">Czekam na odpowiedzi ekipy</span>'}</div>
      <div class="actions">
        ${mine ? '' : `<button class="btn sm ${my === 'y' ? 'primary' : ''}" data-act="ans" data-id="${m.id}" data-v="y">${z ? 'Jadę' : 'Będę'}</button><button class="btn sm ${my === 'n' ? 'dark' : ''}" data-act="ans" data-id="${m.id}" data-v="n">Nie dam rady</button>`}
        <button class="btn sm" data-act="meetnav" data-id="${m.id}">Prowadź</button>
        ${mine || isAdmin() ? `<button class="btn sm danger" data-act="meetcancel" data-id="${m.id}">Odwołaj</button>` : ''}
      </div></div>`;
  }).join('');
}
HOOK.act.ans = el => answer(el.dataset.id, el.dataset.v);
HOOK.act.meetnav = el => { const m = S.meets.get(el.dataset.id); if (m) startNav({ lat: m.lat, lon: m.lon, label: m.place, at: m.at, meetId: m.id }); };
HOOK.act.meetcancel = el => {
  if (el.dataset.confirm) { const id = el.dataset.id; S.meets.delete(id); pubTopic('m', id, null, true); if (S.nav?.meetId === id) stopNav(); tick(true); toast('Spotkanie odwołane'); return; }
  el.dataset.confirm = '1'; el.textContent = 'Na pewno?';
};

const meetLayer = L.layerGroup().addTo(map);
function drawMeets() {
  meetLayer.clearLayers();
  for (const m of S.meets.values()) {
    if (S.nav?.meetId === m.id || Date.now() > m.at + 45 * 60e3) continue;
    meetLayer.addLayer(L.marker([m.lat, m.lon], { icon: L.divIcon({ className: '', html: `<div class="flag"><span>${hhmm(m.at)}</span></div>`, iconSize: [12, 40], iconAnchor: [2, 40] }), zIndexOffset: 840 })
      .on('click', () => { S.sheetOpen = true; S.selected = null; tick(true); }));
  }
}

/* Meeting form */
function openMeetForm(lat, lon, place, kind) {
  const f = $('#meetForm'), z = kind === 'z';
  $('#mfPlace').value = place || '';
  $('#mfNote').value = '';
  $('#mfTitle').textContent = z ? 'Zbiórka' : 'Spotkanie';
  $('#mfSub').textContent = z ? 'Cała ekipa dostanie wezwanie i trasę dojazdu' : 'Ekipa dostanie zaproszenie i trasę dojazdu';
  let at = Date.now() + (z ? 15 : 30) * 60e3;
  const setAt = t => { at = t; const d = new Date(t); $('#mfTime').value = `${String(d.getHours()).padStart(2, '0')}:${String(Math.round(d.getMinutes() / 5) * 5 % 60).padStart(2, '0')}`; };
  setAt(at);
  f.querySelectorAll('[data-plus]').forEach(b => { b.onclick = () => setAt(Date.now() + +b.dataset.plus * 60e3); });
  $('#mfTime').onchange = () => { const [h, mi] = $('#mfTime').value.split(':').map(Number); const d = new Date(); d.setHours(h, mi, 0, 0); if (d < Date.now() - 10 * 60e3) d.setDate(d.getDate() + 1); at = +d; };
  $('#meet').hidden = false;
  f.onsubmit = e => {
    e.preventDefault();
    const place = $('#mfPlace').value.trim() || 'Punkt na mapie';
    $('#meet').hidden = true;
    createMeet(lat, lon, place, at, $('#mfNote').value.trim(), kind);
  };
}
$('#meet').addEventListener('click', e => { if (e.target.id === 'meet' || e.target.closest('[data-close]')) $('#meet').hidden = true; });

// Name a spot: hut nearby, else lift station / piste.
function placeName(lat, lon) {
  const poi = S.net?.nearPoi(lat, lon, 80);
  if (poi) return poi.name;
  if (!S.net) return '';
  const [x, y] = S.net.P(lat, lon);
  const nn = S.net.nearNodes(x, y, 120).filter(a => S.net.stop(a[0])).sort((a, b) => a[1] - b[1])[0];
  return nn ? nodeLabel(nn[0]) : '';
}

/* ---------- map: long-press menu + huts ---------- */
const popActions = (lat, lon, name) => `<div class="popact" data-lat="${lat}" data-lon="${lon}" data-name="${esc(name)}">
  <button class="btn sm primary" data-pop="nav">Prowadź tutaj</button><button class="btn sm" data-pop="gather">Zbiórka tutaj</button><button class="btn sm" data-pop="meet">Spotkanie</button>
  ${S.me?.demo ? '<button class="btn sm" data-pop="here">Tu jestem (demo)</button>' : ''}</div>`;
HOOK.longpress = ll => {
  const name = placeName(ll.lat, ll.lng);
  L.popup({ className: 'ekpop' }).setLatLng(ll).setContent(`<b>${esc(name || 'Punkt na mapie')}</b>${popActions(ll.lat, ll.lng, name)}`).openOn(map);
};
document.addEventListener('click', e => {
  const b = e.target.closest('[data-pop]'); if (!b) return;
  const box = b.closest('.popact'), lat = +box.dataset.lat, lon = +box.dataset.lon, name = box.dataset.name;
  map.closePopup();
  if (b.dataset.pop === 'meet') openMeetForm(lat, lon, name);
  else if (b.dataset.pop === 'gather') openMeetForm(lat, lon, name, 'z');
  else if (b.dataset.pop === 'nav') startNav({ lat, lon, label: name || 'punkt na mapie' });
  else if (b.dataset.pop === 'here') { setMyPos([lat, lon, null, 5, 0, null], true); toast('Ustawiono Twoją pozycję (demo)'); }
});

const poiLayer = L.layerGroup(), poiTownLayer = L.layerGroup();   // huts from zoom 13, bars/restaurants from 15
const POI_GLYPH = { hut: 'S', bar: 'B', cafe: 'K', food: 'R' };
function drawPois() {
  poiLayer.clearLayers(); poiTownLayer.clearLayers();
  for (const p of S.net?.pois || []) {
    (p.kind === 'hut' ? poiLayer : poiTownLayer).addLayer(L.marker([p.lat, p.lon], { icon: L.divIcon({ className: '', html: `<div class="poi ${p.kind}" title="${esc(p.name)}">${POI_GLYPH[p.kind]}</div>`, iconSize: [22, 22] }), zIndexOffset: 100 })
      .bindPopup(`<b>${esc(p.name)}</b><br><span class="small">${POI_PL[p.kind]}</span>${popActions(p.lat, p.lon, p.name)}`, { className: 'ekpop' }));
  }
}
function syncPoiLayer() {
  const z = map.getZoom();
  for (const [layer, minZ] of [[poiLayer, 13], [poiTownLayer, 15]]) {
    if (z >= minZ && !map.hasLayer(layer)) layer.addTo(map); else if (z < minZ && map.hasLayer(layer)) map.removeLayer(layer);
  }
}
map.on('zoomend', syncPoiLayer);
let poiRetry = 0;
async function loadPois(force) {
  if (!S.net || !S.netMeta) return;
  const key = 'ek.poi2:' + S.netMeta.bbox.join(',');
  let list = !force && LS.get(key, null);
  if (!list) {
    try { list = await fetchPois(S.netMeta.bbox); LS.set(key, list); poiRetry = 0; }
    catch { if (poiRetry < 6) setTimeout(() => loadPois(force), 30e3 * 2 ** poiRetry++); return; }   // Overpass busy: try again later
  }
  S.net.setPois(list); drawPois(); syncPoiLayer(); tick(true);
}
HOOK.netReady.push(() => setTimeout(() => loadPois(), 0));

/* ---------- SOS ---------- */
S.sos = LS.get('ek.sos', 0);
if (S.sos && Date.now() - S.sos > 6 * 3600e3) S.sos = 0;
let sosConfirm = false;
HOOK.out.push(() => (S.sos ? { sos: S.sos } : {}));
HOOK.friend.push((f, m, prev) => {
  f.sos = m.sos && Date.now() - m.sos < 6 * 3600e3 ? m.sos : 0;
  if (f.sos && (!prev || prev.sos !== f.sos)) notify(`SOS: ${f.name} potrzebuje pomocy`, 'Otwórz aplikację, żeby zobaczyć, gdzie jest.', true);
});
function setSos(on) {
  S.sos = on ? Date.now() : 0; LS.set('ek.sos', S.sos); sosConfirm = false;
  if (on) { S.wakeUntil = Date.now() + 6 * 3600e3; if (S.me.share === false || (S.me.hideUntil || 0) > Date.now()) { S.me.share = true; S.me.hideUntil = 0; saveMe(); } }
  else S.wakeUntil = 0;
  setGpsMode(true); publish(true); tick(true);
}
HOOK.act.sos = () => { sosConfirm = true; tick(true); };
// The SOS button sits under the settings button; it opens the confirmation at the top of the list.
$('#btnSos').onclick = () => {
  if (!S.me) return;
  S.selected = null; S.view = null; S.tab = 'crew'; S.sheetOpen = true;
  if (!S.sos) sosConfirm = true;
  tick(true);
  const l = $('#sheetBody .list'); if (l) l.scrollTop = 0;
};
HOOK.tick.push(() => $('#btnSos').classList.toggle('on', !!S.sos || visibleFriends().some(f => f.sos)));
// "Prowadź" under SOS: the list of people to guide to, at the top of the sheet.
// While guiding it turns into "Zakończ"; a second tap on an open picker closes it.
$('#btnNav').onclick = () => {
  if (!S.me) return;
  if (S.nav) { stopNav(); toast('Prowadzenie zakończone'); return; }
  if (pickOpen && !S.view && !S.selected) { pickOpen = false; tick(true); return; }
  S.selected = null; S.view = null; S.tab = 'crew'; S.sheetOpen = true; pickOpen = true;
  tick(true);
  const l = $('#sheetBody .list'); if (l) l.scrollTop = 0;
};
HOOK.tick.push(() => {
  const b = $('#btnNav'), on = !!S.nav;
  b.classList.toggle('stop', on);
  b.lastChild.textContent = on ? 'Zakończ' : 'Prowadź';
  b.setAttribute('aria-label', on ? 'Zakończ prowadzenie' : 'Prowadź do…');
});
// Escape / back closes whatever is on top: a window, the status menu, the picker, a detail view.
function closeTop() {
  for (const id of ['#meet', '#chat', '#group', '#settings']) { const el = $(id); if (el && !el.hidden && !(id === '#settings' && !S.me)) { if (id === '#chat') closeChat(); else el.hidden = true; return true; } }
  if (!$('#stMenu').hidden) { $('#stMenu').hidden = true; renderStatusBtn(); return true; }
  if (map._popup && map.hasLayer(map._popup)) { map.closePopup(); return true; }
  if (pickOpen) { pickOpen = false; tick(true); return true; }
  if (S.view || S.selected) { deselect(); return true; }
  return false;
}
document.addEventListener('keydown', e => { if (e.key === 'Escape' && closeTop()) e.preventDefault(); });
HOOK.act.sosyes = () => setSos(true);
HOOK.act.sosno = () => { sosConfirm = false; tick(true); };
HOOK.act.sosoff = () => setSos(false);
HOOK.act.sosgo = el => startFriendNav(el.dataset.id);
function sosCards() {
  let h = '';
  if (S.sos) h += `<div class="card sos"><div class="card-h"><b>Wysłano SOS</b><span class="small">od ${hhmm(S.sos)}</span></div><p>Ekipa widzi Twoją pozycję i dostała alarm. Jeśli to poważne, dzwoń pod <b class="num">112</b>.</p><div class="actions"><button class="btn sm" data-act="sosoff">Odwołaj SOS</button></div></div>`;
  else if (sosConfirm) h += `<div class="card sos"><div class="card-h"><b>Wysłać alarm SOS do ekipy?</b></div><p>Wszyscy dostaną powiadomienie z Twoją dokładną pozycją.</p><div class="actions"><button class="btn sm sosbtn" data-act="sosyes">Wyślij SOS</button><button class="btn sm" data-act="sosno">Anuluj</button></div></div>`;
  for (const f of visibleFriends()) if (f.sos) {
    const d = distTo(f);
    h += `<div class="card sos"><div class="card-h"><b>SOS: ${esc(f.name)} potrzebuje pomocy</b><span class="small">${hhmm(f.sos)}</span></div><p>${d != null ? fmtDist(d) + ' od Ciebie · ' : ''}${esc(S.preds.get(f.id)?.text || '')}. Numer alarmowy: <b class="num">112</b>.</p><div class="actions"><button class="btn sm sosbtn" data-act="sosgo" data-id="${esc(f.id)}">Prowadź do: ${esc(f.name)}</button></div></div>`;
  }
  return h;
}
const sosLayer = L.layerGroup().addTo(map);
function drawSos() {
  sosLayer.clearLayers();
  for (const f of visibleFriends()) if (f.sos) sosLayer.addLayer(L.circleMarker([f.pos[0], f.pos[1]], { renderer, radius: 26, color: '#dc2626', weight: 4, fillColor: '#dc2626', fillOpacity: 0.15, interactive: false }));
}

/* ---------- hide for a while ---------- */
function hideFor(min) {
  S.me.hideUntil = min ? Date.now() + min * 60e3 : 0; saveMe();
  if (min) { clearMine(); toast(`Ukryto Cię do ${hhmm(S.me.hideUntil)}`); } else { publish(true); toast('Znowu widać Cię na mapie'); }
  tick(true);
}
HOOK.act.unhide = () => hideFor(0);
document.addEventListener('click', e => { const b = e.target.closest('[data-hide]'); if (b) { hideFor(+b.dataset.hide); $('#settings').hidden = true; } });
setInterval(() => { if (S.me?.hideUntil && Date.now() > S.me.hideUntil) { S.me.hideUntil = 0; saveMe(); publish(true); tick(true); } }, 30000);

/* ---------- friend nearby ---------- */
const nearSeen = {};
HOOK.friend.push(f => {
  const d = distTo(f);
  if (d == null || d > 100 || f.act !== 'ski' || S.act !== 'ski') return;
  if (Date.now() - (nearSeen[f.id] || 0) < 30 * 60e3) return;
  nearSeen[f.id] = Date.now();
  notify(`${f.name} jest obok`, `${fmtDist(d)} od Ciebie`);
});

/* ---------- cards above the list ---------- */
HOOK.top.unshift(() => {
  const hidden = (S.me?.hideUntil || 0) > Date.now();
  const bar = hidden ? `<div class="actbar"><span class="small">Jesteś ukryty na mapie znajomych</span><span class="grow"></span><button class="btn sm" data-act="unhide">Pokaż mnie</button></div>` : '';
  return sosCards() + pickCard() + navCard() + meetCards() + bar + chatPreview();
});

HOOK.netReady.push(askNotifications);

// Popups (long-press, huts) slide the map so they stay above the sheet and below the top bar.
map.on('popupopen', e => {
  const p = e.popup;
  p.options.autoPanPaddingTopLeft = L.point(20, 110);
  p.options.autoPanPaddingBottomRight = L.point(70, sheetH() + 20);
  if (p._adjustPan) p._adjustPan();
});
