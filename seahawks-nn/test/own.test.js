import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dayNumber, loadGames } from '../src/data.js';
import { scoreLedger } from '../src/ledger.js';
import { ATOM, BREAK_EVEN, buildRows, evaluateLattice, moonPhase, pickOf, scorePickRule, tzOf } from '../src/lab/own.js';

const games = loadGames();
const data = buildRows(games);

test('moon phase: known full and new moons', () => {
  const full = moonPhase(dayNumber('2024-01-25')); // full moon 2024-01-25 17:54 UTC
  const nu = moonPhase(dayNumber('2024-01-11')); // new moon 2024-01-11 11:57 UTC
  assert.ok(Math.abs(full - 0.5) < 0.04, `full ${full}`);
  assert.ok(Math.min(nu, 1 - nu) < 0.04, `new ${nu}`);
});

test('time zones follow relocations and Arizona time', () => {
  assert.equal(tzOf('SEA', 2020, 10), -3);
  assert.equal(tzOf('LA', 2015, 10), -1); // St. Louis
  assert.equal(tzOf('LA', 2016, 10), -3);
  assert.equal(tzOf('ARI', 2020, 10), -3); // daylight time in the East, same clock as the Pacific
  assert.equal(tzOf('ARI', 2020, 12), -2);
});

test('the two sides of a game mirror each other against the spread', () => {
  for (const g of data.games.filter((x) => x.played && x.spread !== null).slice(0, 2000)) {
    const [h, a] = g.rows;
    assert.equal(h.resid, -a.resid + 0); // + 0: a push is 0 on both sides, not -0
    assert.equal(h.cover, -a.cover + 0);
    assert.equal(h.spread, -a.spread + 0);
  }
  assert.ok(Math.abs(BREAK_EVEN - 0.5238) < 1e-3);
});

test('a lattice picks a side only when exactly one side fits', () => {
  const g = data.games.find((x) => x.played && x.spread !== null && x.div && !x.neutral);
  assert.equal(pickOf({ clauses: [{ atoms: ['home'], side: 'back' }] }, g), g.rows[0]);
  assert.equal(pickOf({ clauses: [{ atoms: ['home'], side: 'fade' }] }, g), g.rows[1]);
  assert.equal(pickOf({ clauses: [{ atoms: ['div'], side: 'back' }] }, g), null); // both sides fit
  assert.ok(ATOM.home.test(g.rows[0]) && !ATOM.home.test(g.rows[1]));
});

test('backing every home team: covers + non-covers = graded games', () => {
  const e = evaluateLattice(data, { clauses: [{ atoms: ['home'], side: 'back' }] });
  const graded = data.games.filter((g) => g.played && g.spread !== null && !g.neutral && g.season >= 1999 && g.season <= 2025 && g.rows[0].cover !== 0);
  assert.equal(e.all.n, graded.length);
  assert.equal(e.all.hits, graded.filter((g) => g.rows[0].cover === 1).length);
  assert.ok(e.all.rate > 0.45 && e.all.rate < 0.55);
});

test('history features only use earlier games', () => {
  const sea = data.byTeam.get('SEA');
  const r = sea.find((x) => x.game.date === '2024-09-15');
  assert.equal(r.prev.game.date, '2024-09-08');
  assert.equal(r.lastRes[0], r.prev.result);
  assert.equal(r.lag[7], r.prev.result);
});

test('the ledger scores pick lattices only after their registration date', () => {
  const rule = { id: 't', registered: '2025-12-31', type: 'pick', clauses: [{ atoms: ['home'], side: 'back' }] };
  const s = scorePickRule(data, rule);
  assert.ok(s.picks.every((p) => p.date > '2025-12-31'));
  const [scored] = scoreLedger(games, { rules: [rule] });
  assert.equal(scored.n, s.n);
  assert.ok(scored.description.startsWith('Back the side that is: home team'));
});
