-- BetFriends: Push-Benachrichtigungen (tägliche Erinnerung)
-- Im Supabase SQL Editor einmal ausführen (nach 0001–0004).
-- Danach die Edge Function "push" anlegen (siehe README, Abschnitt Push).

-- ---------------------------------------------------------------------------
-- Push-Abos: ein Eintrag pro Gerät/Browser
-- ---------------------------------------------------------------------------
create table if not exists public.push_subscriptions (
  endpoint    text primary key,
  user_id     uuid not null default auth.uid() references public.profiles on delete cascade,
  p256dh      text not null,
  auth        text not null,
  tz          text not null default 'Europe/Berlin',
  last_daily  date,                       -- an welchem (lokalen) Tag zuletzt erinnert
  created_at  timestamptz not null default now()
);
create index if not exists push_subscriptions_user on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;
drop policy if exists "push_select_own" on public.push_subscriptions;
create policy "push_select_own" on public.push_subscriptions for select to authenticated using (user_id = auth.uid());
drop policy if exists "push_insert_own" on public.push_subscriptions;
create policy "push_insert_own" on public.push_subscriptions for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "push_update_own" on public.push_subscriptions;
create policy "push_update_own" on public.push_subscriptions for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "push_delete_own" on public.push_subscriptions;
create policy "push_delete_own" on public.push_subscriptions for delete to authenticated using (user_id = auth.uid());

-- Wechselt ein Gerät den Nutzer (Abmelden, anderer Login), gehört das Abo danach dem neuen Nutzer
create or replace function public.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text, p_tz text)
returns void language sql security definer set search_path = public as $$
  insert into push_subscriptions (endpoint, user_id, p256dh, auth, tz)
  select p_endpoint, auth.uid(), p_p256dh, p_auth, coalesce(nullif(p_tz, ''), 'Europe/Berlin')
  where auth.uid() is not null
  on conflict (endpoint) do update
    set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, tz = excluded.tz;
$$;
grant execute on function public.save_push_subscription(text, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Interne Schlüssel (VAPID). Nur die Server-Funktion darf hier lesen/schreiben.
-- ---------------------------------------------------------------------------
create table if not exists public.app_secrets (
  key    text primary key,
  value  text not null
);
alter table public.app_secrets enable row level security;  -- keine Regeln = für App-Nutzer unsichtbar
revoke all on public.app_secrets from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Wer ist jetzt fällig? Lokale Uhrzeit >= Erinnerungszeit, heute noch nicht
-- erinnert, und mindestens eine laufende Challenge heute noch nicht abgehakt.
-- ---------------------------------------------------------------------------
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
    select s.endpoint, b.title,
      -- verpasste Tage bis gestern (wie in der App: weder abgehakt noch angerechnet)
      (select count(*) from generate_series(coalesce(p.since, b.start_date),
                                            least(coalesce(b.end_date, s.today - 1), s.today - 1), interval '1 day') d
        where not exists (select 1 from checks c where c.bet_id = b.id and c.user_id = p.user_id and c.day = d::date)
          and not (p.credited_until is not null and d::date <= p.credited_until)) as missed,
      b.jokers
    from subs s
    join participants p on p.user_id = s.user_id
    join bets b on b.id = p.bet_id
    where b.type = 'challenge'
      and coalesce(p.since, b.start_date) <= s.today
      and (b.end_date is null or b.end_date >= s.today)
      and not exists (select 1 from checks c where c.bet_id = b.id and c.user_id = p.user_id and c.day = s.today)
  )
  select s.endpoint, s.p256dh, s.auth, s.user_id, s.today,
         array_agg(o.title order by o.title)
  from subs s
  join open_bets o on o.endpoint = s.endpoint and o.missed <= o.jokers
  where s.daily_on
    and s.local_ts::time >= s.reminder::time
    and (s.last_daily is null or s.last_daily < s.today)
  group by s.endpoint, s.p256dh, s.auth, s.user_id, s.today;
$$;
revoke execute on function public.due_daily_reminders() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Zeitplan: alle 15 Minuten die Server-Funktion "push" aufrufen
-- ---------------------------------------------------------------------------
create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$ begin
  perform cron.unschedule('betfriends-daily-reminder');
exception when others then null; end $$;

select cron.schedule(
  'betfriends-daily-reminder',
  '*/15 * * * *',
  $cron$
    select net.http_post(
      url := 'https://ufkmwqwxryerbifflfmj.supabase.co/functions/v1/push',
      headers := '{"Content-Type": "application/json"}'::jsonb,
      body := '{"action": "daily"}'::jsonb
    );
  $cron$
);
