// Browser smoke test: drives installed Chrome through every way to play and saves screenshots.
//   npm run e2e            (CHROME=/path/to/chrome to override; SHOTS=dir for screenshots)
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from '../server.js';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SHOTS = process.env.SHOTS || 'e2e/shots';
fs.mkdirSync(SHOTS, { recursive: true });

const server = await startServer(0);
const base = `http://localhost:${server.address().port}/`;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
let failures = 0;

function check(cond, what) {
  console.log(`${cond ? '✔' : '✖'} ${what}`);
  if (!cond) failures++;
}

const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) });

// Click board point (x, y): the board has 1.15 cells of margin with coordinates on.
async function clickPoint(page, size, x, y) {
  const box = await page.$eval('#board', (c) => {
    const r = c.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width };
  });
  const cell = box.width / (size - 1 + 2.3);
  await page.mouse.click(box.left + cell * (1.15 + x), box.top + cell * (1.15 + y));
}

const saved = (page, key) => page.evaluate((k) => JSON.parse(localStorage.getItem(`go.${k}`) || 'null'), key);
const text = (page, sel) => page.$eval(sel, (el) => el.textContent.trim());
const visible = (page, sel) => page.$eval(sel, (el) => !el.hidden && el.offsetParent !== null);

async function newPage(width = 1280, height = 820) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => {
    console.log('page error:', e.message);
    failures++;
  });
  page.on('console', (m) => m.type() === 'error' && console.log('console error:', m.text()));
  return page;
}

try {
  // ── Menu ──
  const page = await newPage();
  await page.goto(base);
  check(await visible(page, '#menu'), 'menu shows');
  await shot(page, '1-menu');

  // ── Against the computer ──
  await page.click('[data-mode="solo"]');
  await page.click('#setup-form input[name="size"][value="9"] + span');
  await page.click('#setup-form input[name="level"][value="beginner"] + span');
  await page.click('#setup-form input[name="color"][value="black"] + span');
  await shot(page, '2-setup');
  await page.click('#setup-start');
  await page.waitForSelector('#game:not([hidden])');
  await clickPoint(page, 9, 4, 4);
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('go.solo')).game.moves.length >= 2, { timeout: 10000 });
  let solo = await saved(page, 'solo');
  check(solo.game.moves[0] === 40, 'your stone is played at E5');
  check(solo.game.moves.length === 2, 'the computer replies');
  await clickPoint(page, 9, 2, 6);
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('go.solo')).game.moves.length >= 4, { timeout: 10000 });
  await shot(page, '3-solo');
  await page.click('#btn-undo');
  solo = await saved(page, 'solo');
  check(solo.game.moves.length === 2, 'undo takes back your move and the reply');
  await page.click('#btn-pass');
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('go.solo')).game.moves.length >= 4, { timeout: 10000 });
  check((await text(page, '#status')).length > 0, `status reads "${await text(page, '#status')}"`);
  // The computer answers a pass with a pass when it's ahead: accept its count.
  await page.waitForSelector('#controls-score:not([hidden])');
  await page.waitForFunction(() => !document.querySelector('#btn-accept').disabled, { timeout: 10000 });
  await page.click('#btn-accept');
  await page.waitForSelector('#controls-over:not([hidden])');
  check((await text(page, '#result')).includes('Computer wins'), `the count ends the game: "${await text(page, '#result')}"`);

  // A fresh game, resigned through the confirm dialog.
  await page.click('#btn-again');
  await page.waitForSelector('#controls-play:not([hidden])');
  await page.click('#btn-resign');
  await page.waitForSelector('#confirm[open]');
  await page.click('#confirm-ok');
  await page.waitForSelector('#controls-over:not([hidden])');
  check((await text(page, '#result')).includes('by resignation'), `resigning ends the game: "${await text(page, '#result')}"`);

  // ── Pass & play, to scoring ──
  await page.click('#game .bar [data-action="menu"]');
  await page.click('[data-mode="local"]');
  await page.click('#setup-form input[name="size"][value="9"] + span');
  await page.click('#setup-start');
  await page.waitForSelector('#game:not([hidden])');
  await clickPoint(page, 9, 2, 2);
  await clickPoint(page, 9, 6, 6);
  await clickPoint(page, 9, 2, 6);
  await clickPoint(page, 9, 6, 2);
  let local = await saved(page, 'local');
  check(local.game.moves.length === 4, 'pass & play alternates colours');
  await clickPoint(page, 9, 2, 2); // occupied
  local = await saved(page, 'local');
  check(local.game.moves.length === 4, 'clicking a stone does nothing');
  await page.click('#btn-pass');
  await page.click('#btn-pass');
  await page.waitForSelector('#controls-score:not([hidden])');
  await page.waitForFunction(() => !document.querySelector('#btn-accept').disabled, { timeout: 10000 });
  await shot(page, '4-scoring');
  await page.click('#btn-accept');
  await page.waitForSelector('#controls-over:not([hidden])');
  check((await text(page, '#result')).includes('White wins by 7.5'), `local result: "${await text(page, '#result')}"`);
  await shot(page, '5-local-over');

  // ── Online: two separate browsers ──
  const alice = await newPage();
  await alice.goto(base);
  await alice.evaluate(() => localStorage.setItem('go.name', JSON.stringify('Alice')));
  await alice.click('[data-mode="online"]');
  await alice.click('#setup-form input[name="size"][value="13"] + span');
  await alice.click('#setup-form input[name="color"][value="black"] + span');
  await alice.click('#setup-start');
  await alice.waitForSelector('#waiting:not([hidden])');
  const code = await text(alice, '#waiting-code');
  check(/^[A-Z2-9]{4}$/.test(code), `a game code is shown (${code})`);
  await shot(alice, '6-online-waiting');

  const bob = await newPage(390, 844); // a phone
  await bob.goto(base);
  await bob.evaluate(() => localStorage.setItem('go.name', JSON.stringify('Bob')));
  await bob.goto(`${base}?room=${code}`);
  await bob.waitForSelector('#game:not([hidden])');
  await alice.waitForSelector('#waiting', { hidden: true });
  check((await text(alice, '#player-white .pname')) === 'Bob', 'Alice sees Bob join as White');
  check((await text(bob, '#status')).includes('Alice'), `Bob waits for Alice: "${await text(bob, '#status')}"`);

  await clickPoint(alice, 13, 3, 3);
  await bob.waitForFunction(() => document.querySelector('#status').textContent.includes('Your move'));
  check(true, 'Bob gets the move after Alice plays');
  // Phone: first tap previews, second tap plays.
  await bob.touchscreen.tap(...(await pointXY(bob, 13, 9, 9)));
  await new Promise((r) => setTimeout(r, 200));
  check((await text(bob, '#status')).includes('Your move'), 'first tap on a phone only previews');
  await shot(bob, '7-phone-preview');
  await bob.touchscreen.tap(...(await pointXY(bob, 13, 9, 9)));
  await alice.waitForFunction(() => document.querySelector('#status').textContent.includes('Your move'));
  check(true, 'second tap plays and Alice gets the move');
  await shot(alice, '8-online-alice');
  await shot(bob, '9-online-bob-phone');

  // Bob's connection drops: he rejoins his seat automatically.
  await bob.evaluate(() => window.dispatchEvent(new Event('offline')));
  await bob.reload();
  await bob.waitForSelector('#menu:not([hidden])');
  const rejoinBtn = await bob.$('#resume-list .btn');
  check(!!rejoinBtn, 'after a reload the menu offers to rejoin');
  await rejoinBtn.click();
  await bob.waitForSelector('#game:not([hidden])');
  await bob.waitForFunction(() => document.querySelector('#player-white .pname').textContent.includes('(you)'));
  check(true, 'Bob is back in his seat');

  // Both pass, both accept.
  await clickPoint(alice, 13, 9, 3);
  await bob.waitForFunction(() => document.querySelector('#status').textContent.includes('Your move'));
  await bob.click('#btn-pass');
  await alice.waitForFunction(() => !document.querySelector('#btn-pass').disabled);
  await alice.click('#btn-pass');
  await alice.waitForSelector('#controls-score:not([hidden])');
  await bob.waitForSelector('#controls-score:not([hidden])');
  await alice.click('#btn-accept');
  await bob.waitForFunction(() => document.querySelector('#score-line').textContent.includes('agreed'));
  await bob.click('#btn-accept');
  await alice.waitForSelector('#controls-over:not([hidden])');
  check((await text(alice, '#result')).length > 0, `online result: "${await text(alice, '#result')}"`);
  await alice.click('#btn-again');
  await bob.waitForFunction(() => document.querySelector('#btn-again').textContent.includes('Accept rematch'));
  await bob.click('#btn-again');
  await alice.waitForFunction(() => document.querySelector('#player-white .pname').textContent.includes('(you)'));
  check(true, 'rematch swaps colours');

  // Dark mode look
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  await page.click('#game .bar [data-action="menu"]');
  await shot(page, '10-menu-dark');
} catch (e) {
  console.log('✖', e.message);
  failures++;
} finally {
  await browser.close();
  for (const ws of server.wss.clients) ws.terminate();
  server.close();
}

async function pointXY(page, size, x, y) {
  const box = await page.$eval('#board', (c) => {
    const r = c.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width };
  });
  const cell = box.width / (size - 1 + 2.3);
  return [box.left + cell * (1.15 + x), box.top + cell * (1.15 + y)];
}

console.log(failures ? `\n${failures} failure(s)` : '\nAll good');
process.exit(failures ? 1 : 0);
