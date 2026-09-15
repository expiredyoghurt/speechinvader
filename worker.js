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
 *   GET    /api/settings             -> { ok: true, settings: {...} }      (public)
 *   POST   /api/settings             -> { ok: true, settings: {...} }      (admin only)
 *
 * v1.5: Class Controls. A single small object controlling which practice
 * modes and difficulty tiers are currently open to students -- lets a
 * teacher temporarily switch off e.g. Novice or Spot the Error class-wide
 * (say, during an assessment week) without editing any file. Reads are
 * public so every device's mode-select screen can respect it; writes are
 * admin-only, same as deletes. Missing/unset keys default to "on" so an
 * empty/never-configured settings object behaves exactly like v1.4.2.
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

import { DurableObject } from "cloudflare:workers";

/**
 * v1.5.1: TeamChallengeRoom -- Durable Object backing the live-push Team
 * Leaderboard. One instance ever gets created (see idFromName("global")
 * below) since a single classroom only ever runs one projector view at a
 * time. It does two things:
 *
 *   1. Accepts WebSocket upgrades from the projector's Team Leaderboard
 *      screen and holds those sockets (via the Hibernation API, so the
 *      object can be evicted between messages instead of billing as
 *      "active" the whole lesson).
 *   2. Accepts an internal POST /broadcast from the main Worker fetch
 *      handler every time a score is submitted, and relays that entry to
 *      every connected socket.
 *
 * This is a SQLite-backed Durable Object (see new_sqlite_classes in
 * wrangler.toml) -- that matters because it's what makes this feature run
 * on the Workers FREE plan. The older key-value storage backend for
 * Durable Objects is Paid-plan-only; SQLite-backed ones are free-tier from
 * the ground up:
 * https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/#create-sqlite-backed-durable-object-class
 *
 * KV is still the only source of truth for actual scores. The embedded
 * SQLite table here holds nothing but a short rolling log of the last 50
 * broadcasts, purely so a projector that briefly drops connection (wifi
 * blip, laptop sleep) can replay whatever it missed the moment it
 * reconnects, instead of sitting stale until the fallback poll fires. If
 * this object is evicted and that log is lost, the worst case is still
 * just a missed live update -- the client always re-syncs a full snapshot
 * from GET /api/leaderboard every time the Team Leaderboard screen opens.
 */
export class TeamChallengeRoom extends DurableObject {
  constructor(ctx, env){
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS recent_broadcasts(" +
      "id INTEGER PRIMARY KEY AUTOINCREMENT, entry TEXT NOT NULL, ts INTEGER NOT NULL)"
    );
  }

  async fetch(request){
    const url = new URL(request.url);

    if(url.pathname === "/connect"){
      if(request.headers.get("Upgrade") !== "websocket"){
        return new Response("expected websocket", { status: 426 });
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      // Hibernation API: the runtime can drop this object from memory
      // between events and wake it back up on the next message/close,
      // rather than billing it as continuously active for the whole time
      // a projector tab is just sitting open with no new scores coming in.
      this.ctx.acceptWebSocket(server);

      // Replay anything broadcast after the timestamp the client's last
      // socket saw (passed as ?since=<ms>), so a brief drop mid-lesson
      // doesn't silently lose a score before the next reconnect.
      const since = Number(url.searchParams.get("since") || 0);
      if(since > 0){
        const rows = this.sql.exec(
          "SELECT entry, ts FROM recent_broadcasts WHERE ts > ? ORDER BY ts ASC",
          since
        ).toArray();
        for(const row of rows){
          try{ server.send(JSON.stringify({ type: "score", entry: JSON.parse(row.entry), ts: row.ts })); }
          catch(e){ /* client not actually ready yet; fallback poll covers it */ }
        }
      }

      return new Response(null, { status: 101, webSocket: client });
    }

    if(url.pathname === "/broadcast" && request.method === "POST"){
      let entry;
      try{ entry = await request.json(); }catch(e){ return new Response("bad json", { status: 400 }); }
      const ts = Date.now();
      this.sql.exec("INSERT INTO recent_broadcasts (entry, ts) VALUES (?, ?)", JSON.stringify(entry), ts);
      // Keep the log short -- this is a reconnect buffer, not a history
      // feature, so bound it well under the free plan's row-write limits.
      this.sql.exec(
        "DELETE FROM recent_broadcasts WHERE id NOT IN (SELECT id FROM recent_broadcasts ORDER BY id DESC LIMIT 50)"
      );
      const payload = JSON.stringify({ type: "score", entry: entry, ts: ts });
      for(const ws of this.ctx.getWebSockets()){
        try{ ws.send(payload); }catch(e){ /* socket gone; hibernation API cleans it up */ }
      }
      return new Response("ok");
    }

    return new Response("not found", { status: 404 });
  }

  // Required by the Hibernation API even though the projector view is
  // read-only and never sends application messages up to us.
  async webSocketMessage(ws, message){ /* no-op: push-only channel */ }

  async webSocketClose(ws, code, reason, wasClean){
    try{ ws.close(code, reason); }catch(e){ /* already closing */ }
  }

  async webSocketError(ws){
    try{ ws.close(1011, "error"); }catch(e){ /* already closing */ }
  }
}

const KV_KEY = "leaderboard";
const ANALYTICS_KEY = "analytics";
const SETTINGS_KEY = "settings";
const MAX_ENTRIES = 100;
const MAX_NAME_LEN = 18;
const MAX_CLASS_LEN = 20;
const MAX_QID_LEN = 60;

// v1.5: default Class Controls -- everything on. Only the keys a teacher
// has actually toggled off are stored in KV; this default is merged under
// whatever's stored so new modes/difficulties added later default to "on".
const DEFAULT_SETTINGS = {
  modes: { fill: true, spot: true },
  difficulties: { novice: true, veteran: true, elite: true },
  categories: {
    simplePast: true, pastProgressive: true, pastPerfect: true, pastPerfectProgressive: true,
    reportedQuestions: true, reportedCommands: true, activeToPassive: true, passiveToActive: true
  },
  questionTypes: { tenseAspect: true, reportedSpeech: true, voiceConversion: true, custom: true }
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Admin-Secret, signature-agent", 
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

async function readSettings(env){
  const raw = await env.LEADERBOARD.get(SETTINGS_KEY);
  let stored = {};
  if(raw){
    try{
      const parsed = JSON.parse(raw);
      if(parsed && typeof parsed === "object" && !Array.isArray(parsed)) stored = parsed;
    }catch(e){ stored = {}; }
  }
  return {
    modes: Object.assign({}, DEFAULT_SETTINGS.modes, stored.modes || {}),
    difficulties: Object.assign({}, DEFAULT_SETTINGS.difficulties, stored.difficulties || {}),
    categories: Object.assign({}, DEFAULT_SETTINGS.categories, stored.categories || {}),
    questionTypes: Object.assign({}, DEFAULT_SETTINGS.questionTypes, stored.questionTypes || {})
  };
}

function sanitizeSettings(body){
  if(!body || typeof body !== "object") return null;
  const out = { modes: {}, difficulties: {}, categories: {}, questionTypes: {} };
  const modeKeys = ["fill", "spot"];
  const diffKeys = ["novice", "veteran", "elite"];
  const questionTypeKeys = ["tenseAspect", "reportedSpeech", "voiceConversion", "custom"];
  const categoryKeys = ["simplePast", "pastProgressive", "pastPerfect", "pastPerfectProgressive", "reportedQuestions", "reportedCommands", "activeToPassive", "passiveToActive"];
  modeKeys.forEach(function(k){
    if(body.modes && typeof body.modes === "object" && typeof body.modes[k] === "boolean"){
      out.modes[k] = body.modes[k];
    }
  });
  diffKeys.forEach(function(k){
    if(body.difficulties && typeof body.difficulties === "object" && typeof body.difficulties[k] === "boolean"){
      out.difficulties[k] = body.difficulties[k];
    }
  });
  questionTypeKeys.forEach(function(k){
    if(body.questionTypes && typeof body.questionTypes === "object" && typeof body.questionTypes[k] === "boolean"){
      out.questionTypes[k] = body.questionTypes[k];
    }
  });
  categoryKeys.forEach(function(k){
    if(body.categories && typeof body.categories === "object" && typeof body.categories[k] === "boolean"){
      out.categories[k] = body.categories[k];
    }
  });
  return out;
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

// One Team Challenge room for the whole Worker -- a classroom only ever
// runs one projector session at a time, so there's nothing to key this by.
function teamChallengeStub(env){
  const id = env.TEAM_CHALLENGE.idFromName("global");
  return env.TEAM_CHALLENGE.get(id);
}

export default {
  async fetch(request, env, ctx){
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if(request.method === "OPTIONS"){
      return new Response(null, { headers: corsHeaders() });
    }

    // v1.5.1: live push channel for the Team Leaderboard. Not wrapped in
    // corsHeaders() since a 101 Switching Protocols response can't carry a
    // JSON body or those headers anyway.
    if(path === "/api/team-challenge/connect"){
      return teamChallengeStub(env).fetch(request);
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
        // Fire-and-forget push to any open Team Leaderboard projector.
        // ctx.waitUntil keeps this from delaying or ever failing the
        // pupil's own score submission -- if no one has the board open,
        // or the DO is unreachable, this silently does nothing.
        ctx.waitUntil(
          teamChallengeStub(env)
            .fetch("https://internal/broadcast", { method: "POST", body: JSON.stringify(entry) })
            .catch(function(){ /* no listeners; ignore */ })
        );
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

      if(path === "/api/settings" && request.method === "GET"){
        const settings = await readSettings(env);
        return json({ ok: true, settings: settings });
      }

      if(path === "/api/settings" && request.method === "POST"){
        if(!isAdmin(request, env)){ return json({ ok:false, error:"unauthorized" }, 401); }
        let body;
        try{ body = await request.json(); } catch(e){ return json({ ok:false, error:"invalid JSON" }, 400); }
        const incoming = sanitizeSettings(body);
        if(!incoming){ return json({ ok:false, error:"invalid payload" }, 400); }
        const current = await readSettings(env);
        const merged = {
          modes: Object.assign({}, current.modes, incoming.modes),
          difficulties: Object.assign({}, current.difficulties, incoming.difficulties),
          categories: Object.assign({}, current.categories, incoming.categories),
          questionTypes: Object.assign({}, current.questionTypes, incoming.questionTypes)
        };
        await env.LEADERBOARD.put(SETTINGS_KEY, JSON.stringify(merged));
        return json({ ok: true, settings: merged });
      }
// GET settings
if (path === "/api/settings" && request.method === "GET") {
  const raw = await env.LEADERBOARD.get("settings");
  const settings = raw ? JSON.parse(raw) : {};
  return json({ ok: true, settings });
}

// POST settings (admin-only)
if (path === "/api/settings" && request.method === "POST") {
  if (!isAdmin(request, env)) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }
  let body;
  try { body = await request.json(); } catch (e) {
    return json({ ok: false, error: "invalid JSON" }, 400);
  }
  if (!body || typeof body !== "object") {
    return json({ ok: false, error: "invalid payload" }, 400);
  }
  await env.LEADERBOARD.put("settings", JSON.stringify(body));
  return json({ ok: true });
}

      return json({ ok: false, error: "not found" }, 404);
    }catch(e){
      return json({ ok: false, error: "server error" }, 500);
    }
  }
};
