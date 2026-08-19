/**
 * Galactic Leaderboard \u2014 Cloudflare Worker
 * -----------------------------------------
 * Backs the Speech Invaders leaderboard with a KV namespace so scores are
 * genuinely shared across every device and browser, with no login required
 * to read or submit a score.
 *
 * Endpoints:
 *   GET    /api/ping                 -> { ok: true }                       (public)
 *   GET    /api/leaderboard          -> { ok: true, entries: [...] }       (public)
 *   POST   /api/leaderboard          -> { ok: true, entry: {...} }         (public)
 *   DELETE /api/leaderboard/:id      -> { ok: true, removed: 0|1 }         (admin only)
 *   DELETE /api/leaderboard          -> { ok: true }  (wipes everything)   (admin only)
 *
 * Each leaderboard entry also carries:
 *   classCode -- optional, parsed client-side from "callsign@ClassCode"
 *                (see README) so a teacher's class can filter to just
 *                their own students. Validated/normalized server-side.
 *   season    -- server-computed ISO week ("2026-W33"), used for the
 *                "This Week" leaderboard view. Nothing to reset manually;
 *                a new week's key just starts empty on its own.
 * The Worker still returns the full entries array as before -- ranks,
 * class filtering, and weekly filtering are all computed client-side from
 * that array, so there's no separate ranking endpoint to keep in sync.
 *
 *   GET    /api/analytics            -> { ok: true, entries: {...} }       (public)
 *   POST   /api/analytics            -> { ok: true }                       (public)
 *   DELETE /api/analytics            -> { ok: true }  (wipes everything)   (admin only)
 *
 * Analytics entries are keyed by question id (e.g. "simplePast_3") and hold
 * only aggregate counts -- { attempts, misses, tense } -- no player names
 * or identifying info, so it's safe to leave reads public alongside the
 * leaderboard. This powers the "per-question error rate" table in the
 * Admin Console, so teachers can see which questions the class is missing.
 *
 * Admin requests must include a header:
 *   X-Admin-Secret: <your secret>
 * which must match the ADMIN_SECRET secret configured on this Worker
 * (see README.md \u2014 set it with `wrangler secret put ADMIN_SECRET`,
 * never commit it to source).
 *
 * Bind a KV namespace called LEADERBOARD to this Worker (see wrangler.toml).
 *
 * wrangler.toml also binds a second namespace, Game_SI_KV, reserved for
 * this game specifically but not yet used by any code below \u2014 it's there
 * for a future feature (e.g. server-side custom question sets or
 * whole-class session state) that needs its own storage separate from
 * the public leaderboard/analytics data in LEADERBOARD.
 */

const KV_KEY = "leaderboard";
const ANALYTICS_KEY = "analytics";
const MAX_ENTRIES = 100;
const MAX_NAME_LEN = 18;
const MAX_CLASS_LEN = 20;
const MAX_QID_LEN = 60;

function corsHeaders(){
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Admin-Secret",
    "Content-Type": "application/json"
  };
}

function json(data, status){
  return new Response(JSON.stringify(data), { status: status || 200, headers: corsHeaders() });
}

async function readBoard(env){
  const raw = await env.LEADERBOARD.get(KV_KEY);
  if(!raw) return [];
  try{
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  }catch(e){
    return [];
  }
}

async function writeBoard(env, list){
  await env.LEADERBOARD.put(KV_KEY, JSON.stringify(list));
}

function genId(){
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ISO-8601 week key, e.g. "2026-W33". Computed server-side (never trust the
// client's clock/timezone) so every player's "this week" bucket agrees,
// and it resets itself automatically \u2014 nothing to run or clean up weekly.
function isoWeek(ts){
  const d = new Date(ts);
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (date.getUTCDay() + 6) % 7; // Mon=0 .. Sun=6
  date.setUTCDate(date.getUTCDate() - dayNum + 3); // nearest Thursday
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const weekNum = 1 + Math.round((date - firstThursday) / (7 * 24 * 3600 * 1000));
  return date.getUTCFullYear() + "-W" + String(weekNum).padStart(2, "0");
}

async function readAnalytics(env){
  const raw = await env.LEADERBOARD.get(ANALYTICS_KEY);
  if(!raw) return {};
  try{
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === "object" && !Array.isArray(parsed)) ? parsed : {};
  }catch(e){
    return {};
  }
}

async function writeAnalytics(env, data){
  await env.LEADERBOARD.put(ANALYTICS_KEY, JSON.stringify(data));
}

function sanitizeAnalyticsBody(body){
  if(!body || typeof body !== "object") return null;
  const id = typeof body.id === "string" ? body.id.trim().slice(0, MAX_QID_LEN) : "";
  if(!id) return null;
  return {
    id: id,
    tense: typeof body.tense === "string" ? body.tense.slice(0, 40) : "",
    correct: !!body.correct
  };
}

function isAdmin(request, env){
  const provided = request.headers.get("X-Admin-Secret") || "";
  // env.ADMIN_SECRET must be set via `wrangler secret put ADMIN_SECRET`.
  return !!env.ADMIN_SECRET && provided === env.ADMIN_SECRET;
}

function sanitizeEntry(body){
  if(!body || typeof body !== "object") return null;
  const name = typeof body.name === "string" ? body.name.trim().slice(0, MAX_NAME_LEN) : "";
  const score = typeof body.score === "number" && isFinite(body.score) ? Math.max(0, Math.floor(body.score)) : null;
  if(!name || score === null) return null;
  // Class/group code, parsed client-side from "callsign@ClassCode". Only
  // letters, digits, hyphen, underscore \u2014 anything else and we just drop
  // it rather than reject the whole score.
  const rawClass = typeof body.classCode === "string" ? body.classCode.trim().toUpperCase().slice(0, MAX_CLASS_LEN) : "";
  const classCode = /^[A-Z0-9_-]*$/.test(rawClass) ? rawClass : "";
  const now = Date.now();
  return {
    id: genId(),
    name: name,
    score: score,
    mode: typeof body.mode === "string" ? body.mode.slice(0, 40) : "",
    length: typeof body.length === "string" ? body.length.slice(0, 20) : "",
    difficulty: typeof body.difficulty === "string" ? body.difficulty.slice(0, 20) : "",
    classCode: classCode,
    season: isoWeek(now), // server-computed weekly bucket, e.g. "2026-W33"
    date: now // server-assigned, never trust the client's clock
  };
}

export default {
  async fetch(request, env){
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if(request.method === "OPTIONS"){
      return new Response(null, { headers: corsHeaders() });
    }

    try{
      if(path === "/api/ping" && request.method === "GET"){
        return json({ ok: true, time: Date.now() });
      }

      if(path === "/api/leaderboard" && request.method === "GET"){
        const entries = await readBoard(env);
        return json({ ok: true, entries: entries });
      }

      if(path === "/api/leaderboard" && request.method === "POST"){
        let body;
        try{ body = await request.json(); } catch(e){ return json({ ok:false, error:"invalid JSON" }, 400); }
        const entry = sanitizeEntry(body);
        if(!entry){ return json({ ok:false, error:"invalid payload \u2014 name and score are required" }, 400); }

        const list = await readBoard(env);
        list.push(entry);
        list.sort(function(a, b){ return b.score - a.score; });
        const trimmed = list.slice(0, MAX_ENTRIES);
        await writeBoard(env, trimmed);
        return json({ ok: true, entry: entry });
      }

      if(path === "/api/leaderboard" && request.method === "DELETE"){
        if(!isAdmin(request, env)){ return json({ ok:false, error:"unauthorized" }, 401); }
        await writeBoard(env, []);
        return json({ ok: true });
      }

      if(path.indexOf("/api/leaderboard/") === 0 && request.method === "DELETE"){
        if(!isAdmin(request, env)){ return json({ ok:false, error:"unauthorized" }, 401); }
        const id = decodeURIComponent(path.slice("/api/leaderboard/".length));
        const list = await readBoard(env);
        const filtered = list.filter(function(e){ return e.id !== id; });
        await writeBoard(env, filtered);
        return json({ ok: true, removed: list.length - filtered.length });
      }

      if(path === "/api/analytics" && request.method === "GET"){
        const entries = await readAnalytics(env);
        return json({ ok: true, entries: entries });
      }

      if(path === "/api/analytics" && request.method === "POST"){
        let body;
        try{ body = await request.json(); } catch(e){ return json({ ok:false, error:"invalid JSON" }, 400); }
        const rec = sanitizeAnalyticsBody(body);
        if(!rec){ return json({ ok:false, error:"invalid payload \u2014 id is required" }, 400); }

        const data = await readAnalytics(env);
        const existing = data[rec.id] || { attempts: 0, misses: 0, tense: rec.tense };
        existing.attempts += 1;
        if(!rec.correct) existing.misses += 1;
        if(rec.tense) existing.tense = rec.tense;
        data[rec.id] = existing;
        await writeAnalytics(env, data);
        return json({ ok: true });
      }

      if(path === "/api/analytics" && request.method === "DELETE"){
        if(!isAdmin(request, env)){ return json({ ok:false, error:"unauthorized" }, 401); }
        await writeAnalytics(env, {});
        return json({ ok: true });
      }

      return json({ ok: false, error: "not found" }, 404);
    }catch(e){
      return json({ ok: false, error: "server error" }, 500);
    }
  }
};
