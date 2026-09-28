import assert from 'node:assert/strict';
import { test } from 'node:test';
import { trainEnsemble, trainNet } from '../src/nn.js';
import { mulberry32 } from '../src/rng.js';

// XOR of two ±1 inputs, repeated with a little noise.
function xorData(n = 200) {
  const rand = mulberry32(7);
  const X = new Float64Array(n * 2);
  const y = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const a = rand() < 0.5 ? -1 : 1;
    const b = rand() < 0.5 ? -1 : 1;
    X[2 * i] = a + 0.1 * (rand() - 0.5);
    X[2 * i + 1] = b + 0.1 * (rand() - 0.5);
    y[i] = a !== b ? 1 : 0;
  }
  return { X, y, rows: Array.from({ length: n }, (_, i) => i) };
}

const accuracy = (p, y, rows) => rows.filter((i, r) => (p[r] >= 0.5 ? 1 : 0) === y[i]).length / rows.length;

test('hidden layer learns XOR; logistic regression cannot', () => {
  const { X, y, rows } = xorData();
  const net = trainNet(X, 2, y, rows, { hidden: 8, l2: 0, lr: 0.05, maxEpochs: 800, valFrac: 0, seed: 3 });
  assert.ok(accuracy(net.predict(X, rows), y, rows) > 0.97);
  const lr = trainNet(X, 2, y, rows, { hidden: 0, l2: 0, lr: 0.05, maxEpochs: 800, valFrac: 0, seed: 3 });
  assert.ok(accuracy(lr.predict(X, rows), y, rows) < 0.7);
});

test('logistic regression recovers a linear rule', () => {
  const rand = mulberry32(11);
  const n = 300;
  const X = new Float64Array(n * 3);
  const y = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < 3; j++) X[3 * i + j] = 2 * rand() - 1;
    y[i] = 2 * X[3 * i] - X[3 * i + 2] > 0 ? 1 : 0;
  }
  const rows = Array.from({ length: n }, (_, i) => i);
  const lr = trainNet(X, 3, y, rows, { hidden: 0, l2: 0, lr: 0.05, maxEpochs: 600, valFrac: 0 });
  assert.ok(accuracy(lr.predict(X, rows), y, rows) > 0.95);
});

test('training is deterministic for a given seed', () => {
  const { X, y, rows } = xorData(80);
  const a = trainEnsemble(X, 2, y, rows, { hidden: 4 }, [1, 2]).predict(X, rows);
  const b = trainEnsemble(X, 2, y, rows, { hidden: 4 }, [1, 2]).predict(X, rows);
  assert.deepEqual(Array.from(a), Array.from(b));
});
