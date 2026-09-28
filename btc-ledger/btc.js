#!/usr/bin/env node
// Forward ledger for Bitcoin up/down rules. Each rule is written down on a
// date (ledger.json) and scored only on days after that date, so it cannot
// have been fitted to the days it is judged on.
//
// A day's direction is its close against the previous day's close, where a
// day's close is the BTC-USD price at 00:00 UTC at the end of that day (the
// convention of Coin Metrics' daily price and of exchange daily candles).
//
//   node btc.js update    append new daily closes (Coinbase, else Kraken)
//   node btc.js           score every rule on the days after its date
//   node btc.js today     the next call of every rule
//   node btc.js history   how each rule did before it was written down
//
// Zero dependencies; Node 18+ (update uses the built-in fetch).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DATA_FILE = join(HERE, 'data', 'btc-daily.csv');
export const LEDGER_FILE = join(HERE, 'ledger.json');
// Buying a 50-cent contract with Kalshi's standard fee (about 1.75 cents per
// contract at 50 cents) needs this win rate just to break even.
export const BREAK_EVEN = 0.5175;
const DAY = 86_400_000;

export const addDays = (iso, k) => new Date(Date.parse(`${iso}T00:00:00Z`) + k * DAY).toISOString().slice(0, 10);

export function loadCloses(file = DATA_FILE) {
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .slice(1)
    .map((line) => {
      const [date, close, source] = line.split(',');
      return { date, close: Number(close), source };
    });
}

export function saveCloses(rows, file = DATA_FILE) {
  writeFileSync(file, `date,close,source\n${rows.map((r) => `${r.date},${r.close},${r.source}`).join('\n')}\n`);
}

// date -> +1 (up) / -1 (down) against the previous calendar day; flat days are left out.
export function directions(rows) {
  const byDate = new Map(rows.map((r) => [r.date, r.close]));
  const out = new Map();
  for (const r of rows) {
    const prev = byDate.get(addDays(r.date, -1));
    if (prev === undefined) continue;
    const d = Math.sign(r.close - prev);
    if (d) out.set(r.date, d);
  }
  return out;
}

// A lag rule calls day D from the direction of day D - lag: the same
// direction, or the opposite when `reverse` is set ("fade yesterday").
export function callFor(rule, dirs, date) {
  const d = dirs.get(addDays(date, -rule.lag));
  if (d === undefined) return null;
  return rule.reverse ? -d : d;
}

function score(rule, rows, keep) {
  const dirs = directions(rows);
  const days = [];
  for (const r of rows) {
    if (!keep(r.date)) continue;
    const call = callFor(rule, dirs, r.date);
    const actual = dirs.get(r.date);
    if (call === null || actual === undefined) continue;
    days.push({ date: r.date, call, actual, hit: call === actual });
  }
  return { days, n: days.length, hits: days.filter((d) => d.hit).length };
}

// Forward record: only days after the rule was written down.
export const scoreRule = (rule, rows) => score(rule, rows, (date) => date > rule.registered);

// Before the rule was written down, by period (context only: these are the
// days the rule was chosen from).
export function history(rule, rows, periods) {
  return periods.map(([from, to]) => ({ from, to, ...score(rule, rows, (d) => d >= from && d <= to && d <= rule.registered) }));
}

export function nextCall(rule, rows) {
  const date = addDays(rows.at(-1).date, 1);
  return { date, call: callFor(rule, directions(rows), date) };
}

// P(X >= k) for X ~ Binomial(n, p).
export function binomUpper(k, n, p) {
  if (k <= 0) return 1;
  let logC = 0;
  let total = 0;
  for (let i = 0; i <= n; i++) {
    if (i > 0) logC += Math.log(n - i + 1) - Math.log(i);
    if (i >= k) total += Math.exp(logC + i * Math.log(p) + (n - i) * Math.log1p(-p));
  }
  return Math.min(1, total);
}

// ---- fetching new closes -----------------------------------------------------
// Coinbase candles: [time, low, high, open, close, volume], time = start of the day (UTC).
export const parseCoinbase = (json) =>
  json.map(([t, , , , close]) => ({ date: new Date(t * 1000).toISOString().slice(0, 10), close }));
// Kraken OHLC: { result: { XXBTZUSD: [[time, open, high, low, close, ...]] } }.
export function parseKraken(json) {
  const key = Object.keys(json.result).find((k) => k !== 'last');
  return json.result[key].map(([t, , , , close]) => ({ date: new Date(t * 1000).toISOString().slice(0, 10), close: Number(close) }));
}

// Complete days after the last stored close (the current UTC day is still open).
export function mergeNew(rows, fresh, source, today = new Date().toISOString().slice(0, 10)) {
  const last = rows.at(-1).date;
  const add = new Map();
  for (const r of fresh) if (r.date > last && r.date < today && Number.isFinite(r.close)) add.set(r.date, r.close);
  return [...rows, ...[...add].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, close]) => ({ date, close, source }))];
}

async function fetchCoinbase(since, today) {
  const out = [];
  for (let start = since; start < today; start = addDays(start, 290)) {
    const end = addDays(start, 290) < today ? addDays(start, 290) : today;
    const url = `https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=86400&start=${start}T00:00:00Z&end=${end}T00:00:00Z`;
    const res = await fetch(url, { headers: { 'User-Agent': 'btc-ledger' } });
    if (!res.ok) throw new Error(`Coinbase ${res.status}`);
    out.push(...parseCoinbase(await res.json()));
  }
  return out;
}

async function fetchKraken(since) {
  const res = await fetch(`https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=1440&since=${Date.parse(`${since}T00:00:00Z`) / 1000}`);
  if (!res.ok) throw new Error(`Kraken ${res.status}`);
  const json = await res.json();
  if (json.error?.length) throw new Error(`Kraken ${json.error.join(', ')}`);
  return parseKraken(json);
}

// ---- command line --------------------------------------------------------------
const pct = (x) => `${(100 * x).toFixed(1)}%`;
const word = (d) => (d === 1 ? 'UP' : 'DOWN');

async function main(cmd = 'score') {
  const ledger = JSON.parse(readFileSync(LEDGER_FILE, 'utf8'));
  let rows = loadCloses();
  if (cmd === 'update') {
    const today = new Date().toISOString().slice(0, 10);
    const since = addDays(rows.at(-1).date, 1);
    let fresh = null;
    let source = null;
    for (const [name, get] of [['coinbase', () => fetchCoinbase(since, today)], ['kraken', () => fetchKraken(since)]]) {
      try {
        fresh = await get();
        source = name;
        break;
      } catch (e) {
        console.error(`${name}: ${e.message}`);
      }
    }
    if (!fresh) {
      console.error('No price source reachable; nothing added.');
      process.exitCode = 1;
      return;
    }
    const before = rows.length;
    rows = mergeNew(rows, fresh, source, today);
    saveCloses(rows);
    console.log(`Added ${rows.length - before} daily closes from ${source}; data now runs to ${rows.at(-1).date}.`);
    return;
  }
  const last = rows.at(-1).date;
  for (const rule of ledger.rules) {
    console.log(`${rule.id} (written down ${rule.registered}): ${rule.text}`);
    if (cmd === 'today') {
      const { date, call } = nextCall(rule, rows);
      console.log(call === null ? `  No call yet for ${date}: the closes it needs are missing (run update).` : `  Call for ${date} (UTC day, settles at 00:00 UTC ${addDays(date, 1)}): ${word(call)}`);
      continue;
    }
    if (cmd === 'history') {
      for (const h of history(rule, rows, [['2011-01-01', '2018-12-31'], ['2019-01-01', rule.registered]])) {
        console.log(`  ${h.from.slice(0, 4)}-${h.to.slice(0, 4)}: ${h.hits}/${h.n} (${pct(h.hits / h.n)})`);
      }
      continue;
    }
    const s = scoreRule(rule, rows);
    if (!s.n) {
      console.log(`  No days scored yet: data runs to ${last}${last <= rule.registered ? ` (the first scored day is ${addDays(rule.registered, 1)}; run update)` : ''}.`);
      continue;
    }
    console.log(`  Forward record: ${s.hits}/${s.n} (${pct(s.hits / s.n)}), through ${s.days.at(-1).date}`);
    console.log(`  Chance of doing this well by luck (coin flip): p = ${binomUpper(s.hits, s.n, 0.5).toFixed(3)}; Kalshi break-even at 50 cents: ${pct(BREAK_EVEN)}`);
    for (const d of s.days.slice(-7)) console.log(`    ${d.date}: called ${word(d.call)}, went ${word(d.actual)} ${d.hit ? 'hit' : 'miss'}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv[2]).catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
}
