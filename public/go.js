// The rules of Go: placing stones, captures, ko (positional superko), passing, marking dead
// stones and area scoring. Shared by the browser and the server, which referees online games.
//
// Points are indexes into a size×size array: idx = y * size + x, with y = 0 the top row.
// A pass is idx -1.

export const EMPTY = 0;
export const BLACK = 1;
export const WHITE = 2;
export const PASS = -1;

export const other = (color) => 3 - color;
export const colorName = (color) => (color === BLACK ? 'black' : 'white');

const COLUMNS = 'ABCDEFGHJKLMNOPQRST'; // Go skips I

export function pointName(size, idx) {
  if (idx === PASS) return 'pass';
  return COLUMNS[idx % size] + (size - Math.floor(idx / size));
}

export const BOARD_SIZES = [9, 13, 19];

// Star points (hoshi) for drawing the board and placing handicap stones.
export function starPoints(size) {
  const edge = size >= 13 ? 3 : 2;
  const lo = edge;
  const hi = size - 1 - edge;
  const mid = (size - 1) / 2;
  const at = (x, y) => y * size + x;
  return {
    corners: [at(hi, lo), at(lo, hi), at(hi, hi), at(lo, lo)], // top-right, bottom-left, bottom-right, top-left
    sides: [at(lo, mid), at(hi, mid), at(mid, lo), at(mid, hi)], // left, right, top, bottom
    centre: at(mid, mid),
  };
}

export function maxHandicap(size) {
  return size >= 13 ? 9 : 5;
}

// The traditional placement order: two opposite corners, then the others, then the sides and centre.
export function handicapPoints(size, count) {
  if (count < 2) return [];
  const { corners, sides, centre } = starPoints(size);
  const n = Math.min(count, maxHandicap(size));
  const points = corners.slice(0, Math.min(n, 4));
  if (n === 5 || n === 7 || n === 9) points.push(centre);
  if (n >= 6) points.push(sides[0], sides[1]);
  if (n >= 8) points.push(sides[2], sides[3]);
  return points;
}

export function neighbourTable(size) {
  const table = [];
  for (let idx = 0; idx < size * size; idx++) {
    const x = idx % size;
    const y = Math.floor(idx / size);
    const list = [];
    if (x > 0) list.push(idx - 1);
    if (x < size - 1) list.push(idx + 1);
    if (y > 0) list.push(idx - size);
    if (y < size - 1) list.push(idx + size);
    table.push(list);
  }
  return table;
}

export class Game {
  constructor({ size = 19, komi = 7.5, handicap = 0 } = {}) {
    if (!BOARD_SIZES.includes(size)) throw new Error(`Unsupported board size ${size}`);
    this.size = size;
    this.komi = komi;
    this.handicap = handicapPoints(size, handicap).length;
    this.neighbours = neighbourTable(size);
    this.board = new Uint8Array(size * size);
    for (const idx of handicapPoints(size, handicap)) this.board[idx] = BLACK;
    this.toMove = this.handicap ? WHITE : BLACK;
    this.captures = { [BLACK]: 0, [WHITE]: 0 }; // stones captured BY each colour
    this.moves = []; // { color, idx, captured: [idx, …] }
    this.seen = new Set([this.positionKey(this.board)]);
    this.consecutivePasses = 0;
    this.phase = 'play'; // play → scoring → over
    this.dead = new Set();
    this.result = null; // { winner, reason: 'score' | 'resign' | 'timeout', margin?, black?, white? }
  }

  get settings() {
    return { size: this.size, komi: this.komi, handicap: this.handicap };
  }

  get lastMove() {
    return this.moves.length ? this.moves[this.moves.length - 1] : null;
  }

  positionKey(board) {
    return String.fromCharCode(...board);
  }

  // The stones of the chain at idx and how many distinct liberties it has.
  chain(board, start) {
    const color = board[start];
    const stones = [start];
    const seen = new Set(stones);
    const liberties = new Set();
    for (let i = 0; i < stones.length; i++) {
      for (const n of this.neighbours[stones[i]]) {
        if (seen.has(n)) continue;
        if (board[n] === color) {
          seen.add(n);
          stones.push(n);
        } else if (board[n] === EMPTY) {
          liberties.add(n);
        }
      }
    }
    return { stones, liberties };
  }

  // What playing idx would do, without doing it: { error } or { board, captured, key }.
  simulate(idx, color = this.toMove) {
    if (this.phase !== 'play') return { error: 'The game is not in play' };
    if (!Number.isInteger(idx) || idx < 0 || idx >= this.board.length) return { error: 'Off the board' };
    if (this.board[idx] !== EMPTY) return { error: 'That point is taken' };
    const board = this.board.slice();
    board[idx] = color;
    const captured = [];
    for (const n of this.neighbours[idx]) {
      if (board[n] !== other(color)) continue;
      const { stones, liberties } = this.chain(board, n);
      if (liberties.size === 0) {
        for (const s of stones) {
          board[s] = EMPTY;
          captured.push(s);
        }
      }
    }
    if (this.chain(board, idx).liberties.size === 0) return { error: 'Suicide is not allowed' };
    const key = this.positionKey(board);
    if (this.seen.has(key)) return { error: 'Ko: that would repeat an earlier position' };
    return { board, captured, key };
  }

  isLegal(idx, color = this.toMove) {
    return !this.simulate(idx, color).error;
  }

  legalMoves(color = this.toMove) {
    const moves = [];
    for (let idx = 0; idx < this.board.length; idx++) {
      if (this.board[idx] === EMPTY && this.isLegal(idx, color)) moves.push(idx);
    }
    return moves;
  }

  play(idx) {
    if (idx === PASS) return this.pass();
    const sim = this.simulate(idx);
    if (sim.error) return { ok: false, error: sim.error };
    const color = this.toMove;
    this.board = sim.board;
    this.seen.add(sim.key);
    this.captures[color] += sim.captured.length;
    this.moves.push({ color, idx, captured: sim.captured });
    this.toMove = other(color);
    this.consecutivePasses = 0;
    return { ok: true, captured: sim.captured };
  }

  pass() {
    if (this.phase !== 'play') return { ok: false, error: 'The game is not in play' };
    this.moves.push({ color: this.toMove, idx: PASS, captured: [] });
    this.toMove = other(this.toMove);
    this.consecutivePasses++;
    if (this.consecutivePasses >= 2) {
      this.phase = 'scoring';
      this.dead = new Set();
    }
    return { ok: true, captured: [] };
  }

  resign(color) {
    if (this.phase === 'over') return { ok: false, error: 'The game is over' };
    this.phase = 'over';
    this.result = { winner: other(color), reason: 'resign' };
    return { ok: true };
  }

  // Scoring phase: flip a whole chain between alive and dead.
  toggleDead(idx) {
    if (this.phase !== 'scoring' || this.board[idx] === EMPTY) return false;
    const { stones } = this.chain(this.board, idx);
    const makeDead = !this.dead.has(idx);
    for (const s of stones) {
      if (makeDead) this.dead.add(s);
      else this.dead.delete(s);
    }
    return true;
  }

  setDead(points) {
    this.dead = new Set(points.filter((idx) => this.board[idx] !== EMPTY));
  }

  // Back to play after a disputed count. The player who would have moved next moves.
  resume() {
    if (this.phase !== 'scoring') return false;
    this.phase = 'play';
    this.consecutivePasses = 0;
    this.dead = new Set();
    return true;
  }

  // Area (Chinese) scoring: live stones plus empty points reached only by one colour.
  // Dead stones are removed first, so their points count for whoever surrounds them.
  score() {
    const size2 = this.board.length;
    const board = this.board.slice();
    for (const idx of this.dead) board[idx] = EMPTY;
    const owner = new Uint8Array(size2);
    let black = 0;
    let white = 0;
    const visited = new Uint8Array(size2);
    for (let idx = 0; idx < size2; idx++) {
      if (board[idx] === BLACK) {
        black++;
        owner[idx] = BLACK;
      } else if (board[idx] === WHITE) {
        white++;
        owner[idx] = WHITE;
      } else if (!visited[idx]) {
        const region = [idx];
        visited[idx] = 1;
        let borders = 0;
        for (let i = 0; i < region.length; i++) {
          for (const n of this.neighbours[region[i]]) {
            if (board[n] === EMPTY) {
              if (!visited[n]) {
                visited[n] = 1;
                region.push(n);
              }
            } else {
              borders |= board[n];
            }
          }
        }
        if (borders === BLACK || borders === WHITE) {
          for (const r of region) owner[r] = borders;
          if (borders === BLACK) black += region.length;
          else white += region.length;
        }
      }
    }
    white += this.komi;
    const margin = Math.abs(black - white);
    const winner = black > white ? BLACK : white > black ? WHITE : EMPTY;
    return { black, white, owner, winner, margin };
  }

  finishScoring() {
    if (this.phase !== 'scoring') return false;
    const { black, white, winner, margin } = this.score();
    this.phase = 'over';
    this.result = { winner, reason: 'score', margin, black, white };
    return true;
  }

  // Everything needed to rebuild the game: settings plus the move list.
  toJSON() {
    return {
      ...this.settings,
      moves: this.moves.map((m) => m.idx),
      phase: this.phase,
      dead: [...this.dead],
      result: this.result,
    };
  }

  static fromJSON(data) {
    const game = new Game(data);
    for (const idx of data.moves || []) {
      const r = game.play(idx);
      if (!r.ok) throw new Error(`Bad move ${idx} in saved game: ${r.error}`);
    }
    if (data.phase === 'over') {
      game.phase = 'over';
      game.result = data.result;
      game.dead = new Set(data.dead || []);
    } else if (game.phase === 'scoring') {
      game.dead = new Set(data.dead || []);
    }
    return game;
  }

  // The game with the last n moves taken back.
  undo(n = 1) {
    const data = this.toJSON();
    data.moves = data.moves.slice(0, Math.max(0, data.moves.length - n));
    data.phase = 'play';
    data.dead = [];
    data.result = null;
    return Game.fromJSON(data);
  }
}
