import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCsv, toCsv } from '../src/csv.js';
import { allTeams, dayNumber, isoDate, loadGames, teamSchedule, weekdayName } from '../src/data.js';

test('csv handles quotes, commas and escaped quotes', () => {
  const rows = parseCsv('a,b\r\n1,"x, y"\n2,"say ""hi"""\n3,\n');
  assert.deepEqual(rows, [
    { a: '1', b: 'x, y' },
    { a: '2', b: 'say "hi"' },
    { a: '3', b: '' },
  ]);
  assert.deepEqual(parseCsv(toCsv(rows, ['a', 'b'])), rows);
});

test('calendar helpers', () => {
  assert.equal(weekdayName(dayNumber('1970-01-01')), 'Thu');
  assert.equal(weekdayName(dayNumber('2026-09-27')), 'Sun');
  assert.equal(weekdayName(dayNumber('2024-10-10')), 'Thu');
  assert.equal(dayNumber('2025-01-05') - dayNumber('2024-12-08'), 28);
  assert.equal(isoDate(dayNumber('2000-02-29')), '2000-02-29');
});

const games = loadGames();
const sea = teamSchedule(games, 'SEA');

test('bundled data: 32 franchises and known Seattle seasons', () => {
  assert.equal(allTeams(games).length, 32);
  const record = (season, post) => {
    const g = sea.filter((x) => x.season === season && (x.gameType !== 'REG') === post);
    return [g.filter((x) => x.result === 1).length, g.filter((x) => x.result === -1).length];
  };
  assert.deepEqual(record(2013, false), [13, 3]);
  assert.deepEqual(record(2013, true), [3, 0]); // Super Bowl XLVIII
  assert.deepEqual(record(2008, false), [4, 12]);
  assert.ok(sea.some((g) => g.season === 2016 && g.result === 0), '2016 tie with Arizona');
});

test('spread is from the team perspective', () => {
  const at = (date) => sea.find((g) => g.date === date);
  assert.equal(at('2026-09-27').spread, 8.5); // SEA favored at WAS, lost 31-33
  assert.equal(at('2026-09-27').result, -1);
  assert.equal(at('2026-09-27').home, -1);
  assert.equal(at('2026-10-04').spread, 6.5); // vs LAC, not played in the bundled data
});
