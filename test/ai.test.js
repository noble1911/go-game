import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, BLACK, WHITE, EMPTY, PASS } from '../public/go.js';
import { FastBoard, chooseMove, estimateDead, makeRng } from '../public/ai.js';

const at = (size, x, y) => y * size + x;

// Plays the same random game on the rules engine and the fast board and compares them.
test('the fast board agrees with the rules engine over random games', () => {
  const rng = makeRng(42);
  for (let gameNo = 0; gameNo < 20; gameNo++) {
    const g = new Game({ size: 9 });
    for (let move = 0; move < 120 && g.phase === 'play'; move++) {
      const legal = g.legalMoves();
      if (!legal.length) break;
      const idx = legal[Math.floor(rng() * legal.length)];
      g.play(idx);
      const fb = FastBoard.fromGame(g);
      for (let i = 0; i < g.board.length; i++) assert.equal(fb.color[fb.toFast(i)], g.board[i]);
      // Every legal move on the fast board is legal in the engine (the engine adds superko).
      for (let i = 0; i < g.board.length; i++) {
        if (g.isLegal(i)) assert.ok(fb.isLegal(fb.toFast(i), g.toMove), `move ${i} should be legal`);
      }
    }
  }
});

test('fast board incremental play matches a rebuild after captures', () => {
  const rng = makeRng(7);
  const g = new Game({ size: 9 });
  const fb = new FastBoard(9);
  for (let move = 0; move < 200; move++) {
    const legal = g.legalMoves();
    if (!legal.length) break;
    const idx = legal[Math.floor(rng() * legal.length)];
    g.play(idx);
    fb.play(fb.toFast(idx), 3 - g.toMove);
    const rebuilt = FastBoard.fromGame(g);
    for (let i = 0; i < g.board.length; i++) {
      const p = fb.toFast(i);
      assert.equal(fb.color[p], g.board[i]);
      if (g.board[i] !== EMPTY) {
        // Same chain liberty facts either way.
        assert.equal(fb.inAtari(fb.gid[p]), rebuilt.inAtari(rebuilt.gid[p]));
      }
    }
    assert.equal(fb.nEmpty, rebuilt.nEmpty);
  }
});

test('the computer captures a three-stone chain in atari', () => {
  // White (4,3)-(4,5) walled in by black, last liberty at (4,6); filler white stones in corners.
  const black = [at(9, 3, 3), at(9, 3, 4), at(9, 3, 5), at(9, 5, 3), at(9, 5, 4), at(9, 5, 5), at(9, 4, 2)];
  const white = [at(9, 4, 3), at(9, 4, 4), at(9, 4, 5), at(9, 0, 8), at(9, 8, 0), at(9, 8, 8), at(9, 0, 0)];
  let captures = 0;
  for (let seed = 1; seed <= 5; seed++) {
    const g = new Game({ size: 9 });
    for (let i = 0; i < black.length; i++) {
      g.play(black[i]);
      g.play(white[i]);
    }
    if (chooseMove(g, { level: 'easy', rng: makeRng(seed) }).move === at(9, 4, 6)) captures++;
  }
  assert.ok(captures >= 4, `captured in ${captures}/5 searches`);
});

test('the computer saves its own stone from atari', () => {
  const g = new Game({ size: 9 });
  // Black stone at (4,4), white on three sides; black to move should extend at (4,5).
  for (const m of [at(9, 4, 4), at(9, 3, 4), at(9, 0, 8), at(9, 5, 4), at(9, 8, 0), at(9, 4, 3)]) g.play(m);
  assert.equal(g.toMove, BLACK);
  const { move } = chooseMove(g, { level: 'medium', rng: makeRng(2) });
  assert.equal(move, at(9, 4, 5));
});

test('the computer only ever plays legal moves', () => {
  const rng = makeRng(3);
  const g = new Game({ size: 9 });
  for (let i = 0; i < 60 && g.phase === 'play'; i++) {
    const { move } = chooseMove(g, { level: 'easy', rng, allowResign: false });
    if (move === PASS) g.pass();
    else assert.ok(g.play(move).ok);
  }
});

test('estimateDead finds a lone stone inside the opponent territory', () => {
  const g = new Game({ size: 9, komi: 0.5 });
  for (let y = 0; y < 9; y++) {
    g.play(at(9, 3, y));
    g.play(at(9, 5, y));
  }
  g.play(at(9, 7, 4)); // a black stone deep in white's area
  g.pass();
  g.pass();
  const { dead } = estimateDead(g, { playouts: 400, rng: makeRng(4) });
  assert.deepEqual(dead, [at(9, 7, 4)]);
});

test('medium beats a random player on 9×9', () => {
  const rng = makeRng(5);
  let wins = 0;
  const games = 4;
  for (let n = 0; n < games; n++) {
    const g = new Game({ size: 9, komi: 6.5 });
    const ai = n % 2 ? WHITE : BLACK;
    let moves = 0;
    while (g.phase === 'play' && moves++ < 200) {
      if (g.toMove === ai) {
        const { move } = chooseMove(g, { level: 'easy', rng });
        if (move === 'resign') g.resign(ai);
        else if (move === PASS) g.pass();
        else g.play(move);
      } else {
        const legal = g.legalMoves().filter((i) => {
          // the random player doesn't fill its own single-point eyes
          return !g.neighbours[i].every((n) => g.board[n] === g.toMove);
        });
        if (legal.length) g.play(legal[Math.floor(rng() * legal.length)]);
        else g.pass();
      }
    }
    if (g.phase === 'scoring') {
      g.setDead(estimateDead(g, { playouts: 300, rng }).dead);
      g.finishScoring();
    }
    if (g.phase === 'play') {
      g.setDead([]);
      g.phase = 'scoring';
      g.setDead(estimateDead(g, { playouts: 300, rng }).dead);
      g.finishScoring();
    }
    if (g.result.winner === ai) wins++;
  }
  assert.equal(wins, games);
});
