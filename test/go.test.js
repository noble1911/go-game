import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, BLACK, WHITE, EMPTY, PASS, handicapPoints, pointName } from '../public/go.js';

// Build a game from a picture: X black, O white, . empty. Black and white alternate as listed.
const at = (size, x, y) => y * size + x;

function playAll(game, moves) {
  for (const m of moves) {
    const r = game.play(m);
    assert.ok(r.ok, `move ${m} failed: ${r.error}`);
  }
}

test('stones alternate, starting with black', () => {
  const g = new Game({ size: 9 });
  assert.equal(g.toMove, BLACK);
  playAll(g, [at(9, 2, 2)]);
  assert.equal(g.board[at(9, 2, 2)], BLACK);
  assert.equal(g.toMove, WHITE);
});

test('a surrounded stone is captured and counted', () => {
  const g = new Game({ size: 9 });
  // White stone at (1,1) surrounded by black on four sides.
  playAll(g, [at(9, 1, 0), at(9, 1, 1), at(9, 0, 1), at(9, 8, 8), at(9, 2, 1), at(9, 8, 7)]);
  const r = g.play(at(9, 1, 2));
  assert.ok(r.ok);
  assert.deepEqual(r.captured, [at(9, 1, 1)]);
  assert.equal(g.board[at(9, 1, 1)], EMPTY);
  assert.equal(g.captures[BLACK], 1);
});

test('corner capture with two liberties', () => {
  const g = new Game({ size: 9 });
  playAll(g, [at(9, 1, 0), at(9, 0, 0)]);
  const r = g.play(at(9, 0, 1));
  assert.deepEqual(r.captured, [at(9, 0, 0)]);
});

test('suicide is illegal, but a capturing move into no liberties is fine', () => {
  const g = new Game({ size: 9 });
  // Black surrounds (0,0): white playing there is suicide.
  playAll(g, [at(9, 1, 0), at(9, 5, 5), at(9, 0, 1)]);
  assert.equal(g.toMove, WHITE);
  const r = g.play(at(9, 0, 0));
  assert.equal(r.ok, false);
  assert.match(r.error, /Suicide/);
});

test('simple ko cannot be retaken immediately, but can after a ko threat', () => {
  const g = new Game({ size: 9 });
  //   . X O .
  //   X O . O
  //   . X O .
  playAll(g, [
    at(9, 1, 0), at(9, 2, 0),
    at(9, 0, 1), at(9, 3, 1),
    at(9, 1, 2), at(9, 2, 2),
    at(9, 6, 6), at(9, 1, 1), // white plays into the ko shape
  ]);
  // Black captures at (2,1)
  let r = g.play(at(9, 2, 1));
  assert.ok(r.ok);
  assert.deepEqual(r.captured, [at(9, 1, 1)]);
  // White may not recapture at once.
  r = g.play(at(9, 1, 1));
  assert.equal(r.ok, false);
  assert.match(r.error, /Ko/);
  // A threat elsewhere and an answer, then the recapture is legal.
  playAll(g, [at(9, 7, 7), at(9, 7, 6)]);
  r = g.play(at(9, 1, 1));
  assert.ok(r.ok, r.error);
});

test('two passes start scoring; area score counts stones, territory and komi', () => {
  const g = new Game({ size: 9, komi: 6.5 });
  // Black wall on column 3, white wall on column 4.
  for (let y = 0; y < 9; y++) playAll(g, [at(9, 3, y), at(9, 4, y)]);
  g.pass();
  g.pass();
  assert.equal(g.phase, 'scoring');
  const s = g.score();
  assert.equal(s.black, 4 * 9);
  assert.equal(s.white, 5 * 9 + 6.5);
  assert.equal(s.winner, WHITE);
  assert.equal(s.margin, 15.5);
  g.finishScoring();
  assert.equal(g.phase, 'over');
  assert.equal(g.result.winner, WHITE);
});

test('dead stones count for the side that surrounds them', () => {
  const g = new Game({ size: 9, komi: 0.5 });
  for (let y = 0; y < 9; y++) playAll(g, [at(9, 3, y), at(9, 4, y)]);
  playAll(g, [at(9, 7, 4)]); // black invades white's area
  g.pass();
  g.pass();
  g.pass(); // three passes: scoring started at the second
  assert.equal(g.phase, 'scoring');
  const before = g.score();
  assert.equal(before.white, 0.5 + 9 * 1); // only white's stones: the area holds a black stone
  g.toggleDead(at(9, 7, 4));
  const after = g.score();
  assert.equal(after.white, 0.5 + 5 * 9);
  assert.equal(after.black, 4 * 9);
});

test('toggling a dead stone marks the whole chain', () => {
  const g = new Game({ size: 9 });
  playAll(g, [at(9, 4, 4), at(9, 0, 0), at(9, 4, 5)]);
  g.pass();
  g.pass();
  g.toggleDead(at(9, 4, 4));
  assert.deepEqual([...g.dead].sort((a, b) => a - b), [at(9, 4, 4), at(9, 4, 5)]);
  g.toggleDead(at(9, 4, 5));
  assert.equal(g.dead.size, 0);
});

test('resume returns to play and clears dead marks', () => {
  const g = new Game({ size: 9 });
  playAll(g, [at(9, 4, 4)]);
  g.pass();
  g.pass();
  g.toggleDead(at(9, 4, 4));
  assert.ok(g.resume());
  assert.equal(g.phase, 'play');
  assert.equal(g.dead.size, 0);
  assert.equal(g.toMove, WHITE);
});

test('resigning ends the game for the other side', () => {
  const g = new Game({ size: 13 });
  g.resign(BLACK);
  assert.equal(g.phase, 'over');
  assert.deepEqual(g.result, { winner: WHITE, reason: 'resign' });
});

test('handicap stones go on star points and white moves first', () => {
  const g = new Game({ size: 19, handicap: 4 });
  assert.equal(g.toMove, WHITE);
  const stones = [...g.board.keys()].filter((i) => g.board[i] === BLACK);
  assert.equal(stones.length, 4);
  assert.deepEqual(stones.map((i) => pointName(19, i)).sort(), ['D16', 'D4', 'Q16', 'Q4']);
  assert.equal(handicapPoints(9, 9).length, 5); // 9×9 tops out at five
  assert.equal(handicapPoints(19, 9).length, 9);
});

test('JSON round trip replays the moves', () => {
  const g = new Game({ size: 9, komi: 5.5 });
  playAll(g, [at(9, 2, 2), at(9, 6, 6), at(9, 2, 6)]);
  g.pass();
  const copy = Game.fromJSON(JSON.parse(JSON.stringify(g)));
  assert.deepEqual([...copy.board], [...g.board]);
  assert.equal(copy.toMove, g.toMove);
  assert.equal(copy.komi, 5.5);
  assert.equal(copy.moves.at(-1).idx, PASS);
});

test('undo takes back moves', () => {
  const g = new Game({ size: 9 });
  playAll(g, [at(9, 2, 2), at(9, 6, 6)]);
  const u = g.undo(2);
  assert.equal(u.moves.length, 0);
  assert.equal(u.board[at(9, 2, 2)], EMPTY);
  assert.equal(u.toMove, BLACK);
});

test('positional superko forbids recreating any earlier position', () => {
  const g = new Game({ size: 9 });
  // Same ko as above: after black captures, white retaking at once would repeat the position.
  playAll(g, [
    at(9, 1, 0), at(9, 2, 0), at(9, 0, 1), at(9, 3, 1), at(9, 1, 2), at(9, 2, 2),
    at(9, 6, 6), at(9, 1, 1), at(9, 2, 1),
  ]);
  const key = g.positionKey(g.board);
  assert.ok(g.seen.has(key));
  assert.equal(g.isLegal(at(9, 1, 1)), false);
});
