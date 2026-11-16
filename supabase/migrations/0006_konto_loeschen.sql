-- BetFriends: Konto selbst löschen (DSGVO, Art. 17)
-- Im Supabase SQL Editor einmal ausführen (nach 0001–0005).
--
-- Löscht den angemeldeten Nutzer aus auth.users. Über "on delete cascade" verschwinden
-- damit automatisch Profil, Teilnahmen, Häkchen, Feed, Kommentare, Reaktionen,
-- Freundschaften, Einladungen, Push-Abos und die selbst erstellten Wetten.

create or replace function public.delete_my_account()
returns void language plpgsql security definer set search_path = public, auth as $$
begin
  if auth.uid() is null then
    raise exception 'Nicht angemeldet';
  end if;
  delete from auth.users where id = auth.uid();
end;
$$;
revoke execute on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
