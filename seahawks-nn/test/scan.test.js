import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadGames, teamSchedule } from '../src/data.js';
import { lookbackRule } from '../src/models.js';
import { mulberry32, shuffleWithinSeason } from '../src/rng.js';
import { gapStructure, intervalScan, lookbackCases } from '../src/scan.js';

const sea = teamSchedule(loadGames(), 'SEA');
const base = sea.map((g) => g.result);

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
  const cases = lookbackCases(sea, { from: 1999, to: 2025 });
  assert.equal(cases.length, 11);
  assert.equal(cases.filter((c) => sea[c.first].result === sea[c.game].result).length, 10);
  const fired = cases.filter((c) => c.agree);
  assert.equal(fired.length, 8);
  assert.ok(fired.every((c) => c.hit));
  const jan5 = sea.findIndex((g) => g.date === '2025-01-05');
  assert.equal(lookbackRule(sea, base, jan5), 1);
});

test('scan finds the 28/10 rule and corrects it for the search', () => {
  const s = intervalScan(sea, { from: 1999, to: 2025, nPerm: 200, pairs: false });
  assert.equal(s.focus.hits, 8);
  assert.equal(s.focus.n, 8);
  assert.ok(s.focus.p < 0.01);
  assert.ok(s.focus.pFamily > s.focus.p);
  assert.ok(s.rulesTested > 50);
});

test('back-to-back gaps follow the weekday grid', () => {
  const gaps = new Map(gapStructure(sea, { from: 1999, to: 2025 }).map((g) => [g.gap, g]));
  assert.ok(gaps.get(4).moves.every((m) => m.move === 'Sun -> Thu'));
  assert.ok(gaps.get(10).moves.every((m) => m.move === 'Thu -> Sun'));
  assert.ok(gaps.get(7).n > 250);
});
