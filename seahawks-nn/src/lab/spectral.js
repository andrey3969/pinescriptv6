// "Value" families for the lab: every item is one number per team (pooled =
// the mean over teams), compared with the same number in null histories.
//   specGame  periodogram over game order (does the W/L sequence cycle every
//             k games?), results demeaned within each season
//   specCal   periodogram over calendar days (does it cycle every P days?)
//   lz        Lempel-Ziv complexity: how compressible the W/L string is.
//             Any repeating structure at all makes it lower.
const TAU = 2 * Math.PI;

// Cycles per game: periods from 100 games down to 2 games.
export const GAME_FREQS = Array.from({ length: 99 }, (_, j) => 0.005 * (j + 2));
// Periods in days, log-spaced from 3 to 400.
export const CAL_PERIODS = Array.from({ length: 300 }, (_, j) => 3 * (400 / 3) ** (j / 299));

// Played games of the window with the season each one belongs to.
function played(seq, rows) {
  const keep = rows.filter((i) => seq[i].result !== null);
  const seasons = [...new Set(keep.map((i) => seq[i].season))];
  const index = new Map(seasons.map((s, k) => [s, k]));
  return { rows: Int32Array.from(keep), season: Int32Array.from(keep, (i) => index.get(seq[i].season)), nSeasons: seasons.length };
}

function trigTables(n, F, angle) {
  const cos = new Float32Array(n * F);
  const sin = new Float32Array(n * F);
  for (let k = 0; k < n; k++) {
    for (let f = 0; f < F; f++) {
      const a = angle(k, f);
      cos[k * F + f] = Math.cos(a);
      sin[k * F + f] = Math.sin(a);
    }
  }
  return { cos, sin };
}

// |sum x_k e^{-i a_kf}|^2 / n with x = result minus its season's mean.
function periodogram(c, results) {
  const n = c.rows.length;
  const F = c.F;
  const out = new Float64Array(F);
  if (!n) return out;
  const sum = new Float64Array(c.nSeasons);
  const cnt = new Float64Array(c.nSeasons);
  const x = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const r = results[c.rows[k]];
    x[k] = r === 1 ? 1 : r === -1 ? -1 : 0;
    sum[c.season[k]] += x[k];
    cnt[c.season[k]]++;
  }
  const C = new Float64Array(F);
  const S = new Float64Array(F);
  for (let k = 0; k < n; k++) {
    const v = x[k] - sum[c.season[k]] / cnt[c.season[k]];
    if (v === 0) continue;
    const off = k * F;
    for (let f = 0; f < F; f++) {
      C[f] += v * c.cos[off + f];
      S[f] += v * c.sin[off + f];
    }
  }
  for (let f = 0; f < F; f++) out[f] = (C[f] * C[f] + S[f] * S[f]) / n;
  return out;
}

// Kaspar-Schuster LZ76 complexity of a 0/1 array.
export function lz76(s) {
  const n = s.length;
  if (n < 2) return n;
  let c = 1;
  let l = 1;
  let i = 0;
  let k = 1;
  let kmax = 1;
  for (;;) {
    if (s[i + k - 1] === s[l + k - 1]) {
      k++;
      if (l + k > n) {
        c++;
        break;
      }
    } else {
      if (k > kmax) kmax = k;
      i++;
      if (i === l) {
        c++;
        l += kmax;
        if (l + 1 > n) break;
        i = 0;
        k = 1;
        kmax = 1;
      } else k = 1;
    }
  }
  return c;
}

const fmtPeriod = (p) => (p < 10 ? p.toFixed(2) : p < 100 ? p.toFixed(1) : p.toFixed(0));

export const VALUE_FAMILIES = {
  specGame: {
    label: 'Cycles in game order (periodogram, 2-100 games)',
    short: 'Game-order cycles',
    type: 'value',
    sided: 'upper',
    size: () => GAME_FREQS.length,
    build(seq, rows) {
      const c = played(seq, rows);
      c.F = GAME_FREQS.length;
      Object.assign(c, trigTables(c.rows.length, c.F, (k, f) => TAU * GAME_FREQS[f] * k));
      return c;
    },
    value: periodogram,
    describe: (id) => `cycle every ${fmtPeriod(1 / GAME_FREQS[id])} games`,
  },

  specCal: {
    label: 'Cycles in calendar time (periodogram, 3-400 days)',
    short: 'Calendar cycles',
    type: 'value',
    sided: 'upper',
    size: () => CAL_PERIODS.length,
    build(seq, rows) {
      const c = played(seq, rows);
      c.F = CAL_PERIODS.length;
      const t0 = c.rows.length ? seq[c.rows[0]].day : 0;
      const days = Array.from(c.rows, (i) => seq[i].day - t0);
      Object.assign(c, trigTables(c.rows.length, c.F, (k, f) => (TAU * days[k]) / CAL_PERIODS[f]));
      return c;
    },
    value: periodogram,
    describe: (id) => `cycle every ${fmtPeriod(CAL_PERIODS[id])} days`,
  },

  lz: {
    label: 'Compressibility of the W/L sequence (Lempel-Ziv complexity)',
    short: 'Compressibility (LZ)',
    type: 'value',
    sided: 'lower', // hidden structure makes a sequence more compressible
    size: () => 1,
    build: (seq, rows) => Int32Array.from(rows.filter((i) => seq[i].result !== null)),
    value(rows, results) {
      const bits = [];
      for (const i of rows) if (results[i] === 1 || results[i] === -1) bits.push(results[i] === 1 ? 1 : 0);
      const n = bits.length;
      return Float64Array.of(n > 1 ? (lz76(bits) * Math.log2(n)) / n : 0);
    },
    describe: () => 'LZ complexity',
  },
};
