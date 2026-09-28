import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadGames, teamSchedule } from '../src/data.js';
import { mulberry32, shuffleWithinSeason } from '../src/rng.js';
import { RULES, ruleCall, ruleCases, ruleInputs } from '../src/rules.js';
import { gapStructure, intervalScan } from '../src/scan.js';

const sea = teamSchedule(loadGames(), 'SEA');
const base = sea.map((g) => g.result);
const at = (date) => sea.findIndex((g) => g.date === date);

test('within-season shuffle keeps every season record', () => {
  const shuffled = shuffleWithinSeason(sea, base, mulberry32(5));
  const tally = (res) => {
    const t = {};
    sea.forEach((g, i) => {
      const k = `${g.season}:${res[i]}`;
      t[k] = (t[k] ?? 0) + 1;
    });
    return t;
  };
  assert.deepEqual(tally(shuffled), tally(base));
  assert.notDeepEqual(shuffled, base);
});

test('28/10 rule on 1999-2025 reproduces the hand count', () => {
  const cases = ruleCases(sea, RULES.rule_28_10, { from: 1999, to: 2025 });
  assert.equal(cases.length, 11);
  assert.equal(cases.filter((c) => sea[c.older].result === sea[c.game].result).length, 10);
  const fired = cases.filter((c) => c.call !== null);
  assert.equal(fired.length, 8);
  assert.ok(fired.every((c) => c.hit));
  assert.equal(ruleCall(base, ruleInputs(sea, at('2025-01-05'), RULES.rule_28_10)), 1);
});

test('10-day, 4th-previous rule: the 2015 hit, the 2014 miss, and the same-season variant', () => {
  const rule = RULES.rule_gap10_k4;
  // 2015-10-05 (Mon) W ... 2015-10-22 (Thu) W -> 2015-11-01 W, a 27-day span
  const inputs = ruleInputs(sea, at('2015-11-01'), rule);
  assert.deepEqual(inputs.map((i) => sea[i].date), ['2015-10-05', '2015-10-22']);
  assert.equal(ruleCall(base, inputs), 1);
  // Jan 11 2014 playoff W and Sep 4 2014 W called a win; Sep 14 2014 at San Diego was a loss
  const miss = ruleInputs(sea, at('2014-09-14'), rule);
  assert.deepEqual(miss.map((i) => sea[i].date), ['2014-01-11', '2014-09-04']);
  assert.equal(sea[at('2014-09-14')].result, -1);
  assert.equal(ruleInputs(sea, at('2014-09-14'), { ...rule, sameSeason: true }), null);

  const record = (r) => {
    const fired = ruleCases(sea, r, { from: 1999, to: 2025 }).filter((c) => c.hit !== null);
    return [fired.filter((c) => c.hit).length, fired.length];
  };
  assert.deepEqual(record(rule), [9, 10]);
  assert.deepEqual(record({ ...rule, sameSeason: true }), [9, 9]);
});

test('scan corrects both rule families for the search', () => {
  const s = intervalScan(sea, { from: 1999, to: 2025, nPerm: 200, pairs: false });
  assert.equal(s.focus.hits, 8);
  assert.equal(s.focus.n, 8);
  assert.ok(s.focus.p < 0.01);
  assert.ok(s.focus.pFamily > s.focus.p);
  assert.ok(s.focus.pBoth >= s.focus.pFamily);
  const [asWritten, sameSeason] = s.order.focus;
  assert.deepEqual([asWritten.hits, asWritten.n], [9, 10]);
  assert.deepEqual([sameSeason.hits, sameSeason.n], [9, 9]);
  assert.deepEqual(s.order.positions.find((p) => p.k === 4).same, { n: 9, hits: 9 });
  assert.ok(sameSeason.pBoth > sameSeason.p);
  assert.equal(s.combinedRules, s.rulesTested + s.order.rulesTested);
});

test('back-to-back gaps follow the weekday grid', () => {
  const gaps = new Map(gapStructure(sea, { from: 1999, to: 2025 }).map((g) => [g.gap, g]));
  assert.ok(gaps.get(4).moves.every((m) => m.move === 'Sun -> Thu'));
  assert.ok(gaps.get(10).moves.every((m) => m.move === 'Thu -> Sun'));
  assert.ok(gaps.get(7).n > 250);
});

test('lag rules repeat or reverse the game exactly d days before', () => {
  const games = loadGames();
  const sea = teamSchedule(games, 'SEA');
  const base = sea.map((g) => g.result);
  const j = sea.findIndex((g) => g.date === '2024-10-27'); // 21 days after 2024-10-06 (a loss)
  const inputs = ruleInputs(sea, j, { type: 'lag', lag: 21 });
  assert.equal(sea[inputs[0]].date, '2024-10-06');
  assert.equal(ruleCall(base, inputs, { type: 'lag', lag: 21 }), -1);
  assert.equal(ruleCall(base, inputs, { type: 'lag', lag: 21, reverse: true }), 1);
  const cases = ruleCases(sea, { type: 'lag', lag: 21, reverse: true }, { from: 2024, to: 2024 }).filter((c) => c.hit !== null);
  assert.equal(cases.length, 8); // the handwritten 2024 page: 8 pairs, 6 reversals
  assert.equal(cases.filter((c) => c.hit).length, 6);
});
