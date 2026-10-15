import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startServer } from '../server.js';

let server;
let base;

before(async () => {
  server = await startServer(0);
  base = `ws://localhost:${server.address().port}/ws`;
});

after(() => {
  for (const ws of server.wss.clients) ws.terminate();
  server.close();
});

// A client that queues messages so tests can await the next one of a given type.
function client() {
  const ws = new WebSocket(base);
  const queue = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    const i = waiters.findIndex((w) => w.match(msg));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else queue.push(msg);
  });
  const opened = new Promise((r) => ws.on('open', r));
  return {
    ws,
    opened,
    send: (m) => ws.send(JSON.stringify(m)),
    next(type, pred = () => true) {
      const match = (m) => m.type === type && pred(m);
      const i = queue.findIndex(match);
      if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        waiters.push({ match, resolve });
        setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), 3000);
      });
    },
    close: () => ws.close(),
  };
}

async function pair(settings = { size: 9, komi: 6.5, color: 'black' }) {
  const a = client();
  const b = client();
  await Promise.all([a.opened, b.opened]);
  a.send({ type: 'create', name: 'Alice', settings });
  const { code, token: aToken } = await a.next('joined');
  await a.next('state');
  b.send({ type: 'join', code, name: 'Bob' });
  const { token: bToken } = await b.next('joined');
  const aState = await a.next('state', (m) => m.room.game);
  const bState = await b.next('state', (m) => m.room.game);
  return { a, b, code, aToken, bToken, aState, bState };
}

test('the server serves the game and a health check', async () => {
  const port = server.address().port;
  const page = await fetch(`http://localhost:${port}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>Go<\/title>/);
  assert.equal((await fetch(`http://localhost:${port}/go.js`)).status, 200);
  assert.equal((await fetch(`http://localhost:${port}/healthz`)).status, 200);
  assert.equal((await fetch(`http://localhost:${port}/..%2fserver.js`)).status, 404);
});

test('two players join a room and the game starts with the chosen colours', async () => {
  const { a, b, aState, bState } = await pair();
  assert.equal(aState.you, 'black');
  assert.equal(bState.you, 'white');
  assert.equal(aState.room.players.black.name, 'Alice');
  assert.equal(aState.room.players.white.name, 'Bob');
  assert.equal(aState.room.settings.size, 9);
  a.close();
  b.close();
});

test('moves are refereed: out of turn and illegal moves are refused', async () => {
  const { a, b } = await pair();
  b.send({ type: 'move', idx: 40 });
  assert.match((await b.next('error')).msg, /turn/);
  a.send({ type: 'move', idx: 40 });
  const s = await b.next('state', (m) => m.room.game.moves.length === 1);
  assert.deepEqual(s.room.game.moves, [40]);
  await a.next('state', (m) => m.room.game.moves.length === 1);
  b.send({ type: 'move', idx: 40 });
  assert.match((await b.next('error')).msg, /taken/);
  a.close();
  b.close();
});

test('two passes lead to scoring; both accepting finishes the game; rematch swaps colours', async () => {
  const { a, b } = await pair();
  a.send({ type: 'move', idx: 40 });
  await b.next('state', (m) => m.room.game.moves.length === 1);
  b.send({ type: 'pass' });
  await a.next('state', (m) => m.room.game.moves.length === 2);
  a.send({ type: 'pass' });
  const scoring = await b.next('state', (m) => m.room.game.phase === 'scoring');
  assert.deepEqual(scoring.room.accepted, { black: false, white: false });
  await a.next('state', (m) => m.room.game.phase === 'scoring');
  a.send({ type: 'accept' });
  await b.next('state', (m) => m.room.accepted.black);
  b.send({ type: 'accept' });
  const over = await a.next('state', (m) => m.room.game.phase === 'over');
  assert.equal(over.room.game.result.reason, 'score');
  assert.equal(over.room.game.result.winner, 1); // 81 points of black area vs 6.5 komi
  await b.next('state', (m) => m.room.game.phase === 'over');
  a.send({ type: 'rematch' });
  await b.next('state', (m) => m.room.rematch.black);
  b.send({ type: 'rematch' });
  const again = await a.next('state', (m) => m.room.gameNumber === 2);
  assert.equal(again.you, 'white');
  assert.equal(again.room.players.black.name, 'Bob');
  a.close();
  b.close();
});

test('marking stones dead in scoring resets acceptance', async () => {
  const { a, b } = await pair();
  a.send({ type: 'move', idx: 40 });
  await b.next('state', (m) => m.room.game.moves.length === 1);
  b.send({ type: 'pass' });
  await a.next('state', (m) => m.room.game.moves.length === 2);
  a.send({ type: 'pass' });
  await a.next('state', (m) => m.room.game.phase === 'scoring');
  await b.next('state', (m) => m.room.game.phase === 'scoring');
  a.send({ type: 'accept' });
  await b.next('state', (m) => m.room.accepted.black);
  b.send({ type: 'toggleDead', idx: 40 });
  const s = await a.next('state', (m) => m.room.game.dead.includes(40));
  assert.deepEqual(s.room.accepted, { black: false, white: false });
  a.close();
  b.close();
});

test('a dropped player can rejoin their seat with the token', async () => {
  const { a, b, code, bToken } = await pair();
  b.close();
  const gone = await a.next('state', (m) => !m.room.players.white.connected);
  assert.equal(gone.room.players.white.connected, false);
  const b2 = client();
  await b2.opened;
  b2.send({ type: 'rejoin', code, token: bToken });
  await b2.next('joined');
  const back = await b2.next('state');
  assert.equal(back.you, 'white');
  await a.next('state', (m) => m.room.players.white.connected);
  b2.send({ type: 'rejoin', code, token: 'nope' });
  await b2.next('rejoinFailed');
  a.close();
  b2.close();
});

test('leaving mid-game resigns; open rooms are listed until joined', async () => {
  const host = client();
  const looker = client();
  await Promise.all([host.opened, looker.opened]);
  host.send({ type: 'create', name: 'Host', settings: { size: 13 } });
  const { code } = await host.next('joined');
  looker.send({ type: 'list' });
  const { rooms } = await looker.next('rooms');
  const mine = rooms.find((r) => r.code === code);
  assert.equal(mine.host, 'Host');
  assert.equal(mine.size, 13);
  looker.send({ type: 'join', code, name: 'Looker' });
  await looker.next('state', (m) => m.room.game);
  looker.send({ type: 'leave' });
  const s = await host.next('state', (m) => m.room.game?.phase === 'over');
  assert.equal(s.room.game.result.reason, 'resign');
  host.close();
  looker.close();
});

test('joining a full or missing room fails politely', async () => {
  const { a, b, code } = await pair();
  const c = client();
  await c.opened;
  c.send({ type: 'join', code, name: 'Carol' });
  assert.match((await c.next('error')).msg, /two players/);
  c.send({ type: 'join', code: 'ZZZZ', name: 'Carol' });
  assert.match((await c.next('error')).msg, /No game/);
  a.close();
  b.close();
  c.close();
});
