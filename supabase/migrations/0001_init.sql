-- BetFriends: Grundschema
-- Im Supabase-Dashboard unter "SQL Editor" einmal komplett ausführen.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Tabellen
-- ---------------------------------------------------------------------------

create table public.profiles (
  id          uuid primary key references auth.users on delete cascade,
  name        text not null check (char_length(name) between 1 and 20),
  color       text not null default '#52525B' check (color ~ '^#[0-9A-Fa-f]{6}$'),
  settings    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create table public.bets (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique check (code ~ '^[A-Z0-9]{6}$'),
  type        text not null check (type in ('challenge', 'tipp')),
  emoji       text not null default '🔥' check (char_length(emoji) <= 8),
  title       text not null check (char_length(title) between 1 and 60),
  descr       text not null default '' check (char_length(descr) <= 140),
  creator     uuid not null default auth.uid() references public.profiles on delete cascade,
  stake       numeric(10, 2) not null default 0 check (stake >= 0 and stake <= 100000),
  start_date  date not null,
  end_date    date,                       -- null = ohne Ende
  jokers      int not null default 0 check (jokers between 0 and 10),
  same_goal   boolean not null default false,
  options     text[] not null default '{}',
  result      int,                        -- Index der richtigen Option (Tipp-Wette)
  created_at  timestamptz not null default now(),
  check (end_date is null or end_date >= start_date),
  check (type = 'challenge' or cardinality(options) between 2 and 6)
);

create table public.participants (
  bet_id      uuid not null references public.bets on delete cascade,
  user_id     uuid not null default auth.uid() references public.profiles on delete cascade,
  goal        text not null default '' check (char_length(goal) <= 60),
  pick        int,
  joined_at   timestamptz not null default now(),
  primary key (bet_id, user_id)
);

create table public.checks (
  bet_id      uuid not null,
  user_id     uuid not null default auth.uid(),
  day         date not null,
  created_at  timestamptz not null default now(),
  primary key (bet_id, user_id, day),
  foreign key (bet_id, user_id) references public.participants on delete cascade
);

create table public.feed (
  id          uuid primary key default gen_random_uuid(),
  bet_id      uuid not null references public.bets on delete cascade,
  user_id     uuid not null default auth.uid() references public.profiles on delete cascade,
  kind        text not null check (kind in ('new', 'join', 'check', 'joker', 'result')),
  created_at  timestamptz not null default now()
);
create index feed_bet_idx on public.feed (bet_id, created_at desc);

create table public.reactions (
  feed_id     uuid not null references public.feed on delete cascade,
  user_id     uuid not null default auth.uid() references public.profiles on delete cascade,
  emoji       text not null check (emoji in ('🔥', '💪', '👏', '😂', '🤨')),
  primary key (feed_id, user_id, emoji)
);

create table public.comments (
  id          uuid primary key default gen_random_uuid(),
  bet_id      uuid not null references public.bets on delete cascade,
  feed_id     uuid references public.feed on delete cascade,   -- null = Kommentar zur Wette selbst
  user_id     uuid not null default auth.uid() references public.profiles on delete cascade,
  body        text not null check (char_length(body) between 1 and 280),
  created_at  timestamptz not null default now()
);
create index comments_bet_idx on public.comments (bet_id, created_at);

-- ---------------------------------------------------------------------------
-- Profil automatisch beim Registrieren anlegen
-- ---------------------------------------------------------------------------

create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, name)
  values (new.id, left(coalesce(nullif(trim(new.raw_user_meta_data ->> 'name'), ''), split_part(new.email, '@', 1)), 20));
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Sichtbarkeit
-- Eine Wette sieht man, wenn man mitmacht, sie erstellt hat, oder wenn ein
-- "Freund" (jemand, mit dem man schon eine Wette teilt) mitmacht und sein
-- Profil öffentlich ist (Einstellung "Im Community Board zeigen").
-- ---------------------------------------------------------------------------

create function public.is_participant(b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from participants where bet_id = b and user_id = auth.uid());
$$;

create function public.can_see_bet(b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select
    exists (select 1 from bets where id = b and creator = auth.uid())
    or exists (
      select 1
      from participants p
      where p.bet_id = b
        and (
          p.user_id = auth.uid()
          or (
            coalesce((select (pr.settings ->> 'public')::boolean from profiles pr where pr.id = p.user_id), true)
            and exists (
              select 1
              from participants mine
              join participants theirs on theirs.bet_id = mine.bet_id
              where mine.user_id = auth.uid() and theirs.user_id = p.user_id
            )
          )
        )
    );
$$;

create function public.can_see_profile(u uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select u = auth.uid()
    or exists (select 1 from participants p where p.user_id = u and public.can_see_bet(p.bet_id));
$$;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.profiles     enable row level security;
alter table public.bets         enable row level security;
alter table public.participants enable row level security;
alter table public.checks       enable row level security;
alter table public.feed         enable row level security;
alter table public.reactions    enable row level security;
alter table public.comments     enable row level security;

-- Profile
create policy "profiles_select" on public.profiles for select to authenticated using (public.can_see_profile(id));
create policy "profiles_update_own" on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- Wetten
create policy "bets_select" on public.bets for select to authenticated using (public.can_see_bet(id));
create policy "bets_insert" on public.bets for insert to authenticated with check (creator = auth.uid() and result is null);
create policy "bets_update_creator" on public.bets for update to authenticated using (creator = auth.uid()) with check (creator = auth.uid());
create policy "bets_delete_creator" on public.bets for delete to authenticated using (creator = auth.uid());

-- Teilnehmer (Freunde treten über join_bet() bei; direkt eintragen darf sich nur der Ersteller selbst)
create policy "participants_select" on public.participants for select to authenticated using (public.can_see_bet(bet_id));
create policy "participants_insert_creator" on public.participants for insert to authenticated
  with check (user_id = auth.uid() and exists (select 1 from bets where id = bet_id and creator = auth.uid()));
create policy "participants_update_own" on public.participants for update to authenticated
  using (user_id = auth.uid() and exists (select 1 from bets where id = bet_id and result is null))
  with check (user_id = auth.uid());

-- Abhaken: nur eigene Einträge, nur rund um heute (gegen nachträgliches Schummeln)
create policy "checks_select" on public.checks for select to authenticated using (public.can_see_bet(bet_id));
create policy "checks_insert_own" on public.checks for insert to authenticated
  with check (user_id = auth.uid() and public.is_participant(bet_id) and day between current_date - 1 and current_date + 1);
create policy "checks_delete_own" on public.checks for delete to authenticated
  using (user_id = auth.uid() and day between current_date - 1 and current_date + 1);

-- Feed
create policy "feed_select" on public.feed for select to authenticated using (public.can_see_bet(bet_id));
create policy "feed_insert_own" on public.feed for insert to authenticated
  with check (user_id = auth.uid() and public.is_participant(bet_id) and kind in ('check', 'joker', 'result', 'new'));
create policy "feed_delete_own" on public.feed for delete to authenticated using (user_id = auth.uid());

-- Reaktionen
create policy "reactions_select" on public.reactions for select to authenticated
  using (exists (select 1 from feed f where f.id = feed_id and public.can_see_bet(f.bet_id)));
create policy "reactions_insert_own" on public.reactions for insert to authenticated
  with check (user_id = auth.uid() and exists (select 1 from feed f where f.id = feed_id and public.can_see_bet(f.bet_id)));
create policy "reactions_delete_own" on public.reactions for delete to authenticated using (user_id = auth.uid());

-- Kommentare
create policy "comments_select" on public.comments for select to authenticated using (public.can_see_bet(bet_id));
create policy "comments_insert_own" on public.comments for insert to authenticated
  with check (
    user_id = auth.uid() and public.can_see_bet(bet_id)
    and (feed_id is null or exists (select 1 from feed f where f.id = feed_id and f.bet_id = comments.bet_id))
  );
create policy "comments_delete_own" on public.comments for delete to authenticated using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Beitreten per Code
-- ---------------------------------------------------------------------------

-- Vorschau einer Wette anhand des Codes (auch wenn man sie noch nicht sehen darf)
create function public.find_bet(p_code text)
returns table (
  id uuid, type text, emoji text, title text, descr text, stake numeric, start_date date, end_date date,
  jokers int, same_goal boolean, options text[], result int, creator_name text, shared_goal text,
  participant_count int, already_joined boolean
)
language sql stable security definer set search_path = public as $$
  select b.id, b.type, b.emoji, b.title, b.descr, b.stake, b.start_date, b.end_date,
         b.jokers, b.same_goal, b.options, b.result,
         (select name from profiles where id = b.creator),
         (select goal from participants where bet_id = b.id and user_id = b.creator),
         (select count(*)::int from participants where bet_id = b.id),
         exists (select 1 from participants where bet_id = b.id and user_id = auth.uid())
  from bets b
  where b.code = upper(trim(p_code)) and auth.uid() is not null;
$$;

create function public.join_bet(p_code text, p_goal text default '', p_pick int default null)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  b bets;
  g text;
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
    insert into participants (bet_id, user_id, goal) values (b.id, auth.uid(), coalesce(g, ''));
  else
    if p_pick is null or p_pick < 0 or p_pick >= cardinality(b.options) then raise exception 'Bitte einen Tipp wählen'; end if;
    insert into participants (bet_id, user_id, pick) values (b.id, auth.uid(), p_pick);
  end if;

  insert into feed (bet_id, user_id, kind) values (b.id, auth.uid(), 'join');
  return b.id;
end $$;

grant execute on function public.find_bet(text) to authenticated;
grant execute on function public.join_bet(text, text, int) to authenticated;

-- ---------------------------------------------------------------------------
-- Live-Updates
-- ---------------------------------------------------------------------------

alter publication supabase_realtime add table
  public.bets, public.participants, public.checks, public.feed, public.reactions, public.comments, public.profiles;
