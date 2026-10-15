// The computer player: Monte-Carlo tree search with RAVE over a fast playout board.
// Also estimates which stones are dead when a game ends (used by the server and single player).
//
// The fast board is padded with an edge border, so position p has neighbours p±1 and p±W
// where W = size + 2. Chains keep *pseudo-liberties* (liberties counted once per adjacent
// stone) plus the sum and sum of squares of their positions: a chain is in atari exactly when
// all its pseudo-liberties are one point, i.e. count × sumSq == sum² (Cauchy–Schwarz).

import { BLACK, WHITE, EMPTY, PASS, other } from './go.js';

const EDGE = 3;
const NO_MOVE = 0; // position 0 is always edge, so it doubles as "pass" on the fast board
const ATARI_RING = 4;

export class FastBoard {
  constructor(size) {
    this.size = size;
    const W = (this.W = size + 2);
    const N = (this.N = W * W);
    this.color = new Uint8Array(N).fill(EDGE);
    this.gid = new Int32Array(N); // chain root
    this.next = new Int32Array(N); // circular list of a chain's stones
    this.gsize = new Int32Array(N);
    this.libs = new Int32Array(N);
    this.libSum = new Int32Array(N);
    this.libSq = new Int32Array(N);
    this.empties = new Int32Array(N);
    this.emptyAt = new Int32Array(N);
    this.nEmpty = 0;
    this.ko = NO_MOVE;
    this.last = NO_MOVE;
    this.toMove = BLACK;
    this.ataris = new Int32Array(ATARI_RING); // 0 = empty slot (always edge)
    this.atariHead = 0;
    this.dirs = [1, -1, W, -W];
    this.diags = [W + 1, W - 1, -W + 1, -W - 1];
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const p = (y + 1) * W + x + 1;
        this.color[p] = EMPTY;
        this.emptyAt[p] = this.nEmpty;
        this.empties[this.nEmpty++] = p;
      }
    }
  }

  toFast(idx) {
    return (Math.floor(idx / this.size) + 1) * this.W + (idx % this.size) + 1;
  }

  toIdx(p) {
    return (Math.floor(p / this.W) - 1) * this.size + (p % this.W) - 1;
  }

  copyFrom(o) {
    this.color.set(o.color);
    this.gid.set(o.gid);
    this.next.set(o.next);
    this.gsize.set(o.gsize);
    this.libs.set(o.libs);
    this.libSum.set(o.libSum);
    this.libSq.set(o.libSq);
    this.empties.set(o.empties);
    this.emptyAt.set(o.emptyAt);
    this.nEmpty = o.nEmpty;
    this.ko = o.ko;
    this.last = o.last;
    this.toMove = o.toMove;
    this.ataris.set(o.ataris);
    this.atariHead = o.atariHead;
  }

  static fromGame(game) {
    const fb = new FastBoard(game.size);
    // Placing a legal position's stones in any order never leaves a chain without a liberty:
    // a partial chain always borders an unplaced stone of its own chain (still empty).
    for (let idx = 0; idx < game.board.length; idx++) {
      if (game.board[idx] !== EMPTY) fb.play(fb.toFast(idx), game.board[idx]);
    }
    fb.toMove = game.toMove;
    fb.ko = NO_MOVE;
    fb.last = NO_MOVE;
    const last = game.lastMove;
    if (last && last.idx !== PASS) {
      fb.last = fb.toFast(last.idx);
      if (last.captured.length === 1) {
        const p = fb.last;
        const r = fb.gid[p];
        if (fb.gsize[r] === 1 && fb.libs[r] === 1) fb.ko = fb.toFast(last.captured[0]);
      }
    }
    return fb;
  }

  inAtari(r) {
    return this.libs[r] * this.libSq[r] === this.libSum[r] * this.libSum[r];
  }

  atariPoint(r) {
    return this.libSum[r] / this.libs[r];
  }

  // A point surrounded by one colour (the edge counts as either).
  isEyeish(p, c) {
    for (const d of this.dirs) {
      const n = this.color[p + d];
      if (n !== c && n !== EDGE) return false;
    }
    return true;
  }

  // A real eye: eyeish, and the opponent doesn't hold enough diagonals to make it false.
  isEye(p, c) {
    if (!this.isEyeish(p, c)) return false;
    let enemy = 0;
    let edge = 0;
    const o = other(c);
    for (const d of this.diags) {
      const n = this.color[p + d];
      if (n === o) enemy++;
      else if (n === EDGE) edge++;
    }
    return edge ? enemy === 0 : enemy < 2;
  }

  isLegal(p, c) {
    if (this.color[p] !== EMPTY || p === this.ko) return false;
    for (const d of this.dirs) {
      const n = p + d;
      const cn = this.color[n];
      if (cn === EMPTY) return true;
      if (cn === c) {
        if (!this.inAtari(this.gid[n])) return true;
      } else if (cn !== EDGE) {
        if (this.inAtari(this.gid[n])) return true;
      }
    }
    return false;
  }

  // Would capture something if played here.
  captures(p, c) {
    const o = other(c);
    for (const d of this.dirs) {
      const n = p + d;
      if (this.color[n] === o && this.inAtari(this.gid[n])) return true;
    }
    return false;
  }

  // Playing here leaves the new chain with at most one liberty (and captures nothing).
  isSelfAtari(p, c) {
    if (this.captures(p, c)) return false;
    let lib1 = 0;
    let lib2 = 0;
    const addLib = (l) => {
      if (l === p || l === lib1 || l === lib2) return true;
      if (!lib1) lib1 = l;
      else if (!lib2) lib2 = l;
      else return false; // three liberties: safe
      return true;
    };
    for (const d of this.dirs) {
      const n = p + d;
      const cn = this.color[n];
      if (cn === EMPTY) {
        if (!addLib(n)) return false;
      } else if (cn === c) {
        // Walk the chain's real liberties (chains here are small or we bail early).
        const r = this.gid[n];
        let s = r;
        do {
          for (const d2 of this.dirs) {
            const l = s + d2;
            if (this.color[l] === EMPTY && !addLib(l)) return false;
          }
          s = this.next[s];
        } while (s !== r);
      }
    }
    return !lib2;
  }

  removeFromEmpties(p) {
    const i = this.emptyAt[p];
    const lastP = this.empties[--this.nEmpty];
    this.empties[i] = lastP;
    this.emptyAt[lastP] = i;
  }

  addToEmpties(p) {
    this.emptyAt[p] = this.nEmpty;
    this.empties[this.nEmpty++] = p;
  }

  play(p, c) {
    this.removeFromEmpties(p);
    const { color, gid, libs, libSum, libSq, dirs } = this;
    color[p] = c;
    gid[p] = p;
    this.next[p] = p;
    this.gsize[p] = 1;
    libs[p] = 0;
    libSum[p] = 0;
    libSq[p] = 0;
    for (const d of dirs) {
      const n = p + d;
      const cn = color[n];
      if (cn === EMPTY) {
        libs[p]++;
        libSum[p] += n;
        libSq[p] += n * n;
      } else if (cn !== EDGE) {
        const r = gid[n];
        libs[r]--;
        libSum[r] -= p;
        libSq[r] -= p * p;
      }
    }
    for (const d of dirs) {
      const n = p + d;
      if (color[n] === c && gid[n] !== gid[p]) this.merge(gid[p], gid[n]);
    }
    const o = other(c);
    let captured = 0;
    let capturedAt = NO_MOVE;
    for (const d of dirs) {
      const n = p + d;
      if (color[n] === o && libs[gid[n]] === 0) {
        captured += this.removeChain(gid[n]);
        capturedAt = n;
      }
    }
    const r = gid[p];
    this.ko = captured === 1 && this.gsize[r] === 1 && libs[r] === 1 ? capturedAt : NO_MOVE;
    for (const d of dirs) {
      const n = p + d;
      if (color[n] === o && this.inAtari(gid[n])) this.noteAtari(n);
    }
    if (this.inAtari(r)) this.noteAtari(p);
    this.last = p;
    this.toMove = o;
    return captured;
  }

  pass() {
    this.ko = NO_MOVE;
    this.last = NO_MOVE;
    this.toMove = other(this.toMove);
  }

  merge(a, b) {
    let big = a;
    let small = b;
    if (this.gsize[a] < this.gsize[b]) {
      big = b;
      small = a;
    }
    let s = small;
    do {
      this.gid[s] = big;
      s = this.next[s];
    } while (s !== small);
    const t = this.next[big];
    this.next[big] = this.next[small];
    this.next[small] = t;
    this.gsize[big] += this.gsize[small];
    this.libs[big] += this.libs[small];
    this.libSum[big] += this.libSum[small];
    this.libSq[big] += this.libSq[small];
  }

  removeChain(r) {
    const { color, gid, libs, libSum, libSq, next, dirs } = this;
    let count = 0;
    let s = r;
    do {
      color[s] = EMPTY;
      this.addToEmpties(s);
      count++;
      s = next[s];
    } while (s !== r);
    s = r;
    do {
      for (const d of dirs) {
        const n = s + d;
        const cn = color[n];
        if (cn === BLACK || cn === WHITE) {
          const g = gid[n];
          libs[g]++;
          libSum[g] += s;
          libSq[g] += s * s;
        }
      }
      s = next[s];
    } while (s !== r);
    return count;
  }

  // Remember chains that a move left in atari (a short ring of recent events), so the
  // playout policy can take them, or rescue them, a move or two later.
  noteAtari(p) {
    this.ataris[this.atariHead] = p;
    this.atariHead = (this.atariHead + 1) % ATARI_RING;
  }

  // Tactics: take an opponent chain in atari, or rescue one of ours (by capturing a
  // neighbour in atari, or by extending when that doesn't just self-atari).
  tacticalMove(c, rng) {
    if (rng() > 0.9) return NO_MOVE;
    const o = other(c);
    const { color, gid, ataris } = this;
    for (let i = 0; i < ATARI_RING; i++) {
      const p = ataris[i];
      if (color[p] === o && this.inAtari(gid[p])) {
        const a = this.atariPoint(gid[p]);
        if (this.isLegal(a, c)) return a;
      }
    }
    for (let i = 0; i < ATARI_RING; i++) {
      const p = ataris[i];
      if (color[p] !== c) continue;
      const r = gid[p];
      if (!this.inAtari(r)) continue;
      let s = r;
      do {
        for (const d of this.dirs) {
          const e = s + d;
          if (color[e] === o && this.inAtari(gid[e])) {
            const a = this.atariPoint(gid[e]);
            if (this.isLegal(a, c)) return a;
          }
        }
        s = this.next[s];
      } while (s !== r);
      const a = this.atariPoint(r);
      if (this.isLegal(a, c) && !this.isSelfAtari(a, c)) return a;
    }
    return NO_MOVE;
  }

  // The playout policy: tactics, else a random legal move that doesn't fill our own eye
  // (and, mostly, isn't a self-atari).
  policyMove(c, rng) {
    const t = this.tacticalMove(c, rng);
    if (t !== NO_MOVE) return t;
    const n = this.nEmpty;
    if (n === 0) return NO_MOVE;
    const start = Math.floor(rng() * n);
    let fallback = NO_MOVE;
    for (let k = 0; k < n; k++) {
      const p = this.empties[(start + k) % n];
      if (this.isEye(p, c) || !this.isLegal(p, c)) continue;
      if (this.isSelfAtari(p, c) && rng() < 0.9) {
        if (fallback === NO_MOVE) fallback = p;
        continue;
      }
      return p;
    }
    return fallback;
  }

  // Area score at the end of a playout (black minus white, before komi), and who owns what.
  playoutScore(owner) {
    let score = 0;
    const { color, dirs } = this;
    for (let y = 1; y <= this.size; y++) {
      for (let x = 1; x <= this.size; x++) {
        const p = y * this.W + x;
        let c = color[p];
        if (c === EMPTY) {
          let seen = 0;
          for (const d of dirs) {
            const n = color[p + d];
            if (n === BLACK || n === WHITE) seen |= n;
          }
          c = seen === BLACK || seen === WHITE ? seen : EMPTY;
        }
        if (c === BLACK) score++;
        else if (c === WHITE) score--;
        if (owner) owner[p] += c === BLACK ? 1 : c === WHITE ? -1 : 0;
      }
    }
    return score;
  }

  // Plays random moves until both sides pass. amaf records who first played each point.
  playout(rng, amaf) {
    const maxMoves = this.size * this.size * 3;
    let passes = 0;
    for (let moves = 0; passes < 2 && moves < maxMoves; moves++) {
      const c = this.toMove;
      const p = this.policyMove(c, rng);
      if (p === NO_MOVE) {
        passes++;
        this.pass();
      } else {
        passes = 0;
        if (amaf && !amaf[p]) amaf[p] = c;
        this.play(p, c);
      }
    }
  }
}

// Small fast seeded PRNG (mulberry32), so tests are repeatable.
export function makeRng(seed = (Math.random() * 2 ** 32) >>> 0) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Node {
  constructor(move, toMove, priorWins, priorVisits) {
    this.move = move; // fast-board position that led here
    this.toMove = toMove; // who moves from this node
    this.children = null;
    this.N = 0; // visits
    this.W = 0; // wins for the player who made `move`
    this.aN = priorVisits; // AMAF visits (seeded with a prior)
    this.aW = priorWins;
  }
}

const PRIOR_VISITS = 10;
// Search knobs (tuned by self-play; see test/tune.mjs).
export const TUNE = { rave: 500, explore: 0, win: 0.85, tactical: 10 };

// Stones in opponent chains this move would capture.
function captureSize(fb, p, c) {
  const o = other(c);
  let size = 0;
  const counted = [];
  for (const d of fb.dirs) {
    const n = p + d;
    if (fb.color[n] !== o) continue;
    const r = fb.gid[n];
    if (fb.inAtari(r) && !counted.includes(r)) {
      counted.push(r);
      size += fb.gsize[r];
    }
  }
  return size;
}

// Stones of ours in atari that playing here rescues (extending to more than one liberty).
function rescueSize(fb, p, c) {
  let size = 0;
  const counted = [];
  for (const d of fb.dirs) {
    const n = p + d;
    if (fb.color[n] !== c) continue;
    const r = fb.gid[n];
    if (fb.inAtari(r) && !counted.includes(r)) {
      counted.push(r);
      size += fb.gsize[r];
    }
  }
  return size && !fb.isSelfAtari(p, c) ? size : 0;
}

// A move's prior: how promising it looks before any playout, and how sure we are of it.
// Tactical moves (captures and rescues) also seed the real visit counts, not just AMAF.
function prior(fb, p, c, earlyGame) {
  const captured = captureSize(fb, p, c);
  if (captured) return { value: Math.min(0.95, 0.75 + 0.05 * captured), sure: true };
  const rescued = rescueSize(fb, p, c);
  if (rescued) return { value: Math.min(0.9, 0.7 + 0.05 * rescued), sure: true };
  if (fb.isSelfAtari(p, c)) return { value: 0.15, sure: false };
  const x = (p % fb.W) - 1;
  const y = Math.floor(p / fb.W) - 1;
  const line = Math.min(x, y, fb.size - 1 - x, fb.size - 1 - y);
  if (line === 0) return { value: earlyGame ? 0.2 : 0.4, sure: false };
  if (line === 1 && earlyGame) return { value: 0.4, sure: false };
  if (fb.last !== NO_MOVE) {
    const lx = (fb.last % fb.W) - 1;
    const ly = Math.floor(fb.last / fb.W) - 1;
    if (Math.abs(lx - x) <= 1 && Math.abs(ly - y) <= 1) return { value: 0.6, sure: false };
  }
  return { value: 0.5, sure: false };
}

function expand(node, fb, allowed, tune) {
  const c = fb.toMove;
  const earlyGame = fb.nEmpty > fb.size * fb.size * 0.8;
  const children = [];
  const consider = (p) => {
    if (!fb.isLegal(p, c) || fb.isEye(p, c)) return;
    const { value, sure } = prior(fb, p, c, earlyGame);
    const child = new Node(p, other(c), value * PRIOR_VISITS, PRIOR_VISITS);
    if (sure && tune.tactical) {
      child.N = tune.tactical;
      child.W = value * tune.tactical;
    }
    children.push(child);
  };
  if (allowed) allowed.forEach(consider);
  else for (let i = 0; i < fb.nEmpty; i++) consider(fb.empties[i]);
  node.children = children;
}

function select(node, tune) {
  let best = null;
  let bestValue = -Infinity;
  const logN = Math.log(node.N + 1);
  for (const ch of node.children) {
    const { N, aN } = ch;
    const beta = aN / (N + aN + (N * aN) / tune.rave);
    const q = N ? ch.W / N : 0;
    const a = ch.aW / aN;
    const value = (1 - beta) * q + beta * a + tune.explore * Math.sqrt(logN / (N + 1));
    if (value > bestValue) {
      bestValue = value;
      best = ch;
    }
  }
  return best;
}

// How hard the computer tries. Playouts are a cap; time is the other cap (bigger boards are slower).
export const LEVELS = {
  beginner: { playouts: 120, timeMs: 400, label: 'Beginner' },
  easy: { playouts: 800, timeMs: 900, label: 'Easy' },
  medium: { playouts: 5000, timeMs: 2500, label: 'Medium' },
  hard: { playouts: 40000, timeMs: 6000, label: 'Hard' },
};

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// Runs the search. Returns the root, the fast board, ownership per point and the playout count.
export function search(game, { playouts, timeMs, rng, tune = TUNE }) {
  const rootBoard = FastBoard.fromGame(game);
  const color = game.toMove;
  // The root uses the real rules (positional superko), deeper nodes use simple ko.
  const allowed = game.legalMoves(color).map((idx) => rootBoard.toFast(idx));
  const root = new Node(NO_MOVE, color, 0, 0);
  expand(root, rootBoard, allowed, tune);
  const fb = new FastBoard(game.size);
  const amaf = new Uint8Array(rootBoard.N);
  const owner = new Float64Array(rootBoard.N);
  const komi = game.komi;
  const scoreScale = game.size * 0.75;
  const deadline = now() + timeMs;
  let done = 0;
  if (!root.children.length) return { root, rootBoard, owner, done };
  while (done < playouts && (done % 64 !== 0 || now() < deadline)) {
    fb.copyFrom(rootBoard);
    amaf.fill(0);
    let node = root;
    const path = [root];
    while (node.children) {
      if (!node.children.length) break;
      const child = select(node, tune);
      const c = fb.toMove;
      if (!amaf[child.move]) amaf[child.move] = c;
      fb.play(child.move, c);
      node = child;
      path.push(node);
    }
    if (!node.children && node.N >= 1) {
      expand(node, fb, null, tune);
      if (node.children.length) {
        const child = select(node, tune);
        const c = fb.toMove;
        if (!amaf[child.move]) amaf[child.move] = c;
        fb.play(child.move, c);
        node = child;
        path.push(node);
      }
    }
    fb.playout(rng, amaf);
    const margin = fb.playoutScore(owner) - komi;
    // Mostly win/loss, plus a little of the margin so a bigger lead breaks ties between
    // winning moves (pure win/loss search happily skips free captures when already ahead).
    const blackValue = (margin > 0 ? tune.win : 0) + (1 - tune.win) * (0.5 + 0.5 * Math.tanh(margin / scoreScale));
    for (const n of path) {
      n.N++;
      const mover = n.toMove;
      // n.W is from the view of whoever moved INTO n, i.e. the opponent of n.toMove.
      n.W += mover === BLACK ? 1 - blackValue : blackValue;
      if (n.children) {
        const value = mover === BLACK ? blackValue : 1 - blackValue;
        for (const ch of n.children) {
          if (amaf[ch.move] === mover) {
            ch.aN++;
            ch.aW += value;
          }
        }
      }
    }
    done++;
  }
  for (let i = 0; i < owner.length; i++) owner[i] /= Math.max(done, 1);
  return { root, rootBoard, owner, done };
}

// Ownership in game coordinates: +1 black owns it in every playout, -1 white does.
function toGameOwnership(fb, owner) {
  const out = new Float64Array(fb.size * fb.size);
  for (let idx = 0; idx < out.length; idx++) out[idx] = owner[fb.toFast(idx)];
  return out;
}

// Stones whose points mostly end up owned by the other colour are dead.
function deadFromOwnership(game, ownership) {
  const dead = [];
  for (let idx = 0; idx < game.board.length; idx++) {
    const c = game.board[idx];
    if (c === BLACK && ownership[idx] < -0.3) dead.push(idx);
    else if (c === WHITE && ownership[idx] > 0.3) dead.push(idx);
  }
  return dead;
}

// Area score for `color` (positive = ahead) if the game ended now with these dead stones.
function scoreFor(game, dead, color) {
  const savedDead = game.dead;
  game.dead = new Set(dead);
  const { black, white } = game.score();
  game.dead = savedDead;
  return color === BLACK ? black - white : white - black;
}

// Random playouts from the position: which stones are dead, and who owns each point.
export function estimateDead(game, { playouts = 800, rng = makeRng() } = {}) {
  const rootBoard = FastBoard.fromGame(game);
  const fb = new FastBoard(game.size);
  const owner = new Float64Array(rootBoard.N);
  for (let i = 0; i < playouts; i++) {
    fb.copyFrom(rootBoard);
    // Alternate who moves first so neither side gets a free move in every playout.
    if (i % 2) fb.pass();
    fb.playout(rng, null);
    fb.playoutScore(owner);
  }
  for (let i = 0; i < owner.length; i++) owner[i] /= playouts;
  const ownership = toGameOwnership(rootBoard, owner);
  return { dead: deadFromOwnership(game, ownership), ownership };
}

// The computer's move: { move: idx | PASS | 'resign', winrate, playouts, ownership }.
export function chooseMove(game, { level = 'medium', rng = makeRng(), allowResign = true, tune = TUNE, playouts } = {}) {
  const color = game.toMove;
  const cfg = LEVELS[level] || LEVELS.medium;
  const { root, rootBoard, owner, done } = search(game, { ...cfg, ...(playouts ? { playouts, timeMs: 1e9 } : {}), rng, tune });
  const ownership = toGameOwnership(rootBoard, owner);
  if (!root.children.length) return { move: PASS, winrate: 0.5, playouts: done, ownership };

  let best = root.children[0];
  for (const ch of root.children) if (ch.N > best.N) best = ch;
  const winrate = best.N ? best.W / best.N : 0.5;
  const dead = deadFromOwnership(game, ownership);
  const lead = scoreFor(game, dead, color);

  // Only ever pass in answer to a pass: under area scoring a move inside our own area costs
  // nothing, while passing as the opponent keeps playing lets their stones live.
  // Answer a pass with a pass when we're ahead, or when every point left is settled anyway.
  const last = game.lastMove;
  if (last && last.idx === PASS) {
    const settled = root.children.every((ch) => Math.abs(owner[ch.move]) > 0.9);
    if (lead > 0 || settled) return { move: PASS, winrate, playouts: done, ownership };
  }

  const matured = game.moves.length > (game.size * game.size) / 3;
  if (allowResign && matured && winrate < 0.06 && done >= 300 && lead < -10) {
    return { move: 'resign', winrate, playouts: done, ownership };
  }

  return { move: rootBoard.toIdx(best.move), winrate, playouts: done, ownership };
}
