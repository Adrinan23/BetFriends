-- BetFriends: Freundesliste und Sichtbarkeit pro Wette
-- Im Supabase SQL Editor einmal ausführen (nach 0001 und 0002).
--
-- Bisher galten alle, mit denen man schon eine Wette geteilt hat, automatisch
-- als Freunde. Ab jetzt gibt es eine echte Freundesliste. Damit niemand seine
-- Leute verliert, werden diese bisherigen Kontakte einmalig als Freunde übernommen.

-- ---------------------------------------------------------------------------
-- Freundescode pro Profil
-- ---------------------------------------------------------------------------

create or replace function public.random_code() returns text
language sql volatile as $$
  select string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 1 + floor(random() * 32)::int, 1), '')
  from generate_series(1, 6);
$$;

alter table public.profiles add column if not exists friend_code text unique default public.random_code();
update public.profiles set friend_code = public.random_code() where friend_code is null;
alter table public.profiles alter column friend_code set not null;

-- ---------------------------------------------------------------------------
-- Freundschaften
-- ---------------------------------------------------------------------------

create table if not exists public.friendships (
  id          uuid primary key default gen_random_uuid(),
  requester   uuid not null references public.profiles on delete cascade,
  addressee   uuid not null references public.profiles on delete cascade,
  status      text not null default 'pending' check (status in ('pending', 'accepted')),
  created_at  timestamptz not null default now(),
  check (requester <> addressee)
);
create unique index if not exists friendships_pair on public.friendships (least(requester, addressee), greatest(requester, addressee));

create or replace function public.are_friends(a uuid, b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from friendships
    where status = 'accepted'
      and least(requester, addressee) = least(a, b)
      and greatest(requester, addressee) = greatest(a, b)
  );
$$;

-- Bisherige Kontakte (gemeinsame Wette) als Freunde übernehmen
insert into public.friendships (requester, addressee, status)
select distinct least(a.user_id, b.user_id), greatest(a.user_id, b.user_id), 'accepted'
from public.participants a
join public.participants b on a.bet_id = b.bet_id and a.user_id < b.user_id
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Sichtbarkeit pro Wette: alle Freunde, ausgewählte Freunde oder niemand
-- (Mitspieler sehen ihre Wette immer). Gemeint sind die Freunde des Erstellers.
-- ---------------------------------------------------------------------------

alter table public.bets add column if not exists visibility text not null default 'friends'
  check (visibility in ('friends', 'selected', 'none'));

create table if not exists public.bet_viewers (
  bet_id   uuid not null references public.bets on delete cascade,
  user_id  uuid not null references public.profiles on delete cascade,
  primary key (bet_id, user_id)
);

-- Direkte Einladungen an Freunde (zusätzlich zum Einladungscode)
create table if not exists public.bet_invites (
  bet_id      uuid not null references public.bets on delete cascade,
  user_id     uuid not null references public.profiles on delete cascade,
  invited_by  uuid not null default auth.uid() references public.profiles on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (bet_id, user_id)
);

-- Bisherige Einstellung "Im Community Board zeigen: aus" -> Wetten dieser Person auf "niemand"
update public.bets b set visibility = 'none'
from public.profiles p
where p.id = b.creator and (p.settings ->> 'public') = 'false';

create or replace function public.can_see_bet(b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from bets x
    where x.id = b
      and (
        x.creator = auth.uid()
        or exists (select 1 from participants where bet_id = b and user_id = auth.uid())
        or exists (select 1 from bet_invites where bet_id = b and user_id = auth.uid())
        or (x.visibility = 'friends' and public.are_friends(x.creator, auth.uid()))
        or (x.visibility = 'selected' and public.are_friends(x.creator, auth.uid())
            and exists (select 1 from bet_viewers v where v.bet_id = b and v.user_id = auth.uid()))
      )
  );
$$;

create or replace function public.can_see_profile(u uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select u = auth.uid()
    or exists (select 1 from friendships f where (f.requester = u and f.addressee = auth.uid()) or (f.addressee = u and f.requester = auth.uid()))
    or exists (select 1 from participants p where p.user_id = u and public.can_see_bet(p.bet_id));
$$;

-- ---------------------------------------------------------------------------
-- Zugriffsregeln
-- ---------------------------------------------------------------------------

alter table public.friendships enable row level security;
alter table public.bet_viewers enable row level security;
alter table public.bet_invites enable row level security;

-- Einladen darf jeder Teilnehmer, aber nur eigene Freunde
drop policy if exists "bet_invites_select" on public.bet_invites;
create policy "bet_invites_select" on public.bet_invites for select to authenticated
  using (user_id = auth.uid() or invited_by = auth.uid() or public.is_participant(bet_id));
drop policy if exists "bet_invites_insert" on public.bet_invites;
create policy "bet_invites_insert" on public.bet_invites for insert to authenticated
  with check (invited_by = auth.uid() and public.is_participant(bet_id) and public.are_friends(auth.uid(), user_id));
drop policy if exists "bet_invites_delete" on public.bet_invites;
create policy "bet_invites_delete" on public.bet_invites for delete to authenticated
  using (user_id = auth.uid() or invited_by = auth.uid());

drop policy if exists "friendships_select" on public.friendships;
create policy "friendships_select" on public.friendships for select to authenticated
  using (auth.uid() in (requester, addressee));
drop policy if exists "friendships_delete" on public.friendships;
create policy "friendships_delete" on public.friendships for delete to authenticated
  using (auth.uid() in (requester, addressee));
-- Anlegen und Annehmen nur über die Funktionen unten

drop policy if exists "bet_viewers_select" on public.bet_viewers;
create policy "bet_viewers_select" on public.bet_viewers for select to authenticated
  using (user_id = auth.uid() or exists (select 1 from bets where id = bet_id and creator = auth.uid()));
drop policy if exists "bet_viewers_insert" on public.bet_viewers;
create policy "bet_viewers_insert" on public.bet_viewers for insert to authenticated
  with check (exists (select 1 from bets where id = bet_id and creator = auth.uid()) and public.are_friends(auth.uid(), user_id));
drop policy if exists "bet_viewers_delete" on public.bet_viewers;
create policy "bet_viewers_delete" on public.bet_viewers for delete to authenticated
  using (exists (select 1 from bets where id = bet_id and creator = auth.uid()));

-- ---------------------------------------------------------------------------
-- Funktionen
-- ---------------------------------------------------------------------------

-- Person per Freundescode finden (Vorschau vor dem Hinzufügen)
create or replace function public.find_user(p_code text)
returns table (id uuid, name text, color text, status text)
language sql stable security definer set search_path = public as $$
  select p.id, p.name, p.color,
    case
      when p.id = auth.uid() then 'self'
      when public.are_friends(p.id, auth.uid()) then 'friends'
      when exists (select 1 from friendships f where f.requester = auth.uid() and f.addressee = p.id) then 'sent'
      when exists (select 1 from friendships f where f.requester = p.id and f.addressee = auth.uid()) then 'received'
      else 'none'
    end
  from profiles p
  where p.friend_code = upper(trim(p_code)) and auth.uid() is not null;
$$;

-- Anfrage schicken; hat der andere schon angefragt, sind beide sofort Freunde
create or replace function public.add_friend(p_code text) returns text
language plpgsql security definer set search_path = public as $$
declare
  other uuid;
  existing friendships;
begin
  if auth.uid() is null then raise exception 'Nicht angemeldet'; end if;
  select id into other from profiles where friend_code = upper(trim(p_code));
  if other is null then raise exception 'Diesen Freundescode gibt es nicht'; end if;
  if other = auth.uid() then raise exception 'Das ist dein eigener Code'; end if;
  select * into existing from friendships
    where least(requester, addressee) = least(other, auth.uid()) and greatest(requester, addressee) = greatest(other, auth.uid());
  if found then
    if existing.status = 'accepted' then return 'friends'; end if;
    if existing.requester = other then
      update friendships set status = 'accepted' where id = existing.id;
      return 'friends';
    end if;
    return 'sent';
  end if;
  insert into friendships (requester, addressee) values (auth.uid(), other);
  return 'sent';
end $$;

create or replace function public.accept_friend(p_id uuid) returns void
language sql security definer set search_path = public as $$
  update friendships set status = 'accepted' where id = p_id and addressee = auth.uid() and status = 'pending';
$$;

-- Nach dem Beitreten ist die Einladung erledigt
create or replace function public.clear_invite() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  delete from bet_invites where bet_id = new.bet_id and user_id = new.user_id;
  return new;
end $$;
drop trigger if exists participants_clear_invite on public.participants;
create trigger participants_clear_invite after insert on public.participants
  for each row execute function public.clear_invite();

grant execute on function public.find_user(text) to authenticated;
grant execute on function public.add_friend(text) to authenticated;
grant execute on function public.accept_friend(uuid) to authenticated;

-- Live-Updates
do $$ begin
  alter publication supabase_realtime add table public.friendships, public.bet_viewers, public.bet_invites;
exception when duplicate_object then null; end $$;
