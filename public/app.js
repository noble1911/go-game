// The page: menu, game setup, and the three ways to play (the computer, pass & play, online).
import { Game, BLACK, WHITE, PASS, other, maxHandicap } from './go.js';
import { BoardView } from './board.js';
import { playStone, unlockAudio, isMuted, setMuted } from './sound.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

// Every game on games.noblehaus.uk shares one origin, so keys carry a "go." prefix.
const store = {
  get(key, fallback = null) {
    try {
      const v = localStorage.getItem(`go.${key}`);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`go.${key}`, JSON.stringify(value));
    } catch {}
  },
  del(key) {
    try {
      localStorage.removeItem(`go.${key}`);
    } catch {}
  },
};

const LEVEL_LABELS = { beginner: 'Beginner', easy: 'Easy', medium: 'Medium', hard: 'Hard' };

// ── State ────────────────────────────────────────────────────────────────────

let mode = null; // 'solo' | 'local' | 'online'
let game = null;
let solo = null; // { settings, human, ai, level, thinking }
let online = { ws: null, code: null, token: null, you: 0, room: null, connected: false, retries: 0 };
let worker = null;
let requestId = 0;
let counting = false; // waiting for the dead-stone estimate
let setupMode = null;
let roomPoll = null;
let coords = store.get('coords', true);

const board = new BoardView($('#board'), { onPlay, onToggle });

// ── Screens ──────────────────────────────────────────────────────────────────

function show(id) {
  for (const s of $$('.screen')) s.hidden = s.id !== id;
  $('#toast').hidden = true;
  if (id !== 'setup') stopRoomPoll();
  if (id === 'menu') renderResumeList();
  if (id === 'game') board.resize();
  window.scrollTo(0, 0);
}

let toastTimer;
function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2600);
}

function confirmBox(text, okLabel = 'OK') {
  const dlg = $('#confirm');
  $('#confirm-text').textContent = text;
  $('#confirm-ok').textContent = okLabel;
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise((resolve) => dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true }));
}

// ── Menu ─────────────────────────────────────────────────────────────────────

function describe(settings) {
  return `${settings.size}×${settings.size}`;
}

function renderResumeList() {
  const list = $('#resume-list');
  list.replaceChildren();
  const add = (title, detail, label, action) => {
    const row = document.createElement('div');
    row.className = 'resume';
    const text = document.createElement('div');
    text.innerHTML = `<b></b><br><span></span>`;
    text.querySelector('b').textContent = title;
    text.querySelector('span').textContent = detail;
    const btn = document.createElement('button');
    btn.className = 'btn primary';
    btn.textContent = label;
    btn.addEventListener('click', action);
    row.append(text, btn);
    list.append(row);
  };
  const savedSolo = store.get('solo');
  if (savedSolo && savedSolo.game.phase !== 'over') {
    add('Game against the computer', `${LEVEL_LABELS[savedSolo.level]} · ${describe(savedSolo.game)} · move ${savedSolo.game.moves.length}`, 'Continue', () => resumeSolo(savedSolo));
  }
  const savedLocal = store.get('local');
  if (savedLocal && savedLocal.game.phase !== 'over') {
    add('Pass & play game', `${describe(savedLocal.game)} · move ${savedLocal.game.moves.length}`, 'Continue', () => resumeLocal(savedLocal));
  }
  const session = store.get('online');
  if (session) add(`Online game ${session.code}`, 'Pick up where you left off', 'Rejoin', () => rejoin(session));
}

for (const btn of $$('.mode')) btn.addEventListener('click', () => openSetup(btn.dataset.mode));

// ── Setup ────────────────────────────────────────────────────────────────────

const form = $('#setup-form');

function openSetup(which) {
  setupMode = which;
  $('#setup-title').textContent = { solo: 'Play the computer', local: 'Pass & play', online: 'Play online' }[which];
  for (const el of $$('[data-for]')) el.hidden = !el.dataset.for.split(' ').includes(which);
  $('#setup-start').textContent = which === 'online' ? 'Create a game' : 'Start';
  const saved = store.get('settings', {});
  const pick = (name, value) => {
    const input = form.querySelector(`input[name="${name}"][value="${value}"]`);
    if (input) input.checked = true;
  };
  if (saved.size) pick('size', saved.size);
  if (saved.level) pick('level', saved.level);
  if (saved.color) pick('color', saved.color);
  form.komi.value = saved.komi ?? 7.5;
  fillHandicap(saved.handicap || 0);
  form.name.value = store.get('name', '');
  show('setup');
  if (which === 'online') {
    ensureSocket();
    startRoomPoll();
  }
}

function fillHandicap(selected) {
  const size = Number(form.querySelector('input[name="size"]:checked').value);
  const sel = form.handicap;
  sel.replaceChildren();
  const opt = (value, text) => {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = text;
    sel.append(o);
  };
  opt(0, 'None');
  for (let n = 2; n <= maxHandicap(size); n++) opt(n, `${n} stones for Black`);
  sel.value = Math.min(selected, maxHandicap(size));
}

for (const r of form.querySelectorAll('input[name="size"]')) r.addEventListener('change', () => fillHandicap(Number(form.handicap.value)));

// Komi follows the handicap: a handicap game is usually played with half a point.
form.handicap.addEventListener('change', () => {
  const h = Number(form.handicap.value);
  const k = Number(form.komi.value);
  if (h > 0 && k === 7.5) form.komi.value = 0.5;
  if (h === 0 && k === 0.5) form.komi.value = 7.5;
});

function readSettings() {
  const val = (name) => form.querySelector(`input[name="${name}"]:checked`)?.value;
  let komi = Math.round(Number(form.komi.value) * 2) / 2;
  if (!Number.isFinite(komi)) komi = 7.5;
  const s = {
    size: Number(val('size')),
    level: val('level'),
    color: val('color'),
    handicap: Number(form.handicap.value),
    komi,
  };
  store.set('settings', s);
  const name = form.name.value.trim();
  if (name) store.set('name', name);
  return s;
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  unlockAudio();
  const s = readSettings();
  if (setupMode === 'solo') startSolo(s);
  else if (setupMode === 'local') startLocal(s);
  else createOnline(s);
});

// ── Pass & play ──────────────────────────────────────────────────────────────

function startLocal(settings) {
  mode = 'local';
  solo = null;
  game = new Game(settings);
  saveLocal();
  show('game');
  render();
}

function resumeLocal(saved) {
  mode = 'local';
  solo = null;
  game = Game.fromJSON(saved.game);
  show('game');
  render();
  if (game.phase === 'scoring' && !game.dead.size) countDead();
}

function saveLocal() {
  store.set('local', { game: game.toJSON() });
}

// ── Against the computer ─────────────────────────────────────────────────────

function startSolo(settings) {
  const human = settings.color === 'white' ? WHITE : settings.color === 'black' ? BLACK : Math.random() < 0.5 ? BLACK : WHITE;
  mode = 'solo';
  game = new Game(settings);
  solo = { settings, human, ai: other(human), level: settings.level || 'easy', thinking: false };
  saveSolo();
  show('game');
  render();
  computerTurn();
}

function resumeSolo(saved) {
  mode = 'solo';
  game = Game.fromJSON(saved.game);
  solo = { settings: saved.settings, human: saved.human, ai: other(saved.human), level: saved.level, thinking: false };
  show('game');
  render();
  if (game.phase === 'scoring' && !game.dead.size) countDead();
  else computerTurn();
}

function saveSolo() {
  store.set('solo', { settings: solo.settings, human: solo.human, level: solo.level, game: game.toJSON() });
}

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('./ai-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => workerReplies.get(data.id)?.(data);
    worker.onerror = (e) => {
      console.error('AI worker failed', e);
      toast('The computer player failed to load');
    };
  }
  return worker;
}

const workerReplies = new Map();

function ask(kind, extra = {}) {
  const id = ++requestId;
  return new Promise((resolve) => {
    workerReplies.set(id, (data) => {
      workerReplies.delete(id);
      resolve(data);
    });
    getWorker().postMessage({ id, kind, game: game.toJSON(), ...extra });
  });
}

// Drop whatever the worker is doing (after undo, a new game, or leaving).
function cancelThinking() {
  if (worker && (solo?.thinking || counting)) {
    worker.terminate();
    worker = null;
    workerReplies.clear();
  }
  if (solo) solo.thinking = false;
  counting = false;
}

async function computerTurn() {
  if (mode !== 'solo' || game.phase !== 'play' || game.toMove !== solo.ai || solo.thinking) return;
  solo.thinking = true;
  render();
  const started = performance.now();
  const forGame = game;
  const reply = await ask('move', { level: solo.level });
  // A short pause so a fast reply doesn't feel like the stone was there all along.
  const wait = 450 - (performance.now() - started);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  if (game !== forGame || !solo?.thinking) return;
  solo.thinking = false;
  if (reply.move === 'resign') {
    game.resign(solo.ai);
  } else if (reply.move === PASS || !game.play(reply.move).ok) {
    game.pass();
    toast('The computer passes');
  } else {
    playStone(game.lastMove.captured.length);
  }
  afterChange();
}

// Two passes: estimate the dead stones so the players only correct the guess.
async function countDead() {
  counting = true;
  render();
  const forGame = game;
  const { dead } = await ask('dead');
  if (game !== forGame || game.phase !== 'scoring') return;
  counting = false;
  game.setDead(dead);
  afterChange();
}

function afterChange() {
  if (mode === 'solo') saveSolo();
  if (mode === 'local') saveLocal();
  render();
  computerTurn();
}

// ── Online ───────────────────────────────────────────────────────────────────

function socketUrl() {
  // Relative to the page, so the game works under a path (games.noblehaus.uk/go/).
  const url = new URL('ws', location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}

function ensureSocket() {
  if (online.ws && online.ws.readyState <= 1) {
    return online.ws.readyState === 1 ? Promise.resolve() : new Promise((r) => online.ws.addEventListener('open', r, { once: true }));
  }
  const ws = new WebSocket(socketUrl());
  online.ws = ws;
  ws.onmessage = (e) => onServer(JSON.parse(e.data));
  ws.onopen = () => {
    online.connected = true;
    online.retries = 0;
    if (online.code && online.token) send({ type: 'rejoin', code: online.code, token: online.token });
    if (mode === 'online') render();
  };
  ws.onclose = () => {
    if (online.ws !== ws) return;
    online.connected = false;
    online.ws = null;
    if (mode === 'online' && online.code) {
      render();
      // Phones drop sockets when they sleep: keep trying, backing off to 10 s.
      const delay = Math.min(10_000, 1000 * 2 ** online.retries++);
      setTimeout(() => {
        if (mode === 'online' && online.code && !online.ws) ensureSocket();
      }, delay);
    }
  };
  return new Promise((r) => ws.addEventListener('open', r, { once: true }));
}

function send(msg) {
  if (online.ws?.readyState === 1) online.ws.send(JSON.stringify(msg));
  else toast('Reconnecting…');
}

async function createOnline(settings) {
  await ensureSocket();
  send({ type: 'create', name: store.get('name', 'Player'), settings });
}

async function joinOnline(code) {
  code = code.trim().toUpperCase();
  if (code.length !== 4) return toast('Codes are four letters');
  const name = form.name.value.trim() || store.get('name', '');
  if (name) store.set('name', name);
  await ensureSocket();
  send({ type: 'join', code, name: name || 'Player' });
}

async function rejoin(session) {
  online.code = session.code;
  online.token = session.token;
  mode = 'online';
  if (online.ws?.readyState === 1) send({ type: 'rejoin', code: session.code, token: session.token });
  else await ensureSocket(); // onopen sends the rejoin
}

$('#join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  unlockAudio();
  joinOnline($('#join-code').value);
});

function startRoomPoll() {
  stopRoomPoll();
  const poll = () => online.ws?.readyState === 1 && send({ type: 'list' });
  ensureSocket().then(poll);
  roomPoll = setInterval(poll, 4000);
}

function stopRoomPoll() {
  clearInterval(roomPoll);
  roomPoll = null;
}

function renderRooms(rooms) {
  const list = $('#open-rooms');
  list.replaceChildren();
  if (!rooms.length) {
    list.innerHTML = '<li class="muted">No open games. Create one and send a friend the code.</li>';
    return;
  }
  for (const r of rooms) {
    const li = document.createElement('li');
    li.className = 'room';
    const text = document.createElement('div');
    text.innerHTML = '<b></b><br><span></span>';
    text.querySelector('b').textContent = r.host;
    const colour = r.color === 'random' ? 'random colours' : `they play ${r.color}`;
    text.querySelector('span').textContent = `${r.size}×${r.size} · komi ${r.komi}${r.handicap ? ` · ${r.handicap} handicap` : ''} · ${colour}`;
    const btn = document.createElement('button');
    btn.className = 'btn primary';
    btn.textContent = 'Join';
    btn.addEventListener('click', () => joinOnline(r.code));
    li.append(text, btn);
    list.append(li);
  }
}

function onServer(msg) {
  switch (msg.type) {
    case 'joined':
      online.code = msg.code;
      online.token = msg.token;
      store.set('online', { code: msg.code, token: msg.token });
      if (mode !== 'online' || $('#game').hidden) {
        cancelThinking();
        mode = 'online';
        solo = null;
        show('game');
      }
      break;
    case 'state': {
      const { room } = msg;
      online.you = msg.you === 'black' ? BLACK : WHITE;
      online.room = room;
      const prev = game;
      game = room.game ? Game.fromJSON(room.game) : new Game(room.settings);
      const fresh = prev && mode === 'online' && room.game && prev.moves.length < game.moves.length;
      if (fresh && game.lastMove.idx !== PASS) playStone(game.lastMove.captured.length);
      if (mode === 'online') render();
      break;
    }
    case 'rooms':
      renderRooms(msg.rooms);
      break;
    case 'rejoinFailed':
      store.del('online');
      online.code = null;
      online.token = null;
      online.room = null;
      if (mode === 'online') {
        mode = null;
        toast('That game has finished');
        show('menu');
      } else {
        renderResumeList();
      }
      break;
    case 'error':
      toast(msg.msg);
      break;
  }
}

function leaveOnline() {
  send({ type: 'leave' });
  store.del('online');
  online.code = null;
  online.token = null;
  online.room = null;
  mode = null;
}

async function inviteLink() {
  const url = new URL(location.href);
  url.search = `?room=${online.code}`;
  url.hash = '';
  return url.href;
}

$('#copy-link').addEventListener('click', async () => {
  const link = await inviteLink();
  try {
    await navigator.clipboard.writeText(link);
    toast('Link copied');
  } catch {
    toast(link);
  }
});

if (navigator.share) {
  $('#share-link').hidden = false;
  $('#share-link').addEventListener('click', async () => {
    try {
      await navigator.share({ title: 'Play Go with me', text: `Join my Go game: code ${online.code}`, url: await inviteLink() });
    } catch {}
  });
}

// ── Playing ──────────────────────────────────────────────────────────────────

function myTurn() {
  if (!game || game.phase !== 'play') return false;
  if (mode === 'local') return true;
  if (mode === 'solo') return game.toMove === solo.human && !solo.thinking;
  if (mode === 'online') return !!online.room?.game && online.connected && game.toMove === online.you;
  return false;
}

function onPlay(idx) {
  unlockAudio();
  if (!myTurn()) return;
  if (mode === 'online') {
    const sim = game.simulate(idx);
    if (sim.error) return toast(sim.error);
    send({ type: 'move', idx });
    return;
  }
  const r = game.play(idx);
  if (!r.ok) return toast(r.error);
  playStone(r.captured.length);
  afterChange();
}

function onToggle(idx) {
  if (game.phase !== 'scoring' || counting) return;
  if (mode === 'online') return send({ type: 'toggleDead', idx });
  game.toggleDead(idx);
  afterChange();
}

$('#btn-pass').addEventListener('click', () => {
  unlockAudio();
  if (!myTurn()) return;
  if (mode === 'online') return send({ type: 'pass' });
  game.pass();
  if (game.phase === 'scoring') {
    afterChange();
    countDead();
  } else {
    afterChange();
  }
});

$('#btn-undo').addEventListener('click', () => {
  if (mode === 'local') {
    if (!game.moves.length) return;
    cancelThinking();
    game = game.undo(1);
  } else if (mode === 'solo') {
    // Back to before your last move (taking the computer's reply with it).
    let n = 0;
    for (let i = game.moves.length - 1; i >= 0; i--) {
      n++;
      if (game.moves[i].color === solo.human) break;
      if (i === 0) n = 0;
    }
    if (!n) return;
    cancelThinking();
    game = game.undo(n);
  }
  afterChange();
});

$('#btn-resign').addEventListener('click', async () => {
  if (game.phase === 'over') return;
  const who = mode === 'local' ? (game.toMove === BLACK ? 'Black' : 'White') : 'You';
  if (!(await confirmBox(`${who === 'You' ? 'Resign' : `${who} resigns`} this game?`, 'Resign'))) return;
  if (mode === 'online') return send({ type: 'resign' });
  cancelThinking();
  game.resign(mode === 'solo' ? solo.human : game.toMove);
  afterChange();
});

$('#btn-accept').addEventListener('click', () => {
  if (game.phase !== 'scoring' || counting) return;
  if (mode === 'online') return send({ type: 'accept' });
  game.finishScoring();
  afterChange();
});

$('#btn-resume').addEventListener('click', () => {
  if (mode === 'online') return send({ type: 'resume' });
  cancelThinking();
  game.resume();
  afterChange();
});

$('#btn-again').addEventListener('click', () => {
  if (mode === 'online') return send({ type: 'rematch' });
  if (mode === 'solo') return startSolo(solo.settings);
  startLocal(game.settings);
});

for (const el of $$('[data-action="menu"]')) {
  el.addEventListener('click', async () => {
    if (mode === 'online' && online.code) {
      const g = online.room?.game;
      if (g && g.phase !== 'over' && !(await confirmBox('Leave this game? It counts as resigning.', 'Leave'))) return;
      leaveOnline();
    }
    cancelThinking();
    if (mode !== 'online') mode = null;
    show('menu');
  });
}

$('[data-action="leave"]').addEventListener('click', () => {
  leaveOnline();
  show('menu');
});

const soundBtn = $('#sound-toggle');
const coordsBtn = $('#coords-toggle');
function syncToggles() {
  soundBtn.setAttribute('aria-pressed', String(!isMuted()));
  soundBtn.setAttribute('aria-label', isMuted() ? 'Sound off' : 'Sound on');
  coordsBtn.setAttribute('aria-pressed', String(coords));
}
soundBtn.addEventListener('click', () => {
  setMuted(!isMuted());
  syncToggles();
});
coordsBtn.addEventListener('click', () => {
  coords = !coords;
  store.set('coords', coords);
  syncToggles();
  render();
});
syncToggles();

// ── Rendering the game screen ────────────────────────────────────────────────

function nameOf(color) {
  if (mode === 'solo') return color === solo.human ? 'You' : 'Computer';
  if (mode === 'online') {
    const p = online.room?.players[color === BLACK ? 'black' : 'white'];
    if (!p) return 'Waiting…';
    return color === online.you ? `${p.name} (you)` : p.name;
  }
  return color === BLACK ? 'Black' : 'White';
}

function resultText(result) {
  if (!result) return '';
  const { winner, reason, margin } = result;
  if (!winner) return 'A draw (jigo)';
  const who = nameOf(winner).replace(' (you)', '');
  const verb = who === 'You' ? 'win' : 'wins';
  const lead = mode === 'online' && winner === online.you ? 'You win' : `${who} ${verb}`;
  return reason === 'resign' ? `${lead} by resignation` : `${lead} by ${margin} points`;
}

function render() {
  if (!game) return;
  const phase = game.phase;
  const room = online.room;
  const waiting = mode === 'online' && room && !room.game;

  $('#game-title').textContent =
    mode === 'solo' ? `vs Computer · ${LEVEL_LABELS[solo.level]}` : mode === 'online' ? 'Online game' : 'Pass & play';

  for (const color of [BLACK, WHITE]) {
    const el = $(color === BLACK ? '#player-black' : '#player-white');
    el.classList.toggle('turn', phase === 'play' && game.toMove === color && !waiting);
    el.querySelector('.pname').textContent = nameOf(color);
    el.querySelector('.pcap').textContent = game.captures[color];
    const meta = el.querySelector('.pmeta');
    let text = color === BLACK ? 'Black' : `White · komi ${game.komi}`;
    let off = false;
    meta.classList.remove('thinking');
    if (mode === 'solo' && color === solo.ai) {
      text = solo.thinking ? 'Thinking' : `${color === BLACK ? 'Black' : 'White'} · ${LEVEL_LABELS[solo.level]}`;
      if (solo.thinking) meta.classList.add('thinking');
    }
    if (mode === 'online') {
      const p = room?.players[color === BLACK ? 'black' : 'white'];
      if (p && p.left) [text, off] = ['Left the game', true];
      else if (p && !p.connected) [text, off] = ['Disconnected', true];
      if (color === online.you && !online.connected) [text, off] = ['Reconnecting…', true];
    }
    meta.textContent = text;
    meta.classList.toggle('off', off);
  }

  // Status line
  let status = '';
  const last = game.lastMove;
  const passed = last && last.idx === PASS && phase === 'play' ? `${nameOf(last.color).replace(' (you)', '')} passed. ` : '';
  if (waiting) status = 'Waiting for an opponent';
  else if (phase === 'play') {
    if (mode === 'solo') status = solo.thinking ? passed + 'The computer is thinking' : passed + 'Your move';
    else if (mode === 'online') status = passed + (game.toMove === online.you ? 'Your move' : `${nameOf(game.toMove)} to play`);
    else status = passed + `${game.toMove === BLACK ? 'Black' : 'White'} to play`;
  } else if (phase === 'scoring') status = counting ? 'Counting…' : 'Both passed: agree on dead stones';
  else status = 'Game over';
  $('#status').textContent = status;

  // Controls
  $('#controls-play').hidden = phase !== 'play';
  $('#controls-score').hidden = phase !== 'scoring';
  $('#controls-over').hidden = phase !== 'over';
  $('#btn-pass').disabled = !myTurn();
  $('#btn-undo').hidden = mode === 'online';
  $('#btn-undo').disabled = !game.moves.length || (mode === 'solo' && !game.moves.some((m) => m.color === solo.human));
  $('#btn-resign').disabled = waiting || (mode === 'online' && !online.connected);

  let owner = null;
  if (phase === 'scoring' || (phase === 'over' && game.result?.reason === 'score')) {
    const s = game.score();
    owner = s.owner;
    const accepted = room?.accepted || {};
    const tick = (c) => (mode === 'online' && accepted[c] ? '<span class="ok">✓ agreed</span>' : '');
    $('#score-line').innerHTML =
      `<div><small>Black</small><b>${s.black}</b>${tick('black')}</div>` +
      `<div><small>White (+${game.komi})</small><b>${s.white}</b>${tick('white')}</div>`;
    const iAccepted = mode === 'online' && accepted[online.you === BLACK ? 'black' : 'white'];
    $('#btn-accept').disabled = counting || iAccepted;
    $('#btn-accept').textContent = iAccepted ? 'Waiting for opponent' : 'Accept count';
  }

  if (phase === 'over') {
    $('#result').textContent = resultText(game.result);
    const again = $('#btn-again');
    again.textContent = mode === 'online' ? 'Rematch' : 'Play again';
    again.disabled = false;
    if (mode === 'online') {
      const mine = room?.rematch[online.you === BLACK ? 'black' : 'white'];
      const theirs = room?.rematch[online.you === BLACK ? 'white' : 'black'];
      const gone = room?.players[online.you === BLACK ? 'white' : 'black']?.left;
      if (gone) [again.textContent, again.disabled] = ['Opponent left', true];
      else if (mine) [again.textContent, again.disabled] = ['Waiting for opponent', true];
      else if (theirs) again.textContent = 'Accept rematch';
    }
  }

  $('#waiting').hidden = !waiting;
  if (waiting) $('#waiting-code').textContent = online.code;
  $('#room-code').hidden = mode !== 'online' || waiting || !online.code;
  $('#room-code').textContent = `Game code ${online.code}`;

  const interactive = (phase === 'play' && myTurn()) || (phase === 'scoring' && !counting && (mode !== 'online' || online.connected));
  board.set({
    game,
    interactive,
    ghostColor: game.toMove,
    scoring: phase === 'scoring',
    owner,
    dead: phase === 'play' ? null : game.dead,
    coords,
  });

  const yourMove = mode === 'online' && phase === 'play' && myTurn();
  document.title = yourMove && document.hidden ? '● Your move · Go' : 'Go';
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) document.title = 'Go';
  // Coming back to a sleeping phone's tab: reconnect straight away.
  if (!document.hidden && mode === 'online' && online.code && !online.ws) {
    online.retries = 0;
    ensureSocket();
  }
});

// ── Start ────────────────────────────────────────────────────────────────────

const params = new URLSearchParams(location.search);
const invite = params.get('room');
if (invite) {
  history.replaceState(null, '', location.pathname);
  openSetup('online');
  $('#join-code').value = invite.toUpperCase();
  if (store.get('name')) joinOnline(invite);
  else {
    form.name.focus();
    toast('Enter your name, then tap Join');
  }
} else {
  show('menu');
}
