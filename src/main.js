import './style.css';
import { configured, sb, loadState, api, subscribe } from './data.js';

/* ===================== Hilfsfunktionen ===================== */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const ds = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return ds(d); };
const diffDays = (a, b) => Math.round((parse(b) - parse(a)) / 86400000);
let TODAY = ds(new Date());
const fmtDate = s => parse(s).toLocaleDateString('de-DE', { day: 'numeric', month: 'short' });
const euro = n => (Math.round(n * 100) / 100).toLocaleString('de-DE', { style: 'currency', currency: 'EUR', minimumFractionDigits: n % 1 ? 2 : 0 });
const ago = ts => {
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return 'gerade eben'; if (m < 60) return `vor ${m} Min.`;
  const h = Math.floor(m / 60); if (h < 24) return `vor ${h} Std.`;
  const d = Math.floor(h / 24); return d === 1 ? 'gestern' : `vor ${d} Tagen`;
};
const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* egal */ } };

/* ===================== Zustand ===================== */
let S = null;            // geladene Daten (siehe data.js)
let session = null;      // Supabase-Session
let view = { name: 'home' };
let busy = false;
const openThreads = new Set();
let theme = lsGet('bf-theme') || 'system';

const U = id => S?.users.find(u => u.id === id) || { name: 'Jemand', color: '#A1A1AA', settings: {} };
const B = id => S.bets.find(b => b.id === id);
const av = (id, cls = '') => { const u = U(id); return `<span class="av ${cls}" style="background:${esc(u.color)}" title="${esc(u.name)}">${esc((u.name[0] || '?').toUpperCase())}</span>`; };
const pool = b => b.stake * b.participants.length;
// Einsatz 0 € = Wette nur zum Spaß bzw. nur für sich selbst
const perPerson = s => Number(s) > 0 ? `${euro(Number(s))} pro Person` : 'Ohne Einsatz';
const potBox = (s, n) => Number(s) > 0 ? `<div class="pool"><b>${euro(Number(s) * n)}</b><small>im Pott</small></div>` : '';
const isMine = b => b.participants.some(p => p.userId === S.me);
const names = ids => ids.map(id => esc(U(id).name)).join(', ');

/* ===================== Spielregeln ===================== */
// Challenge: jeder Tag von Start bis gestern (bzw. Ende) muss abgehakt sein.
// Verpasste Tage werden erst mit Jokern ausgeglichen, danach ist man raus.
// "dabei seit": ab wann die Challenge für diese Person zählt (Standard: Start der Wette).
// Tage bis "credit" stammen aus der Zeit vor der App und gelten als geschafft.
const pStart = (b, p) => p.since || b.start;
const done = (p, d) => !!p.checks[d] || (!!p.credit && d <= p.credit);
function pStatus(b, p) {
  const last = b.end && TODAY > b.end ? b.end : addDays(TODAY, -1);
  const start = pStart(b, p);
  let missed = 0;
  for (let d = start; d <= last; d = addDays(d, 1)) if (!done(p, d)) missed++;
  const out = missed > (b.jokers || 0);
  let streak = 0;
  for (let d = (done(p, TODAY) ? TODAY : addDays(TODAY, -1)); d >= start && done(p, d); d = addDays(d, -1)) streak++;
  return { missed, out, streak };
}
function betPhase(b) {
  if (b.type === 'tipp') return b.result != null ? 'done' : 'open';
  if (TODAY < b.start) return 'soon';
  if (!b.end) { // ohne Ende: läuft, bis nur noch einer übrig ist
    const alive = b.participants.filter(p => !pStatus(b, p).out).length;
    return (b.participants.length >= 2 && alive <= 1) || alive === 0 ? 'done' : 'running';
  }
  return TODAY > b.end ? 'done' : 'running';
}
function winners(b) {
  if (b.type === 'tipp') return b.result == null ? [] : b.participants.filter(p => p.pick === b.result).map(p => p.userId);
  return b.participants.filter(p => !pStatus(b, p).out).map(p => p.userId);
}
const totalDays = b => b.end ? diffDays(b.start, b.end) + 1 : null;
const dayIndex = b => { const n = Math.max(0, diffDays(b.start, TODAY) + 1); return b.end ? Math.min(totalDays(b), n) : n; };
const period = b => b.end ? (b.start === b.end ? fmtDate(b.start) : fmtDate(b.start) + ' – ' + fmtDate(b.end)) : (b.type === 'tipp' ? 'ohne festes Datum' : 'seit ' + fmtDate(b.start) + ' · ohne Enddatum');

/* ===================== Einstellungen ===================== */
const DEF_SET = { notifDaily: true, reminder: '20:00', notifComments: true, notifReacts: true, notifNewBets: true, weekly: false, defVis: 'friends', defStake: 10, defJokers: 1 };
const getSet = (id = S.me) => ({ ...DEF_SET, ...(U(id).settings || {}) });
const mq = window.matchMedia ? matchMedia('(prefers-color-scheme: dark)') : null;
function applyTheme() {
  const t = theme === 'system' ? (mq && mq.matches ? 'dark' : 'light') : theme;
  document.documentElement.dataset.theme = t;
  document.querySelectorAll('meta[name=theme-color]').forEach(m => m.setAttribute('content', t === 'dark' ? '#0E0E10' : '#F6F6F4'));
}
mq?.addEventListener?.('change', applyTheme);

/* ===================== Laden & Aktionen ===================== */
function toast(t) { const el = $('#toast'); el.textContent = t; el.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('show'), 2400); }

async function refresh() {
  if (!session) return;
  TODAY = ds(new Date());
  try { S = await loadState(session.user.id); render(); }
  catch (e) { console.error(e); toast('Laden fehlgeschlagen. Bist du online?'); }
}

// Führt eine Aktion aus, zeigt Fehler verständlich an und lädt danach neu
async function run(fn, okMsg) {
  if (busy) return; busy = true;
  try { const r = await fn(); if (okMsg) toast(okMsg); await refresh(); return r; }
  catch (e) { console.error(e); toast(niceError(e)); }
  finally { busy = false; }
}
function niceError(e) {
  const m = (e && (e.message || e.error_description)) || String(e);
  const map = [
    [/Invalid login credentials/i, 'E-Mail oder Passwort falsch'],
    [/already registered/i, 'Diese E-Mail ist schon registriert'],
    [/at least 6/i, 'Das Passwort braucht mindestens 6 Zeichen'],
    [/Email not confirmed/i, 'Bitte bestätige zuerst deine E-Mail (Link im Postfach)'],
    [/rate limit/i, 'Zu viele Versuche, bitte kurz warten'],
    [/Failed to fetch|NetworkError/i, 'Keine Verbindung. Bist du online?'],
    [/row-level security/i, 'Das darfst du hier leider nicht'],
  ];
  for (const [re, t] of map) if (re.test(m)) return t;
  return m;
}

function toggleCheck(betId) {
  const b = B(betId), p = b.participants.find(p => p.userId === S.me);
  if (!p) return;
  if (p.checks[TODAY]) {
    const f = S.feed.find(f => f.betId === betId && f.userId === S.me && f.kind === 'check' && ds(new Date(f.ts)) === TODAY);
    p.checks[TODAY] = false; render();
    run(() => api.uncheck(betId, S.me, TODAY, f?.id), 'Abhaken zurückgenommen');
  } else {
    p.checks[TODAY] = true; view.pop = betId; render(); view.pop = null;
    run(() => api.check(betId, S.me, TODAY), `Erledigt. ${pStatus(b, p).streak} Tage am Stück`);
  }
}
function checkAll() {
  const open = S.bets.filter(b => b.type === 'challenge' && betPhase(b) === 'running')
    .map(b => ({ b, p: b.participants.find(p => p.userId === S.me) }))
    .filter(x => x.p && !pStatus(x.b, x.p).out && !x.p.checks[TODAY]);
  if (!open.length) return;
  open.forEach(x => { x.p.checks[TODAY] = true; }); render();
  run(async () => { for (const x of open) await api.check(x.b.id, S.me, TODAY); }, `${open.length} Challenges abgehakt`);
}
function react(fid, emo) {
  const f = S.feed.find(x => x.id === fid); const on = !(f.reacts[emo] || []).includes(S.me);
  run(() => api.react(fid, S.me, emo, on));
}
function toggleThread(key) { openThreads.has(key) ? openThreads.delete(key) : openThreads.add(key); render(); if (openThreads.has(key)) document.getElementById('ci-' + key)?.focus(); }
async function addComment(ev, key) {
  ev.preventDefault();
  const input = ev.target.querySelector('input'), text = input.value.trim();
  if (!text) return;
  const [kind, id] = key.split(':');
  const betId = kind === 'f' ? S.feed.find(f => f.id === id).betId : id;
  openThreads.add(key);
  await run(() => api.comment(betId, kind === 'f' ? id : null, S.me, text));
  document.getElementById('ci-' + key)?.focus();
}
function delComment(cid) { run(() => api.deleteComment(cid)); }
function go(name, extra = {}) { view = { name, ...extra }; render(); window.scrollTo(0, 0); }
function copyCode(c) {
  const text = `Mach mit bei meiner Wette auf BetFriends! Code: ${c}\n${location.origin}/?code=${c}`;
  if (navigator.share) navigator.share({ title: 'BetFriends', text }).catch(() => {});
  else navigator.clipboard?.writeText(text).then(() => toast('Einladung kopiert'), () => toast('Code: ' + c));
}

/* ===================== Bausteine ===================== */
function commentList(key, list, opts = {}) {
  const open = opts.always || openThreads.has(key);
  const n = (list || []).length;
  if (!open) return '';
  return `<div class="comments" ${opts.always ? 'style="border:none;padding:0;margin:0"' : ''}>
    ${(list || []).map(c => `<div class="cmt">${av(c.userId, 'sm')}<div class="bubble"><b>${esc(U(c.userId).name)}</b>${esc(c.text)}
      <div class="when">${ago(c.ts)}${c.userId === S.me ? ` · <button class="cbtn" style="padding:0;margin:0;font-size:12px" onclick="delComment('${c.id}')">löschen</button>` : ''}</div></div></div>`).join('')}
    <form class="cform" onsubmit="addComment(event,'${key}')">
      <input class="in" id="ci-${key}" maxlength="280" placeholder="${n ? 'Antworten…' : 'Kommentar schreiben…'}" autocomplete="off">
      <button class="btn sm">Senden</button>
    </form>
  </div>`;
}

function betCard(b) {
  const ph = betPhase(b), mine = b.participants.find(p => p.userId === S.me);
  let progress = '', tags = [];
  if (b.type === 'challenge') {
    if (b.end) progress = `<div class="bar"><i style="width:${Math.round(dayIndex(b) / totalDays(b) * 100)}%"></i></div>`;
    tags.push(ph === 'done' ? `<span class="tag">Beendet</span>` : ph === 'soon' ? `<span class="tag">Startet ${fmtDate(b.start)}</span>` : b.end ? `<span class="tag">Tag ${dayIndex(b)} / ${totalDays(b)}</span>` : `<span class="tag acc">Tag ${dayIndex(b)} · ohne Ende</span>`);
    if (mine && ph !== 'soon') { const st = pStatus(b, mine); tags.push(st.out ? `<span class="tag bad">Ausgeschieden</span>` : `<span class="tag ok">${st.streak} Tage Serie</span>`); }
  } else {
    tags.push(ph === 'done' ? `<span class="tag">Aufgelöst</span>` : `<span class="tag acc">Tipp · ${!b.end ? 'offen' : b.end === TODAY ? 'heute' : fmtDate(b.end)}</span>`);
    if (ph === 'done' && mine) tags.push(mine.pick === b.result ? `<span class="tag ok">Gewonnen</span>` : `<span class="tag bad">Verloren</span>`);
  }
  const nc = (b.comments || []).length;
  if (nc) tags.push(`<span class="tag">💬 ${nc}</span>`);
  return `<div class="card betcard" onclick="go('bet',{id:'${b.id}'})">
    <div class="bettop"><div class="ico">${esc(b.emoji)}</div>
      <div><div class="bettitle">${esc(b.title)}</div><div class="sub">${perPerson(b.stake)}</div></div>
      ${potBox(b.stake, b.participants.length)}</div>
    ${progress}
    <div class="meta">${tags.join('')}<div class="faces">${b.participants.slice(0, 5).map(p => av(p.userId, 'sm')).join('')}</div></div>
  </div>`;
}

function feedText(f) {
  const b = B(f.betId), n = `<b>${esc(U(f.userId).name)}</b>`, t = b ? `<b>${esc(b.title)}</b>` : '';
  const p = b?.participants.find(p => p.userId === f.userId);
  switch (f.kind) {
    case 'new': return `${n} hat eine neue Wette gestartet: ${t}`;
    case 'join': return `${n} ist bei ${t} eingestiegen${p?.goal && !b.sameGoal ? ` mit dem Ziel „${esc(p.goal)}“` : ''}${p?.credit ? ` (schon seit ${fmtDate(p.since)} dabei)` : ''}`;
    case 'check': return `${n} hat heute abgehakt: ${esc(p?.goal || b?.title)} <span class="sub">· ${esc(b?.title)}</span>`;
    case 'joker': return `${n} hat einen Joker bei ${t} eingesetzt`;
    case 'result': return `Ergebnis bei ${t}: <b>${esc(b?.options?.[b.result])}</b>`;
    default: return '';
  }
}
function feedItem(f) {
  const key = 'f:' + f.id, nc = (f.comments || []).length;
  return `<div class="feeditem">${av(f.userId)}<div class="feedtext"><div class="t">${feedText(f)}</div><div class="when">${ago(f.ts)}</div>
    <div class="actions">${['🔥', '💪', '👏', '😂', '🤨'].map(e => { const a = f.reacts[e] || []; return `<button class="react ${a.includes(S.me) ? 'on' : ''}" onclick="react('${f.id}','${e}')">${e}${a.length ? ' ' + a.length : ''}</button>`; }).join('')}
      <button class="cbtn" onclick="toggleThread('${key}')">${nc ? `💬 ${nc} Kommentar${nc > 1 ? 'e' : ''}` : '💬 Kommentieren'}</button></div>
    ${commentList(key, f.comments)}
  </div></div>`;
}

/* ===================== Installieren-Hinweis ===================== */
let installEvt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; render(); });
const standalone = () => window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
function installHint() {
  if (standalone() || lsGet('bf-hide-install')) return '';
  if (!isIOS() && !installEvt) return '';
  return `<div class="card hint"><img src="/icons/icon-192.png" alt="">
    <div style="flex:1"><b style="font-weight:600">BetFriends als App installieren</b>
      <div class="sub" style="margin-top:2px">${isIOS() ? 'Tippe unten in Safari auf „Teilen“ und dann auf „Zum Home-Bildschirm“. Nur so bekommst du auf dem iPhone Benachrichtigungen.' : 'Mit einem Tippen auf dem Home-Bildschirm, wie eine normale App.'}</div>
      <div style="display:flex;gap:8px;margin-top:10px">${installEvt ? `<button class="btn sm" onclick="doInstall()">Installieren</button>` : ''}<button class="btn sec2 sm" onclick="localStorage.setItem('bf-hide-install','1');render()">Später</button></div>
    </div></div>`;
}
async function doInstall() { if (!installEvt) return; installEvt.prompt(); await installEvt.userChoice.catch(() => {}); installEvt = null; render(); }

/* ===================== Ansichten ===================== */
function viewHome() {
  const mine = S.bets.filter(isMine);
  const todos = mine.filter(b => b.type === 'challenge' && betPhase(b) === 'running').map(b => ({ b, p: b.participants.find(p => p.userId === S.me) })).filter(x => !pStatus(x.b, x.p).out);
  const active = mine.filter(b => betPhase(b) !== 'done'), done = mine.filter(b => betPhase(b) === 'done');
  const left = todos.filter(x => !x.p.checks[TODAY]).length;
  return `
  <h1>Hallo ${esc(U(S.me).name)}</h1>
  <div class="sub">${active.length} laufende Wette${active.length === 1 ? "" : "n"} · ${euro(active.reduce((s, b) => s + b.stake, 0))} Einsatz von dir</div>
  ${installHint()}
  ${myInvites().map(i => { const b = B(i.betId); return `<div class="card hint" style="align-items:center"><div class="ico">${esc(b.emoji)}</div>
    <div style="flex:1;min-width:0"><b style="font-weight:600">${esc(U(i.by).name)} lädt dich ein</b><div class="sub">${esc(b.title)} · ${Number(b.stake) > 0 ? euro(b.stake) : 'ohne Einsatz'}</div></div>
    <button class="btn sm" onclick="openInviteJoin('${b.code}')">Ansehen</button><button class="btn sec2 sm" aria-label="Ablehnen" onclick="declineInvite('${b.id}')">✕</button></div>`; }).join('')}
  ${todos.length ? `<div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
      <h2>Heute</h2><div style="display:flex;gap:6px;align-items:center">${left > 1 ? `<button class="btn sec2 sm" onclick="checkAll()">Alle abhaken</button>` : ''}<span class="tag ${left ? 'warn' : 'ok'}">${left ? left + ' offen' : 'Alles erledigt'}</span></div></div>
    ${todos.map(({ b, p }) => `<div class="todo">
      <button class="check ${p.checks[TODAY] ? 'on' : ''} ${view.pop === b.id ? 'pop' : ''}" onclick="toggleCheck('${b.id}')" aria-label="Abhaken">${p.checks[TODAY] ? '✓' : ''}</button>
      <div style="flex:1;cursor:pointer" onclick="go('bet',{id:'${b.id}'})"><div style="font-weight:500">${esc(p.goal)}</div><div class="sub">${esc(b.title)} · ${pStatus(b, p).streak} Tage Serie</div></div>
    </div>`).join('')}
  </div>` : ''}
  <div class="sec"><h2>Laufende Wetten</h2><span class="sub">${active.length}</span></div>
  ${active.length ? active.map(betCard).join('') : `<div class="card empty">Noch keine Wetten.<br><br>
     <div style="display:flex;gap:8px;justify-content:center"><button class="btn" onclick="go('create')">Wette starten</button><button class="btn sec2" onclick="go('join')">Code eingeben</button></div></div>`}
  ${done.length ? `<div class="sec"><h2>Abgeschlossen</h2></div>${done.map(betCard).join('')}` : ''}`;
}

function viewBet() {
  const b = B(view.id); if (!b) return viewHome();
  const ph = betPhase(b), me = b.participants.find(p => p.userId === S.me), w = winners(b);
  let body = '';
  if (b.type === 'challenge') {
    const first = b.participants.reduce((m, p) => pStart(b, p) < m ? pStart(b, p) : m, b.start);
    const days = [], until = b.end || (TODAY < b.start ? b.start : TODAY);
    for (let d = first; d <= until; d = addDays(d, 1)) days.push(d);
    const anyCredit = b.participants.some(p => p.credit);
    const shown = days.length > 60 ? days.slice(-60) : days;
    body = `<div class="sec"><h2>Teilnehmer</h2><span class="sub">${b.jokers ? b.jokers + ' Joker pro Person' : 'Keine Joker'}</span></div>
    <div class="card">${b.participants.map(p => { const st = pStatus(b, p); let used = 0;
      return `<div class="prow">${av(p.userId)}<div style="flex:1;min-width:0">
        <div style="display:flex;justify-content:space-between;gap:8px"><b style="font-weight:600">${esc(U(p.userId).name)}</b>
          ${ph === 'soon' ? '' : st.out ? `<span class="tag bad">Ausgeschieden</span>` : `<span class="tag ok">${st.streak} Tage</span>`}</div>
        <div class="sub">${esc(p.goal)}${p.credit ? ` · dabei seit ${fmtDate(pStart(b, p))}` : ''}</div>
        <div class="grid">${shown.map(d => { let c = '';
          if (d < pStart(b, p)) c = 'na';
          else if (!p.checks[d] && p.credit && d <= p.credit) c = 'ok pre';
          else if (d < TODAY) c = p.checks[d] ? 'ok' : (used++ < (b.jokers || 0) ? 'joker' : 'miss');
          else if (d === TODAY && p.checks[d]) c = 'ok';
          return `<span class="day ${c} ${d === TODAY ? 'today' : ''}" title="${fmtDate(d)}"></span>`; }).join('')}</div>
      </div></div>`; }).join('')}
      <div class="legend"><span style="--c:var(--ok)">geschafft</span><span style="--c:#F5B53F">Joker</span><span style="--c:var(--bad)">verpasst</span>${anyCredit ? '<span style="--c:var(--ok);opacity:.5">vor der App</span>' : ''}</div>
    </div>
    ${me && ph === 'running' && !pStatus(b, me).out ? `<button class="btn ${me.checks[TODAY] ? 'sec2' : ''} full" onclick="toggleCheck('${b.id}')">${me.checks[TODAY] ? '✓ Heute erledigt · rückgängig' : 'Heute geschafft'}</button>` : ''}
    ${!b.end && ph !== 'done' ? `<div class="note">Keine feste Dauer: Die Challenge läuft, bis nur noch einer übrig ist. Noch dabei: <b>${names(w)}</b>.</div>` : ''}
    ${ph === 'done' ? `<div class="card winbox"><b>${w.length ? names(w) + ' ' + (w.length === 1 ? 'hat' : 'haben') + (b.end ? ' durchgehalten' : ' am längsten durchgehalten') : 'Niemand hat durchgehalten'}</b>
      <div class="sub" style="margin-top:4px">${!b.stake ? (w.length ? 'Geschafft!' : 'Diesmal hat es nicht geklappt') : w.length ? `${euro(pool(b) / w.length)} pro Gewinner` : 'Alle bekommen ihren Einsatz zurück'}</div></div>` : ''}`;
  } else {
    body = `<div class="sec"><h2>Tipps</h2></div><div class="card" style="padding-top:8px">
      ${b.options.map((o, i) => { const ps = b.participants.filter(p => p.pick === i);
        return `<div class="opt ${b.result === i ? 'win' : me && me.pick === i ? 'on' : ''}"><span style="flex:1;font-weight:500">${esc(o)}${b.result === i ? ' · Ergebnis' : ''}</span>
        <span class="faces">${ps.map(p => av(p.userId, 'sm')).join('')}</span><span class="sub" style="min-width:14px;text-align:right">${ps.length}</span></div>`; }).join('')}
      ${ph === 'done' ? `<div class="note">${!b.stake ? (w.length ? `${names(w)} lag${w.length === 1 ? '' : 'en'} richtig.` : 'Niemand lag richtig.') : w.length ? `${names(w)} bekomm${w.length === 1 ? 't' : 'en'} je <b>${euro(pool(b) / w.length)}</b>.` : 'Niemand lag richtig, alle bekommen ihren Einsatz zurück.'}</div>` : ''}
    </div>
    ${me && me.pick == null && ph !== 'done' ? `<button class="btn acc full" onclick="openPick('${b.id}')">Tipp abgeben</button><div style="height:8px"></div>` : ''}
    ${ph !== 'done' && b.creator === S.me ? `<button class="btn full" onclick="openResolve('${b.id}')">Ergebnis eintragen</button>` : ''}
    ${ph !== 'done' && b.creator !== S.me ? `<div class="note">${esc(U(b.creator).name)} trägt das Ergebnis ein, sobald es feststeht.</div>` : ''}`;
  }
  const feed = S.feed.filter(f => f.betId === b.id && f.kind !== 'new').slice(0, 10);
  return `<button class="back" onclick="go('home')">← Zurück</button>
  <div class="card">
    <div class="bettop"><div class="ico">${esc(b.emoji)}</div>
      <div><div class="bettitle" style="font-size:18px">${esc(b.title)}</div>
      <div class="sub">von ${esc(U(b.creator).name)} · ${period(b)}</div></div></div>
    ${b.desc ? `<p style="margin-top:12px;color:var(--ink2)">${esc(b.desc)}</p>` : ''}
    <div class="row" style="margin-top:14px">
      ${b.stake > 0 ? `<div class="stat"><b>${euro(pool(b))}</b><span class="sub">im Pott</span></div>
      <div class="stat"><b>${euro(b.stake)}</b><span class="sub">Einsatz</span></div>` : `<div class="stat"><b>0 €</b><span class="sub">ohne Einsatz</span></div>`}
      <div class="stat"><b>${b.participants.length}</b><span class="sub">dabei</span></div>
    </div>
    ${ph !== 'done' ? `<div class="codebox"><div><div class="sub">Einladungscode</div><code>${esc(b.code)}</code></div><button class="btn sec2 sm" onclick="copyCode('${b.code}')">Link teilen</button></div>` : ''}
    ${ph !== 'done' && me && S.friends.length ? `<button class="btn sec2 full" style="margin-top:8px" onclick="openInvite('${b.id}')">Freunde einladen</button>` : ''}
    <div class="sub" style="margin-top:10px;display:flex;justify-content:space-between;align-items:center">
      <span>Sichtbar für: <b style="font-weight:500;color:var(--ink)">${visLabel(b)}</b></span>
      ${b.creator === S.me ? `<button class="linkbtn" onclick="openVisibility('${b.id}')">Ändern</button>` : ''}</div>
  </div>
  ${body}
  <div class="sec"><h2>Kommentare</h2><span class="sub">${(b.comments || []).length}</span></div>
  <div class="card">${(b.comments || []).length ? '' : '<div class="sub" style="margin-bottom:10px">Noch keine Kommentare. Sag was dazu.</div>'}${commentList('b:' + b.id, b.comments, { always: true })}</div>
  ${feed.length ? `<div class="sec"><h2>Aktivität</h2></div><div class="card">${feed.map(feedItem).join('')}</div>` : ''}
  <div class="note">Die App zeigt nur an, wer wie viel setzt. Bezahlt wird unter euch.</div>`;
}

/* ---------- Freunde & Sichtbarkeit ---------- */
const VIS = [['friends', 'Alle Freunde'], ['selected', 'Ausgewählte'], ['none', 'Nur Mitspieler']];
function visLabel(b) {
  if (b.visibility === 'none') return 'nur Mitspieler';
  if (b.visibility === 'selected') return b.creator === S.me ? (b.viewers.length ? names(b.viewers) : 'niemand ausgewählt') : 'ausgewählte Freunde';
  return 'alle Freunde';
}
// Auswahl "wer sieht die Wette"; target = 'draft' oder 'visEdit'
function visPicker(vis, viewers, target) {
  return `<div class="segctl">${VIS.map(([v, l]) => `<button class="${vis === v ? 'on' : ''}" onclick="${target}.vis='${v}';refreshPicker('${target}')">${l}</button>`).join('')}</div>
  <div class="sub" style="margin-top:6px">${vis === 'friends' ? 'Alle deine Freunde sehen die Wette im Community Board.' : vis === 'selected' ? 'Nur die angehakten Freunde sehen sie.' : 'Nur wer mitmacht (oder eingeladen ist) sieht die Wette.'}</div>
  ${vis === 'selected' ? (S.friends.length ? `<div class="setgroup" style="margin-top:8px">${S.friends.map(f => `<button class="setrow" onclick="toggleViewer('${target}','${f.userId}')">${av(f.userId, 'sm')}<div class="lbl">${esc(U(f.userId).name)}</div>${sw(viewers.includes(f.userId))}</button>`).join('')}</div>`
    : `<div class="note">Du hast noch keine Freunde. <button class="linkbtn" onclick="go('friends')">Freunde hinzufügen</button></div>`) : ''}`;
}
let visEdit = null;
function refreshPicker(target) { target === 'visEdit' ? openVisibility(visEdit.betId) : render(); }
function toggleViewer(target, id) {
  const o = target === 'draft' ? draft : visEdit;
  o.viewers = o.viewers.includes(id) ? o.viewers.filter(x => x !== id) : [...o.viewers, id];
  refreshPicker(target);
}
function openVisibility(betId) {
  const b = B(betId);
  if (!visEdit || visEdit.betId !== betId) visEdit = { betId, vis: b.visibility, viewers: [...b.viewers] };
  modal(`<h1>Wer sieht die Wette?</h1><div class="sub" style="margin-bottom:12px">${esc(b.title)}</div>${visPicker(visEdit.vis, visEdit.viewers, 'visEdit')}
    <div style="height:16px"></div><div class="row"><button class="btn sec2" onclick="visEdit=null;modal('')">Abbrechen</button><button class="btn" onclick="saveVisibility()">Speichern</button></div>`);
}
function saveVisibility() {
  const v = visEdit; if (v.vis === 'selected' && !v.viewers.length) return toast('Wähl mindestens einen Freund aus');
  visEdit = null; modal('');
  run(() => api.setVisibility(v.betId, v.vis, v.viewers), 'Sichtbarkeit gespeichert');
}
let inviteSel = [];
function openInvite(betId) {
  const b = B(betId);
  const taken = new Set([...b.participants.map(p => p.userId), ...S.invites.filter(i => i.betId === betId).map(i => i.userId)]);
  const list = S.friends.filter(f => !taken.has(f.userId));
  modal(`<h1>Freunde einladen</h1><div class="sub" style="margin-bottom:12px">${esc(b.title)}. Sie sehen die Einladung auf ihrer Startseite.</div>
    ${list.length ? `<div class="setgroup">${list.map(f => `<button class="setrow" onclick="inviteSel=inviteSel.includes('${f.userId}')?inviteSel.filter(x=>x!=='${f.userId}'):[...inviteSel,'${f.userId}'];openInvite('${betId}')">${av(f.userId, 'sm')}<div class="lbl">${esc(U(f.userId).name)}</div>${sw(inviteSel.includes(f.userId))}</button>`).join('')}</div>`
      : '<div class="note">Alle deine Freunde sind schon dabei oder eingeladen.</div>'}
    <div style="height:16px"></div><div class="row"><button class="btn sec2" onclick="inviteSel=[];modal('')">Abbrechen</button>${list.length ? `<button class="btn" onclick="sendInvites('${betId}')">Einladen${inviteSel.length ? ' (' + inviteSel.length + ')' : ''}</button>` : ''}</div>`);
}
function sendInvites(betId) {
  if (!inviteSel.length) return toast('Wähl mindestens einen Freund aus');
  const ids = inviteSel; inviteSel = []; modal('');
  run(() => api.invite(betId, ids), ids.length === 1 ? 'Einladung verschickt' : `${ids.length} Einladungen verschickt`);
}
const myInvites = () => S.invites.filter(i => i.userId === S.me && B(i.betId) && !isMine(B(i.betId)) && betPhase(B(i.betId)) !== 'done');
function declineInvite(betId) { run(() => api.declineInvite(betId, S.me), 'Einladung abgelehnt'); }
function openInviteJoin(code) { joinState.code = code; joinState.found = null; go('join'); lookup(code); }

let friendState = { code: '', found: null, looking: false, notFound: false };
function onFriendCode(v) {
  friendState.code = v.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  friendState.found = null; friendState.notFound = false;
  if (friendState.code.length === 6) lookupFriend(friendState.code);
  render();
  const i = document.querySelector('.friendin'); i.focus(); i.setSelectionRange(99, 99);
}
async function lookupFriend(code) {
  friendState.looking = true;
  try { const f = await api.findUser(code); if (friendState.code !== code) return; friendState.found = f; friendState.notFound = !f; }
  catch (e) { toast(niceError(e)); }
  finally { friendState.looking = false; render(); }
}
async function addFriend() {
  const r = await run(() => api.addFriend(friendState.code));
  if (!r) return;
  toast(r === 'friends' ? 'Ihr seid jetzt Freunde' : 'Anfrage verschickt');
  friendState = { code: '', found: null, looking: false, notFound: false }; render();
}
function acceptFriend(fid) { run(() => api.acceptFriend(fid), 'Ihr seid jetzt Freunde'); }
function removeFriendship(fid, msg) { modal(''); run(() => api.removeFriendship(fid), msg); }
function confirmRemove(fid, uid) {
  modal(`<h1>${esc(U(uid).name)} entfernen?</h1><div class="sub">Ihr seht dann gegenseitig nur noch Wetten, bei denen ihr beide mitmacht.</div><div style="height:16px"></div>
    <div class="row"><button class="btn sec2" onclick="modal('')">Abbrechen</button><button class="btn" style="background:var(--bad);color:#fff" onclick="removeFriendship('${fid}','Freund entfernt')">Entfernen</button></div>`);
}
function shareFriendCode() {
  const text = `Füg mich auf BetFriends als Freund hinzu! Mein Code: ${S.myCode}\n${location.origin}/?friend=${S.myCode}`;
  if (navigator.share) navigator.share({ title: 'BetFriends', text }).catch(() => {});
  else navigator.clipboard?.writeText(text).then(() => toast('Link kopiert'), () => toast('Code: ' + S.myCode));
}
function viewFriends() {
  const f = friendState.found;
  const st = f && { self: 'Das bist du.', friends: 'Ihr seid schon Freunde.', sent: 'Anfrage ist schon verschickt.', received: '' }[f.status];
  return `<button class="back" onclick="go('board')">← Community</button>
  <h1>Freunde</h1><div class="sub">Freunde sehen die Wetten, die du für sie freigibst.</div>
  <div class="card">
    <div class="sub">Dein Freundescode</div>
    <div style="display:flex;align-items:center;justify-content:space-between;margin-top:4px">
      <code style="font-family:ui-monospace,Menlo,monospace;font-size:22px;letter-spacing:.15em;font-weight:600">${esc(S.myCode)}</code>
      <button class="btn sm" onclick="shareFriendCode()">Teilen</button></div>
  </div>
  <div class="sec"><h2>Freund hinzufügen</h2></div>
  <div class="card">
    <input class="in friendin" style="font-family:ui-monospace,Menlo,monospace;font-size:18px;text-align:center;letter-spacing:.25em;text-transform:uppercase" maxlength="6" placeholder="FREUNDESCODE" autocapitalize="characters" autocomplete="off" value="${esc(friendState.code)}" oninput="onFriendCode(this.value)">
    ${friendState.looking ? '<div class="note">Suche …</div>' : ''}
    ${friendState.notFound ? '<div class="note">Diesen Code gibt es nicht.</div>' : ''}
    ${f ? `<div class="prow" style="margin-top:12px;align-items:center"><span class="av" style="background:${esc(f.color)}">${esc((f.name[0] || '?').toUpperCase())}</span>
      <div style="flex:1"><b style="font-weight:600">${esc(f.name)}</b>${st ? `<div class="sub">${st}</div>` : ''}</div>
      ${f.status === 'none' ? `<button class="btn sm" onclick="addFriend()">Anfrage senden</button>` : f.status === 'received' ? `<button class="btn sm" onclick="addFriend()">Annehmen</button>` : ''}</div>` : ''}
  </div>
  ${S.incoming.length ? `<div class="sec"><h2>Anfragen</h2><span class="sub">${S.incoming.length}</span></div><div class="setgroup">
    ${S.incoming.map(r => `<div class="setrow">${av(r.userId)}<div class="lbl"><b style="font-weight:600">${esc(U(r.userId).name)}</b><small>möchte mit dir befreundet sein</small></div>
      <button class="btn sm" onclick="acceptFriend('${r.fid}')">Annehmen</button><button class="btn sec2 sm" onclick="removeFriendship('${r.fid}','Anfrage abgelehnt')">✕</button></div>`).join('')}</div>` : ''}
  <div class="sec"><h2>Deine Freunde</h2><span class="sub">${S.friends.length}</span></div>
  ${S.friends.length ? `<div class="setgroup">${S.friends.map(fr => `<div class="setrow">${av(fr.userId)}<div class="lbl"><b style="font-weight:500">${esc(U(fr.userId).name)}</b></div>
      <button class="cbtn" onclick="confirmRemove('${fr.fid}','${fr.userId}')">Entfernen</button></div>`).join('')}</div>`
    : '<div class="card empty">Noch keine Freunde. Teile deinen Freundescode oder gib den Code eines Freundes ein.</div>'}
  ${S.outgoing.length ? `<div class="sec"><h2>Gesendete Anfragen</h2></div><div class="setgroup">
    ${S.outgoing.map(r => `<div class="setrow">${av(r.userId)}<div class="lbl">${esc(U(r.userId).name)}<small>wartet auf Bestätigung</small></div>
      <button class="cbtn" onclick="removeFriendship('${r.fid}','Anfrage zurückgezogen')">Zurückziehen</button></div>`).join('')}</div>` : ''}`;
}

function viewBoard() {
  const items = [];
  S.bets.filter(b => b.type === 'challenge' && betPhase(b) === 'running').forEach(b => b.participants.forEach(p => {
    items.push({ b, p, st: pStatus(b, p) });
  }));
  items.sort((a, b) => a.st.out - b.st.out || b.st.streak - a.st.streak);
  return `<h1>Community</h1><div class="sub">Was deine Freunde gerade durchziehen</div>
  <button class="card" style="display:flex;align-items:center;gap:12px;width:100%;text-align:left;cursor:pointer" onclick="go('friends')">
    <div class="faces" style="margin-left:6px">${S.friends.slice(0, 5).map(f => av(f.userId, 'sm')).join('') || '<span class="av sm" style="background:var(--soft);color:var(--muted)">+</span>'}</div>
    <div style="flex:1"><b style="font-weight:600">${S.friends.length ? `${S.friends.length} Freund${S.friends.length > 1 ? 'e' : ''}` : 'Freunde hinzufügen'}</b>
      <div class="sub">${S.incoming.length ? `${S.incoming.length} neue Freundschaftsanfrage${S.incoming.length > 1 ? 'n' : ''}` : 'Freundesliste verwalten'}</div></div>
    ${S.incoming.length ? `<span class="tag warn">${S.incoming.length}</span>` : ''}<span class="sub">›</span></button>
  <div class="sec"><h2>Challenges</h2><span class="sub">${items.length}</span></div>
  ${items.length ? `<div class="board">${items.map(({ b, p, st }) => `<div class="cb" onclick="go('bet',{id:'${b.id}'})">
      <div style="display:flex;align-items:center;gap:8px">${av(p.userId, 'sm')}<span style="font-weight:500;font-size:14px">${esc(U(p.userId).name)}</span>${p.checks[TODAY] ? '<span class="tag ok" style="margin-left:auto">✓ heute</span>' : ''}</div>
      <div class="goal">${esc(p.goal)}</div>
      ${st.out ? `<span class="tag bad">Ausgeschieden</span>` : `<div class="streak">${st.streak}</div><div class="sub">Tage Serie</div>`}
    </div>`).join('')}</div>` : '<div class="card empty">Gerade keine Challenges. Lade Freunde zu einer Wette ein, dann tauchen ihre Challenges hier auf.</div>'}
  <div class="sec"><h2>Feed</h2></div>
  <div class="card">${S.feed.slice(0, 40).map(feedItem).join('') || '<div class="empty">Noch nichts los.</div>'}</div>
  <div class="note">🤨 heißt „Glaub ich dir nicht“. So könnt ihr euch gegenseitig auf die Finger schauen.</div>`;
}

/* ---------- Neue Wette ---------- */
let draft = null;
function newDraft() { draft = { vis: getSet().defVis, viewers: [], type: 'challenge', title: '', desc: '', emoji: '🔥', stake: getSet().defStake, len: 7, startMode: 'today', from: addDays(TODAY, -28), to: addDays(TODAY, 13), jokers: getSet().defJokers, goal: '', sameGoal: false, options: ['', ''] }; }
function viewCreate() {
  if (!draft) newDraft();
  const d = draft, emos = d.type === 'challenge' ? ['🔥', '👟', '🚭', '🍺', '💪', '🥗', '📵', '📚', '🧘', '💤'] : ['⚽', '🍕', '🎮', '🏀', '🎤', '🎲', '🍻', '💘', '🏎️', '🌧️'];
  const lens = d.type === 'challenge' ? [[1, '1 Tag'], [7, '1 Woche'], [30, '30 Tage'], ['custom', 'Bis Datum'], ['open', 'Ohne Ende']] : [[1, 'Heute'], [2, 'Morgen'], ['custom', 'Eigenes Datum'], ['open', 'Ohne Datum']];
  const pl = planDates(d);
  const q = v => typeof v === 'string' ? `'${v}'` : v;
  const stakes = [0, 2, 5, 10, 20, 50];
  return `<h1>Neue Wette</h1><div class="sub">Danach bekommst du einen Code für deine Freunde.</div>
  <label class="f">Art</label>
  <div class="seg">
    <button class="segbtn ${d.type === 'challenge' ? 'on' : ''}" onclick="setD('type','challenge')"><b>Challenge</b><small>Jeden Tag abhaken, wer durchhält gewinnt</small></button>
    <button class="segbtn ${d.type === 'tipp' ? 'on' : ''}" onclick="setD('type','tipp')"><b>Tipp-Wette</b><small>Wer richtig tippt, gewinnt</small></button>
  </div>
  <label class="f">Titel</label>
  <input class="in" id="f-title" maxlength="60" placeholder="${d.type === 'challenge' ? 'z. B. Rauchfrei bis Silvester' : 'z. B. Wer gewinnt heute?'}" value="${esc(d.title)}" oninput="draft.title=this.value">
  <label class="f">Symbol</label>
  <div class="chips">${emos.map(e => `<button class="chip ${d.emoji === e ? 'on' : ''}" onclick="setD('emoji','${e}')">${e}</button>`).join('')}</div>
  <label class="f">Beschreibung (optional)</label>
  <input class="in" maxlength="140" placeholder="Regeln, Beweise …" value="${esc(d.desc)}" oninput="draft.desc=this.value">
  <label class="f">Einsatz pro Person</label>
  <div class="chips">${stakes.map(v => `<button class="chip ${d.stake === v ? 'on' : ''}" onclick="setD('stake',${v})">${v} €</button>`).join('')}
    <input class="in" style="width:100px;padding:6px 10px" type="number" inputmode="decimal" min="0" step="0.5" value="${stakes.includes(d.stake) ? '' : d.stake}" placeholder="Betrag" oninput="draft.stake=Math.max(0,+this.value||0)"></div>
  ${d.stake === 0 ? '<div class="sub" style="margin-top:6px">Ohne Einsatz, z. B. für eine Challenge nur für dich.</div>' : ''}
  ${d.type === 'challenge' ? `
    <label class="f">Start</label>
    <div class="chips">${[['today', 'Heute'], ['past', 'Schon früher begonnen'], ['future', 'Später']].map(([v, l]) => `<button class="chip ${d.startMode === v ? 'on' : ''}" onclick="setStart('${v}')">${l}</button>`).join('')}</div>
    ${d.startMode === 'past' ? `<input class="in" style="margin-top:8px" type="date" max="${addDays(TODAY, -1)}" min="${addDays(TODAY, -1095)}" value="${d.from}" onchange="draft.from=this.value;render()">
      <div class="note" style="margin-top:6px">Die ${diffDays(d.from, TODAY)} Tage seit dem ${fmtDate(d.from)} werden dir als geschafft angerechnet. Ab heute hakst du in der App ab.</div>` : ''}
    ${d.startMode === 'future' ? `<input class="in" style="margin-top:8px" type="date" min="${addDays(TODAY, 1)}" value="${d.from}" onchange="draft.from=this.value;render()">` : ''}
  ` : ''}
  <label class="f">${d.type === 'challenge' ? 'Dauer' : 'Auflösung'}</label>
  <div class="chips">${lens.map(([v, l]) => `<button class="chip ${d.len === v ? 'on' : ''}" onclick="setD('len',${q(v)})">${l}</button>`).join('')}</div>
  ${d.len === 'custom' ? `<div style="margin-top:8px"><input class="in" type="date" min="${pl.start > TODAY ? pl.start : TODAY}" value="${d.to}" onchange="draft.to=this.value;render()"></div>` : ''}
  ${d.type === 'challenge' && d.len !== 'open' ? `<div class="note" style="margin-top:6px">${pl.end < TODAY ? '<span style="color:var(--bad)">Das Ende liegt schon in der Vergangenheit. Wähl eine längere Dauer oder „Ohne Ende“.</span>' : `${fmtDate(pl.start)} bis ${fmtDate(pl.end)} · ${diffDays(pl.start, pl.end) + 1} Tage`}</div>` : ''}
  ${d.len === 'open' ? `<div class="note" style="margin-top:8px">${d.type === 'challenge' ? 'Kein Enddatum: Jeder hakt täglich ab, und wer als Letzter übrig bleibt, gewinnt den Pott.' : 'Das Ergebnis wird eingetragen, wann immer es feststeht.'}</div>` : ''}
  ${d.type === 'challenge' ? `
    <label class="f">Joker (Tage, die man verpassen darf)</label>
    <div class="chips">${[0, 1, 2, 3].map(v => `<button class="chip ${d.jokers === v ? 'on' : ''}" onclick="setD('jokers',${v})">${v}</button>`).join('')}</div>
    <label class="f">Ziel</label>
    <div class="chips"><button class="chip ${!d.sameGoal ? 'on' : ''}" onclick="setD('sameGoal',false)">Jeder sein eigenes</button><button class="chip ${d.sameGoal ? 'on' : ''}" onclick="setD('sameGoal',true)">Alle das gleiche</button></div>
    <input class="in" style="margin-top:8px" maxlength="60" placeholder="${d.sameGoal ? 'z. B. 10.000 Schritte' : 'Dein Ziel, z. B. Keine Zigaretten'}" value="${esc(d.goal)}" oninput="draft.goal=this.value">
  ` : `
    <label class="f">Antwortmöglichkeiten</label>
    ${d.options.map((o, i) => `<input class="in" style="margin-top:6px" maxlength="40" placeholder="Option ${i + 1}" value="${esc(o)}" oninput="draft.options[${i}]=this.value">`).join('')}
    ${d.options.length < 6 ? `<button class="chip" style="margin-top:8px" onclick="draft.options.push('');render()">+ Option</button>` : ''}
  `}
  <label class="f">Wer sieht die Wette in der Community?</label>
  ${visPicker(d.vis, d.viewers, 'draft')}
  <div style="height:20px"></div>
  <button class="btn full" ${busy ? 'disabled' : ''} onclick="createBet()">Wette starten</button>`;
}
// Start und Ende aus dem Formular berechnen
function planDates(d) {
  const start = d.type === 'challenge' && d.startMode !== 'today' ? d.from : TODAY;
  let end;
  if (d.len === 'open') end = null;
  else if (d.len === 'custom') end = d.to < start ? start : d.to;
  else end = addDays(start, d.len - 1);
  return { start, end };
}
function setStart(m) {
  draft.startMode = m;
  if (m === 'past' && draft.from >= TODAY) draft.from = addDays(TODAY, -28);
  if (m === 'future' && draft.from <= TODAY) draft.from = addDays(TODAY, 1);
  if (m === 'past' && draft.len !== 'custom') draft.len = 'open';
  render();
}
function setD(k, v) { draft[k] = v; if (k === 'type') { draft.emoji = v === 'challenge' ? '🔥' : '⚽'; draft.len = v === 'challenge' ? 7 : 1; } render(); }
async function createBet() {
  const d = draft;
  if (!d.title.trim()) return toast('Gib der Wette einen Titel');
  if (d.type === 'challenge' && !d.goal.trim()) return toast('Trag noch ein Ziel ein');
  const opts = d.options.map(o => o.trim()).filter(Boolean);
  if (d.type === 'tipp' && opts.length < 2) return toast('Mindestens zwei Optionen');
  const { start, end } = planDates(d);
  if (end && end < TODAY) return toast('Das Ende liegt in der Vergangenheit');
  const bet = { type: d.type, emoji: d.emoji, title: d.title.trim(), descr: d.desc.trim(), stake: d.stake, start_date: start, end_date: end,
    jokers: d.type === 'challenge' ? d.jokers : 0, same_goal: d.type === 'challenge' && d.sameGoal, options: d.type === 'tipp' ? opts : [] };
  const mine = d.type === 'challenge' ? { goal: d.goal.trim(), since: start, credited_until: start < TODAY ? addDays(TODAY, -1) : null } : {};
  if (d.vis === 'selected' && !d.viewers.length) return toast('Wähl mindestens einen Freund aus');
  bet.visibility = d.vis;
  const id = await run(() => api.createBet(bet, S.me, mine, d.vis === 'selected' ? d.viewers : []));
  if (!id) return;
  draft = null;
  if (d.type === 'tipp') { go('bet', { id }); return openPick(id); }
  go('bet', { id }); toast(d.stake > 0 ? 'Wette läuft. Lade jetzt deine Freunde ein.' : 'Wette läuft. Viel Erfolg!');
}

/* ---------- Beitreten ---------- */
let joinState = { code: '', goal: '', pick: null, since: null, found: null, looking: false, notFound: false };
function onCodeInput(v) {
  joinState.code = v.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  joinState.found = null; joinState.notFound = false;
  if (joinState.code.length === 6) lookup(joinState.code);
  render();
  const i = document.querySelector('.codein'); i.focus(); i.setSelectionRange(99, 99);
}
async function lookup(code) {
  joinState.looking = true;
  try { const f = await api.findBet(code); if (joinState.code !== code) return; joinState.found = f; joinState.notFound = !f; }
  catch (e) { toast(niceError(e)); }
  finally { joinState.looking = false; render(); }
}
function viewJoin() {
  const f = joinState.found;
  const done = f && ((f.type === 'tipp' && f.result != null) || (f.type === 'challenge' && f.end_date && f.end_date < TODAY));
  return `<h1>Wette beitreten</h1><div class="sub">Gib den 6-stelligen Code ein, den du bekommen hast.</div>
  <input class="in codein" style="font-family:ui-monospace,Menlo,monospace;font-size:22px;text-align:center;letter-spacing:.3em;margin-top:16px;text-transform:uppercase" maxlength="6" placeholder="ABC123" autocapitalize="characters" autocomplete="off" value="${esc(joinState.code)}"
    oninput="onCodeInput(this.value)">
  ${joinState.looking ? `<div class="note">Suche …</div>` : ''}
  ${joinState.notFound ? `<div class="note">Diesen Code gibt es nicht.</div>` : ''}
  ${f ? `<div class="card" style="margin-top:12px">
      <div class="bettop"><div class="ico">${esc(f.emoji)}</div>
        <div><div class="bettitle">${esc(f.title)}</div><div class="sub">von ${esc(f.creator_name)} · ${f.type === 'tipp' ? 'Tipp-Wette' : 'Challenge'}</div></div>
        ${potBox(f.stake, f.participant_count)}</div>
      ${f.descr ? `<p class="sub" style="margin-top:10px">${esc(f.descr)}</p>` : ''}
      <div class="meta"><span class="tag">${perPerson(f.stake)}</span><span class="tag">${f.participant_count} dabei</span>
        <span class="tag">${period({ type: f.type, start: f.start_date, end: f.end_date })}</span></div>
    </div>
    ${f.already_joined ? `<button class="btn full" onclick="go('bet',{id:'${f.id}'})">Du bist schon dabei · ansehen</button>` : done ? `<div class="note">Diese Wette ist schon vorbei.</div>` : `
      ${f.type === 'challenge' ? (f.same_goal ? `<div class="note">Ziel für alle: <b>${esc(f.shared_goal)}</b></div>` : `<label class="f">Dein persönliches Ziel</label><input class="in" maxlength="60" placeholder="z. B. Kein Alkohol" value="${esc(joinState.goal)}" oninput="joinState.goal=this.value">`)
        + (!f.end_date ? `<label class="f">Seit wann machst du das schon?</label>
          <div class="chips"><button class="chip ${!joinState.since ? 'on' : ''}" onclick="joinState.since=null;render()">Ab heute</button><button class="chip ${joinState.since ? 'on' : ''}" onclick="joinState.since=joinState.since||'${addDays(TODAY, -28)}';render()">Schon früher begonnen</button></div>
          ${joinState.since ? `<input class="in" style="margin-top:8px" type="date" max="${addDays(TODAY, -1)}" min="${addDays(TODAY, -1095)}" value="${joinState.since}" onchange="joinState.since=this.value;render()">
            <div class="note" style="margin-top:6px">Die ${diffDays(joinState.since, TODAY)} Tage seit dem ${fmtDate(joinState.since)} werden dir angerechnet.</div>` : ''}` : '')
        : `<label class="f">Dein Tipp</label>${f.options.map((o, i) => `<button class="opt ${joinState.pick === i ? 'on' : ''}" onclick="joinState.pick=${i};render()">${esc(o)}</button>`).join('')}`}
      <div style="height:16px"></div>
      <button class="btn full" ${busy ? 'disabled' : ''} onclick="joinBet()">Beitreten${Number(f.stake) > 0 ? ' · ' + euro(Number(f.stake)) : ''}</button>`}` : ''}`;
}
async function joinBet() {
  const f = joinState.found;
  if (f.type === 'challenge' && !f.same_goal && !joinState.goal.trim()) return toast('Trag dein Ziel ein');
  if (f.type === 'tipp' && joinState.pick == null) return toast('Wähl deinen Tipp');
  const id = await run(() => api.joinBet(joinState.code, joinState.goal.trim(), joinState.pick, joinState.found.type === 'challenge' && !joinState.found.end_date ? joinState.since : null), 'Du bist dabei');
  if (!id) return;
  joinState = { code: '', goal: '', pick: null, since: null, found: null, looking: false, notFound: false };
  go('bet', { id });
}

/* ---------- Dialoge ---------- */
function modal(html) { $('#modal').innerHTML = html ? `<div class="modalbg" onclick="if(event.target===this)modal('')"><div class="modal">${html}</div></div>` : ''; }
function openPick(id) {
  const b = B(id); if (!b) return;
  modal(`<h1>Dein Tipp</h1><div class="sub">${esc(b.title)}</div>${b.options.map((o, i) => `<button class="opt" onclick="setPick('${id}',${i})">${esc(o)}</button>`).join('')}`);
}
function setPick(id, i) { modal(''); run(() => api.setPick(id, S.me, i), 'Tipp gespeichert. Lade jetzt deine Freunde ein.'); }
function openResolve(id) {
  const b = B(id);
  modal(`<h1>Ergebnis eintragen</h1><div class="sub">Das kann danach nicht mehr geändert werden.</div>${b.options.map((o, i) => `<button class="opt" onclick="resolveBet('${id}',${i})">${esc(o)}</button>`).join('')}`);
}
function resolveBet(id, i) { modal(''); run(() => api.resolve(id, S.me, i)); }

/* ---------- Einstellungen ---------- */
const sw = on => `<span class="sw ${on ? 'on' : ''}" role="switch" aria-checked="${on}"></span>`;
const COLORS = ['#52525B', '#E06D4F', '#3F9D6B', '#6B5BD6', '#2B7FD9', '#D9467A', '#C28A12', '#0F8B8D'];
function setSet(k, v) {
  const u = S.users.find(u => u.id === S.me); u.settings = { ...getSet(), [k]: v }; render();
  run(() => api.updateProfile(S.me, { settings: u.settings }));
}
function setProfile(fields, msg) { Object.assign(S.users.find(u => u.id === S.me), fields); render(); run(() => api.updateProfile(S.me, fields), msg); }
function setTheme(t) { theme = t; lsSet('bf-theme', t); applyTheme(); render(); }
function viewSettings() {
  const st = getSet(), me = U(S.me);
  const tog = (k, label, hint = '') => `<button class="setrow" onclick="setSet('${k}',${!st[k]})"><div class="lbl">${label}${hint ? `<small>${hint}</small>` : ''}</div>${sw(st[k])}</button>`;
  return `<h1>Einstellungen</h1><div class="sub">${esc(session.user.email)}</div>

  <div class="sec"><h2>Profil</h2></div>
  <div class="setgroup">
    <div class="setrow">${av(S.me)}<div class="lbl"><input class="in" style="padding:8px 10px" maxlength="20" value="${esc(me.name)}" onchange="const v=this.value.trim();if(v)setProfile({name:v},'Name gespeichert')"><small style="margin-top:4px">So sehen dich deine Freunde</small></div></div>
    <div class="setrow" style="display:block"><div class="lbl" style="margin-bottom:8px">Profilfarbe</div><div class="colors">${COLORS.map(c => `<button class="${me.color === c ? 'on' : ''}" style="background:${c}" aria-label="Farbe" onclick="setProfile({color:'${c}'})"></button>`).join('')}</div></div>
  </div>

  <div class="sec"><h2>Darstellung</h2></div>
  <div class="setgroup"><div class="setrow" style="display:block">
    <div class="segctl">${[['light', 'Hell'], ['dark', 'Dunkel'], ['system', 'System']].map(([v, l]) => `<button class="${theme === v ? 'on' : ''}" onclick="setTheme('${v}')">${l}</button>`).join('')}</div>
    <div class="sub" style="margin-top:8px">„System“ übernimmt automatisch die Einstellung deines Geräts.</div>
  </div></div>

  <div class="sec"><h2>Benachrichtigungen</h2><span class="sub">bald verfügbar</span></div>
  <div class="setgroup">
    ${tog('notifDaily', 'Tägliche Erinnerung', 'Erinnert dich, wenn du heute noch nicht abgehakt hast')}
    ${st.notifDaily ? `<div class="setrow"><div class="lbl">Uhrzeit</div><input class="in" type="time" style="width:120px;padding:6px 10px" value="${st.reminder}" onchange="setSet('reminder',this.value)"></div>` : ''}
    ${tog('notifComments', 'Kommentare', 'Wenn jemand deine Wetten oder Fortschritte kommentiert')}
    ${tog('notifReacts', 'Reaktionen', 'Emojis auf deine Fortschritte')}
    ${tog('notifNewBets', 'Neue Wetten von Freunden')}
    ${tog('weekly', 'Wochenrückblick', 'Jeden Sonntag: Serien, Pötte und wer raus ist')}
  </div>

  <div class="sec"><h2>Neue Wetten</h2></div>
  <div class="setgroup">
    <div class="setrow" style="display:block"><div class="lbl" style="margin-bottom:8px">Standard-Einsatz</div>
      <div class="chips">${[0, 2, 5, 10, 20, 50].map(v => `<button class="chip ${st.defStake === v ? 'on' : ''}" onclick="setSet('defStake',${v})">${v} €</button>`).join('')}</div></div>
    <div class="setrow" style="display:block"><div class="lbl" style="margin-bottom:8px">Standard-Joker</div>
      <div class="chips">${[0, 1, 2, 3].map(v => `<button class="chip ${st.defJokers === v ? 'on' : ''}" onclick="setSet('defJokers',${v})">${v}</button>`).join('')}</div></div>
  </div>

  <div class="sec"><h2>Freunde & Privatsphäre</h2></div>
  <div class="setgroup">
    <button class="setrow" onclick="go('friends')"><div class="lbl">Freunde<small>${S.friends.length} Freunde${S.incoming.length ? ` · ${S.incoming.length} neue Anfrage${S.incoming.length > 1 ? 'n' : ''}` : ''}</small></div><span class="sub">›</span></button>
    <div class="setrow" style="display:block"><div class="lbl" style="margin-bottom:8px">Neue Wetten sichtbar für<small>Kannst du bei jeder Wette auch einzeln ändern</small></div>
      <div class="segctl">${VIS.filter(([v]) => v !== 'selected').map(([v, l]) => `<button class="${st.defVis === v ? 'on' : ''}" onclick="setSet('defVis','${v}')">${l}</button>`).join('')}</div></div>
  </div>

  <div class="sec"><h2>Hilfe</h2></div>
  <div class="setgroup">
    <button class="setrow" onclick="openRules()"><div class="lbl">Spielregeln</div><span class="sub">›</span></button>
    <div class="setrow"><div class="lbl">Version</div><span class="sub">${__APP_VERSION__}</span></div>
  </div>

  <div class="sec"><h2>Konto</h2></div>
  <div class="setgroup">
    <button class="setrow" onclick="openPassword()"><div class="lbl">Passwort ändern</div><span class="sub">›</span></button>
    <button class="setrow danger" onclick="openLogout()"><div class="lbl">Abmelden</div></button>
  </div>`;
}
function openRules() {
  modal(`<h1>Spielregeln</h1>
    <div class="card"><h2>Challenge</h2><p class="sub" style="margin-top:4px">Jeder hakt täglich ab. Verpasste Tage werden erst mit Jokern ausgeglichen, danach ist man raus. Alle, die bis zum Ende durchhalten, teilen sich den Pott.</p></div>
    <div class="card"><h2>Challenge ohne Ende</h2><p class="sub" style="margin-top:4px">Läuft, bis nur noch einer übrig ist. Wer als Letzter durchhält, gewinnt den Pott.</p></div>
    <div class="card"><h2>Tipp-Wette</h2><p class="sub" style="margin-top:4px">Jeder gibt einen Tipp ab. Wer die Wette erstellt hat, trägt das Ergebnis ein. Alle mit dem richtigen Tipp teilen sich den Pott.</p></div>
    <div class="card"><h2>Abhaken</h2><p class="sub" style="margin-top:4px">Abhaken geht nur für heute. Wer einen Tag vergisst, verbraucht einen Joker.</p></div>
    <div class="card"><h2>Geld</h2><p class="sub" style="margin-top:4px">Die App zeigt nur an, wer wie viel setzt. Bezahlt wird unter euch.</p></div>
    <button class="btn full" onclick="modal('')">Verstanden</button>`);
}
function openLogout() {
  modal(`<h1>Abmelden?</h1><div class="sub">Deine Wetten bleiben gespeichert. Du kannst dich jederzeit wieder anmelden.</div><div style="height:16px"></div>
    <div class="row"><button class="btn sec2" onclick="modal('')">Abbrechen</button><button class="btn" style="background:var(--bad);color:#fff" onclick="modal('');sb.auth.signOut()">Abmelden</button></div>`);
}
function openPassword(recovery = false) {
  modal(`<h1>${recovery ? 'Neues Passwort festlegen' : 'Passwort ändern'}</h1>
    <form onsubmit="savePassword(event)"><input class="in" type="password" name="pw" minlength="6" placeholder="Neues Passwort (mind. 6 Zeichen)" autocomplete="new-password" required style="margin-top:12px">
    <div style="height:12px"></div><button class="btn full">Speichern</button></form>`);
}
async function savePassword(ev) {
  ev.preventDefault();
  const { error } = await sb.auth.updateUser({ password: ev.target.pw.value });
  if (error) return toast(niceError(error));
  modal(''); toast('Passwort gespeichert');
}

/* ---------- Anmelden ---------- */
let auth = { mode: 'login', msg: '', err: '' };
function viewAuth() {
  const m = auth.mode;
  return `<div class="auth">
    <div class="brand"><img src="/icons/icon-192.png" alt="BetFriends"><h1>BetFriends</h1><div class="sub">Wetten und Challenges unter Freunden</div></div>
    ${auth.msg ? `<div class="card">${auth.msg}</div>` : `
    <form onsubmit="submitAuth(event)">
      ${m === 'register' ? `<input class="in" name="name" maxlength="20" placeholder="Dein Name" autocomplete="nickname" required>` : ''}
      <input class="in" name="email" type="email" placeholder="E-Mail" autocomplete="email" value="${esc(auth.email || '')}" required>
      ${m !== 'reset' ? `<input class="in" name="pw" type="password" minlength="6" placeholder="Passwort${m === 'register' ? ' (mind. 6 Zeichen)' : ''}" autocomplete="${m === 'register' ? 'new-password' : 'current-password'}" required>` : ''}
      ${auth.err ? `<div class="err">${esc(auth.err)}</div>` : ''}
      <div style="height:14px"></div>
      <button class="btn full" ${busy ? 'disabled' : ''}>${m === 'login' ? 'Anmelden' : m === 'register' ? 'Konto erstellen' : 'Link zum Zurücksetzen schicken'}</button>
    </form>`}
    <div style="display:flex;justify-content:space-between;margin-top:12px">
      ${m === 'login' ? `<button class="linkbtn" onclick="setAuth('register')">Neu hier? Konto erstellen</button><button class="linkbtn" onclick="setAuth('reset')">Passwort vergessen?</button>`
        : `<button class="linkbtn" onclick="setAuth('login')">← Zur Anmeldung</button>`}
    </div>
  </div>`;
}
function setAuth(mode) { auth = { mode, msg: '', err: '', email: auth.email }; render(); }
async function submitAuth(ev) {
  ev.preventDefault();
  const f = ev.target, email = f.email.value.trim();
  auth.email = email;
  busy = true; auth.err = ''; render();
  try {
    if (auth.mode === 'login') {
      const { error } = await sb.auth.signInWithPassword({ email, password: f.pw.value });
      if (error) throw error;
    } else if (auth.mode === 'register') {
      const { data, error } = await sb.auth.signUp({ email, password: f.pw.value, options: { data: { name: f.name.value.trim() }, emailRedirectTo: location.origin } });
      if (error) throw error;
      if (!data.session) auth.msg = `<b>Fast geschafft!</b><div class="sub" style="margin-top:4px">Wir haben dir eine E-Mail an ${esc(email)} geschickt. Klick auf den Link darin und melde dich dann hier an.</div>`;
    } else {
      const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin });
      if (error) throw error;
      auth.msg = `<b>E-Mail ist unterwegs</b><div class="sub" style="margin-top:4px">Öffne den Link in der E-Mail, dann kannst du ein neues Passwort festlegen.</div>`;
    }
  } catch (e) { auth.err = niceError(e); }
  finally { busy = false; render(); }
}

function viewSetup() {
  return `<div class="auth"><div class="brand"><img src="/icons/icon-192.png" alt=""><h1>BetFriends</h1></div>
    <div class="card"><b>Noch nicht eingerichtet</b><div class="sub" style="margin-top:4px">Es fehlen <code>VITE_SUPABASE_URL</code> und <code>VITE_SUPABASE_ANON_KEY</code>. Siehe README.</div></div></div>`;
}

/* ===================== Render ===================== */
const ICONS = {
  home: '<svg viewBox="0 0 24 24"><path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></svg>',
  board: '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.8c2 .7 3.2 2.5 3.6 5.2"/></svg>',
  create: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="5"/><path d="M12 8v8M8 12h8"/></svg>',
  join: '<svg viewBox="0 0 24 24"><path d="M3 8a2 2 0 0 0 0 4v4a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-4a2 2 0 0 0 0-4V4.5"/><path d="M3 8V5a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v3M10 4v13" stroke-dasharray="2 2.5"/></svg>',
  settings: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
};
function render() {
  applyTheme();
  const navEl = $('#nav').parentElement;
  if (!configured) { $('#app').innerHTML = viewSetup(); navEl.style.display = 'none'; return; }
  if (!session) { $('#app').innerHTML = viewAuth(); navEl.style.display = 'none'; return; }
  if (!S) { $('#app').innerHTML = '<div class="spinner"></div>'; navEl.style.display = 'none'; return; }
  navEl.style.display = '';
  const views = { home: viewHome, bet: viewBet, board: viewBoard, create: viewCreate, join: viewJoin, settings: viewSettings, friends: viewFriends };
  $('#app').innerHTML = `<header><div class="logo"><img src="/icon.svg" alt="">BetFriends</div>
    <button class="me" onclick="go('settings')">${av(S.me, 'sm')} ${esc(U(S.me).name)}</button></header>` + (views[view.name] || viewHome)();
  const tabs = [['home', 'Wetten'], ['board', 'Community'], ['create', 'Neu'], ['join', 'Beitreten'], ['settings', 'Einstellungen']];
  const cur = view.name === 'bet' ? 'home' : view.name === 'friends' ? 'board' : view.name;
  $('#nav').innerHTML = tabs.map(([n, l]) => `<button class="${cur === n ? 'on' : ''}" onclick="go('${n}')">${ICONS[n]}${l}</button>`).join('');
}

// Inline-Handler brauchen globale Namen
Object.assign(window, {
  go, render, setStart, checkAll, toggleCheck, refreshPicker, toggleViewer, openVisibility, saveVisibility, openInvite, sendInvites,
  declineInvite, openInviteJoin, onFriendCode, addFriend, acceptFriend, removeFriendship, confirmRemove, shareFriendCode, react, toggleThread, addComment, delComment, copyCode, setD, createBet, onCodeInput, joinBet,
  modal, openPick, setPick, openResolve, resolveBet, setSet, setProfile, setTheme, openRules, openLogout, openPassword, savePassword,
  setAuth, submitAuth, doInstall, sb,
});
Object.defineProperty(window, 'draft', { get: () => draft });
Object.defineProperty(window, 'joinState', { get: () => joinState });
Object.defineProperty(window, 'visEdit', { get: () => visEdit, set: v => { visEdit = v; } });
Object.defineProperty(window, 'inviteSel', { get: () => inviteSel, set: v => { inviteSel = v; } });

/* ===================== Start ===================== */
async function boot() {
  render();
  if (!configured) return;
  // Einladungslink: /?code=ABC123 öffnet direkt "Beitreten"
  const code = new URLSearchParams(location.search).get('code');
  const fcode = new URLSearchParams(location.search).get('friend');
  if (fcode) { view = { name: 'friends' }; friendState.code = fcode.toUpperCase().slice(0, 6); history.replaceState(null, '', '/'); }
  if (code) { view = { name: 'join' }; joinState.code = code.toUpperCase().slice(0, 6); history.replaceState(null, '', '/'); }

  const { data } = await sb.auth.getSession();
  session = data.session;
  let unsub = null;
  sb.auth.onAuthStateChange((event, s) => {
    const was = session?.user.id; session = s;
    if (event === 'PASSWORD_RECOVERY') setTimeout(() => openPassword(true), 50);
    if (!s) { S = null; unsub?.(); unsub = null; auth = { mode: 'login', msg: '', err: '' }; render(); return; }
    if (s.user.id !== was) { S = null; if (was === undefined && !['join', 'friends'].includes(view.name)) view = { name: 'home' }; render(); refresh(); unsub?.(); unsub = subscribe(refresh); }
  });
  if (session) { await refresh(); unsub = subscribe(refresh); }
  if (joinState.code.length === 6 && session) lookup(joinState.code);
  if (friendState.code.length === 6 && session) lookupFriend(friendState.code);
  render();
  // Beim Zurückkehren in die App frisch laden (z. B. neuer Tag)
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
}
boot();

if ('serviceWorker' in navigator && import.meta.env.PROD) navigator.serviceWorker.register('/sw.js');
