// Musicalia multiplayer: um Durable Object por sala (WebSocket) + um Durable Object "Lobby" com a lista de salas públicas.
import { DurableObject } from "cloudflare:workers";

const ROWS = [4, 8, 8, 8];      // linhas do piano roll por instrumento
const SOUNDS = [3, 4, 4, 5];    // quantidade de sons por instrumento
const STEPS = 32;

const clean = (v, max, fallback) =>
  String(v == null ? "" : v).replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, max) || fallback;

function cleanNotes(a, i) {
  if (!Array.isArray(a)) return [];
  const out = [];
  for (const n of a.slice(0, 256)) {
    if (!Array.isArray(n)) continue;
    const r = n[0] | 0, s = n[1] | 0, l = n[2] | 0;
    if (r >= 0 && r < ROWS[i] && s >= 0 && s < STEPS && l >= 1) out.push([r, s, Math.min(l, STEPS - s)]);
  }
  return out;
}

export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    if (u.pathname === "/api/rooms") {
      const lobby = env.LOBBY.get(env.LOBBY.idFromName("main"));
      const r = await lobby.fetch("https://lobby/list");
      return new Response(r.body, { headers: { "content-type": "application/json", "cache-control": "no-store" } });
    }
    const m = u.pathname.match(/^\/api\/room\/([A-Z]{4})\/ws$/);
    if (m) {
      if (req.headers.get("Upgrade") !== "websocket") return new Response("Expected websocket", { status: 426 });
      return env.ROOM.get(env.ROOM.idFromName(m[1])).fetch(req);
    }
    return new Response("Not found", { status: 404 });
  },
};

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.s = null;
    ctx.blockConcurrencyWhile(async () => { this.s = (await ctx.storage.get("s")) || null; });
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(req) {
    this.code = new URL(req.url).pathname.split("/")[3];
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  fail(ws, msg, code) {
    try { ws.send(JSON.stringify({ t: "err", msg, code })); ws.close(1008, "err"); } catch (e) {}
  }

  async save() { await this.ctx.storage.put("s", this.s); }

  async webSocketMessage(ws, msg) {
    if (typeof msg !== "string" || msg.length > 30000) return;
    let m; try { m = JSON.parse(msg); } catch (e) { return; }
    const att = ws.deserializeAttachment();

    if (m.t === "hello") {
      if (att) return;
      if (!this.s) {
        if (!m.create) return this.fail(ws, "Não achei essa sala.", "missing");
        const g = Array.isArray(m.groove) ? m.groove : [];
        this.s = {
          code: this.code, name: clean(m.rname, 24, "Sala"), pub: !!m.pub, bpm: 80,
          seats: ["cpu", "cpu", "cpu", "cpu"], tracks: [0, 1, 2, 3].map((i) => cleanNotes(g[i], i)), inst: [0, 0, 0, 0],
        };
      } else if (m.create) return this.fail(ws, "Código em uso, tentando outro…", "taken");
      const id = clean(m.id, 40, ""); if (!id) return this.fail(ws, "Identificação inválida.");
      const name = clean(m.name, 16, "Jogador");
      const seats = this.s.seats, want = m.seat | 0;
      let idx = seats.findIndex((x) => x && x.id === id);
      if (idx < 0) {
        for (const c of [want, 0, 1, 2, 3]) {
          if (c >= 0 && c < 4 && (seats[c] === "cpu" || seats[c] === null)) { idx = c; break; }
        }
        if (idx < 0) return this.fail(ws, "A sala está cheia.", "full");
        if (seats[idx] === "cpu") this.s.tracks[idx] = []; // tirando a CPU: a pista começa vazia
      }
      seats[idx] = { id, name };
      ws.serializeAttachment({ id, seat: idx });
      await this.save();
      return this.sync(true);
    }

    if (!att || !this.s) return;
    const seat = this.s.seats[att.seat];
    if (!seat || seat.id !== att.id) return;
    if (m.t === "track" && m.i === att.seat) this.s.tracks[att.seat] = cleanNotes(m.notes, att.seat);
    else if (m.t === "inst" && m.i === att.seat && (m.v | 0) >= 0 && (m.v | 0) < SOUNDS[att.seat]) this.s.inst[att.seat] = m.v | 0;
    else if (m.t === "bpm" && typeof m.v === "number") this.s.bpm = Math.max(60, Math.min(140, Math.round(m.v)));
    else return;
    await this.save();
    await this.sync(false);
  }

  async webSocketClose(ws) { await this.drop(ws); }
  async webSocketError(ws) { await this.drop(ws); }

  async drop(ws) {
    const att = ws.deserializeAttachment();
    if (!att || !this.s) return;
    const still = this.ctx.getWebSockets().some((w) => {
      if (w === ws) return false; const a = w.deserializeAttachment(); return a && a.id === att.id && a.seat === att.seat;
    });
    if (still) return;
    const seat = this.s.seats[att.seat];
    if (seat && seat.id === att.id) { this.s.seats[att.seat] = null; await this.save(); await this.sync(true); }
  }

  humans() { return this.s.seats.filter((x) => x && x.id).length; }

  async sync(notify) {
    const s = this.s;
    const seats = s.seats.map((x) => (x === "cpu" ? { k: "cpu" } : x ? { k: "human", n: x.name } : { k: "free" }));
    for (const w of this.ctx.getWebSockets()) {
      const a = w.deserializeAttachment(); if (!a) continue;
      try { w.send(JSON.stringify({ t: "state", me: a.seat, name: s.name, bpm: s.bpm, seats, tracks: s.tracks, inst: s.inst })); } catch (e) {}
    }
    if (!notify) return;
    const n = this.humans();
    if (s.pub) {
      const lobby = this.env.LOBBY.get(this.env.LOBBY.idFromName("main"));
      this.ctx.waitUntil(lobby.fetch("https://lobby/upsert", { method: "POST", body: JSON.stringify({ code: s.code, name: s.name, count: n }) }));
    }
    if (n === 0) await this.ctx.storage.setAlarm(Date.now() + 3600e3); // sala vazia some em 1h
    else await this.ctx.storage.deleteAlarm();
  }

  async alarm() {
    if (this.s && this.humans() === 0) { await this.ctx.storage.deleteAll(); this.s = null; }
  }
}

export class Lobby extends DurableObject {
  async fetch(req) {
    const u = new URL(req.url), now = Date.now();
    const rooms = (await this.ctx.storage.get("r")) || {};
    for (const k of Object.keys(rooms)) if (now - rooms[k].t > 12 * 3600e3) delete rooms[k];
    if (u.pathname === "/upsert") {
      const b = await req.json();
      if (b.count > 0) rooms[b.code] = { code: b.code, name: clean(b.name, 24, "Sala"), count: b.count | 0, t: now };
      else delete rooms[b.code];
      await this.ctx.storage.put("r", rooms);
      return new Response("ok");
    }
    const list = Object.values(rooms).sort((a, b) => b.t - a.t).slice(0, 50).map((r) => ({ code: r.code, name: r.name, players: r.count, max: 4 }));
    return Response.json(list);
  }
}
