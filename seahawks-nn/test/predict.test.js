import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadGames, teamSchedule } from '../src/data.js';
import { upcomingRuleCalls } from '../src/predict.js';

const sea = teamSchedule(loadGames(), 'SEA');

// 2026 as of 2026-09-27, optionally with the Oct 15 game at Denver decided.
function asOfSept27(denver = null) {
  return sea.map((g) => {
    if (g.date === '2026-10-15') return { ...g, result: denver };
    return g.date > '2026-09-27' ? { ...g, result: null } : g;
  });
}

test('the 28/10 rule has one 2026 regular-season chance: Oct 25 vs KC', () => {
  const calls = upcomingRuleCalls(asOfSept27()).filter((u) => u.game.gameType === 'REG');
  assert.equal(calls.length, 1);
  const [u] = calls;
  assert.equal(u.game.date, '2026-10-25');
  assert.equal(u.game.opp, 'KC');
  assert.equal(u.first.date, '2026-09-27');
  assert.equal(u.middle.date, '2026-10-15');
  assert.match(u.status, /^If the Thu 2026-10-15 game @ DEN is also a loss, the rule calls a loss/);
});

test('the Oct 25 call resolves once the Denver game is played', () => {
  const kc = (seq) => upcomingRuleCalls(seq).find((u) => u.game.date === '2026-10-25');
  assert.equal(kc(asOfSept27(-1)).status, 'The rule calls a loss.');
  assert.equal(kc(asOfSept27(1)).status, 'No call: the two lookback results disagree.');
});
