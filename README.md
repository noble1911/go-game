# Go

The board game Go in the browser: play the computer, pass and play on one screen, or play a
friend online with a four-letter code. Boards 9×9, 13×13 and 19×19, handicap and komi,
positional superko, area (Chinese) scoring with a guessed dead-stone count to agree on.

**Play it:** https://games.noblehaus.uk/go/

## Run it

```bash
npm install
npm run dev          # http://localhost:3000/
npm test             # rules, computer player and server (node:test)
npm run e2e          # drives installed Chrome through every mode, screenshots in e2e/shots/
```

No build step: the browser loads the ES modules in `public/` as they are.

## How it's put together

| File | What |
|------|------|
| `public/go.js` | The rules: captures, suicide, positional superko, passes, dead stones, area scoring. Shared by the browser and the server. |
| `public/ai.js` | The computer player: Monte-Carlo tree search with RAVE over a fast board that tracks pseudo-liberties. Also guesses dead stones at the end of a game. |
| `public/ai-worker.js` | Runs the computer player in a Web Worker so the page never freezes. |
| `public/app.js` | Menu, setup, the three modes, the online client (reconnects and rejoins on its own). |
| `public/board.js` | Canvas board. On touch screens the first tap previews a stone and the second plays it. |
| `server.js` | Static files plus the WebSocket referee at `/ws`: rooms, seats, rematches, rejoin tokens. |
| `test/tune.mjs` | Self-play matches between search settings, for tuning the computer. |

The computer has four levels. Beginner and Easy are gentle; Hard thinks for up to six seconds a
move and is a fair game for a casual club player on 9×9. It only passes after you pass, so the
game ends when you say it does.

Online, the server runs the same rules module as the browser, so it rejects illegal moves
itself. A player who drops (a phone going to sleep) keeps their seat. The page reconnects, or
the menu offers **Rejoin**. When both players pass, the server guesses the dead stones. Either
player can change the guess, and the game ends once both accept the count.

## Hosting

It's one Node container. See `docker-compose.yml` and `CLAUDE.md` for the home-server set-up
behind games.noblehaus.uk.

## Licence

MIT
