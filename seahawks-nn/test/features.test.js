import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadGames, teamSchedule } from '../src/data.js';
import { FEATURE_SETS, buildMatrix } from '../src/features.js';
import { walkForward } from '../src/models.js';

const sea = teamSchedule(loadGames(), 'SEA');
const base = sea.map((g) => g.result);

test('no leakage: a game\'s inputs never depend on its own or later results', () => {
  for (const set of Object.keys(FEATURE_SETS)) {
    const ref = buildMatrix(sea, base, set);
    for (const i of [0, 1, 17, 150, 300, 460]) {
      const flipped = base.map((r, j) => (j >= i && r !== null ? -r || 1 : r));
      const alt = buildMatrix(sea, flipped, set);
      const row = (m) => Array.from(m.X.subarray(i * m.D, (i + 1) * m.D));
      assert.deepEqual(row(alt), row(ref), `${set} row ${i} changed`);
    }
  }
});

test('calendar lags point at the right games', () => {
  const m = buildMatrix(sea, base, 'lattice');
  const i = sea.findIndex((g) => g.date === '2025-12-28');
  const col = (name) => m.X[i * m.D + m.names.indexOf(name)];
  assert.equal(col('day_lag28'), 1); // 2025-11-30, win
  assert.equal(col('day_lag10'), 1); // 2025-12-18 (Thu), win
  assert.equal(col('day_lag9'), 0); // no game
  assert.equal(col('game_lag1'), 1);
  assert.equal(col('weekday_Sun'), 1);
});

test('walk-forward never trains on the season it predicts', () => {
  // Synthetic team: loses every game until 2010, then wins every game.
  const seq = sea.filter((g) => g.season <= 2012).map((g) => ({ ...g, result: g.season >= 2010 ? 1 : -1 }));
  const { preds, testRows } = walkForward({ seq, models: ['always_win'], testFrom: 2010, testTo: 2010, seeds: [1] });
  assert.ok(testRows.length > 0);
  for (const i of testRows) assert.ok(preds.always_win[i] < 0.5, 'saw 2010 wins before predicting 2010');
});
