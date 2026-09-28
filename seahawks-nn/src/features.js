// Feature matrices. Row i only ever reads results[j] for j < i, plus facts
// known before kickoff of game i (date, weekday, home/away, point spread).

export const ORDER_LAGS = 8; // last N games, in game order
export const GAP_LAGS = 4; // day gaps between the last few games
export const CAL_MAX = 63; // "result exactly d days earlier", d = 1..63
const OFFSEASON_DAYS = 60;
const FORM_PRIOR_GAMES = 4;

// "lattice" is the hypothesis under test: nothing but the team's own
// results and the calendar spacing of its games.
// "sequence" is the control: the same results, but no calendar information.
export const FEATURE_SETS = {
  lattice: ['order', 'gaps', 'cal', 'weekday'],
  sequence: ['order'],
  conventional: ['weekday', 'context', 'form', 'market'],
  all: ['order', 'gaps', 'cal', 'weekday', 'context', 'form', 'market'],
};

const WEEKDAY_SLOTS = ['Sun', 'Mon', 'Thu', 'Sat'];
const range = (n, f) => Array.from({ length: n }, (_, k) => f(k + 1));
const clip = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

const schedules = new WeakMap();

// calPrev[i][d] = index of the game played exactly d days before game i, or -1.
export function scheduleIndex(seq) {
  let s = schedules.get(seq);
  if (s) return s;
  const byDay = new Map(seq.map((g, i) => [g.day, i]));
  const calPrev = seq.map((g) => {
    const a = new Int32Array(CAL_MAX + 1).fill(-1);
    for (let d = 1; d <= CAL_MAX; d++) a[d] = byDay.get(g.day - d) ?? -1;
    return a;
  });
  s = { byDay, calPrev };
  schedules.set(seq, s);
  return s;
}

// Season-to-date record (shrunk toward last season) and point differential.
function formTable(seq, results) {
  const seasonPct = new Map();
  for (const [i, g] of seq.entries()) {
    const r = results[i];
    if (r === null) continue;
    const t = seasonPct.get(g.season) ?? { w: 0, n: 0 };
    t.w += r === 1 ? 1 : r === 0 ? 0.5 : 0;
    t.n += 1;
    seasonPct.set(g.season, t);
  }
  const prevPct = (season) => {
    const t = seasonPct.get(season - 1);
    return t && t.n ? t.w / t.n : 0.5;
  };
  const out = [];
  let season = null;
  let w = 0;
  let n = 0;
  let pd = 0;
  let npd = 0;
  for (const [i, g] of seq.entries()) {
    if (g.season !== season) {
      season = g.season;
      w = n = pd = npd = 0;
    }
    const prior = prevPct(season);
    out.push({
      winPct: (w + FORM_PRIOR_GAMES * prior) / (n + FORM_PRIOR_GAMES),
      prevPct: prior,
      pointDiff: npd ? pd / npd : 0,
    });
    const r = results[i];
    if (r !== null) {
      w += r === 1 ? 1 : r === 0 ? 0.5 : 0;
      n += 1;
    }
    if (g.pf !== null) {
      pd += g.pf - g.pa;
      npd += 1;
    }
  }
  return out;
}

const GROUPS = {
  order: {
    names: range(ORDER_LAGS, (k) => `game_lag${k}`),
    fill(out, i, s) {
      for (let k = 1; k <= ORDER_LAGS; k++) out.push(i - k >= 0 ? s.res(i - k) : 0);
    },
  },
  gaps: {
    names: [...range(GAP_LAGS, (k) => `gap${k}_weeks`), ...range(GAP_LAGS, (k) => `gap${k}_offseason`)],
    fill(out, i, s) {
      const weeks = [];
      const off = [];
      for (let k = 1; k <= GAP_LAGS; k++) {
        const a = i - k + 1;
        const b = i - k;
        const gap = b >= 0 ? s.seq[a].day - s.seq[b].day : Infinity;
        weeks.push(gap > OFFSEASON_DAYS ? 0 : Math.min(gap, 21) / 7);
        off.push(gap > OFFSEASON_DAYS ? 1 : 0);
      }
      out.push(...weeks, ...off);
    },
  },
  cal: {
    names: range(CAL_MAX, (d) => `day_lag${d}`),
    fill(out, i, s) {
      const prev = s.calPrev[i];
      for (let d = 1; d <= CAL_MAX; d++) out.push(prev[d] >= 0 ? s.res(prev[d]) : 0);
    },
  },
  weekday: {
    names: [...WEEKDAY_SLOTS.map((w) => `weekday_${w}`), 'weekday_other'],
    fill(out, i, s) {
      const k = WEEKDAY_SLOTS.indexOf(s.seq[i].weekday);
      for (let j = 0; j <= WEEKDAY_SLOTS.length; j++) out.push(j === (k < 0 ? WEEKDAY_SLOTS.length : k) ? 1 : 0);
    },
  },
  context: {
    names: ['home', 'playoff', 'season_week', 'division_game'],
    fill(out, i, s) {
      const g = s.seq[i];
      out.push(g.home, g.gameType === 'REG' ? 0 : 1, Math.min(g.week, 22) / 18, g.div ? 1 : 0);
    },
  },
  form: {
    names: ['season_win_pct', 'last_season_win_pct', 'season_point_diff'],
    fill(out, i, s) {
      const f = s.form[i];
      out.push(f.winPct - 0.5, f.prevPct - 0.5, clip(f.pointDiff / 14, -2, 2));
    },
  },
  market: {
    names: ['spread', 'spread_missing'],
    fill(out, i, s) {
      const sp = s.seq[i].spread;
      out.push(sp === null ? 0 : clip(sp / 14, -2, 2), sp === null ? 1 : 0);
    },
  },
};

export function featureNames(setName) {
  return FEATURE_SETS[setName].flatMap((g) => GROUPS[g].names);
}

// Dense row-major matrix: X[i * D + j].
export function buildMatrix(seq, results, setName) {
  const groups = FEATURE_SETS[setName];
  if (!groups) throw new Error(`unknown feature set: ${setName}`);
  const needsForm = groups.includes('form');
  const s = {
    seq,
    calPrev: scheduleIndex(seq).calPrev,
    res: (j) => (results[j] === 1 ? 1 : results[j] === -1 ? -1 : 0),
    form: needsForm ? formTable(seq, results) : null,
  };
  const names = featureNames(setName);
  const D = names.length;
  const X = new Float64Array(seq.length * D);
  const row = [];
  for (let i = 0; i < seq.length; i++) {
    row.length = 0;
    for (const g of groups) GROUPS[g].fill(row, i, s);
    X.set(row, i * D);
  }
  return { X, D, names };
}
