#!/usr/bin/env node
// How the fade-yesterday rule was found, and what its record is made of.
//
//   1. Repeat or reverse at every lag from 1 to 30 days, against histories in
//      which each calendar year's up and down days are dealt out in random
//      order (the year's up-rate kept): the reversal rate with its p-value, a
//      family-wise p over the 30 lags, a hold-out (the lean of 2011-2018
//      scored on the years after) and a carry-over (each year's lean applied
//      to the next year).
//   2. Up-rate by weekday, and following vs fading yesterday by era.
//   3. Fade yesterday split by side, by the size of yesterday's move, and by
//      year.
//
// Sections 1 and 2 step through consecutive non-flat days, as the original
// analysis did; section 3 uses calendar days, as the ledger does.
//
//   node analysis.js [shuffles]     (default 1,000; about 10 s)
import { addDays, directions, loadCloses } from './btc.js';

// Seeded PRNG and shuffle, the same as seahawks-nn/src/rng.js, so every p-value reproduces.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashSeed(...parts) {
  let h = 0x811c9dc5;
  for (const ch of parts.join('|')) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
function shuffleInPlace(arr, rand) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const REPS = Number(process.argv[2] ?? 1000);
const LAGS = Array.from({ length: 30 }, (_, i) => i + 1);
const SPLIT = 2018; // the hold-out learns on years up to this one
const pc = (x) => (Number.isFinite(x) ? `${(100 * x).toFixed(1)}%` : '  -  ');
const fp = (p) => (p < 0.001 ? '<.001' : p.toFixed(3));
const mean = (v) => v.reduce((a, b) => a + b, 0) / v.length;

const rows = loadCloses();

// ---- 1. every lag from 1 to 30 days --------------------------------------------
const days = [];
for (let k = 1; k < rows.length; k++) {
  if (rows[k].date < '2011-01-01') continue;
  const d = Math.sign(rows[k].close - rows[k - 1].close);
  if (d) days.push({ date: rows[k].date, year: Number(rows[k].date.slice(0, 4)), x: d, dow: new Date(`${rows[k].date}T00:00:00Z`).getUTCDay() });
}
const years = [...new Set(days.map((d) => d.year))];
const yearIndex = years.map((y) => days.flatMap((d, i) => (d.year === y ? [i] : [])));

function shuffled(rep) {
  const rand = mulberry32(hashSeed('btc', rep));
  const out = days.map((d) => d.x);
  for (const idx of yearIndex) {
    const vals = shuffleInPlace(idx.map((i) => out[i]), rand);
    idx.forEach((i, k) => (out[i] = vals[k]));
  }
  return out;
}

// per lag and year: pairs and reversals
function stats(x) {
  const out = new Map();
  for (const L of LAGS) {
    const byYear = new Map();
    for (let t = L; t < x.length; t++) {
      const e = byYear.get(days[t].year) ?? { n: 0, rev: 0 };
      e.n++;
      if (x[t] !== x[t - L]) e.rev++;
      byYear.set(days[t].year, e);
    }
    out.set(L, byYear);
  }
  return out;
}
function sum(byYear, keep = () => true) {
  let n = 0;
  let rev = 0;
  for (const [y, e] of byYear) {
    if (!keep(y)) continue;
    n += e.n;
    rev += e.rev;
  }
  return { n, rev };
}

// fixed reversal rate; the lean of the early years scored on the later ones; each year's lean carried to the next
function measures(x) {
  const st = stats(x);
  const m = {};
  for (const L of LAGS) {
    const by = st.get(L);
    const all = sum(by);
    const early = sum(by, (y) => y <= SPLIT);
    const late = sum(by, (y) => y > SPLIT);
    const lean = Math.sign(early.rev - early.n / 2);
    let cn = 0;
    let ch = 0;
    for (const y of years) {
      const a = by.get(y);
      const b = by.get(y + 1);
      if (!a || !b) continue;
      const l = Math.sign(a.rev - a.n / 2);
      if (!l) continue;
      cn += b.n;
      ch += l > 0 ? b.rev : b.n - b.rev;
    }
    m[L] = {
      rev: all.rev / all.n,
      n: all.n,
      holdout: lean ? (lean > 0 ? late.rev : late.n - late.rev) / late.n : NaN,
      holdN: late.n,
      carry: ch / cn,
      carryN: cn,
    };
  }
  return m;
}

const real = measures(days.map((d) => d.x));
const nulls = Array.from({ length: REPS }, (_, k) => measures(shuffled(k)));
// two-sided: how often a random history is at least as far from the random average
function pOf(get, L) {
  const v = nulls.map((m) => get(m[L])).filter(Number.isFinite);
  const mu = mean(v);
  const r = get(real[L]);
  return { mu, p: (1 + v.filter((z) => Math.abs(z - mu) >= Math.abs(r - mu) - 1e-12).length) / (1 + v.length) };
}
// family-wise over the 30 lags: the real |z| against each random history's largest |z|
const mus = {};
const sds = {};
for (const L of LAGS) {
  const v = nulls.map((m) => m[L].rev);
  mus[L] = mean(v);
  sds[L] = Math.sqrt(mean(v.map((z) => (z - mus[L]) ** 2)));
}
const absZ = (m, L) => Math.abs((m[L].rev - mus[L]) / sds[L]);
const maxNull = nulls.map((m) => Math.max(...LAGS.map((L) => absZ(m, L))));

const ups = days.filter((d) => d.x === 1).length;
console.log(`BTC daily up/down, ${days[0].date} to ${days.at(-1).date}: ${days.length} days, ${pc(ups / days.length)} up; ${REPS} random-order histories\n`);
console.log(`lag | reversed (random)      p   all 30 lags | lean of <=${SPLIT} scored after (random)     p | last year's lean carried (random)     p`);
for (const L of LAGS) {
  const a = pOf((m) => m.rev, L);
  const b = pOf((m) => m.holdout, L);
  const c = pOf((m) => m.carry, L);
  const fam = (1 + maxNull.filter((z) => z >= absZ(real, L) - 1e-9).length) / (1 + maxNull.length);
  console.log(
    `${String(L).padStart(3)} | ${pc(real[L].rev).padStart(6)} (${pc(a.mu)}) ${fp(a.p).padStart(6)}  ${fam.toFixed(2).padStart(10)} |` +
      ` ${pc(real[L].holdout).padStart(30)} (${pc(b.mu)}) ${fp(b.p).padStart(5)} | ${pc(real[L].carry).padStart(26)} (${pc(c.mu)}) ${fp(c.p).padStart(5)}`,
  );
}
for (const [key, nKey, name] of [
  ['holdout', 'holdN', `All 30 lags, lean of <=${SPLIT} scored after`],
  ['carry', 'carryN', "All 30 lags, last year's lean carried"],
]) {
  const pooled = (m) => {
    const ok = LAGS.filter((L) => Number.isFinite(m[L][key]));
    return ok.reduce((s, L) => s + m[L][key] * m[L][nKey], 0) / ok.reduce((s, L) => s + m[L][nKey], 0);
  };
  const r = pooled(real);
  const v = nulls.map(pooled);
  const mu = mean(v);
  const p = (1 + v.filter((z) => Math.abs(z - mu) >= Math.abs(r - mu) - 1e-12).length) / (1 + v.length);
  console.log(`${name}: ${pc(r)} vs ${pc(mu)} random, p ${fp(p)}`);
}

// ---- 2. weekdays, and following vs fading yesterday by era ----------------------
const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const weekday = names.map((name, d) => {
  const s = days.filter((x) => x.dow === d);
  return `${name} ${pc(s.filter((x) => x.x === 1).length / s.length)} (${s.length})`;
});
console.log(`\nUp-rate by weekday (UTC): ${weekday.join(', ')}`);
for (const [a, b] of [[2011, 2018], [2019, 2026]]) {
  let n = 0;
  let rev = 0;
  for (let t = 1; t < days.length; t++) {
    if (days[t].year < a || days[t].year > b) continue;
    n++;
    if (days[t].x !== days[t - 1].x) rev++;
  }
  console.log(`${a}-${b}: fade yesterday ${pc(rev / n)}, follow yesterday ${pc(1 - rev / n)} (${n} days)`);
}

// ---- 3. fade yesterday, taken apart (calendar days, as in the ledger) -----------
const dirs = directions(rows);
const close = new Map(rows.map((r) => [r.date, r.close]));
const era = (date) => (date <= '2018-12-31' ? '2011-2018' : '2019-2026');
const tally = () => ({ n: 0, hits: 0 });
const add = (t, hit) => {
  t.n++;
  if (hit) t.hits++;
};
const show = (t) => `${t.hits}/${t.n} (${pc(t.hits / t.n)})`;
const E = {};
const byYear = new Map();
for (const r of rows) {
  if (r.date < '2011-01-01') continue;
  const today = dirs.get(r.date);
  const prev = dirs.get(addDays(r.date, -1));
  const e = (E[era(r.date)] ??= { fade: tally(), upAfterDown: tally(), downAfterUp: tally(), alwaysUp: tally(), small: tally(), big: tally() });
  if (today !== undefined) add(e.alwaysUp, today === 1);
  if (today === undefined || prev === undefined) continue;
  const hit = today === -prev;
  add(e.fade, hit);
  add(prev === -1 ? e.upAfterDown : e.downAfterUp, hit);
  const move = Math.abs(Math.log(close.get(addDays(r.date, -1)) / close.get(addDays(r.date, -2))));
  add(move >= 0.03 ? e.big : e.small, hit);
  const y = r.date.slice(0, 4);
  if (!byYear.has(y)) byYear.set(y, tally());
  add(byYear.get(y), hit);
}
console.log('\nFade yesterday, taken apart (calendar days, flat days skipped):');
for (const [name, e] of Object.entries(E)) {
  console.log(`  ${name}: fade ${show(e.fade)}; always up ${show(e.alwaysUp)}`);
  console.log(`    after a down day, call up: ${show(e.upAfterDown)}; after an up day, call down: ${show(e.downAfterUp)}`);
  console.log(`    after a move under 3%: ${show(e.small)}; after a move of 3% or more: ${show(e.big)}`);
}
console.log(`  By year: ${[...byYear].map(([y, t]) => `${y} ${show(t)}`).join(', ')}`);
