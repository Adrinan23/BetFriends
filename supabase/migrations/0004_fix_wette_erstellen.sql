-- BetFriends: Fix "Das darfst du hier leider nicht" beim Erstellen einer Wette
-- Im Supabase SQL Editor einmal ausführen.
--
-- Beim Anlegen liest die App die neue Wette direkt zurück. Die Lese-Regel fragte
-- dabei die Tabelle bets ab, in der die gerade eingefügte Zeile noch nicht
-- sichtbar ist. Der Ersteller wird jetzt direkt an der Zeile geprüft.

drop policy if exists "bets_select" on public.bets;
create policy "bets_select" on public.bets for select to authenticated
  using (creator = auth.uid() or public.can_see_bet(id));
