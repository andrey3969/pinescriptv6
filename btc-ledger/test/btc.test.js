import assert from 'node:assert/strict';
import { test } from 'node:test';
import { binomUpper, callFor, directions, history, loadCloses, mergeNew, nextCall, parseCoinbase, parseKraken, scoreRule } from '../btc.js';

const rule = { id: 'fade-yesterday', registered: '2026-01-02', type: 'lag', lag: 1, reverse: true };
const day = (d, close) => ({ date: `2026-01-${String(d).padStart(2, '0')}`, close, source: 'test' });

test('directions compare each close with the previous calendar day', () => {
  const dirs = directions([day(1, 100), day(2, 101), day(3, 100), day(5, 99), day(6, 99)]);
  assert.equal(dirs.get('2026-01-02'), 1);
  assert.equal(dirs.get('2026-01-03'), -1);
  assert.equal(dirs.has('2026-01-05'), false); // Jan 4 missing
  assert.equal(dirs.has('2026-01-06'), false); // flat
});

test('fade yesterday calls the opposite of the day before', () => {
  const dirs = directions([day(1, 100), day(2, 101), day(3, 100)]);
  assert.equal(callFor(rule, dirs, '2026-01-03'), -1); // Jan 2 was up
  assert.equal(callFor(rule, dirs, '2026-01-04'), 1); // Jan 3 was down
  assert.equal(callFor({ ...rule, reverse: false }, dirs, '2026-01-04'), -1);
});

test('only days after the registration date are scored', () => {
  const rows = [day(1, 100), day(2, 101), day(3, 100), day(4, 102), day(5, 101), day(6, 103)];
  const s = scoreRule(rule, rows);
  assert.deepEqual(s.days.map((d) => d.date), ['2026-01-03', '2026-01-04', '2026-01-05', '2026-01-06']);
  assert.equal(s.hits, 4); // up, down, up, down, up: every day reversed the one before
  assert.equal(history(rule, rows, [['2026-01-01', '2026-01-31']])[0].n, 0); // Jan 2 needs Dec 31
  assert.deepEqual(nextCall(rule, rows), { date: '2026-01-07', call: -1 });
});

test('new closes: complete days only, parsed from Coinbase or Kraken', () => {
  const cb = parseCoinbase([[Date.parse('2026-01-07T00:00:00Z') / 1000, 1, 2, 1.5, 104, 9]]);
  assert.deepEqual(cb, [{ date: '2026-01-07', close: 104 }]);
  const kr = parseKraken({ error: [], result: { XXBTZUSD: [[Date.parse('2026-01-08T00:00:00Z') / 1000, '1', '2', '1', '105.5', '1', '1', 1]], last: 0 } });
  assert.deepEqual(kr, [{ date: '2026-01-08', close: 105.5 }]);
  const rows = mergeNew([day(6, 103)], [...cb, ...kr, { date: '2026-01-09', close: 1 }], 'coinbase', '2026-01-09');
  assert.deepEqual(rows.map((r) => r.date), ['2026-01-06', '2026-01-07', '2026-01-08']);
});

test('binomial tail and the stored history', () => {
  assert.ok(Math.abs(binomUpper(8, 10, 0.5) - 56 / 1024) < 1e-12);
  const rows = loadCloses();
  assert.ok(rows.length > 5000);
  const [early, late] = history({ ...rule, registered: '2026-09-28' }, rows, [['2011-01-01', '2018-12-31'], ['2019-01-01', '2026-09-28']]);
  assert.ok(Math.abs(early.hits / early.n - 0.495) < 0.005);
  assert.ok(Math.abs(late.hits / late.n - 0.53) < 0.005);
});
