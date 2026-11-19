// Musicalia multiplayer: um Durable Object por sala (WebSocket) + um Durable Object "Lobby" com as salas públicas.
// Modos: "jam" (livre, CPU nos lugares vazios), "attack" (tempo contado) e "phone" (telefone sem fio).
import { DurableObject } from "cloudflare:workers";

const ROWS = [4, 8, 8, 8, 8];    // linhas do piano roll por instrumento
const SOUNDS = [3, 4, 4, 5, 4];  // sons por instrumento
const STEPS = 32, SEATS = 5, MEL = 3, BARS = [1, 2, 4, 8]; // pista 3 = Melodia (usada no telefone sem fio)
const MODES = ["jam", "attack", "phone"];
const PERMS = ["own", "ask", "free"]; // jam: cada um na sua pista / pedir permissão / todo mundo mexe em tudo
const DURS = { attack: [45, 60, 90, 120], phone: [30, 45, 60, 90] };
const INTRO = (n) => n * 1800 + 3100; // mesma conta do cliente
const HANDOFF = 2500;                 // pausa entre vezes no telefone

const clean = (v, max, fb) => String(v == null ? "" : v).replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, max) || fb;
function cleanNotes(a, i, steps = STEPS) {
  if (!Array.isArray(a)) return [];
  const out = [];
  for (const n of a.slice(0, 256)) {
    if (!Array.isArray(n)) continue;
    const r = n[0] | 0, s = n[1] | 0, l = n[2] | 0;
    if (r >= 0 && r < ROWS[i] && s >= 0 && s < steps && l >= 1) out.push([r, s, Math.min(l, steps - s)]);
  }
  return out;
}
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function melody() { // melodia curta e cantável: passeio aleatório na escala, 6 a 8 notas
  const out = [], target = 6 + Math.floor(Math.random() * 3);
  let pos = 0, row = 2 + Math.floor(Math.random() * 4);
  while (pos < STEPS && out.length < target) {
    const len = [2, 2, 2, 4, 4, 1][Math.floor(Math.random() * 6)];
    if (pos + len > STEPS) break;
    out.push([row, pos, len]);
    pos += len + (Math.random() < 0.3 ? 2 : 0);
    row = Math.max(0, Math.min(7, row + [-2, -1, -1, 1, 1, 2, 0][Math.floor(Math.random() * 7)]));
  }
  return out;
}

export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    if (u.pathname === "/api/rooms") {
      const r = await env.LOBBY.get(env.LOBBY.idFromName("main")).fetch("https://lobby/list");
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
    ctx.blockConcurrencyWhile(async () => {
      const s = (await ctx.storage.get("s")) || null;
      this.s = s && s.v === 2 ? s : null; // formato antigo: descarta
    });
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(req) {
    this.code = new URL(req.url).pathname.split("/")[3];
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  fail(ws, msg, code) { try { ws.send(JSON.stringify({ t: "err", msg, code })); ws.close(1008, "err"); } catch (e) {} }
  async save() { await this.ctx.storage.put("s", this.s); }
  humans() { return this.s.seats.filter((x) => x && x.id); }
  live() { const g = this.s.game; return g.phase === "run" && (this.s.mode === "phone" || Date.now() < g.endAt); }

  async webSocketMessage(ws, msg) {
    if (typeof msg !== "string" || msg.length > 30000) return;
    let m; try { m = JSON.parse(msg); } catch (e) { return; }
    const att = ws.deserializeAttachment();
    if (m.t === "hello") return this.hello(ws, m, att);
    if (!att || !this.s) return;
    const s = this.s, seat = s.seats[att.seat], g = s.game, now = Date.now(), host = att.id === s.host;
    if (!seat || seat.id !== att.id) return;

    if (m.t === "track") {
      if (typeof m.i !== "number" || !this.canEdit(att, m.i) || s.mode === "phone") return;
      if (s.mode === "attack" && !(g.phase === "run" && now >= g.playAt - 300 && now <= g.endAt + 1500)) return;
      s.tracks[m.i] = cleanNotes(m.notes, m.i, this.steps());
    } else if (m.t === "inst") {
      const v = m.v | 0; if (typeof m.i !== "number" || !this.canEdit(att, m.i) || v < 0 || v >= SOUNDS[m.i]) return;
      s.inst[m.i] = v;
    } else if (m.t === "bpm" && typeof m.v === "number") {
      if (s.mode !== "jam" && (!host || this.live())) return;
      s.bpm = Math.max(60, Math.min(140, Math.round(m.v)));
    } else if (m.t === "dur") {
      if (!host || this.live() || !DURS[s.mode] || !DURS[s.mode].includes(m.v)) return;
      g.dur = m.v;
    } else if (m.t === "start") {
      if (!host || s.mode === "jam" || this.live()) return;
      const people = this.humans().length ? s.seats.map((x, i) => (x && x.id ? i : -1)).filter((i) => i >= 0) : [];
      if (!people.length) return;
      const order = s.mode === "phone" ? shuffle(people.slice()) : people;
      g.lineup = order.map((i) => ({ seat: i, name: s.seats[i].name, id: s.seats[i].id }));
      g.introAt = now + 600; g.playAt = g.introAt + INTRO(order.length); g.phase = "run";
      if (s.mode === "attack") { s.tracks = s.tracks.map(() => []); g.endAt = g.playAt + g.dur * 1000; }
      else { g.turn = 0; g.turnAt = g.playAt; g.turnEnd = g.playAt + g.dur * 1000; g.original = melody(); g.attempts = []; this.skipGone(); }
    } else if (m.t === "submit" || m.t === "tick") {
      if (s.mode !== "phone" || g.phase !== "run") return;
      const cur = g.lineup[g.turn]; if (!cur) return;
      if (m.t === "submit") { if (cur.seat !== att.seat || cur.id !== att.id || now < g.turnAt - 500) return; g.attempts[g.turn] = cleanNotes(m.notes, MEL); }
      else { if (now < g.turnEnd) return; if (g.attempts[g.turn] === undefined) g.attempts[g.turn] = null; }
      this.nextTurn(now);
    } else if (m.t === "bars") { // tamanho do loop (só na jam): dup dobra copiando as notas
      const v = m.v | 0, old = this.steps(); if (s.mode !== "jam" || !BARS.includes(v) || v === (s.bars || 2)) return;
      if (m.dup && v === (s.bars || 2) * 2) s.tracks = s.tracks.map((t) => t.concat(t.map((n) => [n[0], n[1] + old, n[2]])));
      s.bars = v; s.tracks = s.tracks.map((t, i) => cleanNotes(t, i, this.steps()));
    } else if (m.t === "ask") { // pedir para editar a pista de outra pessoa
      const i = m.i | 0; if (s.mode !== "jam" || s.perm !== "ask" || i < 0 || i >= SEATS || this.canEdit(att, i)) return;
      if (s.reqs.some((r) => r.from === att.id && r.i === i)) return;
      s.reqs.push({ k: Math.random().toString(36).slice(2, 10), from: att.id, name: seat.name, i });
      if (s.reqs.length > 20) s.reqs.shift();
    } else if (m.t === "answer") {
      const r = s.reqs.find((x) => x.k === m.k); if (!r || this.approver(r.i) !== att.id) return;
      s.reqs = s.reqs.filter((x) => x !== r);
      if (m.ok && !s.grants[r.i].includes(r.from)) s.grants[r.i].push(r.from);
    } else if (m.t === "revoke") {
      const i = m.i | 0; if (i < 0 || i >= SEATS || this.approver(i) !== att.id) return;
      s.grants[i] = [];
    } else if (m.t === "reset") {
      if (!host || s.mode === "jam") return;
      g.phase = "wait";
    } else return;
    await this.save();
    await this.sync(m.t === "start" || m.t === "reset" || m.t === "submit" || m.t === "tick");
  }

  steps() { return (this.s.bars || 2) * 16; }
  approver(i) { const x = this.s.seats[i]; return x && x.id ? x.id : this.s.host; }
  canEdit(att, i) {
    const s = this.s; if (i < 0 || i >= SEATS) return false;
    if (i === att.seat) return true;
    if (s.mode !== "jam") return false;
    return s.perm === "free" || (s.perm === "ask" && s.grants[i].includes(att.id));
  }
  nextTurn(now) {
    const g = this.s.game;
    g.turn++; g.turnAt = now + HANDOFF; g.turnEnd = g.turnAt + g.dur * 1000;
    this.skipGone();
    if (g.turn >= g.lineup.length) g.phase = "end";
  }
  skipGone() { // quem saiu da sala perde a vez
    const g = this.s.game;
    while (g.turn < g.lineup.length) {
      const p = g.lineup[g.turn], x = this.s.seats[p.seat];
      if (x && x.id === p.id) break;
      g.attempts[g.turn] = null; g.turn++;
    }
    if (g.turn >= g.lineup.length) g.phase = "end";
  }

  async hello(ws, m, att) {
    if (att) return;
    if (!this.s) {
      if (!m.create) return this.fail(ws, "Não achei essa sala.", "missing");
      const mode = MODES.includes(m.mode) ? m.mode : "jam";
      const g = Array.isArray(m.groove) ? m.groove : [];
      const dur = DURS[mode] && DURS[mode].includes(m.dur) ? m.dur : mode === "phone" ? 45 : 90;
      this.s = {
        v: 2, code: this.code, name: clean(m.rname, 24, "Sala"), pub: !!m.pub, mode, perm: mode === "jam" && PERMS.includes(m.perm) ? m.perm : "own",
        grants: Array.from({ length: SEATS }, () => []), reqs: [], bpm: mode === "jam" ? 80 : 90, host: null,
        seats: Array(SEATS).fill(mode === "jam" ? "cpu" : null),
        tracks: [...Array(SEATS).keys()].map((i) => (mode === "jam" ? cleanNotes(g[i], i) : [])),
        inst: Array(SEATS).fill(0), game: { phase: "wait", dur, lineup: [] },
      };
    } else if (m.create) return this.fail(ws, "Código em uso, tentando outro…", "taken");
    const id = clean(m.id, 40, ""); if (!id) return this.fail(ws, "Identificação inválida.");
    const s = this.s, seats = s.seats;
    let idx = seats.findIndex((x) => x && x.id === id);
    if (idx < 0) {
      for (const c of [m.seat | 0, ...Array(SEATS).keys()]) if (c >= 0 && c < SEATS && (seats[c] === "cpu" || seats[c] === null)) { idx = c; break; }
      if (idx < 0) return this.fail(ws, "A sala está cheia.", "full");
      if (seats[idx] === "cpu") s.tracks[idx] = []; // tirando a CPU: a pista começa vazia
      s.grants[idx] = []; s.reqs = s.reqs.filter((r) => r.i !== idx); // lugar mudou de dono
    }
    seats[idx] = { id, name: clean(m.name, 16, "Jogador") };
    if (!s.host || !this.humans().some((x) => x.id === s.host)) s.host = id;
    ws.serializeAttachment({ id, seat: idx });
    await this.save();
    await this.sync(true);
  }

  async webSocketClose(ws) { await this.drop(ws); }
  async webSocketError(ws) { await this.drop(ws); }
  async drop(ws) {
    const att = ws.deserializeAttachment();
    if (!att || !this.s) return;
    const still = this.ctx.getWebSockets().some((w) => { if (w === ws) return false; const a = w.deserializeAttachment(); return a && a.id === att.id; });
    if (still) return;
    const s = this.s, seat = s.seats[att.seat];
    if (!seat || seat.id !== att.id) return;
    s.seats[att.seat] = null;
    s.reqs = s.reqs.filter((r) => r.from !== att.id);
    s.grants = s.grants.map((g) => g.filter((id) => id !== att.id));
    if (s.host === att.id) { const h = this.humans()[0]; s.host = h ? h.id : null; }
    const g = s.game;
    if (s.mode === "phone" && g.phase === "run" && g.lineup[g.turn] && g.lineup[g.turn].id === att.id) {
      if (g.attempts[g.turn] === undefined) g.attempts[g.turn] = null;
      this.nextTurn(Date.now());
    }
    await this.save();
    await this.sync(true);
  }

  view(a) { // o que cada jogador pode ver (no telefone, a melodia só vai para quem está na vez)
    const s = this.s, g = s.game;
    const game = { phase: g.phase, dur: g.dur, lineup: (g.lineup || []).map((p) => ({ seat: p.seat, name: p.name })), introAt: g.introAt, playAt: g.playAt, endAt: g.endAt };
    if (s.mode === "phone" && g.lineup.length) {
      Object.assign(game, { turn: g.turn, turnAt: g.turnAt, turnEnd: g.turnEnd, done: (g.attempts || []).length });
      const cur = g.lineup[g.turn];
      if (g.phase === "run" && cur && cur.seat === a.seat && cur.id === a.id) {
        let src = g.original; for (let k = g.turn - 1; k >= 0; k--) if (g.attempts[k]) { src = g.attempts[k]; break; }
        game.src = src;
      }
      if (g.phase === "end") { game.original = g.original; game.attempts = g.lineup.map((_, k) => g.attempts[k] || null); }
    }
    return {
      t: "state", now: Date.now(), bars: s.bars || 2, me: a.seat, host: a.id === s.host, mode: s.mode, name: s.name, bpm: s.bpm,
      seats: s.seats.map((x) => (x === "cpu" ? { k: "cpu" } : x ? { k: "human", n: x.name, h: x.id === s.host } : { k: "free" })),
      tracks: s.tracks, inst: s.inst, game, perm: s.perm,
      edit: s.seats.map((_, i) => this.canEdit(a, i)),
      asked: s.reqs.filter((r) => r.from === a.id).map((r) => r.i),
      reqs: s.reqs.filter((r) => this.approver(r.i) === a.id).map((r) => ({ k: r.k, name: r.name, i: r.i })),
      granted: s.grants.map((g) => g.map((id) => { const x = s.seats.find((y) => y && y.id === id); return x ? x.name : null; }).filter(Boolean)),
    };
  }

  async sync(notify) {
    for (const w of this.ctx.getWebSockets()) {
      const a = w.deserializeAttachment(); if (!a) continue;
      try { w.send(JSON.stringify(this.view(a))); } catch (e) {}
    }
    if (!notify) return;
    const s = this.s, n = this.humans().length;
    if (s.pub) {
      const lobby = this.env.LOBBY.get(this.env.LOBBY.idFromName("main"));
      this.ctx.waitUntil(lobby.fetch("https://lobby/upsert", { method: "POST", body: JSON.stringify({ code: s.code, name: s.name, mode: s.mode, live: this.live(), count: n }) }));
    }
    if (n === 0) await this.ctx.storage.setAlarm(Date.now() + 3600e3); // sala vazia some em 1h
    else await this.ctx.storage.deleteAlarm();
  }

  async alarm() { if (this.s && this.humans().length === 0) { await this.ctx.storage.deleteAll(); this.s = null; } }
}

export class Lobby extends DurableObject {
  async fetch(req) {
    const u = new URL(req.url), now = Date.now();
    const rooms = (await this.ctx.storage.get("r")) || {};
    for (const k of Object.keys(rooms)) if (now - rooms[k].t > 12 * 3600e3) delete rooms[k];
    if (u.pathname === "/upsert") {
      const b = await req.json();
      if (b.count > 0) rooms[b.code] = { code: b.code, name: clean(b.name, 24, "Sala"), mode: MODES.includes(b.mode) ? b.mode : "jam", live: !!b.live, count: b.count | 0, t: now };
      else delete rooms[b.code];
      await this.ctx.storage.put("r", rooms);
      return new Response("ok");
    }
    return Response.json(Object.values(rooms).sort((a, b) => b.t - a.t).slice(0, 50)
      .map((r) => ({ code: r.code, name: r.name, mode: r.mode || "jam", live: !!r.live, players: r.count, max: SEATS })));
  }
}
