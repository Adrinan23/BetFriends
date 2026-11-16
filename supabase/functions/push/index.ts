// BetFriends Edge Function "push"
// Aktionen (POST, JSON-Body { action }):
//   "key"   -> öffentlicher VAPID-Schlüssel für die App (wird beim ersten Aufruf erzeugt)
//   "daily" -> tägliche Erinnerungen an alle, die jetzt fällig sind (vom Zeitplan alle 15 Min.)
//   "test"  -> Test-Benachrichtigung an die eigenen Geräte (braucht Login)
// In Supabase unter Edge Functions mit dem Namen "push" anlegen und "Verify JWT" ausschalten.

import * as webpush from "jsr:@negrel/webpush@0.5.0";
import { createClient } from "jsr:@supabase/supabase-js@2";

const URL_ = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  (() => { try { return Object.values(JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}"))[0] as string; } catch { return ""; } })();
const db = createClient(URL_, SERVICE_KEY, { auth: { persistSession: false } });

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

let cached: { keys: CryptoKeyPair; server: webpush.ApplicationServer; publicKey: string } | null = null;

async function vapid() {
  if (cached) return cached;
  const { data } = await db.from("app_secrets").select("value").eq("key", "vapid").maybeSingle();
  let exported = data ? JSON.parse(data.value) : null;
  if (!exported) {
    const fresh = await webpush.generateVapidKeys({ extractable: true });
    exported = await webpush.exportVapidKeys(fresh);
    // Falls parallel schon jemand Schlüssel angelegt hat, gewinnt der erste
    await db.from("app_secrets").insert({ key: "vapid", value: JSON.stringify(exported) });
    const again = await db.from("app_secrets").select("value").eq("key", "vapid").single();
    exported = JSON.parse(again.data!.value);
  }
  const keys = await webpush.importVapidKeys(exported, { extractable: false });
  const server = await webpush.ApplicationServer.new({ contactInformation: "https://bet-friends-nine.vercel.app", vapidKeys: keys });
  cached = { keys, server, publicKey: await webpush.exportApplicationServerKey(keys) };
  return cached;
}

type Sub = { endpoint: string; p256dh: string; auth: string };

async function send(sub: Sub, payload: Record<string, unknown>) {
  const { server } = await vapid();
  try {
    await server.subscribe({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } })
      .pushTextMessage(JSON.stringify(payload), { ttl: 60 * 60 * 6, urgency: webpush.Urgency.Normal });
    return "ok";
  } catch (e) {
    // Abo existiert nicht mehr (App gelöscht, Erlaubnis entzogen) -> aufräumen
    const status = (e as { response?: Response }).response?.status;
    if (status === 404 || status === 410) {
      await db.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
      return "gone";
    }
    console.error("push failed", status, String(e));
    return "error";
  }
}

function reminderText(titles: string[]) {
  const list = titles.length <= 3 ? titles.join(", ") : `${titles.slice(0, 2).join(", ")} und ${titles.length - 2} weitere`;
  return { title: "Heute schon abgehakt?", body: `Noch offen: ${list}`, url: "/", tag: "daily" };
}

async function daily() {
  const { data, error } = await db.rpc("due_daily_reminders");
  if (error) throw error;
  const result = { sent: 0, gone: 0, errors: 0 };
  for (const r of data ?? []) {
    const status = await send(r, reminderText(r.open_titles));
    if (status === "ok") {
      result.sent++;
      await db.from("push_subscriptions").update({ last_daily: r.local_day }).eq("endpoint", r.endpoint);
    } else if (status === "gone") result.gone++;
    else result.errors++;
  }
  return result;
}

async function test(req: Request) {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: u } = await db.auth.getUser(token);
  if (!u?.user) return json({ error: "Nicht angemeldet" }, 401);
  const { data: subs } = await db.from("push_subscriptions").select("endpoint,p256dh,auth").eq("user_id", u.user.id);
  let sent = 0;
  for (const s of subs ?? []) if (await send(s, { title: "BetFriends", body: "Benachrichtigungen funktionieren 👍", url: "/" }) === "ok") sent++;
  return json({ sent });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { action } = await req.json().catch(() => ({ action: "" }));
    if (action === "key") return json({ publicKey: (await vapid()).publicKey });
    if (action === "daily") return json(await daily());
    if (action === "test") return await test(req);
    return json({ error: "Unbekannte Aktion" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: String(e) }, 500);
  }
});
