// Self-play tournament between two search configurations, for tuning the computer player.
//   node test/tune.mjs '{"rave":500}' '{"rave":2000}' [games] [playouts] [size]
// Each config is merged over TUNE. Prints A's score out of the games played.
import { Game, BLACK, WHITE, PASS } from '../public/go.js';
import { chooseMove, estimateDead, makeRng, TUNE } from '../public/ai.js';

const a = { ...TUNE, ...JSON.parse(process.argv[2] || '{}') };
const b = { ...TUNE, ...JSON.parse(process.argv[3] || '{}') };
const games = Number(process.argv[4] || 20);
const playouts = Number(process.argv[5] || 1000);
const size = Number(process.argv[6] || 9);
const rng = makeRng(Number(process.env.SEED || 1));

let aWins = 0;
for (let n = 0; n < games; n++) {
  const g = new Game({ size, komi: 7.5 });
  const aColor = n % 2 ? WHITE : BLACK;
  while (g.phase === 'play' && g.moves.length < size * size * 3) {
    const tune = g.toMove === aColor ? a : b;
    const { move } = chooseMove(g, { tune, playouts, rng });
    if (move === 'resign') g.resign(g.toMove);
    else if (move === PASS) g.pass();
    else g.play(move);
  }
  if (g.phase === 'play') {
    g.pass();
    g.pass();
  }
  if (g.phase === 'scoring') {
    g.setDead(estimateDead(g, { playouts: 1000, rng }).dead);
    g.finishScoring();
  }
  if (g.result.winner === aColor) aWins++;
  process.stdout.write(g.result.winner === aColor ? 'A' : 'b');
}
console.log(`\nA ${JSON.stringify(a)}\nB ${JSON.stringify(b)}\nA won ${aWins}/${games}`);
