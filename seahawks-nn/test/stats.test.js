import assert from 'node:assert/strict';
import { test } from 'node:test';
import { benjaminiHochberg, binomTwoSided, binomUpper, empiricalP, mcnemar, quantile, wilson } from '../src/stats.js';

const close = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b}`);

test('exact binomial tails', () => {
  close(binomTwoSided(8, 8, 0.5), 2 / 256);
  close(binomTwoSided(9, 10, 0.5), (2 * 11) / 1024);
  close(binomTwoSided(5, 10, 0.5), 1);
  close(binomUpper(0, 7, 0.3), 1);
});

test('wilson interval matches reference values', () => {
  const [lo, hi] = wilson(8, 8);
  close(lo, 0.6756, 1e-4);
  close(hi, 1);
  const [lo2, hi2] = wilson(50, 100);
  close(lo2, 0.4038, 1e-4);
  close(hi2, 0.5962, 1e-4);
});

test('benjamini-hochberg q-values', () => {
  const q = benjaminiHochberg([0.01, 0.04, 0.03, 0.2]);
  [0.04, 0.16 / 3, 0.16 / 3, 0.2].forEach((v, k) => close(q[k], v));
});

test('empirical p never reports zero', () => {
  close(empiricalP([0.1, 0.2, 0.3], (x) => x > 5), 1 / 4);
  close(empiricalP([1, 2, 3], (x) => x >= 2), 3 / 4);
});

test('mcnemar and quantile', () => {
  close(mcnemar(0, 0), 1);
  close(mcnemar(10, 0), 2 / 1024);
  close(quantile([1, 2, 3, 4, 5], 0.5), 3);
  close(quantile([1, 2], 0.25), 1.25);
});
