// Runs the computer player off the main thread so the page stays responsive while it thinks.
import { Game } from './go.js';
import { chooseMove, estimateDead } from './ai.js';

self.onmessage = ({ data }) => {
  const game = Game.fromJSON(data.game);
  if (data.kind === 'move') {
    const { move, winrate, playouts } = chooseMove(game, { level: data.level });
    self.postMessage({ id: data.id, move, winrate, playouts });
  } else if (data.kind === 'dead') {
    const { dead } = estimateDead(game, { playouts: 1000 });
    self.postMessage({ id: data.id, dead });
  }
};
