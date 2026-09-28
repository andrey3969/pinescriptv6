import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadGames, teamSchedule } from '../src/data.js';
import { scoreLedger } from '../src/ledger.js';
import { upcomingRuleCalls } from '../src/predict.js';

const games = loadGames();
const sea = teamSchedule(games, 'SEA');

// 2026 as of 2026-09-27, optionally with the Oct 15 game at Denver decided.
function asOfSept27(denver = null) {
  return sea.map((g) => {
    if (g.date === '2026-10-15') return { ...g, result: denver };
    return g.date > '2026-09-27' ? { ...g, result: null } : g;
  });
}

test('both named rules get one 2026 regular-season chance, on the same two games', () => {
  const calls = upcomingRuleCalls(asOfSept27()).filter((u) => u.game.gameType === 'REG');
  assert.deepEqual(calls.map((u) => u.rule).sort(), ['rule_28_10', 'rule_gap10_k4']);
  for (const u of calls) {
    assert.equal(u.game.date, '2026-10-25');
    assert.equal(u.game.opp, 'KC');
    assert.equal(u.older.date, '2026-09-27');
    assert.equal(u.newer.date, '2026-10-15');
    assert.match(u.status, /^If the Thu 2026-10-15 game @ DEN is also a loss, the rule calls a loss/);
  }
});

test('the Oct 25 call resolves once the Denver game is played', () => {
  const kc = (seq) => upcomingRuleCalls(seq).find((u) => u.game.date === '2026-10-25');
  assert.equal(kc(asOfSept27(-1)).status, 'The rule calls a loss.');
  assert.equal(kc(asOfSept27(1)).status, 'No call: the two results disagree.');
});

test('the ledger only scores games after a rule was written down', () => {
  const rule = { id: 't', team: 'SEA', type: 'calendar', d1: 28, d2: 10 };
  const [early] = scoreLedger(games, { rules: [{ ...rule, registered: '2024-01-01' }] });
  assert.ok(early.calls.every((c) => c.game.date > '2024-01-01'));
  const scored = early.calls.filter((c) => c.hit !== null && c.game.date < '2026-01-01');
  assert.deepEqual(scored.map((c) => c.game.date), ['2025-01-05', '2025-12-28']);
  assert.ok(scored.every((c) => c.hit));
  const [late] = scoreLedger(games, { rules: [{ ...rule, registered: '2026-09-28' }] });
  assert.ok(late.calls.length > 0);
  assert.ok(late.calls.every((c) => c.game.date > '2026-09-28'));
});
