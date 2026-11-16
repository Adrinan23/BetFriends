-- BetFriends: Startdatum zurückdatieren ("ich mache das schon seit 4 Wochen")
-- Im Supabase SQL Editor einmal ausführen. Bestehende Wetten bleiben unverändert.

-- Pro Teilnehmer: ab wann zählt die Challenge für ihn, und bis wann sind Tage
-- ohne Abhaken angerechnet (die Zeit vor der App).
alter table public.participants
  add column if not exists since date,
  add column if not exists credited_until date;

alter table public.participants drop constraint if exists participants_credit_check;
alter table public.participants add constraint participants_credit_check
  check (credited_until is null or (since is not null and credited_until >= since));

-- Angerechnete Tage nie bis heute oder in die Zukunft, höchstens 3 Jahre zurück.
-- Nachträglich lassen sich "dabei seit" und angerechnete Tage nicht mehr ändern.
create or replace function public.guard_participant_dates() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    new.since := old.since;
    new.credited_until := old.credited_until;
    return new;
  end if;
  if new.since is not null and new.since < current_date - 1095 then
    raise exception 'Startdatum liegt zu weit zurück';
  end if;
  if new.credited_until is not null then
    new.credited_until := least(new.credited_until, current_date - 1);
    if new.credited_until < new.since then new.credited_until := null; end if;
  end if;
  return new;
end $$;

drop trigger if exists participants_guard_dates on public.participants;
create trigger participants_guard_dates
  before insert or update on public.participants
  for each row execute function public.guard_participant_dates();

-- Beitreten: optional "schon länger dabei" (nur bei Challenges ohne Ende).
-- Wer später einsteigt, startet sonst am Beitrittstag (verpasst also keine Tage davor).
drop function if exists public.join_bet(text, text, int);
create function public.join_bet(p_code text, p_goal text default '', p_pick int default null, p_since date default null)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  b bets;
  g text;
  s date;
  c date;
begin
  if auth.uid() is null then raise exception 'Nicht angemeldet'; end if;
  select * into b from bets where code = upper(trim(p_code));
  if not found then raise exception 'Diesen Code gibt es nicht'; end if;
  if exists (select 1 from participants where bet_id = b.id and user_id = auth.uid()) then return b.id; end if;
  if b.type = 'tipp' and b.result is not null then raise exception 'Diese Wette ist schon vorbei'; end if;
  if b.type = 'challenge' and b.end_date is not null and b.end_date < current_date then raise exception 'Diese Wette ist schon vorbei'; end if;

  if b.type = 'challenge' then
    if b.same_goal then
      select goal into g from participants where bet_id = b.id and user_id = b.creator;
    else
      g := left(trim(coalesce(p_goal, '')), 60);
      if g = '' then raise exception 'Bitte ein Ziel eintragen'; end if;
    end if;
    s := greatest(b.start_date, current_date);
    if b.end_date is null and p_since is not null and p_since < current_date then
      s := p_since;
      c := current_date - 1;
    end if;
    insert into participants (bet_id, user_id, goal, since, credited_until) values (b.id, auth.uid(), coalesce(g, ''), s, c);
  else
    if p_pick is null or p_pick < 0 or p_pick >= cardinality(b.options) then raise exception 'Bitte einen Tipp wählen'; end if;
    insert into participants (bet_id, user_id, pick) values (b.id, auth.uid(), p_pick);
  end if;

  insert into feed (bet_id, user_id, kind) values (b.id, auth.uid(), 'join');
  return b.id;
end $$;

grant execute on function public.join_bet(text, text, int, date) to authenticated;
