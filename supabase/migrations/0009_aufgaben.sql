-- BetFriends: private Aufgabenliste ("Aufgaben"-Ansicht)
-- Im Supabase SQL Editor einmal ausführen (nach 0001–0008). Darf erneut ausgeführt werden.
--
-- Regeln:
--   * Aufgaben sieht nur, wer sie angelegt hat. Keine Punkte.
--   * repeat: once (einmalig), daily (täglich), every (alle every_n Tage), weekdays (an Wochentagen, 1 = Mo … 7 = So)
--   * due = nächster Fälligkeitstag. Unerledigtes bleibt fällig und erscheint damit automatisch unter "Heute".
--   * Abhaken setzt last_done; wiederkehrende Aufgaben bekommen ein neues due, einmalige done_at.
--     prev_due merkt sich das alte due, damit man Abhaken rückgängig machen kann.

create table if not exists public.tasks (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  title      text not null check (char_length(trim(title)) between 1 and 100),
  repeat     text not null default 'once' check (repeat in ('once', 'daily', 'every', 'weekdays')),
  every_n    int check (every_n between 2 and 60),
  weekdays   int[] check (weekdays <@ array[1,2,3,4,5,6,7]),
  due        date not null,
  last_done  date,
  prev_due   date,
  done_at    timestamptz,
  created_at timestamptz not null default now(),
  constraint tasks_repeat_ok check (
    (repeat <> 'every' or every_n is not null)
    and (repeat <> 'weekdays' or coalesce(cardinality(weekdays), 0) between 1 and 7))
);
create index if not exists tasks_user_idx on public.tasks (user_id, due);

alter table public.tasks enable row level security;
drop policy if exists tasks_own on public.tasks;
create policy tasks_own on public.tasks for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
grant select, insert, update, delete on public.tasks to authenticated;
