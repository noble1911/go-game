# Go

Go in the browser: vs computer (MCTS in a Web Worker), pass & play, and online 1v1 (Node + ws).
No build step. `public/` is served as is. See README.md for the file map.

## Commands

| Task | Command |
|------|---------|
| Run locally | `npm run dev` (http://localhost:3000/) |
| Tests | `npm test` (rules, AI, server over real WebSockets) |
| Browser smoke test | `npm run e2e` (needs Chrome; screenshots in `e2e/shots/`) |
| Tune the AI | `node test/tune.mjs '{"rave":300}' '{}' 24 1000` (A vs B self-play) |

## Rules of the codebase

- `public/go.js` is the single source of the rules. The server imports it to referee, so keep it
  DOM-free. Points are `y * size + x`. A pass is `-1`.
- `public/ai.js` uses a padded fast board (`(size+2)²`, edge = 3) with pseudo-liberties. Atari =
  `libs * libSq == libSum²`. Root moves come from `Game.legalMoves()` (superko); deeper nodes
  only check simple ko.
- The AI only passes in answer to a pass. Passing while the opponent plays lets invaders live (a
  bug we hit). Search knobs live in `TUNE`. Change them only with a `test/tune.mjs` result.
- Everything must work under a path (`games.noblehaus.uk/go/`): relative asset URLs, socket at
  `new URL('ws', location.href)`, localStorage keys prefixed `go.`.

## Hosting (home server, Mac Mini 192.168.1.117)

Runs as a container (restarts on its own, survives reboots):

```bash
cd ~/go-game && git pull && /usr/local/bin/docker compose up -d --build
```

- Played at **https://games.noblehaus.uk/go/** through the games gateway (`~/home-server/games`:
  a `handle_path /go/*` route to `go-game:3000` and an entry in `site/games.json`). On the LAN it's
  `http://192.168.1.117:3008/`.
- Port 3008 is registered in `~/home-server/registry/services.yaml`.
- Logs: `docker logs go-game`. Health: `docker ps` shows `(healthy)`; `/healthz` answers `ok`.
- Online rooms live in memory, so a redeploy ends games in progress.
- Repo: https://github.com/noble1911/go-game
