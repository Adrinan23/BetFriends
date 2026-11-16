# BetFriends

Wetten und Challenges unter Freunden, als Web-App (PWA) zum Installieren auf dem Handy.

- **Challenges:** jeden Tag abhaken, mit Jokern, festem Zeitraum oder ohne Ende („wer hält am längsten durch?“)
- **Tipp-Wetten:** jeder tippt, der Ersteller trägt das Ergebnis ein
- **Einladen per Code** oder Link (`/?code=ABC123`)
- **Community:** Challenges der Freunde, Feed mit Emoji-Reaktionen und Kommentaren
- **Einstellungen:** Hell/Dunkel/System, Profil, Standardwerte, Privatsphäre, Abmelden

Die App bewegt kein Geld. Sie zeigt nur an, wer wie viel setzt; bezahlt wird unter den Freunden.

## Technik

- [Vite](https://vitejs.dev) + Vanilla JS (`src/`)
- [Supabase](https://supabase.com): Login, Datenbank mit Row Level Security, Live-Updates
- Hosting z. B. auf [Vercel](https://vercel.com)

## Einrichtung

### 1. Supabase

1. Auf supabase.com ein neues Projekt anlegen.
2. **SQL Editor** öffnen und die Dateien aus [`supabase/migrations/`](supabase/migrations/) **der Reihe nach** (0001, 0002, …) einfügen und ausführen. Bei späteren Updates nur die neuen Dateien ausführen.
3. **Authentication → URL Configuration:** „Site URL“ auf die spätere Adresse der App setzen (z. B. `https://betfriends.vercel.app`) und dieselbe Adresse unter „Redirect URLs“ eintragen. Sonst führen die Bestätigungs-Mails ins Leere.
4. **Project Settings → API:** „Project URL“ und „anon public key“ kopieren.

### 2. Vercel

1. Auf vercel.com mit GitHub anmelden, **Add New → Project**, das Repo `BetFriends` importieren.
2. Framework wird als „Vite“ erkannt. Unter **Environment Variables** eintragen:
   - `VITE_SUPABASE_URL` = Project URL
   - `VITE_SUPABASE_ANON_KEY` = anon public key
3. **Deploy**. Jeder Push auf `main` wird danach automatisch live gestellt.

### Lokal entwickeln

```bash
cp .env.example .env   # Werte aus Supabase eintragen
npm install
npm run dev
```

## Datenschutz und Regeln in der Datenbank

- Eine Wette sehen nur Teilnehmer, der Ersteller und Freunde (Leute, mit denen man schon eine Wette teilt), sofern deren Profil öffentlich ist.
- Beitreten geht nur über den Code (`join_bet`), abhaken nur für sich selbst und nur für gestern bis morgen.
- Tipps lassen sich nach dem Ergebnis nicht mehr ändern; das Ergebnis trägt nur der Ersteller ein.

## Push-Benachrichtigungen (tägliche Erinnerung)

Einmalig einrichten:

1. `supabase/migrations/0005_push.sql` im SQL Editor ausführen. Das legt die Tabelle für Push-Abos an und einen Zeitplan (pg_cron), der alle 15 Minuten die Funktion `Push` aufruft.
2. **Edge Functions → Deploy a new function → Via Editor**, Name **`Push`** (Adresse endet auf `/functions/v1/Push`), den Inhalt von [`supabase/functions/push/index.ts`](supabase/functions/push/index.ts) einfügen und **Deploy**.
3. In der Funktion unter **Details** „Verify JWT“ / „Enforce JWT Verification“ **ausschalten** (der Zeitplan ruft ohne Login auf; die Funktion prüft selbst, wer was darf).

Die Schlüssel für Web Push (VAPID) erzeugt die Funktion beim ersten Aufruf selbst und speichert sie in `app_secrets`; dort kann kein App-Nutzer lesen.

In der App: **Einstellungen → Benachrichtigungen → Erlauben**, Uhrzeit wählen, mit „Test“ prüfen. Erinnert wird nur, wenn an dem Tag noch eine laufende Challenge offen ist. Auf dem iPhone geht das nur in der installierten App (Home-Bildschirm, iOS 16.4+).

## Datenschutz, Nutzungsregeln

Die Seiten liegen als einfache HTML-Dateien in `public/` (`datenschutz.html`, `nutzungsregeln.html`) und sind auch ohne Anmeldung erreichbar. Verlinkt sind sie auf dem Anmeldebildschirm, bei der Registrierung (Pflicht-Häkchen für Mindestalter und Regeln) und in den Einstellungen unter „Rechtliches“. Das Mindestalter steht in `src/main.js` (`MIN_AGE`) und in `nutzungsregeln.html`.

„Konto löschen“ in den Einstellungen braucht `supabase/migrations/0006_konto_loeschen.sql` (einmal im SQL Editor ausführen).

Die Schrift Inter wird über `@fontsource/inter` selbst ausgeliefert, nicht von Google Fonts.

## Punkte

Gesetzt wird mit Spielpunkten (`supabase/migrations/0007_punkte.sql`, einmal im SQL Editor ausführen). Jeder startet mit 1.000 Punkten; Einsatz wird beim Beitreten abgezogen; Abrechnung läuft auf dem Server (`settle_bet`), beim Laden der App für die eigenen Wetten und stündlich per pg_cron für alle. Solo-Challenges: bis zu 10 Punkte pro Tag, aufgeteilt auf alle laufenden Solo-Challenges. Überweisen nur an Freunde. Montags werden Konten unter 100 auf 100 aufgefüllt. Punkte kann man nicht kaufen oder auszahlen.

## Als App installieren

- **Android/Chrome:** In der App erscheint ein „Installieren“-Hinweis.
- **iPhone:** In Safari auf „Teilen“ → „Zum Home-Bildschirm“. Nur so gibt es auf dem iPhone später Push-Benachrichtigungen.

## Nächste Schritte

- Push bei Kommentaren, Reaktionen und neuen Wetten, Wochenrückblick
- Eigene interne Währung (Punkte) zusätzlich zu Euro
