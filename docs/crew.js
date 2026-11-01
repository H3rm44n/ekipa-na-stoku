'use strict';
/* Group chat, admins and members, invitations through the system share sheet. */

/* ---------- invitations ---------- */
const inviteUrl = () => `${WEB_URL}#g-${S.me.group}`;
const inviteText = () => t('inv.text', { code: S.me.group, url: inviteUrl() });
// iPhone app: the native share sheet (AirDrop, WhatsApp, Messenger, SMS…); browser: the Web Share sheet; else copy.
async function shareInvite() {
  const text = inviteText();
  try {
    if (NATIVE && window.Capacitor.isPluginAvailable?.('Share')) { await window.Capacitor.registerPlugin('Share').share({ title: t('app.title'), text, dialogTitle: t('inv.title') }); return; }
    if (navigator.share) { await navigator.share({ title: t('app.title'), text }); return; }
  } catch (e) { if (/abort|cancel/i.test(`${e?.name} ${e?.message}`)) return; }
  try { await navigator.clipboard.writeText(text); toast(t('t.copied')); }
  catch { toast(t('t.code', { code: S.me.group })); }
}
$('#btnCopy').onclick = shareInvite;
$('#btnCopy').textContent = t('inv.btn');
HOOK.act.invite = shareInvite;

/* ---------- chat ---------- */
// Everyone keeps today's own messages in one retained message (topic c/<id>); the app merges them.
const QUICK = [1, 2, 3, 4, 5, 6].map(i => t('q.' + i));
// Reporting and blocking (App Store rule for anything people write): blocked people's messages are hidden here,
// reports go to the group admins (retained topic r/<my id>) who can remove the person.
let blocked = new Set(LS.get('ek.blocked', []));
let hiddenMsgs = new Set(LS.get('ek.hiddenMsgs', []));
let myReports = LS.get('ek.reports', []);
S.reports = new Map();   // reporter id -> [{u, n, t, x}]
let chat = LS.get('ek.chat', null);
if (!chat || chat.date !== todayKey()) chat = { date: todayKey(), msgs: [] };
let chatRead = LS.get('ek.chatRead', 0);
const chatKey = m => m.u + ':' + m.t;
const chatKeys = new Set(chat.msgs.map(chatKey));
function chatRoll() { if (chat.date !== todayKey()) { chat = { date: todayKey(), msgs: [] }; chatKeys.clear(); } }
function chatAdd(m) {
  const k = chatKey(m);
  if (chatKeys.has(k)) return false;
  chatKeys.add(k); chat.msgs.push(m); chat.msgs.sort((a, b) => a.t - b.t);
  if (chat.msgs.length > 300) chat.msgs.splice(0, chat.msgs.length - 300);
  return true;
}
const chatOpen = () => !$('#chat').hidden;
const chatVisible = () => chat.msgs.filter(m => !blocked.has(m.u) && !hiddenMsgs.has(chatKey(m)));
function chatUnread() { return chatOpen() ? 0 : chatVisible().filter(m => m.u !== S.me?.id && m.t > chatRead).length; }

HOOK.topic.c = async (id, payload) => {
  if (!payload || payload.length === 0) return;
  let m; try { m = await unseal(new Uint8Array(payload)); } catch { return; }
  if (!m || m.id !== id || !Array.isArray(m.msgs) || m.d !== todayKey() || isKicked(id)) return;
  chatRoll();
  const fresh = [];
  for (const x of m.msgs.slice(-60)) {
    if (typeof x?.x !== 'string' || !isFinite(x.t)) continue;
    const msg = { u: id, n: String(m.n || '?').slice(0, 20), c: String(m.c || '#7b8fa3'), t: +x.t, x: x.x.slice(0, 300) };
    if (Array.isArray(x.l) && x.l.length === 2) msg.l = x.l.map(Number);
    if (chatAdd(msg)) fresh.push(msg);
  }
  if (!fresh.length) return;
  LS.set('ek.chat', chat);
  const last = fresh[fresh.length - 1];
  if (id !== S.me.id && !blocked.has(id) && !chatOpen() && Date.now() - last.t < 10 * 60e3) notify(last.n, last.x);
  if (chatOpen()) renderChat(); else tick(true);
};
async function sendChat(x, loc) {
  x = x.trim().slice(0, 300); if (!x || !G) return;
  chatRoll();
  const m = { u: S.me.id, n: displayName(S.me), c: S.me.color, t: Date.now(), x };
  if (loc) m.l = loc;
  chatAdd(m); LS.set('ek.chat', chat);
  const mine = chat.msgs.filter(v => v.u === S.me.id).slice(-40).map(v => (v.l ? { t: v.t, x: v.x, l: v.l } : { t: v.t, x: v.x }));
  await pubTopic('c', S.me.id, { id: S.me.id, n: displayName(S.me), c: S.me.color, d: todayKey(), msgs: mine }, true);
  if (chatOpen()) renderChat(); else { tick(true); toast(t('t.sent', { x })); }
}
function renderChat() {
  const list = $('#chatList');
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  if (!S.me.terms) { list.innerHTML = `<div class="box" style="margin:auto 0"><p class="small">${t('su.terms')}</p><div class="actions" style="margin-top:8px"><button class="btn primary" data-chatterms="1">${t('c.accept')}</button></div></div>`; return; }
  const msgs = chatVisible();
  list.innerHTML = msgs.length ? msgs.map(m => {
    const mine = m.u === S.me.id, k = chatKey(m);
    const loc = m.l ? ` <button class="btn sm" data-chatloc="${m.l.join(',')}" style="height:26px;margin-top:4px">${t('d.showMap')}</button>` : '';
    const more = mine ? '' : `<button class="msgmore" data-chatmenu="${esc(k)}" aria-label="${t('c.more')}">⋯</button>`;
    const menu = !mine && chatMenu === k ? `<div class="msgacts"><button class="btn sm" data-chatrep="${esc(k)}">${t('c.report')}</button><button class="btn sm danger" data-chatblock="${esc(m.u)}">${esc(t('c.block', { name: m.n }))}</button></div>` : '';
    return `<div class="msg${mine ? ' mine' : ''}">${more}${mine ? '' : `<span class="who" style="--c:${esc(m.c)}">${esc(m.n)}</span>`}<span class="tm">${hhmm(m.t)}</span><p>${esc(m.x)}</p>${loc}${menu}</div>`;
  }).join('') : `<div class="chatday">${t('c.empty')}</div>`;
  if (atBottom || !renderChat.done) list.scrollTop = list.scrollHeight;
  renderChat.done = true;
  chatRead = Date.now(); LS.set('ek.chatRead', chatRead);
}
let chatMenu = null;
async function reportMsg(k) {
  const m = chat.msgs.find(v => chatKey(v) === k); if (!m) return;
  hiddenMsgs.add(k); LS.set('ek.hiddenMsgs', [...hiddenMsgs].slice(-300));
  myReports.push({ u: m.u, n: m.n, t: m.t, x: m.x }); myReports = myReports.slice(-20); LS.set('ek.reports', myReports);
  await pubTopic('r', S.me.id, { id: S.me.id, n: displayName(S.me), list: myReports }, true);
  chatMenu = null; renderChat(); toast(t('t.reported'));
}
function blockUser(id) {
  const name = chat.msgs.find(m => m.u === id)?.n || S.friends.get(id)?.name || '?';
  blocked.add(id); LS.set('ek.blocked', [...blocked]); chatMenu = null; renderChat(); toast(t('t.blocked', { name }));
}
HOOK.topic.r = async (id, payload) => {
  if (!payload || payload.length === 0) { S.reports.delete(id); return; }
  let m; try { m = await unseal(new Uint8Array(payload)); } catch { return; }
  if (!m || m.id !== id || !Array.isArray(m.list)) return;
  S.reports.set(id, { n: String(m.n || '?').slice(0, 20), list: m.list.slice(-20).filter(r => typeof r?.x === 'string').map(r => ({ u: String(r.u), n: String(r.n || '?').slice(0, 20), t: +r.t, x: r.x.slice(0, 300) })) });
  if (!$('#group').hidden) renderGroup();
};
function openChat() {
  renderChat.done = false;
  $('#chatQuick').innerHTML = `<button type="button" class="btn sm" data-chatq="@loc">${t('q.loc')}</button>` + QUICK.map(q => `<button type="button" class="btn sm" data-chatq="${esc(q)}">${esc(q)}</button>`).join('');
  $('#chat').hidden = false;
  renderChat();
  if (!NATIVE) setTimeout(() => $('#chatText').focus(), 50);
}
function closeChat() { $('#chat').hidden = true; $('#chatText').blur(); tick(true); }
$('#chatForm').onsubmit = e => { e.preventDefault(); if (!S.me.terms) return; const v = $('#chatText').value; $('#chatText').value = ''; sendChat(v); };
$('#chat').addEventListener('click', e => {
  if (e.target.id === 'chat' || e.target.closest('[data-close]')) { closeChat(); return; }
  if (e.target.closest('[data-chatterms]')) { S.me.terms = Date.now(); saveMe(); renderChat(); return; }
  const mm = e.target.closest('[data-chatmenu]');
  if (mm) { chatMenu = chatMenu === mm.dataset.chatmenu ? null : mm.dataset.chatmenu; renderChat(); return; }
  const rp = e.target.closest('[data-chatrep]'); if (rp) { reportMsg(rp.dataset.chatrep); return; }
  const bl = e.target.closest('[data-chatblock]'); if (bl) { blockUser(bl.dataset.chatblock); return; }
  const q = e.target.closest('[data-chatq]');
  if (q) {
    if (q.dataset.chatq !== '@loc') { sendChat(q.dataset.chatq); return; }
    if (!S.myPos) { toast(t('t.noPos')); return; }
    const name = placeName(S.myPos[0], S.myPos[1]);
    sendChat(name ? t('c.iAmAt', { name }) : t('c.iAmHere'), [+S.myPos[0].toFixed(5), +S.myPos[1].toFixed(5)]);
    return;
  }
  const l = e.target.closest('[data-chatloc]');
  if (l) { const [lat, lon] = l.dataset.chatloc.split(',').map(Number); closeChat(); S.follow = false; map.setView([lat, lon], 16); L.popup({ className: 'ekpop' }).setLatLng([lat, lon]).setContent(`<b>${esc(placeName(lat, lon) || t('c.someone'))}</b>${popActions(lat, lon, placeName(lat, lon))}`).openOn(map); }
});
function chatPreview() {
  const vis = chatVisible(), last = vis[vis.length - 1];
  if (!last || Date.now() - last.t > 2 * 3600e3) return '';
  return `<div class="chatlast" data-act="chat"><b>${last.u === S.me.id ? t('c.you') : esc(last.n)}:</b> ${esc(last.x)} <span class="small">· ${agoTxt(last.t)}</span></div>`;
}
HOOK.act.chat = openChat;
$('#btnChat').onclick = () => { if (S.me) openChat(); };
HOOK.tick.push(() => { const n = chatUnread(), b = $('#chatBadge'); b.hidden = !n; b.textContent = n > 9 ? '9+' : n; });
HOOK.act.qmsend = el => sendChat(el.dataset.x);
HOOK.leave.push(() => { pubTopic('c', S.me.id, null, true); pubTopic('r', S.me.id, null, true); });

/* ---------- admins and members ---------- */
// Each phone has its own signing key. The group's admin list is a retained message signed by an admin;
// a change is accepted only when signed by someone who already was an admin, so others can't take over.
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const EC = { name: 'ECDSA', namedCurve: 'P-256' }, SIG = { name: 'ECDSA', hash: 'SHA-256' };
let myKeys = null;
async function loadKeys() {
  let k = LS.get('ek.keys', null);
  try {
    if (!k) {
      const kp = await crypto.subtle.generateKey(EC, true, ['sign', 'verify']);
      k = { priv: await crypto.subtle.exportKey('jwk', kp.privateKey), pub: b64(await crypto.subtle.exportKey('raw', kp.publicKey)) };
      LS.set('ek.keys', k);
    }
    myKeys = { priv: await crypto.subtle.importKey('jwk', k.priv, EC, false, ['sign']), pub: k.pub };
  } catch { myKeys = null; }
}
const metaBody = m => te.encode(JSON.stringify([m.v, m.name || '', m.admins.map(a => [a.id, a.pk]), m.kicked || [], m.t, m.by]));
async function verifyMeta(m, pk) {
  try { const key = await crypto.subtle.importKey('raw', unb64(pk), EC, false, ['verify']); return await crypto.subtle.verify(SIG, key, unb64(m.sig), metaBody(m)); }
  catch { return false; }
}
const metaKey = () => 'ek.meta:' + S.me.group;
S.meta = S.me ? LS.get(metaKey(), null) : null;
function isAdmin(id = S.me?.id) { return !!S.meta?.admins?.some(a => a.id === id && (id !== S.me.id || a.pk === myKeys?.pub)); }
function isKicked(id) { return !!S.meta?.kicked?.includes(id); }
const adminCount = () => S.meta?.admins?.length || 0;

async function acceptMeta(m) {
  if (!m || m.v !== 1 || !Array.isArray(m.admins) || !m.admins.length || typeof m.sig !== 'string') return false;
  const cur = S.meta;
  if (cur && m.t <= cur.t) return false;
  const signer = (cur ? cur.admins : m.admins).find(a => a.id === m.by);   // first time: trust the list it carries
  if (!signer || !await verifyMeta(m, signer.pk)) return false;
  S.meta = { v: 1, name: String(m.name || '').slice(0, 30), admins: m.admins.slice(0, 20), kicked: (m.kicked || []).slice(0, 100), t: m.t, by: m.by, sig: m.sig };
  LS.set(metaKey(), S.meta);
  return true;
}
HOOK.topic.g = async (id, payload) => {
  if (id !== 'meta' || !payload || payload.length === 0) return;
  let m; try { m = await unseal(new Uint8Array(payload)); } catch { return; }
  if (!await acceptMeta(m)) return;
  onMeta();
};
function onMeta() {
  if (isKicked(S.me.id)) { kickedOut(); return; }
  for (const id of S.meta.kicked) S.friends.delete(id);
  applyGroupName();
  if (!$('#group').hidden) renderGroup();
  tick(true);
}
async function updateMeta(fn) {
  if (!myKeys || !isAdmin()) { toast(t('t.onlyAdmin')); return; }
  const m = JSON.parse(JSON.stringify(S.meta));
  fn(m);
  m.t = Math.max(Date.now(), (S.meta?.t || 0) + 1); m.by = S.me.id;
  m.sig = b64(await crypto.subtle.sign(SIG, myKeys.priv, metaBody(m)));
  S.meta = m; LS.set(metaKey(), m);
  await pubTopic('g', 'meta', m, true);
  onMeta();
}
async function claimAdmin() {
  if (!myKeys) { toast(t('t.noSign')); return; }
  if (S.meta) { toast(t('t.hasAdmin')); return; }
  const m = { v: 1, name: '', admins: [{ id: S.me.id, pk: myKeys.pub }], kicked: [], t: Date.now(), by: S.me.id };
  m.sig = b64(await crypto.subtle.sign(SIG, myKeys.priv, metaBody(m)));
  S.meta = m; LS.set(metaKey(), m);
  await pubTopic('g', 'meta', m, true);
  toast(t('t.nowAdmin')); onMeta();
}
function kickedOut() {
  for (const h of HOOK.leave) try { h(); } catch {}
  clearMine();
  alert(t('a.kicked'));
  setTimeout(() => { disconnect(); LS.del('ek.me'); location.hash = ''; location.reload(); }, 300);
}
function applyGroupName() { $('.brand').innerHTML = `<i></i>${esc(S.meta?.name || t('brand'))}`; }

// My public key goes out with my position, so an admin can make me an admin too.
HOOK.out.push(() => (myKeys ? { pk: myKeys.pub } : {}));
HOOK.friend.push((f, m) => { f.pk = typeof m.pk === 'string' && m.pk.length < 200 ? m.pk : null; if (isKicked(f.id)) S.friends.delete(f.id); });

// After connecting: admins re-send the list in case a server lost it; a new group's founder becomes admin.
let metaTimer = null;
HOOK.netReady.push(() => {
  clearTimeout(metaTimer);
  metaTimer = setTimeout(() => {
    if (S.meta && isAdmin()) pubTopic('g', 'meta', S.meta, true);
    else if (!S.meta && S.me.founder) claimAdmin();
  }, 8000);
});

/* group panel */
function memberRows() {
  const me = { id: S.me.id, name: t('r.you', { name: displayName(S.me) }), full: fullName(S.me), color: S.me.color, t: Date.now() };
  const rows = [me, ...[...S.friends.values()].filter(f => !f.demo)];
  rows.sort((a, b) => isAdmin(b.id) - isAdmin(a.id) || b.t - a.t);
  const iAmAdmin = isAdmin();
  return rows.map(f => {
    const adm = isAdmin(f.id), self = f.id === S.me.id;
    let acts = '';
    if (iAmAdmin && !self) acts = `${adm ? `<button class="btn sm" data-g="demote" data-id="${esc(f.id)}">${t('g.demote')}</button>` : `<button class="btn sm" data-g="promote" data-id="${esc(f.id)}">${t('g.promote')}</button>`}<button class="btn sm danger" data-g="kick" data-id="${esc(f.id)}">${t('g.kick')}</button>`;
    else if (iAmAdmin && self && adminCount() > 1) acts = `<button class="btn sm" data-g="demote" data-id="${esc(f.id)}">${t('g.resign')}</button>`;
    return `<div class="mrow"><span class="av sm" style="background:${f.color};color:${f.color}"><span style="color:#fff">${esc(initials(f.name))}</span></span>
      <span class="pn"><b>${esc(f.name)}</b><span>${adm ? `<span class="role">${t('g.admin')}</span> · ` : t('g.member') + ' · '}${self ? t('g.now') : t('g.seen', { t: agoTxt(f.t) })}${f.full && f.full !== f.name ? ' · ' + esc(f.full) : ''}</span></span>
      <span class="acts">${acts}</span></div>`;
  }).join('');
}
function renderGroup() {
  const iAmAdmin = isAdmin();
  $('#grpTitle').textContent = S.meta?.name || t('g.title');
  $('#grpSub').textContent = t('g.code', { code: S.me.group });
  let adminBox;
  if (!S.meta) adminBox = `<div class="box"><h3>${t('g.admin')}</h3><p class="small">${t('g.noAdmin')}</p><div class="actions" style="margin-top:8px"><button class="btn primary" data-g="claim">${t('g.claim')}</button></div></div>`;
  else if (iAmAdmin) adminBox = `<div class="box"><h3>${t('g.name')}</h3><div class="rowflex"><input type="text" id="grpName" maxlength="30" value="${esc(S.meta.name || '')}" placeholder="${t('g.namePh')}"><button class="btn" data-g="rename">${t('g.save')}</button></div></div>`;
  else adminBox = `<p class="small">${t('g.admins', { list: esc(S.meta.admins.map(a => a.id === S.me.id ? t('c.you') : S.friends.get(a.id)?.name || t('g.outside')).join(', ')) })}</p>`;
  const kicked = iAmAdmin && S.meta?.kicked?.length ? `<div class="box"><h3>${t('g.kickedList')}</h3>${S.meta.kicked.map(id => `<div class="rowflex" style="align-items:center;justify-content:space-between"><span class="small">${esc(id.slice(0, 8))}…</span><button class="btn sm" data-g="unkick" data-id="${esc(id)}">${t('g.restore')}</button></div>`).join('')}</div>` : '';
  $('#grpBody').innerHTML = `<div class="actions" style="margin-bottom:10px"><button class="btn primary" data-g="invite">${t('g.invite')}</button></div>
    ${adminBox}<div class="box" style="margin-top:10px"><h3>${t('g.members')}</h3>${memberRows()}<p class="note" style="margin-top:6px">${t('g.membersNote')}</p></div>${kicked}${reportsBox()}${blockedBox()}`;
}
function reportsBox() {
  if (!isAdmin()) return '';
  const rows = [...S.reports.entries()].flatMap(([by, r]) => r.list.map(x => ({ ...x, by: r.n }))).filter(x => !isKicked(x.u)).sort((a, b) => b.t - a.t).slice(0, 20);
  if (!rows.length) return '';
  return `<div class="box"><h3>${t('g.reports')}</h3>${rows.map(x => `<div class="mrow" style="grid-template-columns:1fr auto"><span class="pn"><b>${esc(x.n)}: “${esc(x.x)}”</b><span>${hhmm(x.t)} · ${esc(t('g.reportBy', { name: x.by }))}</span></span><span class="acts">${S.friends.has(x.u) ? `<button class="btn sm danger" data-g="kick" data-id="${esc(x.u)}">${t('g.kick')}</button>` : ''}</span></div>`).join('')}</div>`;
}
function blockedBox() {
  if (!blocked.size) return '';
  return `<div class="box"><h3>${t('g.blocked')}</h3>${[...blocked].map(id => { const n = chat.msgs.find(m => m.u === id)?.n || S.friends.get(id)?.name || id.slice(0, 8); return `<div class="rowflex" style="align-items:center;justify-content:space-between"><span>${esc(n)}</span><button class="btn sm" data-g="unblock" data-id="${esc(id)}">${t('g.unblock')}</button></div>`; }).join('')}</div>`;
}
function openGroup() { $('#settings').hidden = true; renderGroup(); $('#group').hidden = false; }
HOOK.act.group = openGroup;
$('#group').addEventListener('click', async e => {
  if (e.target.id === 'group' || e.target.closest('[data-close]')) { $('#group').hidden = true; return; }
  const b = e.target.closest('[data-g]'); if (!b) return;
  const id = b.dataset.id, f = S.friends.get(id), g = b.dataset.g;
  if (g === 'invite') shareInvite();
  else if (g === 'claim') claimAdmin();
  else if (g === 'rename') updateMeta(m => { m.name = $('#grpName').value.trim().slice(0, 30); });
  else if (g === 'promote') {
    if (!f?.pk) { toast(t('t.mustUpdate', { name: f?.name || t('t.thisPerson') })); return; }
    updateMeta(m => { if (!m.admins.some(a => a.id === id)) m.admins.push({ id, pk: f.pk }); });
  } else if (g === 'demote') {
    if (adminCount() < 2) { toast(t('t.oneAdmin')); return; }
    updateMeta(m => { m.admins = m.admins.filter(a => a.id !== id); });
  } else if (g === 'kick') {
    if (!b.dataset.confirm) { b.dataset.confirm = '1'; b.textContent = t('m.sure'); return; }
    await updateMeta(m => { m.admins = m.admins.filter(a => a.id !== id); if (!m.kicked.includes(id)) m.kicked.push(id); });
    pubTopic('p', id, null, true); pubTopic('c', id, null, true);   // clear what the server keeps for them
    toast(t('t.removed', { name: f?.name || t('t.person') }));
  } else if (g === 'unkick') updateMeta(m => { m.kicked = m.kicked.filter(x => x !== id); });
  else if (g === 'unblock') { blocked.delete(id); LS.set('ek.blocked', [...blocked]); renderGroup(); tick(true); toast(t('t.unblocked', { name: chat.msgs.find(m => m.u === id)?.n || '' })); }
});
HOOK.listEnd = () => `<div class="actions" style="margin:8px 0 4px"><button class="btn sm" data-act="invite">${t('l.invite')}</button><button class="btn sm" data-act="group">${t('l.members')}${isAdmin() ? ' · ' + t('g.admin') : ''}</button></div>`;

loadKeys().then(() => { if (S.meta) applyGroupName(); });
$('#btnGroup').onclick = openGroup;
