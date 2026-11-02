import { SQL } from "bun";
import webpush from "web-push";
import http2 from "node:http2";
import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";

const env = Bun.env;
const APP_NAME = "Raise Your Right Hand";
const MAX_METERS = Number(env.MAX_METERS ?? 100); // spotter must be this close to the asked member
const WINDOW_MIN = Number(env.WINDOW_MIN ?? 5); // asked member's last known location must be at most this old
const RESPOND_MIN = Number(env.RESPOND_MIN ?? 20); // how long an asked member is "on the clock" (and tracked)
const PICK_WINDOW_MIN = Number(env.PICK_WINDOW_MIN ?? 20); // how long a picked member has to use their chance to ask
const PICK_PERCENT = Number(env.PICK_PERCENT ?? 3.36); // share of members picked each day to ask someone to raise
const GAME_START = Number(env.GAME_START ?? 150); // no one is picked until this many members have joined
// Apple push (set these as Railway variables; push to iPhones is skipped until they exist)
const APNS_KEY = (env.APNS_KEY ?? "").replace(/\\n/g, "\n"); // contents of the .p8 file
const APNS_KEY_ID = env.APNS_KEY_ID ?? "";
const APNS_TEAM_ID = env.APNS_TEAM_ID ?? "RNDGPS64D6";
const APNS_TOPIC = env.APNS_TOPIC ?? "ai.nearune.raise"; // the app's bundle ID
const APNS_HOST = env.APNS_ENV === "sandbox" ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com";
// Apple WeatherKit (sky background): set WEATHERKIT_KEY (.p8 contents) and WEATHERKIT_KEY_ID as Railway variables
const WK_KEY = (env.WEATHERKIT_KEY ?? "").replace(/\\n/g, "\n");
const WK_KEY_ID = env.WEATHERKIT_KEY_ID ?? "";
const REVIEW_CODE = (env.REVIEW_CODE ?? "APPLE-REVIEW").toUpperCase(); // lets App Review open a demo walkthrough
const sql = new SQL(env.DATABASE_URL!);

// ---------- database ----------
async function init() {
  await sql`CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, created TIMESTAMPTZ NOT NULL DEFAULT now(), last_seen TIMESTAMPTZ NOT NULL DEFAULT now(), push_sub TEXT)`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS apns_token TEXT`;
  await sql`CREATE TABLE IF NOT EXISTS sends (id SERIAL PRIMARY KEY, sender_id INT NOT NULL, target_id INT NOT NULL, day TEXT NOT NULL, ts TIMESTAMPTZ NOT NULL DEFAULT now(), expires_ts TIMESTAMPTZ NOT NULL, status TEXT NOT NULL, raised_ts TIMESTAMPTZ, lat DOUBLE PRECISION, lng DOUBLE PRECISION, acc DOUBLE PRECISION)`;
  await sql`CREATE TABLE IF NOT EXISTS pings (id SERIAL PRIMARY KEY, send_id INT NOT NULL, ts TIMESTAMPTZ NOT NULL DEFAULT now(), lat DOUBLE PRECISION NOT NULL, lng DOUBLE PRECISION NOT NULL, acc DOUBLE PRECISION)`;
  await sql`CREATE INDEX IF NOT EXISTS pings_send_ts ON pings (send_id, ts DESC)`;
  await sql`CREATE TABLE IF NOT EXISTS matches (id SERIAL PRIMARY KEY, send_id INT UNIQUE NOT NULL, spotter_id INT NOT NULL, ts TIMESTAMPTZ NOT NULL DEFAULT now(), lat DOUBLE PRECISION, lng DOUBLE PRECISION, dist DOUBLE PRECISION, elapsed DOUBLE PRECISION)`;
  await sql`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`;
  await sql`CREATE TABLE IF NOT EXISTS draws (day TEXT PRIMARY KEY)`;
  await sql`CREATE TABLE IF NOT EXISTS picks (day TEXT NOT NULL, user_id INT NOT NULL, PRIMARY KEY (day, user_id))`;
  await sql`ALTER TABLE matches ADD COLUMN IF NOT EXISTS city TEXT`;
  await sql`ALTER TABLE picks ADD COLUMN IF NOT EXISTS picked_ts TIMESTAMPTZ NOT NULL DEFAULT now()`;
}
for (let i = 0; ; i++) {
  try { await init(); break; } catch (e) {
    if (i >= 15) throw e;
    await Bun.sleep(3000); // database may still be starting
  }
}
async function ensure(k: string, make: () => string): Promise<string> {
  await sql`INSERT INTO meta (k, v) VALUES (${k}, ${make()}) ON CONFLICT (k) DO NOTHING`;
  return (await sql`SELECT v FROM meta WHERE k=${k}`)[0].v;
}
const START = new Date(await ensure("start", () => new Date().toISOString()));
const SECRET = await ensure("secret", () => randomBytes(32).toString("hex"));
const VAPID = JSON.parse(await ensure("vapid", () => JSON.stringify(webpush.generateVAPIDKeys())));
webpush.setVapidDetails(env.VAPID_SUBJECT ?? "https://raise.nearune.ai", VAPID.publicKey, VAPID.privateKey);

// ---------- helpers ----------
const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
const mac = (s: string) => createHmac("sha256", SECRET).update(s).digest("base64url");
const sessionCookie = (uid: number) => `rh=${uid}.${mac(String(uid))}; Path=/; Max-Age=315360000; HttpOnly; Secure; SameSite=Lax`;
function readUid(req: Request): number | null {
  const m = (req.headers.get("cookie") ?? "").match(/(?:^|;\s*)rh=([^;]+)/);
  if (!m) return null;
  const [id, h] = m[1].split(".");
  if (!id || !h) return null;
  const a = Buffer.from(h), b = Buffer.from(mac(id));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return Number(id);
}
function hav(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371000, r = Math.PI / 180;
  const dp = (lat2 - lat1) * r, dl = (lon2 - lon1) * r;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
// The game day runs on Pacific time.
const ptDay = (d = new Date()) => d.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
// Asking is only open 9:00 a.m. to 6:00 p.m. Pacific.
const inAskHours = () => {
  const h = Number(new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", hour12: false }));
  return h >= 9 && h < 18;
};
const ptTime = (d: Date) =>
  d.toLocaleString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + " PT";
function coords(b: any) {
  if (typeof b?.lat !== "number" || typeof b?.lng !== "number") return null;
  if (!isFinite(b.lat) || !isFinite(b.lng) || Math.abs(b.lat) > 90 || Math.abs(b.lng) > 180) return null;
  return { lat: b.lat, lng: b.lng, acc: typeof b.acc === "number" && isFinite(b.acc) ? b.acc : 0 };
}

// ---------- push (web push + Apple push) ----------
let apnsJwt = { token: "", at: 0 };
async function apnsToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (apnsJwt.token && now - apnsJwt.at < 2400) return apnsJwt.token; // Apple wants a fresh token every 20-60 min
  const b64 = (o: any) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = b64({ alg: "ES256", kid: APNS_KEY_ID });
  const claims = b64({ iss: APNS_TEAM_ID, iat: now });
  const der = Buffer.from(APNS_KEY.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""), "base64");
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = Buffer.from(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, Buffer.from(`${head}.${claims}`))).toString("base64url");
  apnsJwt = { token: `${head}.${claims}.${sig}`, at: now };
  return apnsJwt.token;
}
function sendApns(deviceToken: string, payload: unknown, jwt: string): Promise<number> {
  return new Promise((resolve) => {
    let status = 0;
    const client = http2.connect(APNS_HOST);
    const done = () => { try { client.close(); } catch {} resolve(status); };
    client.on("error", done);
    const req = client.request({
      ":method": "POST", ":path": `/3/device/${deviceToken}`, authorization: `bearer ${jwt}`,
      "apns-topic": APNS_TOPIC, "apns-push-type": "alert", "apns-priority": "10",
    });
    req.on("response", (h) => { status = Number(h[":status"]); });
    req.on("data", () => {});
    req.on("end", done);
    req.on("error", done);
    req.end(JSON.stringify(payload));
  });
}
async function push(userId: number, title: string, body: string, track = false) {
  try {
    const row = (await sql`SELECT push_sub, apns_token FROM users WHERE id=${userId}`)[0];
    if (!row) return;
    if (row.push_sub) {
      try {
        await webpush.sendNotification(JSON.parse(row.push_sub), JSON.stringify({ title, body }));
      } catch (e: any) {
        if (e?.statusCode === 404 || e?.statusCode === 410) await sql`UPDATE users SET push_sub=NULL WHERE id=${userId}`;
      }
    }
    if (row.apns_token && APNS_KEY && APNS_KEY_ID) {
      const st = await sendApns(row.apns_token, { aps: { alert: { title, body }, sound: "default" }, track }, await apnsToken());
      if (st === 410) await sql`UPDATE users SET apns_token=NULL WHERE id=${userId}`;
    }
  } catch (e) {
    console.error("push failed", e);
  }
}

// ---------- sky (Apple WeatherKit) ----------
let wkJwt = { token: "", at: 0 };
async function wkToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (wkJwt.token && now - wkJwt.at < 2400) return wkJwt.token;
  const b64 = (o: any) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = b64({ alg: "ES256", kid: WK_KEY_ID, id: `${APNS_TEAM_ID}.${APNS_TOPIC}`, typ: "JWT" });
  const claims = b64({ iss: APNS_TEAM_ID, iat: now, exp: now + 3600, sub: APNS_TOPIC });
  const der = Buffer.from(WK_KEY.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""), "base64");
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = Buffer.from(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, Buffer.from(`${head}.${claims}`))).toString("base64url");
  wkJwt = { token: `${head}.${claims}.${sig}`, at: now };
  return wkJwt.token;
}
const skyCache = new Map<string, { at: number; v: any }>();
// Current sky for a place. Location is rounded to about 11 km, used for this lookup only, and never stored.
async function sky(lat: number, lng: number) {
  if (!WK_KEY || !WK_KEY_ID) throw new Error("WeatherKit is not configured");
  const la = lat.toFixed(1), lo = lng.toFixed(1);
  const k = `${la},${lo}`;
  const hit = skyCache.get(k);
  if (hit && Date.now() - hit.at < 10 * 60000) return hit.v;
  const res = await fetch(`https://weatherkit.apple.com/api/v1/weather/en/${la}/${lo}?dataSets=currentWeather`, {
    headers: { authorization: `Bearer ${await wkToken()}` },
  });
  if (!res.ok) throw new Error(`WeatherKit ${res.status}`);
  const cw = ((await res.json()) as any).currentWeather;
  const v = { condition: String(cw?.conditionCode ?? "Clear"), daylight: cw?.daylight !== false, cloud: Number(cw?.cloudCover ?? 0) };
  if (skyCache.size > 500) skyCache.clear();
  skyCache.set(k, { at: Date.now(), v });
  return v;
}

// ---------- city lookup (OpenStreetMap). Coordinates are rounded to ~1 km; only "City, ST" is kept. ----------
async function cityOf(lat: number, lng: number): Promise<string | null> {
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&addressdetails=1&lat=${lat.toFixed(2)}&lon=${lng.toFixed(2)}`, {
      headers: { "user-agent": "RaiseYourRightHand/1.0 (https://raise.nearune.ai)", "accept-language": "en" },
    });
    if (!r.ok) return null;
    const a = ((await r.json()) as any).address ?? {};
    const city = a.city ?? a.town ?? a.village ?? a.hamlet ?? a.suburb ?? a.county;
    if (!city) return null;
    if (a.country_code === "us") {
      const st = a["ISO3166-2-lvl4"] ? String(a["ISO3166-2-lvl4"]).split("-")[1] : a.state;
      return st ? `${city}, ${st}` : String(city);
    }
    return a.country ? `${city}, ${a.country}` : String(city);
  } catch { return null; }
}
let backfilling = false;
async function backfillCities() { // fills in cities for sightings recorded without one, one per second
  if (backfilling) return;
  backfilling = true;
  try {
    const rows = await sql`SELECT id, lat, lng FROM matches WHERE city IS NULL AND lat IS NOT NULL ORDER BY id DESC LIMIT 10`;
    for (const m of rows) {
      const c = await cityOf(m.lat, m.lng);
      if (c) await sql`UPDATE matches SET city=${c} WHERE id=${m.id}`;
      await Bun.sleep(1100);
    }
  } catch (e) { console.error("backfill failed", e); }
  backfilling = false;
}

// Daily lottery: the first request of each Pacific day picks PICK_PERCENT of members (at least 1)
// who get to ask someone to raise their hand today. Returns true if this call ran the draw.
async function ensureDraw(): Promise<boolean> {
  const day = ptDay();
  // The game has not started yet: nobody is picked until GAME_START members have joined.
  if (Number((await sql`SELECT COUNT(*) AS c FROM users`)[0].c) < GAME_START) return false;
  if (!inAskHours()) return false; // picks go out once the day's asking hours open
  const claimed = await sql`INSERT INTO draws (day) VALUES (${day}) ON CONFLICT DO NOTHING RETURNING day`;
  if (!claimed.length) return false;
  const ids: number[] = (await sql`SELECT id FROM users`).map((x: any) => x.id);
  if (!ids.length) { await sql`DELETE FROM draws WHERE day=${day}`; return false; }
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  const k = Math.max(1, Math.round((ids.length * PICK_PERCENT) / 100));
  for (const id of ids.slice(0, k)) {
    await sql`INSERT INTO picks (day, user_id, picked_ts) VALUES (${day}, ${id}, ${new Date()}) ON CONFLICT DO NOTHING`;
    void push(id, "You were picked today!", `Open the app within ${PICK_WINDOW_MIN} minutes to ask a random member to raise their right hand.`);
  }
  return true;
}
async function sweep() {
  await ensureDraw();
  const expired = await sql`UPDATE sends SET status='expired' WHERE status='pending' AND expires_ts < ${new Date()} RETURNING sender_id, day`;
  // An unanswered request gives the sender a fresh window to try again.
  for (const e of expired) {
    await sql`UPDATE picks SET picked_ts=${new Date()} WHERE day=${e.day} AND user_id=${e.sender_id}`;
  }
  await sql`UPDATE sends SET status='unseen' WHERE status='raised' AND raised_ts < ${new Date(Date.now() - WINDOW_MIN * 60000)}`;
}
async function lastReset(): Promise<Date> {
  const r = await sql`SELECT ts FROM matches ORDER BY id DESC LIMIT 1`;
  return r.length ? new Date(r[0].ts) : START;
}
async function getUser(uid: number | null) {
  if (!uid) return null;
  return (await sql`SELECT * FROM users WHERE id=${uid}`)[0] ?? null;
}
async function pickInfo(uid: number) {
  const pk = (await sql`SELECT picked_ts FROM picks WHERE day=${ptDay()} AND user_id=${uid}`)[0];
  if (!pk) return null;
  const until = new Date(new Date(pk.picked_ts).getTime() + PICK_WINDOW_MIN * 60000);
  return { until, expired: until.getTime() < Date.now() };
}
const usedToday = async (uid: number) =>
  (await sql`SELECT 1 FROM sends WHERE sender_id=${uid} AND day=${ptDay()} AND status<>'expired'`).length > 0;

// ---------- api ----------
async function state(uid: number | null) {
  await sweep();
  const prev = await lastReset();
  const n = Number((await sql`SELECT COUNT(*) AS c FROM matches`)[0].c);
  const rec = (await sql`SELECT MAX(elapsed) AS m FROM matches`)[0].m;
  const hist = await sql`SELECT ts, elapsed, city FROM matches ORDER BY id DESC LIMIT 10`;
  if (hist.some((h: any) => !h.city)) void backfillCities();
  const players = Number((await sql`SELECT COUNT(*) AS c FROM users`)[0].c);
  const out: any = {
    clock: { since: prev.toISOString(), matches: n, record: rec == null ? null : Number(rec) },
    history: hist.map((h: any) => ({ ts: new Date(h.ts).toISOString(), elapsed: Number(h.elapsed), city: h.city ?? null })),
    players, game_start: GAME_START, started: players >= GAME_START, vapid: VAPID.publicKey, pick_percent: PICK_PERCENT, respond_min: RESPOND_MIN, pick_window_min: PICK_WINDOW_MIN, me: null,
  };
  const u = await getUser(uid);
  if (u) {
    await sql`UPDATE users SET last_seen=${new Date()} WHERE id=${u.id}`;
    const a = (await sql`SELECT * FROM sends WHERE target_id=${u.id} AND status IN ('pending','raised') ORDER BY id DESC LIMIT 1`)[0];
    let assignment: any = null;
    if (a) {
      assignment = { status: a.status, expires: new Date(a.expires_ts).toISOString(), asked_at: new Date(a.ts).toISOString(), tracking: true };
      if (a.raised_ts) assignment.spot_until = new Date(new Date(a.raised_ts).getTime() + WINDOW_MIN * 60000).toISOString();
    }
    // Missed window: the latest request aimed at this member expired unanswered.
    const last = (await sql`SELECT status, ts, expires_ts FROM sends WHERE target_id=${u.id} ORDER BY id DESC LIMIT 1`)[0];
    const missed = last && last.status === "expired" && new Date(last.expires_ts).getTime() > Date.now() - 86400000
      ? { asked_at: new Date(last.ts).toISOString(), expired_at: new Date(last.expires_ts).toISOString() } : null;
    const pk = await pickInfo(u.id);
    const used = await usedToday(u.id);
    out.me = {
      picked: !!pk, used,
      pick_until: pk ? pk.until.toISOString() : null,
      pick_expired: !!pk && pk.expired && !used,
      can_send: players >= GAME_START && inAskHours() && !!pk && !pk.expired && !used,
      missed, push: !!u.push_sub || !!u.apns_token, assignment,
    };
  }
  return out;
}

async function api(req: Request, path: string): Promise<Response> {
  const uid = readUid(req);
  if (path === "/state" && req.method === "GET") return json(await state(uid));
  if (req.method !== "POST") return json({ error: "Not found." }, 404);
  const body: any = await req.json().catch(() => ({}));

  if (path === "/join") {
    if (await getUser(uid)) return json({ ok: true });
    const r = await sql`INSERT INTO users DEFAULT VALUES RETURNING id`;
    const id = r[0].id;
    // If today's draw already happened, a late joiner gets the same small chance as everyone else.
    const ranDraw = await ensureDraw();
    const joined = Number((await sql`SELECT COUNT(*) AS c FROM users`)[0].c);
    if (!ranDraw && joined >= GAME_START && inAskHours() && Math.random() * 100 < PICK_PERCENT) {
      await sql`INSERT INTO picks (day, user_id, picked_ts) VALUES (${ptDay()}, ${id}, ${new Date()}) ON CONFLICT DO NOTHING`;
    }
    return json({ ok: true }, 200, { "set-cookie": sessionCookie(id) });
  }
  if (path === "/sky") { // sky background for the viewer's place (works before joining)
    const c = coords(body);
    if (!c) return json({ error: "Location is required." }, 400);
    try {
      return json(await sky(c.lat, c.lng));
    } catch (e) {
      console.error("sky failed", e);
      return json({ error: "Sky unavailable." }, 502);
    }
  }
  if (path === "/review") { // App Review demo code (the demo is client-side only and changes no data)
    return json({ ok: typeof body?.code === "string" && body.code.trim().toUpperCase() === REVIEW_CODE });
  }
  const u = await getUser(uid);
  if (!u) return json({ error: "Please join first." }, 401);

  if (path === "/push/subscribe") { // browser web push
    const sub = body?.subscription;
    if (!sub || typeof sub.endpoint !== "string") return json({ error: "Bad subscription." }, 400);
    await sql`UPDATE users SET push_sub=${JSON.stringify(sub)} WHERE id=${u.id}`;
    return json({ ok: true });
  }

  if (path === "/device") { // iPhone app: Apple push token
    const t = typeof body?.token === "string" ? body.token.trim() : "";
    if (!/^[0-9a-fA-F]{32,200}$/.test(t)) return json({ error: "Bad token." }, 400);
    await sql`UPDATE users SET apns_token=NULL WHERE apns_token=${t} AND id<>${u.id}`;
    await sql`UPDATE users SET apns_token=${t} WHERE id=${u.id}`;
    return json({ ok: true });
  }

  if (path === "/location") { // iPhone app: position updates, accepted only during the member's asked window
    const c = coords(body);
    if (!c) return json({ error: "Location is required." }, 400);
    await sweep();
    const s = (await sql`SELECT id, expires_ts FROM sends WHERE target_id=${u.id} AND status IN ('pending','raised') AND expires_ts >= ${new Date()} ORDER BY id DESC LIMIT 1`)[0];
    if (!s) return json({ ok: true, tracking: false });
    await sql`INSERT INTO pings (send_id, lat, lng, acc) VALUES (${s.id}, ${c.lat}, ${c.lng}, ${c.acc})`;
    return json({ ok: true, tracking: true, until: new Date(s.expires_ts).toISOString() });
  }

  if (path === "/send") { // button 1: ask a random other member to raise their right hand
    await sweep();
    const total = Number((await sql`SELECT COUNT(*) AS c FROM users`)[0].c);
    if (total < GAME_START) return json({ error: `The game starts when ${GAME_START} members have joined.` }, 400);
    if (!inAskHours()) return json({ error: "Asking is open from 9:00 a.m. to 6:00 p.m. Pacific." }, 400);
    const pk = await pickInfo(u.id);
    if (!pk) return json({ error: "You weren't picked today. A small share of members is picked each day." }, 400);
    if (await usedToday(u.id)) return json({ error: "You've used today's chance. It resets at 9:00 a.m. Pacific." }, 400);
    if (pk.expired) return json({ error: `Your ${PICK_WINDOW_MIN}-minute window to ask expired at ${ptTime(pk.until)}.` }, 400);
    const seen = new Date(Date.now() - 120000);
    const cands = await sql`SELECT id FROM users WHERE id<>${u.id} AND (push_sub IS NOT NULL OR apns_token IS NOT NULL OR last_seen>=${seen}) AND id NOT IN (SELECT target_id FROM sends WHERE status IN ('pending','raised'))`;
    if (!cands.length) return json({ error: "No one else can be reached right now. Try again a bit later." }, 400);
    const target = cands[Math.floor(Math.random() * cands.length)].id;
    await sql`INSERT INTO sends (sender_id, target_id, day, expires_ts, status) VALUES (${u.id}, ${target}, ${ptDay()}, ${new Date(Date.now() + RESPOND_MIN * 60000)}, 'pending')`;
    void push(target, "Raise your right hand!", `Someone picked you. For the next ${RESPOND_MIN} minutes, hold your right hand straight up. Open the app so it can share your location until then.`, true);
    return json({ ok: true, message: "Sent to a random member. If they raise their hand and someone sees it, the clock resets." });
  }

  if (path === "/raise") { // browser version: the asked member taps once, which records a location now
    const c = coords(body);
    if (!c) return json({ error: "Location is required." }, 400);
    await sweep();
    const s = (await sql`SELECT id FROM sends WHERE target_id=${u.id} AND status='pending' ORDER BY id DESC LIMIT 1`)[0];
    if (!s) {
      const last = (await sql`SELECT status, expires_ts FROM sends WHERE target_id=${u.id} ORDER BY id DESC LIMIT 1`)[0];
      if (last?.status === "expired") return json({ error: `You missed your ${RESPOND_MIN}-minute window. It expired at ${ptTime(new Date(last.expires_ts))}.` }, 400);
      return json({ error: "You don't have an active request right now." }, 400);
    }
    await sql`UPDATE sends SET status='raised', raised_ts=${new Date()}, lat=${c.lat}, lng=${c.lng}, acc=${c.acc} WHERE id=${s.id} AND status='pending'`;
    await sql`INSERT INTO pings (send_id, lat, lng, acc) VALUES (${s.id}, ${c.lat}, ${c.lng}, ${c.acc})`;
    return json({ ok: true, message: `Hand up! Hold it high for ${WINDOW_MIN} minutes.` });
  }

  if (path === "/spot") { // button 2: I saw someone raise their right hand
    const c = coords(body);
    if (!c) return json({ error: "Location is required." }, 400);
    await sweep();
    const cut = new Date(Date.now() - WINDOW_MIN * 60000);
    // Every asked member who is still inside their window and reported a location in the last WINDOW_MIN minutes.
    const rows = await sql`
      SELECT s.id, s.sender_id, s.target_id, p.lat AS plat, p.lng AS plng
      FROM sends s
      JOIN LATERAL (SELECT lat, lng FROM pings WHERE send_id=s.id AND ts>=${cut} ORDER BY ts DESC LIMIT 1) p ON true
      WHERE s.status IN ('pending','raised') AND s.target_id<>${u.id} AND s.sender_id<>${u.id}`;
    let best: any = null, bestD = Infinity;
    for (const r of rows) {
      const d = hav(c.lat, c.lng, r.plat, r.plng);
      if (d <= MAX_METERS && d < bestD) { best = r; bestD = d; }
    }
    const nomatch = json({ matched: false, message: `No match. No asked member was within ${MAX_METERS} meters of you just now.` });
    if (!best) return nomatch;
    const prev = await lastReset();
    const t = new Date();
    const upd = await sql`UPDATE sends SET status='matched' WHERE id=${best.id} AND status IN ('pending','raised') RETURNING id`;
    if (!upd.length) return nomatch;
    const elapsed = (t.getTime() - prev.getTime()) / 1000;
    const mrow = await sql`INSERT INTO matches (send_id, spotter_id, ts, lat, lng, dist, elapsed) VALUES (${best.id}, ${u.id}, ${t}, ${c.lat}, ${c.lng}, ${bestD}, ${elapsed}) RETURNING id`;
    void (async () => { const place = await cityOf(c.lat, c.lng); if (place) await sql`UPDATE matches SET city=${place} WHERE id=${mrow[0].id}`; })();
    void push(best.target_id, "You were spotted!", "Someone saw your raised hand. The clock just reset.");
    void push(best.sender_id, "Your raise was spotted!", "The person you picked was seen. The clock just reset.");
    return json({ matched: true, elapsed, message: "Match! The sighting is recorded and the clock has reset." });
  }
  return json({ error: "Not found." }, 404);
}

// ---------- pwa + page ----------
const SW = `self.addEventListener('push',e=>{let d={};try{d=e.data.json()}catch(_){}
e.waitUntil(self.registration.showNotification(d.title||'Raise Your Right Hand',{body:d.body||'',tag:'rh',renotify:true}))});
self.addEventListener('notificationclick',e=>{e.notification.close();
e.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(l=>{for(const c of l){if('focus' in c)return c.focus()}return clients.openWindow('/')}))});
self.addEventListener('fetch',()=>{});
`;
const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="22" fill="#0f1220"/><text x="50" y="68" font-size="58" text-anchor="middle">&#9995;</text></svg>`;

const PAGE = String.raw`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#2f7fe0"><meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Raise Your Right Hand">
<link rel="manifest" href="/manifest.json"><link rel="icon" href="/icon.svg">
<title>Raise Your Right Hand</title>
<style>
*{box-sizing:border-box}
html{min-height:100%}
body{margin:auto;max-width:480px;min-height:100vh;min-height:100dvh;display:flex;flex-direction:column;font-family:-apple-system,"SF Pro Rounded",system-ui,sans-serif;color:#fff;padding:max(20px,env(safe-area-inset-top)) 22px max(24px,env(safe-area-inset-bottom));background:linear-gradient(#2f7fe0,#8cc8ff);background-attachment:fixed;background-repeat:no-repeat;-webkit-tap-highlight-color:transparent}
@media (prefers-color-scheme:dark){body{background:linear-gradient(#070b24,#1d2757);background-attachment:fixed;background-repeat:no-repeat}}
body.sky-clear{background-image:linear-gradient(#2f7fe0,#8cc8ff 65%,#ffd9a8)}
body.sky-cloud{background-image:linear-gradient(#6f84a0,#cfd8e2)}
body.sky-rain{background-image:linear-gradient(#36435a,#7d8a99)}
body.sky-storm{background-image:linear-gradient(#1f2533,#58626f)}
body.sky-snow{background-image:linear-gradient(#aebccd,#eef3f8);color:#14182b}
body.sky-fog{background-image:linear-gradient(#a3adb5,#e3e6e8);color:#14182b}
body.sky-night{background-image:radial-gradient(1.5px 1.5px at 12% 14%,#fff,transparent),radial-gradient(1.5px 1.5px at 38% 8%,#fff,transparent),radial-gradient(1px 1px at 63% 18%,#fff,transparent),radial-gradient(1.5px 1.5px at 85% 10%,#fff,transparent),radial-gradient(1px 1px at 24% 30%,#fff,transparent),radial-gradient(1px 1px at 74% 34%,#fff,transparent),linear-gradient(#070b24,#1d2757)}
.top{display:flex;justify-content:space-between;gap:8px;font-size:15px;font-weight:600}
.pill{background:rgba(255,255,255,.2);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);padding:7px 13px;border-radius:99px}
body.sky-snow .pill,body.sky-fog .pill{background:rgba(20,24,43,.1)}
.mid{flex:1;display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;padding:24px 0}
.lbl{font-size:14px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;opacity:.85}
.big{font-size:clamp(52px,20vw,84px);font-weight:800;letter-spacing:-.04em;line-height:1;margin:14px 0 6px;font-variant-numeric:tabular-nums;white-space:nowrap;text-shadow:0 4px 30px rgba(0,0,0,.2)}
.unit{font-size:20px;font-weight:600;opacity:.88}
.sub{font-size:17px;opacity:.9;margin-top:22px;max-width:290px;line-height:1.35}
.hand{font-size:88px;filter:drop-shadow(0 8px 20px rgba(0,0,0,.3))}
h2{font-size:38px;font-weight:800;line-height:1.04;letter-spacing:-.03em;margin:14px 0 0}
.ring{position:relative;width:220px;height:220px;margin:26px 0 8px}
.ring svg{position:absolute;inset:0;transform:rotate(-90deg)}
.ring .in{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center}
.ring b{font-size:58px;font-weight:800;letter-spacing:-.03em;font-variant-numeric:tabular-nums}
.small{font-size:14px;opacity:.96;line-height:1.35;text-shadow:0 1px 8px rgba(0,0,0,.45)}
body.sky-snow .small,body.sky-fog .small{text-shadow:none}
.bottom{display:flex;flex-direction:column;gap:12px}
button{width:100%;border:0;border-radius:22px;padding:18px;font-size:19px;font-weight:800;font-family:inherit;background:#fff;color:#111}
button.alt{background:rgba(15,20,45,.3);color:#fff;-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);font-weight:700}
button.gold{background:#ffd166;color:#3a2600}
body.sky-snow button:not(.alt):not(.gold),body.sky-fog button:not(.alt):not(.gold){background:#14182b;color:#fff}
body.sky-snow button.alt,body.sky-fog button.alt{background:rgba(20,24,43,.12);color:#14182b}
button:active{transform:scale(.98)}
.card{background:rgba(255,255,255,.2);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);border-radius:18px;padding:14px 16px;text-align:left;font-size:15px;line-height:1.35}
body.sky-snow .card,body.sky-fog .card{background:rgba(255,255,255,.6)}
.card b{font-size:16px}.card p{margin:6px 0 0}
.notes{display:flex;flex-direction:column;gap:10px;margin-bottom:12px}
.msg{font-size:14px;text-align:center}.msg:empty{display:none}
.row{display:flex;justify-content:space-between;font-size:15px;padding:9px 0;border-top:1px solid rgba(255,255,255,.25)}
.conf{position:fixed;inset:0;pointer-events:none;overflow:hidden;z-index:9}
.conf span{position:absolute;top:-40px;font-size:30px;animation:fall 3s ease-in forwards}
@keyframes fall{to{transform:translateY(110vh) rotate(360deg)}}
.banner{position:fixed;left:0;right:0;top:38%;text-align:center;font-size:40px;font-weight:800;z-index:10;text-shadow:0 4px 30px rgba(0,0,0,.4);pointer-events:none}
</style></head><body>
<div class="top"><span class="pill">&#127757; <span id="members">--</span> in the group</span><span class="pill"><span id="sightings">--</span> sightings</span></div>
<div class="mid" id="hero">
<div class="lbl" id="lbl">Time since last sighting</div>
<div class="big" id="clock">--</div>
<div class="unit" id="unit"></div>
<div class="sub" id="herosub"></div></div>
<div class="mid" id="assign" style="display:none"></div>
<div id="demobar" style="display:none;gap:6px;flex-wrap:wrap;justify-content:center;margin:10px 0"><span class="pill small" style="width:100%;text-align:center">Demo mode: no real action is taken</span><button class="alt" style="width:auto;padding:8px 12px;font-size:14px" onclick="demo('wait')">Waiting</button><button class="alt" style="width:auto;padding:8px 12px;font-size:14px" onclick="demo('ask')">Picked to ask</button><button class="alt" style="width:auto;padding:8px 12px;font-size:14px" onclick="demo('raise')">Asked to raise</button><button class="alt" style="width:auto;padding:8px 12px;font-size:14px" onclick="demo('sight')">Sighted</button><button class="alt" style="width:auto;padding:8px 12px;font-size:14px" onclick="demo('history')">History</button></div>
<div class="bottom">
<div id="join" style="display:none"><button onclick="joinNow()">Join the experiment</button>
<div class="small" style="text-align:center;margin-top:12px">No account. Your location is only used when you are asked.</div>
<div style="text-align:center;margin-top:14px"><a href="#" class="small" style="text-decoration:underline;color:inherit" onclick="document.getElementById('rcbox').style.display='block';return false">App Review? Enter code</a></div>
<div id="rcbox" style="display:none;margin-top:10px"><input id="rc" placeholder="Review code" autocapitalize="characters" style="width:100%;padding:14px;border-radius:16px;border:0;font-size:17px;margin-bottom:8px"><button class="alt" onclick="unlockDemo()">Start demo</button><div class="small" id="rcmsg" style="text-align:center;margin-top:6px"></div></div></div>
<div id="app" style="display:none">
<div class="notes" id="notes"></div>
<div class="bottom">
<button id="sb" class="gold" onclick="sendRaise()" style="display:none">Ask a random member to raise their right hand</button>
<div class="small" id="sinfo" style="text-align:center"></div>
<button id="spotb" onclick="act('spot')">&#128064; I saw a raised hand</button>
<div class="small" id="hint" style="text-align:center">Counts only if an asked member was within 100 meters of you just now.</div>
<div id="pushcard"></div>
<button class="alt" id="histb" onclick="toggleHist()">Recent sightings</button>
<div class="msg" id="msg"></div>
<div id="histwrap" style="display:none"><div class="small" id="rec"></div><div id="hist"></div></div>
</div></div></div>
<script>
let S=null,prevMatches=null,DEMO=false;
const $=id=>document.getElementById(id);
const CAP=window.Capacitor;
const NATIVE=!!(CAP&&CAP.isNativePlatform&&CAP.isNativePlatform());
async function api(path,body){const r=await fetch('/api/'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return {ok:r.ok,data:await r.json()}}
function fmt(s){s=Math.max(0,s);const d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60),x=Math.floor(s%60);return d+'d '+String(h).padStart(2,'0')+':'+String(m).padStart(2,'0')+':'+String(x).padStart(2,'0')}
function esc(t){return String(t).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
function two(n){return String(n).padStart(2,'0')}
function pt(x){return new Date(x).toLocaleString('en-US',{timeZone:'America/Los_Angeles',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})+' PT'}
function mmss(s){s=Math.max(0,Math.floor(s));return two(Math.floor(s/60))+':'+two(s%60)}
function tick(){if(!S)return;
 const s=Math.max(0,(Date.now()-new Date(S.clock.since).getTime())/1000);
 const d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60),x=Math.floor(s%60);
 $('clock').textContent=d>0?d+'d '+two(h)+'h':two(h)+':'+two(m)+':'+two(x);
 $('unit').textContent=d>0?two(m)+'m '+two(x)+'s and counting':(S.clock.record?'Longest streak: '+fmt(S.clock.record).replace(/:\d\d$/,''):'and counting');
 const a=S.me&&S.me.assignment,rt=$('ringT');
 if(a&&rt){const left=(new Date(a.status==='raised'&&a.spot_until?a.spot_until:a.expires).getTime()-Date.now())/1000;
  rt.textContent=mmss(left);const tot=(a.status==='raised'?S.respond_min*0+300:S.respond_min*60);
  const c=$('ringC');if(c)c.setAttribute('stroke-dashoffset',String(628.3*(1-Math.max(0,Math.min(1,left/tot)))))}}
function urlB64(b){const p='='.repeat((4-b.length%4)%4);const r=atob((b+p).replace(/-/g,'+').replace(/_/g,'/'));return Uint8Array.from([...r].map(c=>c.charCodeAt(0)))}
function toggleHist(){const w=$('histwrap');w.style.display=w.style.display==='none'?'block':'none'}
function celebrate(){
 try{if(CAP&&CAP.Plugins&&CAP.Plugins.Haptics)CAP.Plugins.Haptics.notification({type:'SUCCESS'});else if(navigator.vibrate)navigator.vibrate([120,60,120])}catch(e){}
 const c=document.createElement('div');c.className='conf';const em=['&#127881;','&#9995;','&#10024;','&#127882;'];
 for(let i=0;i<28;i++){const s=document.createElement('span');s.innerHTML=em[i%4];s.style.left=(Math.random()*95)+'%';s.style.animationDelay=(Math.random()*0.8)+'s';c.appendChild(s)}
 const b=document.createElement('div');b.className='banner';b.textContent='Sighted! Clock reset.';
 document.body.appendChild(c);document.body.appendChild(b);setTimeout(()=>{c.remove();b.remove()},4000)}

/* ---- sky background: Apple WeatherKit for the viewer's place, clock-based if location is off ---- */
function applySky(d){
  const c=String(d.condition||'');
  let k='clear';
  if(d.daylight===false)k='night';
  else if(/thunder|storm/i.test(c))k='storm';
  else if(/rain|drizzle|shower|hail|sleet/i.test(c))k='rain';
  else if(/snow|flurr|blizzard|ice/i.test(c))k='snow';
  else if(/fog|haze|smok|dust/i.test(c))k='fog';
  else if(/cloud/i.test(c)&&!/partly/i.test(c))k='cloud';
  document.body.className='sky-'+k}
function clockSky(){const h=new Date().getHours();applySky({daylight:h>=7&&h<19,condition:'Clear'})}
function loadSky(){
  clockSky();
  if(!navigator.geolocation)return;
  navigator.geolocation.getCurrentPosition(async p=>{
    try{const r=await api('sky',{lat:p.coords.latitude,lng:p.coords.longitude});if(r.ok&&r.data.condition)applySky(r.data)}catch(e){}
  },()=>{},{enableHighAccuracy:false,timeout:10000,maximumAge:1800000})}

/* ---- iPhone app only: Apple push + automatic location during the asked window ---- */
let watcherId=null,starting=false,trackUntil=0,pushReady=false;
async function startTracking(until){
  trackUntil=new Date(until).getTime();
  if(watcherId!==null||starting)return;
  const BG=CAP.Plugins&&CAP.Plugins.BackgroundGeolocation;if(!BG)return;
  starting=true;
  try{watcherId=await BG.addWatcher({backgroundTitle:'Raise Your Right Hand',backgroundMessage:'Sharing your location only until your window ends.',requestPermissions:true,stale:false,distanceFilter:5},async(loc,err)=>{
    if(err){if(err.code==='NOT_AUTHORIZED')$('msg').textContent='Location permission is needed. Please allow it in Settings.';return}
    if(Date.now()>trackUntil){stopTracking();return}
    await api('location',{lat:loc.latitude,lng:loc.longitude,acc:loc.accuracy})})}catch(e){}
  starting=false}
async function stopTracking(){
  if(watcherId===null)return;const id=watcherId;watcherId=null;
  try{await CAP.Plugins.BackgroundGeolocation.removeWatcher({id})}catch(e){}}
async function registerPush(){
  if(pushReady)return;const PN=CAP.Plugins&&CAP.Plugins.PushNotifications;if(!PN)return;
  pushReady=true;
  try{const p=await PN.requestPermissions();if(p.receive!=='granted')return;
  PN.addListener('registration',t=>api('device',{token:t.value}));
  PN.addListener('pushNotificationActionPerformed',()=>load());
  await PN.register()}catch(e){}}

function ringHtml(){return '<div class="ring"><svg width="220" height="220" viewBox="0 0 220 220"><circle cx="110" cy="110" r="100" fill="none" stroke="rgba(255,255,255,.25)" stroke-width="10"/><circle id="ringC" cx="110" cy="110" r="100" fill="none" stroke="#fff" stroke-width="10" stroke-linecap="round" stroke-dasharray="628.3" stroke-dashoffset="0"/></svg><div class="in"><span class="lbl" style="font-size:12px">Time left</span><b id="ringT">--:--</b></div></div>'}

async function load(){if(DEMO)return;const {data}=await api('state');render(data)}
function render(data){S=data;const m=data.me;
if(prevMatches!==null&&data.clock.matches>prevMatches)celebrate();
prevMatches=data.clock.matches;
$('members').textContent=data.players;
$('sightings').textContent=data.clock.matches;
$('join').style.display=m?'none':'block';$('app').style.display=m?'block':'none';
$('lbl').textContent=data.clock.matches?'Time since last sighting':'Nobody has seen it for';
$('herosub').textContent=!data.started?data.players+' of '+data.game_start+' joined. The game starts at '+data.game_start+'. Invite friends!':m?'Keep your eyes open. If you see a raised right hand, tell us.':'Each day a few strangers are picked to make someone raise their right hand. Will anyone see it?';
let a=null;
if(m){
 a=m.assignment;
 if(a&&a.status==='pending'&&NATIVE)$('assign').innerHTML='<div class="hand">&#9995;</div><h2>You were picked.<br>Raise your right hand.</h2>'+ringHtml()+'<div class="small" style="max-width:280px">Hold it up where someone might see. We share your spot only until the timer ends, then stop.</div>';
 else if(a&&a.status==='pending')$('assign').innerHTML='<div class="hand">&#9995;</div><h2>You were picked.<br>Raise your right hand.</h2>'+ringHtml()+'<button style="max-width:320px" onclick="act(\'raise\')">I\'m raising my right hand now</button><div class="small" style="margin-top:10px">Asked at '+pt(a.asked_at)+'. Answer by '+pt(a.expires)+'.</div>';
 else if(a&&a.status==='raised')$('assign').innerHTML='<div class="hand">&#9995;</div><h2>Hold it up!</h2>'+ringHtml()+'<div class="small">Keep your right hand raised until '+pt(a.spot_until)+'.</div>';
 $('assign').style.display=a?'flex':'none';$('hero').style.display=a?'none':'flex';
 ['sinfo','spotb','hint','pushcard','histb'].forEach(i=>{$(i).style.display=a?'none':''});
 if(NATIVE&&!DEMO){registerPush();if(a)startTracking(a.expires);else stopTracking()}
 let notes='';
 if(m.missed&&!a)notes+='<div class="card"><b>Missed it</b><p>You were asked to raise your right hand at '+pt(m.missed.asked_at)+'. Your '+data.respond_min+'-minute window expired at '+pt(m.missed.expired_at)+'.</p></div>';
 if(m.pick_expired)notes+='<div class="card"><b>Chance expired</b><p>You were picked today, but your '+data.pick_window_min+'-minute window to ask a random member expired at '+pt(m.pick_until)+'.</p></div>';
 $('notes').innerHTML=notes;
 $('sb').style.display=(m.can_send&&!a)?'block':'none';
 $('sinfo').textContent=m.can_send?'You were picked today! Ask before '+pt(m.pick_until)+'.':m.used?'Picks reset at 9:00 a.m. Pacific.':m.pick_expired?'Your window to ask has passed. Picks reset at 9:00 a.m. Pacific.':'Not picked today. About '+data.pick_percent+'% of members are picked each day.';
 $('pushcard').innerHTML=(m.push||NATIVE)?'':'<div class="card"><b>Get notified</b><p>Turn on notifications so you hear when you are picked or asked to raise your hand.</p><button class="alt" style="margin-top:10px;font-size:16px;padding:12px" onclick="enablePush()">Turn on notifications</button><div class="small" style="margin-top:8px">On iPhone, first tap Share, then Add to Home Screen, and open the app from there.</div></div>';
 $('rec').textContent=data.clock.record?'Longest wait: '+fmt(data.clock.record):'';
 $('hist').innerHTML=data.history.map(h=>'<div class="row"><span>'+pt(h.ts)+(h.city?'<div class="small">'+esc(h.city)+'</div>':'')+'</span><span>'+fmt(h.elapsed)+'</span></div>').join('')||'<div class="small">None yet. Be the first!</div>'}
else{$('assign').style.display='none';$('hero').style.display='flex'}
tick()}
async function joinNow(){if(DEMO)return;await api('join',{});load()}
async function unlockDemo(){const r=await api('review',{code:$('rc').value});
 if(r.data&&r.data.ok){DEMO=true;$('demobar').style.display='flex';demo('wait')}else $('rcmsg').textContent='That code is not valid.'}
function demo(kind){
 const n=Date.now(),H=3600000;
 const d={clock:{since:new Date(n-(2*86400+6*3600+41*60)*1000).toISOString(),matches:9,record:6*86400+7200},
  history:[{ts:new Date(n-H*20).toISOString(),elapsed:2*86400+14400,city:'Oakland, CA'},{ts:new Date(n-H*90).toISOString(),elapsed:6*86400+7200,city:'Austin, TX'},{ts:new Date(n-H*250).toISOString(),elapsed:86400+30000,city:'Brooklyn, NY'}],
  players:214,game_start:150,started:true,vapid:'',pick_percent:3.36,respond_min:20,pick_window_min:20,
  me:{picked:false,used:false,can_send:false,missed:null,push:true,assignment:null,pick_expired:false,pick_until:null}};
 if(kind==='ask'){d.me.picked=true;d.me.can_send=true;d.me.pick_until=new Date(n+14*60000).toISOString()}
 if(kind==='raise')d.me.assignment={status:'pending',expires:new Date(n+17*60000).toISOString(),asked_at:new Date(n-3*60000).toISOString()};
 render(d);
 $('histwrap').style.display=kind==='history'?'block':'none';
 if(kind==='sight')celebrate();
 $('msg').textContent=''}
function loc(){return new Promise((res,rej)=>navigator.geolocation?navigator.geolocation.getCurrentPosition(p=>res({lat:p.coords.latitude,lng:p.coords.longitude,acc:p.coords.accuracy}),()=>rej(),{enableHighAccuracy:true,timeout:15000}):rej())}
async function act(kind){if(DEMO){$('msg').textContent='Demo mode: no real action is taken.';return}$('msg').textContent='Getting your location...';let c;try{c=await loc()}catch(e){$('msg').textContent='Location is needed. Please allow it in your browser settings.';return}
const {data}=await api(kind,c);$('msg').textContent=data.error||data.message||'';load()}
async function sendRaise(){if(DEMO){$('msg').textContent='Demo mode: no real action is taken.';return}const {data}=await api('send',{});$('msg').textContent=data.error||data.message||'';load()}
async function enablePush(){try{if(!('serviceWorker' in navigator)||!('PushManager' in window)){$('msg').textContent='Notifications need the app added to your Home Screen first (iPhone) or a newer browser.';return}
if(await Notification.requestPermission()!=='granted'){$('msg').textContent='Notifications were not allowed.';return}
const reg=await navigator.serviceWorker.ready;let sub=await reg.pushManager.getSubscription();
if(!sub)sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:urlB64(S.vapid)});
await api('push/subscribe',{subscription:sub.toJSON()});$('msg').textContent='Notifications are on.';load()}catch(e){$('msg').textContent='Could not turn on notifications here.'}}
if(!NATIVE&&'serviceWorker' in navigator)navigator.serviceWorker.register('/sw.js');
load();loadSky();setInterval(tick,1000);setInterval(()=>{if(!document.hidden)load()},15000);setInterval(()=>{if(!document.hidden)loadSky()},900000);
</script></body></html>`;

const PRIVACY = String.raw`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Privacy Policy - Raise Your Right Hand</title><style>body{margin:0;font-family:-apple-system,system-ui,sans-serif;background:#0f1630;color:#eef1ff;line-height:1.55}main{max-width:680px;margin:auto;padding:32px 22px 60px}h1{font-size:30px;letter-spacing:-.02em}h2{font-size:19px;margin-top:28px}a{color:#ffd166}.mut{color:#a9b2d6;font-size:14px}</style></head><body><main>
<h1>Privacy Policy</h1><p class="mut">Raise Your Right Hand. Last updated November 2, 2026.</p>
<p>Raise Your Right Hand is a group experiment. This page explains what the app collects, why, and what you can ask us to do. It is written to be read.</p>
<h2>No account, no personal details</h2>
<p>You do not create a username or password and you never give us your name, email address or phone number. When you tap Join, we create a random member number for your device. That number is the only thing that identifies you in the app.</p>
<h2>What we collect</h2>
<p><b>Location.</b> The app asks for your location in three situations. First, to show the sky (weather and time of day) where you are. For this we send your location rounded to about 11 km to Apple WeatherKit for one lookup; we do not store it. Second, when you tap "I saw a raised hand", we use your exact location at that moment to see whether an asked member was within 100 meters. Third, when you are asked to raise your right hand, the app shares your location for the next 20 minutes only, so a sighting can be matched. It stops automatically at the end of that window.</p>
<p><b>Sightings.</b> When a sighting is confirmed we record the time, how long the clock had been running, the location of the spotter, and the city and state. Other members see only the time, the wait and the city and state.</p>
<p><b>Notifications.</b> If you allow notifications, we keep your device's push token so we can tell you that you were picked or asked.</p>
<p><b>Activity.</b> We record who was picked or asked (by member number) and the status of each request, to run the daily draw and the game.</p>
<h2>How we use it</h2>
<p>Only to run the game: pick members, deliver requests, match sightings, show the history and show the sky. We do not sell your data, share it with advertisers, or use it to track you across other apps or websites.</p>
<h2>Who sees what</h2>
<p>Other members never see your member number or your exact location. Our hosting provider (Railway) stores the data. City and state names are looked up with OpenStreetMap using coordinates rounded to about 1 km.</p>
<h2>Your choices</h2>
<p>You can turn off location or notifications at any time in iPhone Settings, and the app keeps working with fewer features. You can ask us to delete the data tied to your member number by contacting us; to help us find it, send the member number shown in the app, or tell us roughly when you joined.</p>
<h2>Children</h2>
<p>The app is not directed at children under 13, and we do not knowingly collect their information.</p>
<h2>Changes</h2>
<p>If this policy changes, the updated version will be posted here with a new date.</p>
<h2>Contact</h2>
<p>Mark Berenstein, San Mateo, California. <a href="mailto:support@nearune.ai">support@nearune.ai</a></p>
</main></body></html>`;
const SUPPORT = String.raw`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Support - Raise Your Right Hand</title><style>body{margin:0;font-family:-apple-system,system-ui,sans-serif;background:#0f1630;color:#eef1ff;line-height:1.55}main{max-width:680px;margin:auto;padding:32px 22px 60px}h1{font-size:30px;letter-spacing:-.02em}h2{font-size:19px;margin-top:28px}a{color:#ffd166}.mut{color:#a9b2d6;font-size:14px}</style></head><body><main>
<h1>Support</h1><p class="mut">Raise Your Right Hand</p>
<h2>How the game works</h2>
<p>Each day a few random members are picked. A picked member gets one chance, within 20 minutes, to ask a random other member to raise their right hand. That member then has 20 minutes. If someone sees a raised right hand and taps "I saw a raised hand" within 100 meters, the sighting counts and the clock resets.</p>
<h2>Common questions</h2>
<p><b>Why am I never picked?</b> About 3.36% of members are picked each day, starting at 9:00 a.m. Pacific. Asking is open 9:00 a.m. to 6:00 p.m. Pacific. The game starts when 150 members have joined.</p>
<p><b>I did not get a notification.</b> Open iPhone Settings, then Notifications, then Raise Your Right Hand, and make sure Allow Notifications is on.</p>
<p><b>My sighting did not match.</b> The spotter must be within 100 meters of the asked member, and the asked member's location must be less than 5 minutes old. Make sure location is allowed for the app.</p>
<p><b>Does the app track me all the time?</b> No. Location is shared only for the 20 minutes after you are asked, and when you tap "I saw a raised hand".</p>
<h2>Contact</h2>
<p>Email <a href="mailto:support@nearune.ai">support@nearune.ai</a> and we will reply as soon as we can. See also the <a href="/privacy">Privacy Policy</a>.</p>
</main></body></html>`;

// ---------- server ----------
Bun.serve({
  port: Number(env.PORT ?? 3000),
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;
    try {
      if (p.startsWith("/api/")) return await api(req, p.slice(4));
      if (p === "/sw.js") return new Response(SW, { headers: { "content-type": "application/javascript", "service-worker-allowed": "/", "cache-control": "no-cache" } });
      if (p === "/manifest.json") return json({ name: APP_NAME, short_name: "Right Hand", start_url: "/", display: "standalone", background_color: "#0f1220", theme_color: "#0f1220", icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }] });
      if (p === "/icon.svg") return new Response(ICON, { headers: { "content-type": "image/svg+xml" } });
      if (p === "/privacy") return new Response(PRIVACY, { headers: { "content-type": "text/html; charset=utf-8" } });
      if (p === "/support") return new Response(SUPPORT, { headers: { "content-type": "text/html; charset=utf-8" } });
      if (p === "/") return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
      return json({ error: "Not found." }, 404);
    } catch (e) {
      console.error(e);
      return json({ error: "Something went wrong." }, 500);
    }
  },
});
console.log(`${APP_NAME} is running`);
