// Go server: serves the game from public/ and referees online games over a WebSocket at /ws.
// The rules come from public/go.js, the same module the browser uses, so the server rejects
// anything the rules don't allow (ko, suicide, playing out of turn).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Game, BLACK, WHITE, BOARD_SIZES, maxHandicap, other, colorName } from './public/go.js';
import { estimateDead } from './public/ai.js';

const PORT = Number(process.env.PORT || 3000);
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const ROOM_IDLE_MS = 30 * 60 * 1000; // a room with nobody connected lasts this long
const WAITING_IDLE_MS = 10 * 60 * 1000; // an unjoined room whose host left lasts this long

// ── Static files ─────────────────────────────────────────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }
  if (urlPath === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
    return;
  }
  if (urlPath.endsWith('/')) urlPath += 'index.html';
  const filePath = path.join(PUBLIC, urlPath);
  // path.join resolves '..': a request must not climb out of public/.
  if (!filePath.startsWith(PUBLIC + path.sep)) {
    res.writeHead(404).end('Not found');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      // Small files, frequent deploys: always revalidate so nobody plays a stale build.
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

// ── Rooms ────────────────────────────────────────────────────────────────────

const rooms = new Map(); // code → room
const CODE_CHARS = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; // no 0/O/1/I/L

function makeCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function cleanName(name) {
  const n = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 20);
  return n || 'Player';
}

function cleanSettings(s = {}) {
  const size = BOARD_SIZES.includes(Number(s.size)) ? Number(s.size) : 19;
  let komi = Math.round(Number(s.komi) * 2) / 2;
  if (!Number.isFinite(komi) || Math.abs(komi) > 50) komi = 7.5;
  let handicap = Math.floor(Number(s.handicap) || 0);
  handicap = handicap >= 2 ? Math.min(handicap, maxHandicap(size)) : 0;
  const color = ['black', 'white', 'random'].includes(s.color) ? s.color : 'random';
  return { size, komi, handicap, color };
}

function seatOf(room, ws) {
  if (room.seats[BLACK]?.ws === ws) return BLACK;
  if (room.seats[WHITE]?.ws === ws) return WHITE;
  return 0;
}

function roomView(room) {
  const seat = (c) => {
    const s = room.seats[c];
    return s ? { name: s.name, connected: s.connected, left: !!s.left } : null;
  };
  return {
    code: room.code,
    settings: room.settings,
    players: { black: seat(BLACK), white: seat(WHITE) },
    game: room.game ? room.game.toJSON() : null,
    accepted: { black: room.accepted[BLACK], white: room.accepted[WHITE] },
    rematch: { black: room.rematch[BLACK], white: room.rematch[WHITE] },
    gameNumber: room.gameNumber,
  };
}

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcast(room) {
  const view = roomView(room);
  for (const c of [BLACK, WHITE]) {
    const s = room.seats[c];
    if (s?.connected) send(s.ws, { type: 'state', you: colorName(c), room: view });
  }
}

function startGame(room) {
  const { size, komi, handicap } = room.settings;
  room.game = new Game({ size, komi, handicap });
  room.accepted = { [BLACK]: false, [WHITE]: false };
  room.rematch = { [BLACK]: false, [WHITE]: false };
  room.gameNumber++;
}

// After the second pass: guess the dead stones so players only fix the guess, not mark it all.
function enterScoring(room) {
  const { dead } = estimateDead(room.game, { playouts: 600 });
  room.game.setDead(dead);
  room.accepted = { [BLACK]: false, [WHITE]: false };
}

function touch(room) {
  room.lastActive = Date.now();
}

// ── Messages ─────────────────────────────────────────────────────────────────

const handlers = {
  create(ws, msg) {
    leaveCurrent(ws);
    const settings = cleanSettings(msg.settings);
    const code = makeCode();
    const token = crypto.randomUUID();
    const seat = { name: cleanName(msg.name), token, ws, connected: true };
    const hostColor = settings.color === 'white' ? WHITE : BLACK; // random is settled on join
    const room = {
      code,
      settings,
      seats: { [BLACK]: null, [WHITE]: null },
      game: null,
      accepted: { [BLACK]: false, [WHITE]: false },
      rematch: { [BLACK]: false, [WHITE]: false },
      gameNumber: 0,
      created: Date.now(),
      lastActive: Date.now(),
    };
    room.seats[hostColor] = seat;
    rooms.set(code, room);
    ws.roomCode = code;
    send(ws, { type: 'joined', code, token });
    broadcast(room);
  },

  join(ws, msg) {
    const code = String(msg.code || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return send(ws, { type: 'error', msg: `No game with code ${code || '?'}` });
    if (room.seats[BLACK] && room.seats[WHITE]) return send(ws, { type: 'error', msg: 'That game already has two players' });
    leaveCurrent(ws);
    const token = crypto.randomUUID();
    const seat = { name: cleanName(msg.name), token, ws, connected: true };
    // A "random" host may be swapped onto either colour.
    if (room.settings.color === 'random' && crypto.randomInt(2)) {
      const host = room.seats[BLACK] || room.seats[WHITE];
      room.seats[BLACK] = seat;
      room.seats[WHITE] = host;
    } else if (room.seats[BLACK]) {
      room.seats[WHITE] = seat;
    } else {
      room.seats[BLACK] = seat;
    }
    ws.roomCode = code;
    touch(room);
    startGame(room);
    send(ws, { type: 'joined', code, token });
    broadcast(room);
  },

  rejoin(ws, msg) {
    const room = rooms.get(String(msg.code || '').toUpperCase());
    const color = room && [BLACK, WHITE].find((c) => room.seats[c]?.token === msg.token && !room.seats[c].left);
    if (!color) return send(ws, { type: 'rejoinFailed' });
    leaveCurrent(ws);
    const seat = room.seats[color];
    if (seat.ws && seat.ws !== ws) {
      seat.ws.roomCode = null;
      seat.ws.close(4000, 'Replaced by a newer connection');
    }
    seat.ws = ws;
    seat.connected = true;
    ws.roomCode = room.code;
    touch(room);
    send(ws, { type: 'joined', code: room.code, token: seat.token });
    broadcast(room);
  },

  list(ws) {
    const open = [];
    for (const room of rooms.values()) {
      const host = room.seats[BLACK] || room.seats[WHITE];
      if (!room.game && host?.connected) {
        open.push({ code: room.code, host: host.name, ...room.settings });
      }
    }
    send(ws, { type: 'rooms', rooms: open });
  },

  move(ws, msg, room, color) {
    const g = room.game;
    if (!g || g.toMove !== color) return send(ws, { type: 'error', msg: 'Not your turn' });
    const r = g.play(Number(msg.idx));
    if (!r.ok) return send(ws, { type: 'error', msg: r.error });
    broadcast(room);
  },

  pass(ws, msg, room, color) {
    const g = room.game;
    if (!g || g.phase !== 'play' || g.toMove !== color) return send(ws, { type: 'error', msg: 'Not your turn' });
    g.pass();
    if (g.phase === 'scoring') enterScoring(room);
    broadcast(room);
  },

  resign(ws, msg, room, color) {
    if (!room.game || !room.game.resign(color).ok) return;
    broadcast(room);
  },

  toggleDead(ws, msg, room) {
    if (!room.game?.toggleDead(Number(msg.idx))) return;
    // Any change to the count needs both players to agree again.
    room.accepted = { [BLACK]: false, [WHITE]: false };
    broadcast(room);
  },

  accept(ws, msg, room, color) {
    if (room.game?.phase !== 'scoring') return;
    room.accepted[color] = true;
    if (room.accepted[BLACK] && room.accepted[WHITE]) room.game.finishScoring();
    broadcast(room);
  },

  resume(ws, msg, room) {
    if (!room.game?.resume()) return;
    room.accepted = { [BLACK]: false, [WHITE]: false };
    broadcast(room);
  },

  rematch(ws, msg, room, color) {
    if (room.game?.phase !== 'over') return;
    if (room.seats[other(color)]?.left) return send(ws, { type: 'error', msg: 'Your opponent has left' });
    room.rematch[color] = true;
    if (room.rematch[BLACK] && room.rematch[WHITE]) {
      // Swap colours each game.
      [room.seats[BLACK], room.seats[WHITE]] = [room.seats[WHITE], room.seats[BLACK]];
      startGame(room);
    }
    broadcast(room);
  },

  leave(ws) {
    leaveCurrent(ws);
    send(ws, { type: 'left' });
  },
};

// Leaving on purpose: a game in progress is resigned; an unjoined room is closed.
function leaveCurrent(ws) {
  const room = ws.roomCode && rooms.get(ws.roomCode);
  ws.roomCode = null;
  if (!room) return;
  const color = seatOf(room, ws);
  if (!color) return;
  if (!room.game) {
    rooms.delete(room.code);
    return;
  }
  if (room.game.phase !== 'over') room.game.resign(color);
  Object.assign(room.seats[color], { left: true, connected: false, ws: null });
  if (!room.seats[other(color)]?.connected) rooms.delete(room.code);
  else broadcast(room);
}

const ROOMLESS = new Set(['create', 'join', 'rejoin', 'list', 'leave']);

function onMessage(ws, raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  const handler = Object.hasOwn(handlers, msg?.type) && handlers[msg.type];
  if (!handler) return;
  if (ROOMLESS.has(msg.type)) return handler(ws, msg);
  const room = ws.roomCode && rooms.get(ws.roomCode);
  const color = room && seatOf(room, ws);
  if (!color) return send(ws, { type: 'error', msg: 'You are not in a game' });
  touch(room);
  handler(ws, msg, room, color);
}

function onClose(ws) {
  const room = ws.roomCode && rooms.get(ws.roomCode);
  if (!room) return;
  const color = seatOf(room, ws);
  if (!color) return;
  room.seats[color].connected = false;
  touch(room);
  broadcast(room);
}

function sweep() {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const anyone = [BLACK, WHITE].some((c) => room.seats[c]?.connected);
    if (anyone) continue;
    const limit = room.game ? ROOM_IDLE_MS : WAITING_IDLE_MS;
    if (now - room.lastActive > limit) rooms.delete(code);
  }
}

// ── Wiring ───────────────────────────────────────────────────────────────────

export function startServer(port = PORT) {
  const server = http.createServer(serveStatic);
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });
  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));
    ws.on('message', (raw) => onMessage(ws, raw));
    ws.on('close', () => onClose(ws));
    ws.on('error', () => {});
  });
  // Pings keep proxies (Cloudflare drops idle sockets after ~100 s) from closing quiet games,
  // and find sockets whose phone went to sleep.
  const pinger = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30_000);
  const sweeper = setInterval(sweep, 60_000);
  server.wss = wss;
  server.on('close', () => {
    clearInterval(pinger);
    clearInterval(sweeper);
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = await startServer();
  console.log(`Go server on http://localhost:${server.address().port}/`);
}
