-- BetFriends: Challenges mit Wochenziel ("4× pro Woche ins Gym")
-- Im Supabase SQL Editor einmal ausführen (nach 0001–0007). Darf erneut ausgeführt werden.
--
-- Regeln:
--   * per_week = 1..6: so oft muss man pro Woche (Mo–So) abhaken. null = jeden Tag (wie bisher).
--   * Eine Woche ist geschafft, wenn das Ziel erreicht ist. Angebrochene Wochen am Anfang/Ende:
--     Ziel = höchstens so viele Tage, wie die Woche dort hat.
--   * Verfehlte Wochen kosten einen Joker; mehr verfehlte Wochen als Joker = raus.
--   * Bewertet wird eine Woche erst, wenn ihr Sonntag vorbei ist (+ 1 Tag Kulanz zum Nachhaken).

alter table public.bets add column if not exists per_week int;
alter table public.bets drop constraint if exists bets_per_week_check;
alter table public.bets add constraint bets_per_week_check
  check (per_week is null or (type = 'challenge' and per_week between 1 and 6));

-- Wochenziel nachträglich nicht änderbar (wie Startdatum)
create or replace function public.guard_per_week() returns trigger
language plpgsql as $$
begin
  if current_user in ('authenticated', 'anon') then new.per_week := old.per_week; end if;
  return new;
end $$;
drop trigger if exists bets_guard_per_week on public.bets;
create trigger bets_guard_per_week before update on public.bets
  for each row execute function public.guard_per_week();

-- Ziel und Stand einer Woche (die Woche, in der p_day liegt) für einen Teilnehmer
create or replace function public.week_progress(b bets, p participants, p_day date, out target int, out done int, out week_end date)
language sql stable set search_path = public as $$
  with w as (
    select date_trunc('week', p_day)::date as mon
  ), r as (
    select greatest(w.mon, coalesce(p.since, b.start_date)) as d0,
           least(w.mon + 6, coalesce(b.end_date, w.mon + 6)) as d1
    from w
  )
  select least(b.per_week, greatest(0, r.d1 - r.d0 + 1))::int,
         (select count(*)::int from generate_series(r.d0, r.d1, interval '1 day') d
           where exists (select 1 from checks c where c.bet_id = b.id and c.user_id = p.user_id and c.day = d::date)
              or (p.credited_until is not null and d::date <= p.credited_until)),
         r.d1
  from r;
$$;

-- Verpasste Tage (täglich) bzw. verfehlte Wochen (Wochenziel), Stand cd mit 1 Tag Kulanz
create or replace function public.missed_days(b bets, p participants, cd date) returns int
language plpgsql stable set search_path = public as $$
declare
  s date := coalesce(p.since, b.start_date);
  m date; n int := 0; wp record;
begin
  if b.per_week is null then
    select count(*)::int into n
    from generate_series(s, least(coalesce(b.end_date, cd - 2), cd - 2), interval '1 day') d
    where not exists (select 1 from checks c where c.bet_id = b.id and c.user_id = p.user_id and c.day = d::date)
      and not (p.credited_until is not null and d::date <= p.credited_until);
    return n;
  end if;
  m := date_trunc('week', s)::date;
  loop
    exit when b.end_date is not null and m > b.end_date;
    select * into wp from week_progress(b, p, m);
    exit when wp.week_end > cd - 2;          -- Woche noch nicht bewertet
    if wp.done < wp.target then n := n + 1; end if;
    m := m + 7;
  end loop;
  return n;
end $$;

-- Abrechnung: bei Wochenziel mit Ende erst, wenn die letzte Woche bewertet ist (2 Tage nach Ende)
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
      done := cd >= b.end_date + 2 or (b.per_week is null and cd = b.end_date + 1 and not exists (
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
    end if;
  end if;

  update bets set settled_at = now(), winners = w where id = b.id;
  return true;
end $$;
revoke execute on function public.settle_bet(uuid) from public, anon, authenticated;

-- Tagesbelohnung: tägliche Solo-Challenges zählen immer mit, Wochenziel-Solo-Challenges
-- nur an Tagen, an denen abgehakt wurde (Ruhetage drücken die Belohnung nicht)
create or replace function public.daily_reward_balance(p_user uuid, p_day date) returns void
language plpgsql security definer set search_path = public as $$
declare
  have int; want int; total int; checked int;
begin
  with solo as (
    select b.id, b.per_week,
           exists (select 1 from checks c where c.bet_id = b.id and c.user_id = p_user and c.day = p_day) as chk
    from bets b join participants p on p.bet_id = b.id and p.user_id = p_user
    where b.type = 'challenge'
      and coalesce(p.since, b.start_date) <= p_day and (b.end_date is null or b.end_date >= p_day)
      and (b.settled_at is null or b.settled_at::date >= p_day)
      and (select count(*) from participants x where x.bet_id = b.id) = 1
  )
  select count(*) filter (where per_week is null or chk), count(*) filter (where chk)
    into total, checked from solo;
  want := case when total > 0 then round(10.0 * checked / total)::int else 0 end;
  select coalesce(sum(amount), 0) into have from point_tx where user_id = p_user and kind = 'daily' and day = p_day;
  if want <> have then
    perform book(p_user, want - have, 'daily', null, null, null, p_day);
  end if;
end $$;
revoke execute on function public.daily_reward_balance(uuid, date) from public, anon, authenticated;

-- Erinnerung: Wochenziel-Challenges nur, wenn es knapp wird (heute muss man, sonst ist die Woche verfehlt)
create or replace function public.due_daily_reminders()
returns table (endpoint text, p256dh text, auth text, user_id uuid, local_day date, open_titles text[])
language sql stable security definer set search_path = public as $$
  with subs as (
    select s.*, (now() at time zone s.tz) as local_ts, (now() at time zone s.tz)::date as today,
           coalesce(pr.settings ->> 'reminder', '20:00') as reminder,
           coalesce((pr.settings ->> 'notifDaily')::boolean, true) as daily_on
    from push_subscriptions s
    join profiles pr on pr.id = s.user_id
  ),
  open_bets as (
    select s.endpoint, b.title, b.per_week, b.jokers,
           missed_days(b, p, s.today + 1) as missed,
           (week_progress(b, p, s.today)).*,
           s.today
    from subs s
    join participants p on p.user_id = s.user_id
    join bets b on b.id = p.bet_id
    where b.type = 'challenge' and b.settled_at is null
      and coalesce(p.since, b.start_date) <= s.today
      and (b.end_date is null or b.end_date >= s.today)
      and not exists (select 1 from checks c where c.bet_id = b.id and c.user_id = p.user_id and c.day = s.today)
  )
  select s.endpoint, s.p256dh, s.auth, s.user_id, s.today,
         array_agg(o.title order by o.title)
  from subs s
  join open_bets o on o.endpoint = s.endpoint and o.missed <= o.jokers
    and (o.per_week is null or (o.target - o.done) >= (o.week_end - o.today + 1))
  where s.daily_on
    and s.local_ts::time >= s.reminder::time
    and (s.last_daily is null or s.last_daily < s.today)
  group by s.endpoint, s.p256dh, s.auth, s.user_id, s.today;
$$;
revoke execute on function public.due_daily_reminders() from public, anon, authenticated;

-- Vorschau beim Beitreten: jetzt mit Wochenziel
drop function if exists public.find_bet(text);
create function public.find_bet(p_code text)
returns table (
  id uuid, type text, emoji text, title text, descr text, stake numeric, start_date date, end_date date,
  jokers int, same_goal boolean, options text[], result int, creator_name text, shared_goal text,
  participant_count int, already_joined boolean, per_week int
)
language sql stable security definer set search_path = public as $$
  select b.id, b.type, b.emoji, b.title, b.descr, b.stake, b.start_date, b.end_date,
         b.jokers, b.same_goal, b.options, b.result,
         (select name from profiles where id = b.creator),
         (select goal from participants where bet_id = b.id and user_id = b.creator),
         (select count(*)::int from participants where bet_id = b.id),
         exists (select 1 from participants where bet_id = b.id and user_id = auth.uid()),
         b.per_week
  from bets b
  where b.code = upper(trim(p_code)) and auth.uid() is not null;
$$;
grant execute on function public.find_bet(text) to authenticated;
