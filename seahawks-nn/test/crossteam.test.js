import assert from 'node:assert/strict';
import { test } from 'node:test';
import { equalGaps, fitMarket, ruleOnTeams } from '../src/crossteam.js';
import { loadGames, teamSchedule } from '../src/data.js';
import { ruleInputs } from '../src/rules.js';

const games = loadGames();

test('the point spread maps to sensible win probabilities', () => {
  const market = fitMarket(games);
  assert.ok(market.prob(7) > 0.68 && market.prob(7) < 0.78, `7-point favorite: ${market.prob(7)}`);
  assert.equal(market.prob(0), 0.5);
  assert.ok(Math.abs(market.prob(3) + market.prob(-3) - 1) < 1e-12);
});

test('a game-order rule with gap 0 applies after any gap', () => {
  const sea = teamSchedule(games, 'SEA');
  const j = sea.findIndex((g) => g.date === '2024-09-15'); // 7 days after the opener
  assert.equal(ruleInputs(sea, j, { type: 'order', gap: 10, k: 2 }), null);
  assert.deepEqual(ruleInputs(sea, j, { type: 'order', gap: 0, k: 2 }), [j - 2, j - 1]);
});

test('6 x 3 = 18-day stretches: one in the league through 2025 (Baltimore, 2020)', () => {
  const e = equalGaps(games, { teams: ['BAL', 'SEA', 'KC'], gap: 6, count: 3, from: 1999, to: 2025, nPerm: 20 });
  assert.equal(e.stretches, 1);
});

test('a rule applied to other teams is scored against shuffles and the market', () => {
  const r = ruleOnTeams(games, { type: 'calendar', d1: 28, d2: 10 }, { teams: ['KC', 'NE'], from: 1999, to: 2025, nPerm: 50, market: fitMarket(games) });
  assert.ok(r.n > 0 && r.hits <= r.n);
  assert.ok(r.marketExpected > 0 && r.marketExpected < r.n);
  assert.ok(r.pShuffle > 0 && r.pShuffle <= 1);
});
