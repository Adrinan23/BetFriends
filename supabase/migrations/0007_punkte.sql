-- BetFriends: Punkte statt Euro
-- Im Supabase SQL Editor einmal ausführen (nach 0001–0006).
--
-- Regeln:
--   * Jeder startet mit 1.000 Punkten. Punkte kann man nicht kaufen und nicht auszahlen.
--   * Beitreten zieht den Einsatz sofort ab (er liegt dann im Pott).
--   * Ende einer Wette: Gewinner teilen den Pott. Gewinnt niemand, gibt es den Einsatz zurück.
--     Ausnahme: Challenge allein und nicht geschafft = Einsatz ist weg.
--   * Solo-Challenges: bis zu 10 Punkte pro Tag, aufgeteilt auf alle laufenden Solo-Challenges.
--   * Punkte an Freunde überweisen.
--   * Wer unter 100 Punkte hat, wird jeden Montag auf 100 aufgefüllt.
-- Alle Buchungen laufen nur über die Funktionen hier, nie direkt aus der App.

-- ---------------------------------------------------------------------------
-- Einsätze ab jetzt ganze Punkte (1 € = 1 Punkt)
-- ---------------------------------------------------------------------------
update public.bets set stake = round(stake) where stake <> round(stake);
alter table public.bets drop constraint if exists bets_stake_whole;
alter table public.bets add constraint bets_stake_whole check (stake = trunc(stake));

alter table public.bets
  add column if not exists settled_at timestamptz,   -- wann abgerechnet
  add column if not exists winners uuid[];            -- wer gewonnen hat (bei Abrechnung festgehalten)

-- ---------------------------------------------------------------------------
-- Konto und Buchungen
-- ---------------------------------------------------------------------------
create table if not exists public.wallets (
  user_id  uuid primary key references public.profiles on delete cascade,
  points   int not null default 0,
  constraint wallets_points_check check (points >= 0)
);

create table if not exists public.point_tx (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references public.profiles on delete cascade,
  amount      int not null check (amount <> 0),
  kind        text not null check (kind in ('start', 'stake', 'refund', 'win', 'adjust', 'daily', 'transfer', 'topup')),
  bet_id      uuid references public.bets on delete set null,
  bet_title   text,                                  -- bleibt lesbar, auch wenn die Wette gelöscht wird
  other_user  uuid references public.profiles on delete set null,
  other_name  text,
  day         date,                                  -- für Tagesbelohnung
  note        text check (char_length(note) <= 80),
  created_at  timestamptz not null default now()
);
create index if not exists point_tx_user on public.point_tx (user_id, id desc);
create index if not exists point_tx_bet on public.point_tx (bet_id);

alter table public.wallets  enable row level security;
alter table public.point_tx enable row level security;
drop policy if exists "wallets_select_own" on public.wallets;
create policy "wallets_select_own" on public.wallets for select to authenticated using (user_id = auth.uid());
drop policy if exists "point_tx_select_own" on public.point_tx;
create policy "point_tx_select_own" on public.point_tx for select to authenticated using (user_id = auth.uid());
-- Keine insert/update/delete-Regeln: Buchungen nur über die Funktionen unten.
revoke insert, update, delete on public.wallets, public.point_tx from anon, authenticated;

-- Jede Buchung ändert den Kontostand. Unter 0 geht nicht (wallets_points_check).
create or replace function public.apply_point_tx() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- erst ändern, sonst anlegen (ein Insert mit negativem Betrag würde schon an der Prüfung scheitern)
  update wallets set points = points + new.amount where user_id = new.user_id;
  if not found then
    insert into wallets (user_id, points) values (new.user_id, new.amount);
  end if;
  return new;
end $$;
drop trigger if exists point_tx_apply on public.point_tx;
create trigger point_tx_apply after insert on public.point_tx
  for each row execute function public.apply_point_tx();

-- Hilfsfunktion: eine Buchung anlegen
create or replace function public.book(p_user uuid, p_amount int, p_kind text, p_bet uuid default null,
  p_other uuid default null, p_note text default null, p_day date default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_amount = 0 then return; end if;
  -- Konto gibt es nicht mehr (z. B. gerade gelöscht): nichts buchen
  if not exists (select 1 from profiles where id = p_user) then return; end if;
  insert into point_tx (user_id, amount, kind, bet_id, bet_title, other_user, other_name, note, day)
  values (p_user, p_amount, p_kind, p_bet, (select title from bets where id = p_bet),
          case when exists (select 1 from profiles where id = p_other) then p_other end,
          (select name from profiles where id = p_other), p_note, p_day);
end $$;
revoke execute on function public.book(uuid, int, text, uuid, uuid, text, date) from public, anon, authenticated;

create or replace function public.bf_today() returns date
language sql stable as $$ select (now() at time zone 'Europe/Berlin')::date $$;

-- ---------------------------------------------------------------------------
-- Bestehende Nutzer: Startguthaben, laufende Einsätze abziehen
-- ---------------------------------------------------------------------------
do $$
declare r record;
begin
  if exists (select 1 from point_tx) then return; end if;  -- schon gelaufen
  for r in
    select pr.id, coalesce(sum(b.stake), 0)::int as staked
    from profiles pr
    left join participants p on p.user_id = pr.id
    left join bets b on b.id = p.bet_id
    group by pr.id
  loop
    perform book(r.id, greatest(1000, r.staked), 'start');
  end loop;
  for r in select p.user_id, b.id as bet_id, b.stake::int as stake from participants p join bets b on b.id = p.bet_id where b.stake > 0 loop
    perform book(r.user_id, -r.stake, 'stake', r.bet_id);
  end loop;
end $$;

-- Neue Nutzer: 1.000 Punkte Startguthaben
create or replace function public.give_start_points() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform book(new.id, 1000, 'start');
  return new;
end $$;
drop trigger if exists profiles_start_points on public.profiles;
create trigger profiles_start_points after insert on public.profiles
  for each row execute function public.give_start_points();

-- ---------------------------------------------------------------------------
-- Wetten: Schutz, Einsatz bei Beitritt, Änderungen, Löschen
-- ---------------------------------------------------------------------------

-- Abrechnungsfelder kann nur der Server setzen; abgerechnete Wetten sind eingefroren
create or replace function public.guard_bet_points() returns trigger
language plpgsql as $$
begin
  if current_user in ('authenticated', 'anon') then
    if tg_op = 'INSERT' then
      new.settled_at := null; new.winners := null;
    else
      new.settled_at := old.settled_at; new.winners := old.winners;
      if new.end_date is distinct from old.end_date and new.end_date < bf_today() then
        raise exception 'Das Ende darf nicht in der Vergangenheit liegen';
      end if;
      if old.settled_at is not null and (new.stake is distinct from old.stake or new.result is distinct from old.result
          or new.end_date is distinct from old.end_date or new.jokers is distinct from old.jokers) then
        raise exception 'Diese Wette ist schon abgerechnet';
      end if;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists bets_guard_points on public.bets;
create trigger bets_guard_points before insert or update on public.bets
  for each row execute function public.guard_bet_points();

-- Beitreten (auch der Ersteller selbst): Einsatz abziehen
create or replace function public.take_stake() returns trigger
language plpgsql security definer set search_path = public as $$
declare b bets;
begin
  select * into b from bets where id = new.bet_id;
  if b.settled_at is not null then raise exception 'Diese Wette ist schon vorbei'; end if;
  perform book(new.user_id, -b.stake::int, 'stake', b.id);
  return new;
end $$;
drop trigger if exists participants_take_stake on public.participants;
create trigger participants_take_stake after insert on public.participants
  for each row execute function public.take_stake();

-- Einsatz geändert: Differenz bei allen Teilnehmern ausgleichen
create or replace function public.adjust_stake() returns trigger
language plpgsql security definer set search_path = public as $$
declare p record;
begin
  for p in select user_id from participants where bet_id = new.id loop
    perform book(p.user_id, (old.stake - new.stake)::int, 'adjust', new.id);
  end loop;
  return new;
end $$;
drop trigger if exists bets_adjust_stake on public.bets;
create trigger bets_adjust_stake after update of stake on public.bets
  for each row when (old.stake is distinct from new.stake and new.settled_at is null)
  execute function public.adjust_stake();

-- Wette gelöscht, bevor sie abgerechnet war: alle bekommen ihren Einsatz zurück
create or replace function public.refund_on_delete() returns trigger
language plpgsql security definer set search_path = public as $$
declare p record;
begin
  if old.settled_at is null and old.stake > 0 then
    for p in select user_id from participants where bet_id = old.id loop
      perform book(p.user_id, old.stake::int, 'refund', old.id, null, 'Wette gelöscht');
    end loop;
  end if;
  return old;
end $$;
drop trigger if exists bets_refund_on_delete on public.bets;
create trigger bets_refund_on_delete before delete on public.bets
  for each row execute function public.refund_on_delete();

-- ---------------------------------------------------------------------------
-- Abrechnung
-- Ein Tag Kulanz: Gestern darf man noch abhaken, also zählt ein fehlendes
-- Häkchen erst ab vorgestern als verpasst.
-- ---------------------------------------------------------------------------
create or replace function public.missed_days(b bets, p participants, cd date) returns int
language sql stable set search_path = public as $$
  select count(*)::int
  from generate_series(coalesce(p.since, b.start_date), least(coalesce(b.end_date, cd - 2), cd - 2), interval '1 day') d
  where not exists (select 1 from checks c where c.bet_id = b.id and c.user_id = p.user_id and c.day = d::date)
    and not (p.credited_until is not null and d::date <= p.credited_until);
$$;

create or replace function public.settle_bet(p_bet uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  b bets; cd date := bf_today();
  n int; w uuid[]; nw int; pot int; share int; rest int; i int; done boolean;
begin
  select * into b from bets where id = p_bet for update;
  if not found or b.settled_at is not null then return false; end if;
  select count(*) into n from participants where bet_id = b.id;
  if n = 0 then return false; end if;

  if b.type = 'tipp' then
    if b.result is null then return false; end if;
    select coalesce(array_agg(user_id order by joined_at), '{}') into w from participants where bet_id = b.id and pick = b.result;
  else
    if cd <= b.start_date then return false; end if;
    select coalesce(array_agg(p.user_id order by p.joined_at), '{}') into w
      from participants p where p.bet_id = b.id and missed_days(b, p, cd) <= b.jokers;
    if b.end_date is not null then
      -- Am Tag nach dem Ende nur, wenn alle Übriggebliebenen den letzten Tag schon abgehakt haben
      done := cd >= b.end_date + 2 or (cd = b.end_date + 1 and not exists (
        select 1 from participants p where p.bet_id = b.id and p.user_id = any (w)
          and not exists (select 1 from checks c where c.bet_id = b.id and c.user_id = p.user_id and c.day = b.end_date)
          and not (p.credited_until is not null and b.end_date <= p.credited_until)));
    else
      done := (n >= 2 and cardinality(w) <= 1) or cardinality(w) = 0;
    end if;
    if not done then return false; end if;
  end if;

  nw := cardinality(w); pot := (b.stake * n)::int;
  if pot > 0 then
    if nw > 0 then
      share := pot / nw; rest := pot - share * nw;
      for i in 1..nw loop
        perform book(w[i], share + case when i <= rest then 1 else 0 end, case when n = 1 then 'refund' else 'win' end, b.id);
      end loop;
    elsif n >= 2 then
      perform book(p.user_id, b.stake::int, 'refund', b.id, null, 'Niemand hat gewonnen') from participants p where p.bet_id = b.id;
    end if; -- allein und nicht geschafft: Einsatz ist weg
  end if;

  update bets set settled_at = now(), winners = w where id = b.id;
  return true;
end $$;
revoke execute on function public.settle_bet(uuid) from public, anon, authenticated;

-- Tipp-Wette: sobald das Ergebnis eingetragen ist, sofort abrechnen
create or replace function public.settle_on_result() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform settle_bet(new.id);
  return new;
end $$;
drop trigger if exists bets_settle_on_result on public.bets;
create trigger bets_settle_on_result after update of result on public.bets
  for each row when (old.result is null and new.result is not null)
  execute function public.settle_on_result();

-- Fällige Wetten abrechnen: die App ruft das beim Laden auf (nur eigene Wetten),
-- der Zeitplan stündlich für alle.
create or replace function public.settle_my_due() returns int
language sql security definer set search_path = public as $$
  select count(*)::int from (
    select settle_bet(b.id) as ok from bets b
    where b.settled_at is null and b.type = 'challenge'
      and exists (select 1 from participants p where p.bet_id = b.id and p.user_id = auth.uid())
  ) x where ok;
$$;
grant execute on function public.settle_my_due() to authenticated;

create or replace function public.settle_all_due() returns int
language sql security definer set search_path = public as $$
  select count(*)::int from (select settle_bet(b.id) as ok from bets b where b.settled_at is null) x where ok;
$$;
revoke execute on function public.settle_all_due() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Tagesbelohnung für Solo-Challenges: höchstens 10 Punkte pro Tag, aufgeteilt auf alle
-- laufenden Solo-Challenges (1 Challenge: 10 pro Häkchen, 2: je 5, 3: je ~3 …).
-- Wer alle abhakt, bekommt 10; mehr Challenges bringen nicht mehr Punkte.
-- ---------------------------------------------------------------------------
create or replace function public.daily_reward_balance(p_user uuid, p_day date) returns void
language plpgsql security definer set search_path = public as $$
declare
  have int; want int; total int; checked int;
begin
  select count(*), count(*) filter (where exists (select 1 from checks c where c.bet_id = b.id and c.user_id = p_user and c.day = p_day))
    into total, checked
  from bets b join participants p on p.bet_id = b.id and p.user_id = p_user
  where b.type = 'challenge'
    and coalesce(p.since, b.start_date) <= p_day and (b.end_date is null or b.end_date >= p_day)
    and (b.settled_at is null or b.settled_at::date >= p_day)
    and (select count(*) from participants x where x.bet_id = b.id) = 1;
  want := case when total > 0 then round(10.0 * checked / total)::int else 0 end;
  select coalesce(sum(amount), 0) into have from point_tx where user_id = p_user and kind = 'daily' and day = p_day;
  if want <> have then
    perform book(p_user, want - have, 'daily', null, null, null, p_day);
  end if;
end $$;
revoke execute on function public.daily_reward_balance(uuid, date) from public, anon, authenticated;

create or replace function public.daily_reward() returns trigger
language plpgsql security definer set search_path = public as $$
declare r checks;
begin
  r := case when tg_op = 'DELETE' then old else new end;
  -- Nicht während das Konto gelöscht wird
  if exists (select 1 from profiles where id = r.user_id) then
    perform daily_reward_balance(r.user_id, r.day);
  end if;
  return null;
end $$;
drop trigger if exists checks_daily_reward on public.checks;
create trigger checks_daily_reward after insert or delete on public.checks
  for each row execute function public.daily_reward();

-- ---------------------------------------------------------------------------
-- Überweisen an Freunde
-- ---------------------------------------------------------------------------
create or replace function public.transfer_points(p_to uuid, p_amount int, p_note text default '')
returns void language plpgsql security definer set search_path = public as $$
declare n text := nullif(left(trim(coalesce(p_note, '')), 80), '');
begin
  if auth.uid() is null then raise exception 'Nicht angemeldet'; end if;
  if p_to = auth.uid() then raise exception 'Du kannst dir nicht selbst Punkte schicken'; end if;
  if p_amount is null or p_amount < 1 or p_amount > 100000 then raise exception 'Ungültiger Betrag'; end if;
  if not are_friends(auth.uid(), p_to) then raise exception 'Punkte kannst du nur an Freunde schicken'; end if;
  perform book(auth.uid(), -p_amount, 'transfer', null, p_to, n);
  perform book(p_to, p_amount, 'transfer', null, auth.uid(), n);
end $$;
grant execute on function public.transfer_points(uuid, int, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Montags auffüllen: wer unter 100 hat, bekommt wieder 100
-- ---------------------------------------------------------------------------
create or replace function public.weekly_topup() returns int
language sql security definer set search_path = public as $$
  select count(*)::int from (
    select book(w.user_id, 100 - w.points, 'topup') from wallets w where w.points < 100
  ) x;
$$;
revoke execute on function public.weekly_topup() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Zeitpläne
-- ---------------------------------------------------------------------------
do $$ begin perform cron.unschedule('betfriends-settle'); exception when others then null; end $$;
do $$ begin perform cron.unschedule('betfriends-topup'); exception when others then null; end $$;
select cron.schedule('betfriends-settle', '7 * * * *', 'select public.settle_all_due()');
select cron.schedule('betfriends-topup', '0 5 * * 1', 'select public.weekly_topup()');

-- Bereits beendete Wetten gleich abrechnen
select public.settle_all_due();
