import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dayNumber, loadGames, weekdayName } from '../src/data.js';
import { nullGenerators, prepare } from '../src/lab/engine.js';
import { runFamilyTests } from '../src/lab/familytest.js';
import { FAMILIES, lagItem } from '../src/lab/families.js';
import { lassoFit, ridgeFit } from '../src/lab/ml.js';
import { seasonLags } from '../src/lab/seasons.js';
import { VALUE_FAMILIES, lz76 } from '../src/lab/spectral.js';
import { mulberry32 } from '../src/rng.js';

const games = loadGames();

// A toy schedule: one game a week, one season, results as given.
const toy = (results, start = '2020-09-13') =>
  results.map((r, k) => ({ season: 2020, day: dayNumber(start) + 7 * k, result: r }));

test('day-lag family counts same-result pairs exactly d days apart', () => {
  const seq = toy([1, 1, -1, 1, -1, -1]);
  const rows = seq.map((_, i) => i);
  const f = FAMILIES.calLag;
  const { n, hits } = f.count(f.build(seq, rows, 2020), seq.map((g) => g.result), f.size());
  // 7 days apart: (W,W) (W,L) (L,W) (W,L) (L,L) -> 5 pairs, 2 the same
  assert.equal(n[lagItem(7)], 5);
  assert.equal(hits[lagItem(7)], 2);
  // 14 days apart: (W,L) (W,W) (L,L) (W,L) -> 4 pairs, 2 the same
  assert.equal(n[lagItem(14)], 4);
  assert.equal(hits[lagItem(14)], 2);
  assert.equal(f.describe(lagItem(1764)), '1764 days apart');
});

test('streak family: win rate after each pattern, oldest result first', () => {
  const seq = toy([1, -1, 1, -1, 1, 1]);
  const rows = seq.map((_, i) => i);
  const f = FAMILIES.markov;
  const { n, hits } = f.count(f.build(seq, rows, 2020), seq.map((g) => g.result), f.size());
  const id = (label) => Array.from({ length: f.size() }, (_, i) => i).find((i) => f.describe(i) === label);
  // after an L (games 2, 4, 6 follow a loss... game indices 2 and 4): both wins
  assert.equal(n[id('after L')], 2);
  assert.equal(hits[id('after L')], 2);
  // after W-L (a win, then a loss): games 3 and 5, both wins
  assert.equal(n[id('after W-L')], 2);
  assert.equal(hits[id('after W-L')], 2);
  assert.equal(n[id('after L-W')], 2); // games 4 and 6: a loss then a win
  assert.equal(hits[id('after L-W')], 1);
});

test('phase family: day mod 7 names the real weekday', () => {
  const f = FAMILIES.modular;
  const sunday = dayNumber('2025-09-07');
  assert.equal(weekdayName(sunday), 'Sun');
  const seq = [{ season: 2025, day: sunday, result: 1 }];
  const cases = f.build(seq, [0], 2025);
  const ids = [];
  for (let c = 1; c < cases.length; c += 2) ids.push(cases[c]);
  const label = ids.map((i) => f.describe(i)).find((s) => s.includes('day mod 7'));
  assert.equal(label, 'Sun games (day mod 7)');
});

test('Lempel-Ziv complexity matches the textbook example', () => {
  assert.equal(lz76([0, 0, 0, 1, 1, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 1]), 6);
  assert.equal(lz76([0, 0, 0, 0, 0, 0, 0, 0]), 2);
});

test('an alternating W/L sequence peaks at a 2-game cycle', () => {
  const seq = toy(Array.from({ length: 16 }, (_, k) => (k % 2 ? -1 : 1)));
  const f = VALUE_FAMILIES.specGame;
  const power = f.value(f.build(seq, seq.map((_, i) => i)), seq.map((g) => g.result));
  const best = power.indexOf(Math.max(...power));
  assert.equal(f.describe(best), 'cycle every 2.00 games');
});

test('null histories keep what they promise', () => {
  const ctx = prepare(games, { families: [] });
  const gen = nullGenerators(ctx);
  assert.ok(gen.bWithin > 0.05 && gen.bWithin < ctx.market.b, `within-season slope ${gen.bWithin}`);
  const base = gen.real();
  const record = (res, t) => {
    const m = new Map();
    ctx.schedules[t].forEach((g, i) => m.set(g.season, (m.get(g.season) ?? 0) + (res[t][i] === 1)));
    return [...m.values()].join(',');
  };
  for (const kind of ['shuffle', 'spread']) {
    const res = gen[kind](3);
    for (const t of [0, 13, 31]) assert.equal(record(res, t), record(base, t), `${kind} keeps season records`);
  }
  // market replays keep the two sides of a game consistent
  const res = gen.market(3);
  const t = ctx.teams.indexOf('SEA');
  const u = ctx.teams.indexOf('SF');
  const g = ctx.schedules[t].findIndex((x) => x.opp === 'SF' && x.result !== null && x.result !== 0);
  const h = ctx.schedules[u].findIndex((x) => x.gameId === ctx.schedules[t][g].gameId);
  assert.equal(res[t][g], -res[u][h]);
});

test('the family engine returns calibrated-looking output on pure noise', async () => {
  const L = await runFamilyTests(games, {
    opts: { reps: 12, families: ['orderLag', 'lz'] },
    workers: 2,
    kinds: ['shuffle'],
    placebo: { kind: 'shuffle', rep: 777 },
  });
  const f = L.summary.families.orderLag.nulls.shuffle;
  assert.equal(f.teams.perTeam.length, 32);
  assert.equal(f.pooled.z.length, 40);
  for (const p of [f.pooled.max.p, f.pooled.meanZ2.p, ...f.teams.perTeam.map((x) => x.p)]) assert.ok(p > 0 && p <= 1);
  assert.equal(L.item('lz', 'shuffle', 'SEA', 0).label, 'LZ complexity');
});

test('ridge and lasso logistic fits recover a planted signal', () => {
  const rand = mulberry32(5);
  const n = 3000;
  const D = 6;
  const X = new Float64Array(n * D);
  const y = new Uint8Array(n);
  const ptr = new Int32Array(n + 1);
  const col = [];
  const val = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < D; j++) X[i * D + j] = rand() < 0.5 ? -1 : 1;
    const z = 1.2 * X[i * D] - 0.8 * X[i * D + 1];
    y[i] = rand() < 1 / (1 + Math.exp(-z)) ? 1 : 0;
    for (let j = 0; j < D; j++) {
      col.push(j);
      val.push(X[i * D + j]);
    }
    ptr[i + 1] = col.length;
  }
  const A = { n, ptr, col: Int32Array.from(col), val: Float64Array.from(val) };
  const w = ridgeFit(A, D, y, 1);
  assert.ok(Math.abs(w[0] - 1.2) < 0.15 && Math.abs(w[1] + 0.8) < 0.15, `ridge ${Array.from(w)}`);
  const l = lassoFit(A, D, y, 0.02);
  assert.ok(l[0] > 0.8 && l[1] < -0.4, `lasso ${Array.from(l)}`);
  assert.ok([2, 3, 4, 5].every((j) => Math.abs(l[j]) < 0.05), 'lasso drops the noise inputs');
});

test('season win rates persist from one year to the next', () => {
  const s = seasonLags(games, { permReps: 300, marketReps: 20 });
  const lag1 = s.lags[0];
  assert.ok(lag1.r > 0.1 && lag1.perm.p < 0.01, `lag-1 r ${lag1.r}`);
  assert.equal(s.lags.length, 26);
  assert.equal(s.team.pairs.find((p) => p.lag === 23).pairs.length, 4);
});

test('a planted lattice is really in the history the engine sees', () => {
  const ctx = prepare(games, { families: ['lz'], plant: { rule: { type: 'lag', d: 7 }, q: 1, teams: ['SEA'], seed: 3 } });
  const seq = ctx.schedules[ctx.teams.indexOf('SEA')];
  const byDay = new Map(seq.map((g, i) => [g.day, i]));
  let pairs = 0;
  seq.forEach((g, j) => {
    const i = byDay.get(g.day - 7);
    if (i === undefined || g.season > 2025 || Math.abs(g.result) !== 1 || Math.abs(seq[i].result) !== 1) return;
    pairs++;
    assert.equal(g.result, seq[i].result);
  });
  assert.ok(pairs > 200, `${pairs} planted pairs`);
});
