// Draws the board on a canvas and turns clicks and taps into board points.
// On touch screens the first tap shows where the stone would go and a second tap on the same
// point plays it: on a 19×19 board on a phone a finger covers several points.
import { BLACK, WHITE, EMPTY, PASS, starPoints } from './go.js';

const COLUMNS = 'ABCDEFGHJKLMNOPQRST';

export class BoardView {
  constructor(canvas, { onPlay, onToggle } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onPlay = onPlay;
    this.onToggle = onToggle;
    this.view = null; // { game, interactive, ghostColor, scoring, owner, coords }
    this.hover = -1;
    this.pending = -1; // touch: first tap
    this.grain = null;
    canvas.addEventListener('pointermove', (e) => this.pointerMove(e));
    canvas.addEventListener('pointerleave', () => this.setHover(-1));
    canvas.addEventListener('pointerup', (e) => this.pointerUp(e));
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
  }

  set(view) {
    const sizeChanged = this.view?.game.size !== view.game.size;
    const moved = this.view && this.view.game.moves.length !== view.game.moves.length;
    this.view = view;
    if (sizeChanged || moved || !view.interactive) this.pending = -1;
    if (sizeChanged) this.resize();
    else this.draw();
  }

  // Fit the largest square into the space the layout gives the board.
  resize() {
    const wrap = this.canvas.parentElement;
    const narrow = window.matchMedia('(max-width: 820px)').matches;
    const w = wrap.clientWidth;
    const h = narrow ? w : wrap.clientHeight;
    const css = Math.max(200, Math.floor(Math.min(w, h || w)));
    const dpr = window.devicePixelRatio || 1;
    this.canvas.style.width = `${css}px`;
    this.canvas.style.height = `${css}px`;
    this.canvas.width = Math.round(css * dpr);
    this.canvas.height = Math.round(css * dpr);
    this.css = css;
    this.dpr = dpr;
    this.grain = null;
    this.draw();
  }

  geometry() {
    const size = this.view.game.size;
    const margin = this.view.coords ? 1.15 : 0.75; // in cells
    const cell = this.css / (size - 1 + margin * 2);
    return { size, cell, origin: cell * margin };
  }

  pointAt(e) {
    if (!this.view) return -1;
    const rect = this.canvas.getBoundingClientRect();
    const { size, cell, origin } = this.geometry();
    const x = Math.round((e.clientX - rect.left - origin) / cell);
    const y = Math.round((e.clientY - rect.top - origin) / cell);
    if (x < 0 || y < 0 || x >= size || y >= size) return -1;
    return y * size + x;
  }

  pointerMove(e) {
    if (e.pointerType === 'touch') return;
    this.setHover(this.pointAt(e));
  }

  setHover(idx) {
    if (idx === this.hover) return;
    this.hover = idx;
    this.draw();
  }

  pointerUp(e) {
    const v = this.view;
    if (!v?.interactive) return;
    const idx = this.pointAt(e);
    if (idx < 0) return;
    if (v.scoring) {
      if (v.game.board[idx] !== EMPTY) this.onToggle?.(idx);
      return;
    }
    if (v.game.board[idx] !== EMPTY) return;
    if (e.pointerType === 'touch' && this.pending !== idx) {
      this.pending = idx;
      this.draw();
      return;
    }
    this.pending = -1;
    this.onPlay?.(idx);
  }

  // Wood grain, drawn once per size into an offscreen canvas.
  woodTexture(px) {
    if (this.grain && this.grain.width === px) return this.grain;
    const c = document.createElement('canvas');
    c.width = c.height = px;
    const g = c.getContext('2d');
    const base = g.createLinearGradient(0, 0, px, px);
    base.addColorStop(0, '#e6bd6e');
    base.addColorStop(0.5, '#ddb062');
    base.addColorStop(1, '#d4a356');
    g.fillStyle = base;
    g.fillRect(0, 0, px, px);
    // Seeded so the grain doesn't change on every redraw.
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    g.globalAlpha = 0.08;
    for (let i = 0; i < 70; i++) {
      const y = rnd() * px;
      const amp = 2 + rnd() * 8;
      const freq = 0.002 + rnd() * 0.01;
      g.strokeStyle = rnd() > 0.5 ? '#8a5a1c' : '#f3d79a';
      g.lineWidth = 0.5 + rnd() * 2.5 * (px / 800);
      g.beginPath();
      for (let x = 0; x <= px; x += 6) g.lineTo(x, y + Math.sin(x * freq + i) * amp);
      g.stroke();
    }
    this.grain = c;
    return c;
  }

  draw() {
    const v = this.view;
    if (!v || !this.css) return;
    const { ctx, dpr, css } = this;
    const { game } = v;
    const { size, cell, origin } = this.geometry();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, css, css);
    ctx.drawImage(this.woodTexture(this.canvas.width), 0, 0, css, css);

    const pos = (i) => origin + i * cell;
    const end = pos(size - 1);

    // Grid
    ctx.strokeStyle = 'rgba(40, 25, 5, 0.85)';
    ctx.lineWidth = Math.max(1, cell / 30);
    ctx.beginPath();
    for (let i = 0; i < size; i++) {
      const p = Math.round(pos(i) * dpr) / dpr + 0.5 / dpr;
      ctx.moveTo(origin, p);
      ctx.lineTo(end, p);
      ctx.moveTo(p, origin);
      ctx.lineTo(p, end);
    }
    ctx.stroke();
    ctx.lineWidth = Math.max(1.5, cell / 18);
    ctx.strokeRect(origin, origin, end - origin, end - origin);

    // Star points
    const { corners, sides, centre } = starPoints(size);
    ctx.fillStyle = 'rgba(40, 25, 5, 0.9)';
    for (const idx of size === 9 ? [...corners, centre] : [...corners, ...sides, centre]) {
      ctx.beginPath();
      ctx.arc(pos(idx % size), pos(Math.floor(idx / size)), Math.max(2, cell * 0.11), 0, Math.PI * 2);
      ctx.fill();
    }

    // Coordinates
    if (v.coords) {
      ctx.fillStyle = 'rgba(50, 30, 8, 0.75)';
      ctx.font = `600 ${Math.max(9, cell * 0.36)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const off = cell * 0.68;
      for (let i = 0; i < size; i++) {
        ctx.fillText(COLUMNS[i], pos(i), origin - off);
        ctx.fillText(COLUMNS[i], pos(i), end + off);
        ctx.fillText(String(size - i), origin - off, pos(i));
        ctx.fillText(String(size - i), end + off, pos(i));
      }
    }

    // Territory (scoring and game over)
    if (v.owner) {
      for (let idx = 0; idx < game.board.length; idx++) {
        const o = v.owner[idx];
        const isDead = v.dead?.has(idx);
        if (!o || (game.board[idx] !== EMPTY && !isDead)) continue;
        const s = cell * 0.32;
        ctx.fillStyle = o === BLACK ? 'rgba(15, 12, 10, 0.85)' : 'rgba(250, 248, 242, 0.92)';
        ctx.fillRect(pos(idx % size) - s / 2, pos(Math.floor(idx / size)) - s / 2, s, s);
      }
    }

    // Stones
    const r = cell * 0.48;
    for (let idx = 0; idx < game.board.length; idx++) {
      const c = game.board[idx];
      if (c === EMPTY) continue;
      const alpha = v.dead?.has(idx) ? 0.38 : 1;
      this.stone(pos(idx % size), pos(Math.floor(idx / size)), r, c, alpha);
    }

    // Last move
    const last = game.lastMove;
    if (last && last.idx !== PASS && game.board[last.idx] !== EMPTY) {
      const x = pos(last.idx % size);
      const y = pos(Math.floor(last.idx / size));
      ctx.strokeStyle = game.board[last.idx] === BLACK ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.8)';
      ctx.lineWidth = Math.max(1.5, cell * 0.07);
      ctx.beginPath();
      ctx.arc(x, y, r * 0.45, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Ghost stone: hover on desktop, first tap on touch
    const ghost = this.pending >= 0 ? this.pending : this.hover;
    if (v.interactive && !v.scoring && v.ghostColor && ghost >= 0 && game.board[ghost] === EMPTY) {
      const x = pos(ghost % size);
      const y = pos(Math.floor(ghost / size));
      this.stone(x, y, r, v.ghostColor, this.pending >= 0 ? 0.7 : 0.45);
      if (this.pending >= 0) {
        ctx.strokeStyle = '#a0522d';
        ctx.lineWidth = Math.max(2, cell * 0.08);
        ctx.beginPath();
        ctx.arc(x, y, r + ctx.lineWidth, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  stone(x, y, r, color, alpha) {
    const { ctx } = this;
    ctx.save();
    ctx.globalAlpha = alpha;
    if (alpha === 1) {
      ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
      ctx.shadowBlur = r * 0.25;
      ctx.shadowOffsetX = r * 0.08;
      ctx.shadowOffsetY = r * 0.12;
    }
    const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.1, x, y, r);
    if (color === BLACK) {
      g.addColorStop(0, '#5c5c5c');
      g.addColorStop(0.45, '#161616');
      g.addColorStop(1, '#000');
    } else if (color === WHITE) {
      g.addColorStop(0, '#ffffff');
      g.addColorStop(0.6, '#ece8e0');
      g.addColorStop(1, '#bfb9ae');
    }
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}
