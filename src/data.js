// Datenzugriff auf Supabase. Baut aus den Tabellen den Zustand, den die Oberfläche braucht.
import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;
export const configured = Boolean(url && key);
export const sb = configured ? createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true } }) : null;

const must = ({ data, error }) => { if (error) throw error; return data; };

export async function loadState(meId) {
  const [profiles, bets, parts, checks, feed, reactions, comments] = await Promise.all([
    sb.from('profiles').select('*'),
    sb.from('bets').select('*').order('created_at', { ascending: false }),
    sb.from('participants').select('*').order('joined_at'),
    sb.from('checks').select('bet_id,user_id,day'),
    sb.from('feed').select('*').order('created_at', { ascending: false }).limit(200),
    sb.from('reactions').select('*'),
    sb.from('comments').select('*').order('created_at'),
  ].map(p => p.then(must)));

  const users = profiles.map(p => ({ id: p.id, name: p.name, color: p.color, settings: p.settings || {} }));
  const byBet = {};
  const outBets = bets.map(b => {
    const o = {
      id: b.id, code: b.code, type: b.type, emoji: b.emoji, title: b.title, desc: b.descr, creator: b.creator,
      stake: Number(b.stake), start: b.start_date, end: b.end_date, jokers: b.jokers, sameGoal: b.same_goal,
      options: b.options || [], result: b.result, created: Date.parse(b.created_at), participants: [], comments: [],
    };
    byBet[b.id] = o; return o;
  });
  const partIdx = {};
  for (const p of parts) {
    const b = byBet[p.bet_id]; if (!b) continue;
    const o = { userId: p.user_id, goal: p.goal, pick: p.pick, since: p.since, credit: p.credited_until, checks: {} };
    b.participants.push(o); partIdx[p.bet_id + '|' + p.user_id] = o;
  }
  for (const c of checks) { const p = partIdx[c.bet_id + '|' + c.user_id]; if (p) p.checks[c.day] = true; }

  const feedIdx = {};
  const outFeed = feed.filter(f => byBet[f.bet_id]).map(f => {
    const o = { id: f.id, betId: f.bet_id, userId: f.user_id, kind: f.kind, ts: Date.parse(f.created_at), reacts: {}, comments: [] };
    feedIdx[f.id] = o; return o;
  });
  for (const r of reactions) { const f = feedIdx[r.feed_id]; if (f) (f.reacts[r.emoji] = f.reacts[r.emoji] || []).push(r.user_id); }
  for (const c of comments) {
    const o = { id: c.id, userId: c.user_id, text: c.body, ts: Date.parse(c.created_at) };
    if (c.feed_id) { feedIdx[c.feed_id]?.comments.push(o); } else { byBet[c.bet_id]?.comments.push(o); }
  }
  return { me: meId, users, bets: outBets, feed: outFeed };
}

// ---------- Aktionen ----------
export const api = {
  async check(betId, userId, day) {
    must(await sb.from('checks').insert({ bet_id: betId, user_id: userId, day }));
    must(await sb.from('feed').insert({ bet_id: betId, user_id: userId, kind: 'check' }));
  },
  async uncheck(betId, userId, day, feedId) {
    must(await sb.from('checks').delete().match({ bet_id: betId, user_id: userId, day }));
    if (feedId) must(await sb.from('feed').delete().eq('id', feedId));
  },
  async react(feedId, userId, emoji, on) {
    if (on) must(await sb.from('reactions').insert({ feed_id: feedId, user_id: userId, emoji }));
    else must(await sb.from('reactions').delete().match({ feed_id: feedId, user_id: userId, emoji }));
  },
  async comment(betId, feedId, userId, body) {
    must(await sb.from('comments').insert({ bet_id: betId, feed_id: feedId || null, user_id: userId, body }));
  },
  async deleteComment(id) { must(await sb.from('comments').delete().eq('id', id)); },
  async createBet(bet, me, mine) {
    let row, lastErr;
    for (let i = 0; i < 4 && !row; i++) {
      const { data, error } = await sb.from('bets').insert({ ...bet, code: makeCode(), creator: me }).select().single();
      if (error && error.code === '23505') { lastErr = error; continue; } // Code schon vergeben
      if (error) throw error;
      row = data;
    }
    if (!row) throw lastErr;
    must(await sb.from('participants').insert({ bet_id: row.id, user_id: me, ...mine }));
    must(await sb.from('feed').insert({ bet_id: row.id, user_id: me, kind: 'new' }));
    return row.id;
  },
  async setPick(betId, userId, pick) { must(await sb.from('participants').update({ pick }).match({ bet_id: betId, user_id: userId })); },
  async resolve(betId, userId, result) {
    must(await sb.from('bets').update({ result }).eq('id', betId));
    must(await sb.from('feed').insert({ bet_id: betId, user_id: userId, kind: 'result' }));
  },
  async findBet(code) { return must(await sb.rpc('find_bet', { p_code: code }))[0] || null; },
  async joinBet(code, goal, pick, since) { return must(await sb.rpc('join_bet', { p_code: code, p_goal: goal || '', p_pick: pick ?? null, p_since: since || null })); },
  async updateProfile(id, fields) { must(await sb.from('profiles').update(fields).eq('id', id)); },
};

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const a = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(a, n => chars[n % chars.length]).join('');
}

// Bei jeder Änderung in einer der Tabellen neu laden (für kleine Freundesgruppen völlig ausreichend)
export function subscribe(onChange) {
  let t;
  const ping = () => { clearTimeout(t); t = setTimeout(onChange, 300); };
  const ch = sb.channel('betfriends-live');
  for (const table of ['bets', 'participants', 'checks', 'feed', 'reactions', 'comments', 'profiles']) {
    ch.on('postgres_changes', { event: '*', schema: 'public', table }, ping);
  }
  ch.subscribe();
  return () => sb.removeChannel(ch);
}
