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
2. **SQL Editor** öffnen, den Inhalt von [`supabase/migrations/0001_init.sql`](supabase/migrations/0001_init.sql) einfügen und ausführen.
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

## Als App installieren

- **Android/Chrome:** In der App erscheint ein „Installieren“-Hinweis.
- **iPhone:** In Safari auf „Teilen“ → „Zum Home-Bildschirm“. Nur so gibt es auf dem iPhone später Push-Benachrichtigungen.

## Nächste Schritte

- Push-Benachrichtigungen (tägliche Erinnerung, Kommentare, Reaktionen)
- Eigene interne Währung (Punkte) zusätzlich zu Euro
