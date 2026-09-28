// Lattices of my own, scored the way that matters for an edge: against the
// point spread. A lattice picks a side in a game (back a team, or fade it);
// the pick wins when that side covers. At the usual -110 odds a pick has to
// win 52.4% of the time to break even, so 50% is "no edge" and anything real
// must beat 52.4% on seasons it was not found on.
//
//   mechanism lattices  hypotheses with a physical reason: rest, byes, body
//                       clock and time zones, short weeks, rematches, over-
//                       reaction to blowouts and cover streaks, plus a moon
//                       lattice as a nonsense control and the hand-found rules
//   residual lattices   does the part of a result the market did not expect
//                       (margin minus spread) echo at game or day intervals?
//   machine search      every one-, two- and three-condition lattice from a
//                       grammar of ~90 pre-game conditions, found on 1999-2012,
//                       corrected against sign-flipped histories, scored on
//                       2013-2025 and on the 2026 games played so far
import { Worker } from 'node:worker_threads';
import { DATA_FILE, allTeams, dayNumber, franchise } from '../data.js';
import { hashSeed, mulberry32 } from '../rng.js';
import { binomTwoSided, binomUpper, empiricalP, mean, quantile, wilson } from '../stats.js';

export const BREAK_EVEN = 110 / 210; // -110 on both sides
const num = (s) => (s === '' || s === 'NA' || s == null ? null : Number(s));
const decided = (r) => r === 1 || r === -1;

// ---- time zones (hours from US Eastern) ---------------------------------------
const TZ = {
  ARI: -3, ATL: 0, BAL: 0, BUF: 0, CAR: 0, CHI: -1, CIN: 0, CLE: 0, DAL: -1, DEN: -2, DET: 0, GB: -1,
  HOU: -1, IND: 0, JAX: 0, KC: -1, LA: -3, LAC: -3, LV: -3, MIA: 0, MIN: -1, NE: 0, NO: -1, NYG: 0,
  NYJ: 0, PHI: 0, PIT: 0, SEA: -3, SF: -3, TB: 0, TEN: -1, WAS: 0,
};
export function tzOf(team, season, month) {
  if (team === 'LA' && season <= 2015) return -1; // St. Louis
  if (team === 'ARI') return month >= 11 || month <= 2 ? -2 : -3; // no daylight saving time
  return TZ[team] ?? 0;
}

// Lunar phase, 0 = new moon, 0.5 = full (reference new moon 2000-01-06 18:14 UTC).
const SYNODIC = 29.530588853;
const NEW_MOON_2000 = dayNumber('2000-01-06') + 0.76;
export const moonPhase = (day) => ((((day + 0.5 - NEW_MOON_2000) / SYNODIC) % 1) + 1) % 1;

const hours = (t) => {
  if (!t || t === 'NA') return null;
  const [h, m] = t.split(':').map(Number);
  return h + m / 60;
};

// ---- rows: one per team per game, with what was known before kickoff -----------
export function buildRows(games) {
  const teams = allTeams(games);
  const byTeam = new Map(teams.map((t) => [t, []]));
  const list = [];
  for (const g of games) {
    const home = franchise(g.home_team);
    const away = franchise(g.away_team);
    const hs = num(g.home_score);
    const as = num(g.away_score);
    const played = hs !== null && as !== null;
    const season = Number(g.season);
    const month = Number(g.gameday.slice(5, 7));
    const game = {
      id: g.game_id,
      season,
      week: Number(g.week),
      type: g.game_type,
      date: g.gameday,
      day: dayNumber(g.gameday),
      month,
      weekday: g.weekday,
      kick: hours(g.gametime),
      neutral: g.location === 'Neutral',
      div: g.div_game === '1',
      spread: num(g.spread_line), // points the home team was favored by
      played,
    };
    game.moon = moonPhase(game.day);
    const side = (team, opp, isHome) => {
      const margin = played ? (isHome ? hs - as : as - hs) : null;
      const sp = game.spread === null ? null : isHome ? game.spread : -game.spread;
      return {
        game,
        team,
        opp,
        home: game.neutral ? 0 : isHome ? 1 : -1,
        isHome,
        rest: num(isHome ? g.home_rest : g.away_rest),
        oppRest: num(isHome ? g.away_rest : g.home_rest),
        spread: sp,
        margin,
        result: margin === null ? null : Math.sign(margin),
        cover: margin === null || sp === null ? null : Math.sign(margin - sp),
        resid: margin === null || sp === null ? null : margin - sp,
        tz: tzOf(team, season, month),
        oppTz: tzOf(opp, season, month),
        siteTz: game.neutral ? null : tzOf(home, season, month),
      };
    };
    const h = side(home, away, true);
    const a = side(away, home, false);
    h.other = a;
    a.other = h;
    game.rows = [h, a];
    byTeam.get(home).push(h);
    byTeam.get(away).push(a);
    list.push(game);
  }
  list.sort((x, y) => x.day - y.day || (x.id < y.id ? -1 : 1));

  // History, strictly from earlier games.
  const lastSeason = new Map(); // "team|season" -> win rate
  for (const [team, seq] of byTeam) {
    seq.sort((x, y) => x.game.day - y.game.day);
    const byDay = new Map(seq.map((r, i) => [r.game.day, i]));
    const tally = new Map();
    for (const r of seq) {
      if (!decided(r.result) && r.result !== 0) continue;
      const t = tally.get(r.game.season) ?? { w: 0, n: 0 };
      t.w += r.result === 1 ? 1 : r.result === 0 ? 0.5 : 0;
      t.n++;
      tally.set(r.game.season, t);
    }
    for (const [s, t] of tally) lastSeason.set(`${team}|${s}`, t.w / t.n);
    let w = 0;
    let l = 0;
    seq.forEach((r, i) => {
      const same = (k) => i - k >= 0 && seq[i - k].game.season === r.game.season;
      if (i && !same(1)) {
        w = 0;
        l = 0;
      }
      r.index = i;
      r.gap = i ? r.game.day - seq[i - 1].game.day : null;
      r.prev = same(1) ? seq[i - 1] : null;
      r.lastRes = [];
      r.lastCov = [];
      for (let k = 1; k <= 3 && same(k); k++) {
        r.lastRes.push(seq[i - k].result);
        r.lastCov.push(seq[i - k].cover);
      }
      r.prevK = [1, 2, 3, 4].map((k) => (i - k >= 0 ? seq[i - k].result : null));
      r.lag = Object.fromEntries(
        [7, 10, 14, 21, 28].map((d) => {
          const j = byDay.get(r.game.day - d);
          return [d, j === undefined ? null : seq[j].result];
        }),
      );
      for (let k = i - 1; k >= 0 && r.game.day - seq[k].game.day <= 400; k--) {
        if (seq[k].opp === r.opp) {
          r.lastMeet = seq[k];
          break;
        }
      }
      r.record = w - l;
      r.lastSeason = lastSeason.get(`${team}|${r.game.season - 1}`) ?? null;
      if (r.result === 1) w++;
      else if (r.result === -1) l++;
    });
  }
  return { games: list, teams, byTeam };
}

// ---- atoms: yes/no facts about one side of a game, known before kickoff -------
export const ATOMS = [];
const atom = (group, id, label, test) => ATOMS.push({ group, id, label, test });
atom('loc', 'home', 'home team', (r) => r.home === 1);
atom('loc', 'away', 'road team', (r) => r.home === -1);
atom('div', 'div', 'division game', (r) => r.game.div);
const line = [
  ['fav10', 'favored by 10+', (s) => s >= 10],
  ['fav7', 'favored by 7-9.5', (s) => s >= 7 && s < 10],
  ['fav3', 'favored by 3-6.5', (s) => s >= 3 && s < 7],
  ['even', 'within 2.5 of even', (s) => Math.abs(s) < 3],
  ['dog3', 'underdog by 3-6.5', (s) => s <= -3 && s > -7],
  ['dog7', 'underdog by 7-9.5', (s) => s <= -7 && s > -10],
  ['dog10', 'underdog by 10+', (s) => s <= -10],
];
for (const [id, label, f] of line) atom('line', id, label, (r) => r.spread !== null && f(r.spread));
atom('favdog', 'fav', 'favorite', (r) => r.spread > 0);
atom('favdog', 'dog', 'underdog', (r) => r.spread < 0);
const rest = [
  ['rest4', '4 or fewer days of rest', (d) => d <= 4],
  ['rest6', '5-6 days of rest', (d) => d >= 5 && d <= 6],
  ['rest7', '7 days of rest', (d) => d === 7],
  ['rest9', '8-9 days of rest', (d) => d >= 8 && d <= 9],
  ['rest12', '10-12 days of rest', (d) => d >= 10 && d <= 12],
  ['rest13', 'off a bye (13+ days of rest)', (d) => d >= 13 && d < 60],
];
for (const [id, label, f] of rest) atom('rest', id, label, (r) => r.rest !== null && f(r.rest));
const rd = [
  ['rdm3', '3+ fewer rest days than the opponent', (d) => d <= -3],
  ['rdm1', '1-2 fewer rest days', (d) => d <= -1 && d >= -2],
  ['rd0', 'same rest as the opponent', (d) => d === 0],
  ['rdp1', '1-2 more rest days', (d) => d >= 1 && d <= 2],
  ['rdp3', '3+ more rest days than the opponent', (d) => d >= 3],
];
for (const [id, label, f] of rd) atom('restdiff', id, label, (r) => r.rest !== null && r.oppRest !== null && r.rest < 60 && r.oppRest < 60 && f(r.rest - r.oppRest));
atom('oppRest', 'orest13', 'opponent off a bye', (r) => r.oppRest !== null && r.oppRest >= 13 && r.oppRest < 60);
atom('oppRest', 'orest9', 'opponent on 9 or fewer days of rest', (r) => r.oppRest !== null && r.oppRest <= 9);
for (const [id, wd] of [['sun', 'Sunday'], ['mon', 'Monday'], ['thu', 'Thursday'], ['sat', 'Saturday']]) atom('day', id, `${wd} game`, (r) => r.game.weekday === wd);
atom('kick', 'early', 'kickoff before 2 pm ET', (r) => r.game.kick !== null && r.game.kick < 14);
atom('kick', 'late', 'kickoff 2-6:30 pm ET', (r) => r.game.kick !== null && r.game.kick >= 14 && r.game.kick < 18.5);
atom('kick', 'night', 'night game (6:30 pm ET or later)', (r) => r.game.kick !== null && r.game.kick >= 18.5);
for (const [id, off, name] of [['tzET', 0, 'Eastern'], ['tzCT', -1, 'Central'], ['tzMT', -2, 'Mountain'], ['tzPT', -3, 'Pacific']]) atom('tz', id, `${name}-time team`, (r) => r.tz === off);
atom('oppTz', 'oppET', 'opponent is an Eastern-time team', (r) => r.oppTz === 0);
atom('oppTz', 'oppPT', 'opponent is a Pacific-time team', (r) => r.oppTz === -3);
atom('site', 'siteET', 'game in the Eastern time zone', (r) => r.siteTz === 0);
atom('site', 'sitePT', 'game in the Pacific time zone', (r) => r.siteTz === -3);
atom('travel', 'travel2', 'road team 2+ time zones from home', (r) => r.home === -1 && r.siteTz !== null && Math.abs(r.tz - r.siteTz) >= 2);
atom('clock', 'clock10', 'body clock 10:30 am or earlier at kickoff', (r) => r.game.kick !== null && r.game.kick + r.tz <= 10.5);
atom('clock', 'clockEdge', 'body clock 3+ hours earlier than the opponent’s at a night kickoff', (r) => r.game.kick !== null && r.game.kick >= 18.5 && r.oppTz - r.tz >= 3);
for (const [id, m, name] of [['sep', [9], 'September'], ['oct', [10], 'October'], ['nov', [11], 'November'], ['dec', [12], 'December'], ['jan', [1, 2], 'January-February']]) atom('month', id, `${name} game`, (r) => m.includes(r.game.month));
atom('phase', 'wk1_4', 'weeks 1-4', (r) => r.game.type === 'REG' && r.game.week <= 4);
atom('phase', 'wk14', 'week 14 or later', (r) => r.game.type === 'REG' && r.game.week >= 14);
atom('phase', 'post', 'playoff game', (r) => r.game.type !== 'REG');
const history = (prefix, who, pick) => {
  atom(`${prefix}prev`, `${prefix}prevW`, `${who} won its last game`, (r) => pickRow(r, pick).prev?.result === 1);
  atom(`${prefix}prev`, `${prefix}prevL`, `${who} lost its last game`, (r) => pickRow(r, pick).prev?.result === -1);
  atom(`${prefix}big`, `${prefix}prevW21`, `${who} won its last game by 21+`, (r) => (pickRow(r, pick).prev?.margin ?? 0) >= 21);
  atom(`${prefix}big`, `${prefix}prevL21`, `${who} lost its last game by 21+`, (r) => (pickRow(r, pick).prev?.margin ?? 0) <= -21);
  atom(`${prefix}cov`, `${prefix}prevC`, `${who} covered its last game`, (r) => pickRow(r, pick).prev?.cover === 1);
  atom(`${prefix}cov`, `${prefix}prevN`, `${who} failed to cover its last game`, (r) => pickRow(r, pick).prev?.cover === -1);
  const run = (arr, k, v) => arr.length >= k && arr.slice(0, k).every((x) => x === v);
  atom(`${prefix}streak`, `${prefix}won3`, `${who} won its last 3`, (r) => run(pickRow(r, pick).lastRes, 3, 1));
  atom(`${prefix}streak`, `${prefix}lost3`, `${who} lost its last 3`, (r) => run(pickRow(r, pick).lastRes, 3, -1));
  atom(`${prefix}cstreak`, `${prefix}cov3`, `${who} covered its last 3`, (r) => run(pickRow(r, pick).lastCov, 3, 1));
  atom(`${prefix}cstreak`, `${prefix}nocov3`, `${who} failed to cover its last 3`, (r) => run(pickRow(r, pick).lastCov, 3, -1));
};
const pickRow = (r, pick) => (pick === 'self' ? r : r.other);
history('', 'team', 'self');
history('o', 'opponent', 'opp');
for (const d of [7, 14, 21, 28]) {
  atom(`lag${d}`, `lag${d}W`, `won the game exactly ${d} days before`, (r) => r.lag[d] === 1);
  atom(`lag${d}`, `lag${d}L`, `lost the game exactly ${d} days before`, (r) => r.lag[d] === -1);
}
atom('gap', 'gap10', 'last game exactly 10 days before', (r) => r.gap === 10);
atom('order4', 'p14W', 'last and 4th-previous games both wins', (r) => r.prevK[0] === 1 && r.prevK[3] === 1);
atom('order4', 'p14L', 'last and 4th-previous games both losses', (r) => r.prevK[0] === -1 && r.prevK[3] === -1);
atom('cal2810', 'c2810W', 'won the games 28 and 10 days before', (r) => r.lag[28] === 1 && r.lag[10] === 1);
atom('cal2810', 'c2810L', 'lost the games 28 and 10 days before', (r) => r.lag[28] === -1 && r.lag[10] === -1);
atom('meet', 'meetW', 'won the last meeting with this opponent', (r) => r.lastMeet?.result === 1);
atom('meet', 'meetL', 'lost the last meeting with this opponent', (r) => r.lastMeet?.result === -1);
atom('meetS', 'meetLs', 'lost to this opponent earlier this season', (r) => r.lastMeet?.result === -1 && r.lastMeet.game.season === r.game.season);
atom('rec', 'recUp', 'winning record so far this season', (r) => r.record > 0);
atom('rec', 'recDown', 'losing record so far this season', (r) => r.record < 0);
atom('last', 'lastUp', 'winning record last season', (r) => r.lastSeason !== null && r.lastSeason > 0.5);
atom('last', 'lastDown', 'losing record last season', (r) => r.lastSeason !== null && r.lastSeason < 0.5);
atom('moon', 'full', 'within 1.5 days of a full moon', (r) => Math.abs(r.game.moon - 0.5) <= 1.5 / SYNODIC);
atom('moon', 'new', 'within 1.5 days of a new moon', (r) => Math.min(r.game.moon, 1 - r.game.moon) <= 1.5 / SYNODIC);
export const ATOM = Object.fromEntries(ATOMS.map((a) => [a.id, a]));

// ---- lattices: clauses of atoms; a game is picked when exactly one side fits ----
// { clauses: [{ atoms: [...], side: 'back' | 'fade' }] }
export function pickOf(lattice, game) {
  let pick = null;
  for (const { atoms, side } of lattice.clauses) {
    const fits = game.rows.filter((r) => atoms.every((id) => ATOM[id].test(r)));
    if (fits.length !== 1) continue;
    const row = side === 'back' ? fits[0] : fits[0].other;
    if (pick && pick !== row) return null; // two clauses disagree
    pick = row;
  }
  return pick;
}

export function describeLattice(lattice) {
  return lattice.clauses
    .map(({ atoms, side }) => `${side === 'back' ? 'Back' : 'Fade'} the side that is: ${atoms.map((id) => ATOM[id].label).join(' + ')}`)
    .join('; or ');
}

function score(picks) {
  const graded = picks.filter((p) => decided(p.row.cover));
  const n = graded.length;
  const hits = graded.filter((p) => p.row.cover === 1).length;
  const [lo, hi] = wilson(hits, n);
  const expWin = mean(graded.filter((p) => p.row.spread !== null).map((p) => p.pWin));
  return {
    n,
    hits,
    pushes: picks.filter((p) => p.row.cover === 0).length,
    rate: n ? hits / n : NaN,
    lo,
    hi,
    p: binomTwoSided(hits, n, 0.5),
    pBreakEven: n ? binomUpper(hits, n, BREAK_EVEN) : NaN, // one-sided: beats -110?
    units: hits * (100 / 110) - (n - hits), // profit in units risked at -110
    wins: graded.filter((p) => p.row.result === 1).length,
    expWins: expWin * n,
  };
}

export const WINDOWS = {
  disc: [1999, 2012],
  valid: [2013, 2025],
  fresh: [2026, 2026],
};
const inWindow = (g, [a, b]) => g.season >= a && g.season <= b;

export function evaluateLattice(data, lattice, { market, team = 'SEA' } = {}) {
  const picks = { disc: [], valid: [], fresh: [] };
  for (const g of data.games) {
    if (!g.played || g.spread === null) continue;
    const row = pickOf(lattice, g);
    if (!row) continue;
    const w = Object.keys(WINDOWS).find((k) => inWindow(g, WINDOWS[k]));
    if (!w) continue;
    picks[w].push({ row, pWin: market ? market.prob(row.spread) : 0.5 });
  }
  const all = [...picks.disc, ...picks.valid];
  // Is the effect the same for every team? Chi-square over teams with 10+ picks.
  const byTeam = new Map();
  for (const p of all) {
    if (!decided(p.row.cover)) continue;
    const e = byTeam.get(p.row.team) ?? { n: 0, hits: 0 };
    e.n++;
    if (p.row.cover === 1) e.hits++;
    byTeam.set(p.row.team, e);
  }
  const big = [...byTeam].filter(([, e]) => e.n >= 10);
  const pooled = big.reduce((s, [, e]) => s + e.hits, 0) / Math.max(1, big.reduce((s, [, e]) => s + e.n, 0));
  const chi2 = big.reduce((s, [, e]) => s + (e.hits - e.n * pooled) ** 2 / (e.n * pooled * (1 - pooled)), 0);
  return {
    disc: score(picks.disc),
    valid: score(picks.valid),
    fresh: score(picks.fresh),
    all: score(all),
    team: score(all.filter((p) => p.row.team === team || p.row.opp === team)),
    teams: {
      k: big.length,
      chi2,
      p: big.length > 1 ? chiSquareP(chi2, big.length - 1) : NaN,
      best: big.map(([t, e]) => ({ team: t, ...e, rate: e.hits / e.n })).sort((a, b) => b.rate - a.rate).slice(0, 3),
    },
  };
}

// Upper tail of the chi-square distribution (Wilson-Hilferty approximation).
function chiSquareP(x, k) {
  if (x <= 0) return 1;
  const z = ((x / k) ** (1 / 3) - (1 - 2 / (9 * k))) / Math.sqrt(2 / (9 * k));
  return 0.5 * erfc(z / Math.SQRT2);
}
function erfc(x) {
  const t = 1 / (1 + 0.5 * Math.abs(x));
  const y = t * Math.exp(-x * x - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? y : 2 - y;
}

// ---- the mechanism lattices, written down before scoring any of them ---------
export const MECHANISMS = [
  { id: 'rest3', why: 'More rest than the opponent should help; does the line price it fully?', clauses: [{ atoms: ['rdp3'], side: 'back' }] },
  { id: 'bye', why: 'Teams off a bye against teams that were not.', clauses: [{ atoms: ['rest13', 'orest9'], side: 'back' }] },
  { id: 'thuHome', why: 'Thursday games give the visitor a short week and a trip.', clauses: [{ atoms: ['home', 'thu'], side: 'back' }] },
  { id: 'earlyWest', why: 'A 1 pm Eastern kickoff is 10 am on a Pacific body clock.', clauses: [{ atoms: ['tzPT', 'away', 'siteET', 'early'], side: 'fade' }] },
  { id: 'nightWest', why: 'At a night kickoff a Pacific team is at its daily peak while an Eastern team is 3 hours later in its day (the circadian finding of Smith et al., 1997).', clauses: [{ atoms: ['tzPT', 'oppET', 'night'], side: 'back' }] },
  { id: 'travel', why: 'Road teams 2+ time zones from home.', clauses: [{ atoms: ['travel2'], side: 'fade' }] },
  { id: 'revenge', why: 'The loser of the first meeting in a season, in the rematch.', clauses: [{ atoms: ['meetLs'], side: 'back' }] },
  { id: 'bounce', why: 'After a 21+ point loss the market may overreact.', clauses: [{ atoms: ['prevL21'], side: 'back' }] },
  { id: 'letdown', why: 'After a 21+ point win the market may overreact.', clauses: [{ atoms: ['prevW21'], side: 'fade' }] },
  { id: 'atsHot', why: 'Teams that covered 3 straight: the line may chase them.', clauses: [{ atoms: ['cov3'], side: 'fade' }] },
  { id: 'atsCold', why: 'Teams that failed to cover 3 straight.', clauses: [{ atoms: ['nocov3'], side: 'back' }] },
  { id: 'divDog', why: 'Division rivals know each other; underdogs may keep it closer.', clauses: [{ atoms: ['div', 'dog'], side: 'back' }] },
  { id: 'bigDog', why: 'Double-digit underdogs: the public backs favorites.', clauses: [{ atoms: ['dog10'], side: 'back' }] },
  { id: 'earlyLast', why: 'In weeks 1-4 the line may lean too hard on last season.', clauses: [{ atoms: ['wk1_4', 'lastDown'], side: 'back' }] },
  { id: 'primeFav', why: 'Big favorites in night games draw public money.', clauses: [{ atoms: ['fav7', 'night'], side: 'fade' }, { atoms: ['fav10', 'night'], side: 'fade' }] },
  { id: 'moon', why: 'Control: nothing should happen. Home teams within 1.5 days of a full moon.', clauses: [{ atoms: ['home', 'full'], side: 'back' }], control: true },
  { id: 'hand1004', why: 'The hand-found 10-day / 4th-previous rule as a bet: after 10 days, back a team whose last and 4th-previous games were wins, fade one whose were losses.', clauses: [{ atoms: ['gap10', 'p14W'], side: 'back' }, { atoms: ['gap10', 'p14L'], side: 'fade' }] },
  { id: 'hand2810', why: 'The hand-found 28/10 rule as a bet: back a team that won the games 28 and 10 days before, fade one that lost both.', clauses: [{ atoms: ['c2810W'], side: 'back' }, { atoms: ['c2810L'], side: 'fade' }] },
];

// ---- residual lattices: does the unexpected part of a result echo? ------------
export function residualLattices(data, { reps = 2000, from = 1999, to = 2025 } = {}) {
  const gameIndex = new Map(data.games.map((g, k) => [g, k]));
  const pairs = { game: new Map(), day: new Map() };
  const GAME_LAGS = [1, 2, 3, 4, 5, 6, 7, 8];
  const DAY_LAGS = [3, 4, 6, 7, 8, 10, 11, 13, 14, 21, 28, 35, 42, 49, 56, 63, 364, 371];
  for (const seq of data.byTeam.values()) {
    const byDay = new Map(seq.map((r, i) => [r.game.day, i]));
    seq.forEach((r, i) => {
      if (r.resid === null || r.game.season < from || r.game.season > to) return;
      for (const k of GAME_LAGS) {
        const q = seq[i - k];
        if (!q || q.resid === null || q.game.season !== r.game.season) continue;
        if (!pairs.game.has(k)) pairs.game.set(k, []);
        pairs.game.get(k).push([gameIndex.get(q.game), gameIndex.get(r.game), q.resid * r.resid, q.resid ** 2, r.resid ** 2]);
      }
      for (const d of DAY_LAGS) {
        const j = byDay.get(r.game.day - d);
        if (j === undefined || seq[j].resid === null) continue;
        if (!pairs.day.has(d)) pairs.day.set(d, []);
        pairs.day.get(d).push([gameIndex.get(seq[j].game), gameIndex.get(r.game), seq[j].resid * r.resid, seq[j].resid ** 2, r.resid ** 2]);
      }
    });
  }
  const corr = (list, flip) => {
    let s = 0;
    let a = 0;
    let b = 0;
    for (const [gi, gj, prod, a2, b2] of list) {
      s += flip ? prod * flip[gi] * flip[gj] : prod;
      a += a2;
      b += b2;
    }
    return s / Math.sqrt(a * b);
  };
  const rand = mulberry32(hashSeed('resid-flip'));
  const out = {};
  for (const [kind, all] of [['game', GAME_LAGS], ['day', DAY_LAGS]]) {
    const lags = all.filter((L) => (pairs[kind].get(L) ?? []).length >= 30);
    const real = lags.map((L) => corr(pairs[kind].get(L) ?? [], null));
    const nulls = lags.map(() => []);
    for (let k = 0; k < reps; k++) {
      const flip = Int8Array.from(data.games, () => (rand() < 0.5 ? -1 : 1));
      lags.forEach((L, i) => nulls[i].push(corr(pairs[kind].get(L) ?? [], flip)));
    }
    const sd = nulls.map((v) => Math.sqrt(mean(v.map((x) => x * x))));
    const maxZ = [];
    for (let k = 0; k < reps; k++) maxZ.push(Math.max(...lags.map((_, i) => Math.abs(nulls[i][k]) / sd[i])));
    out[kind] = lags.map((L, i) => ({
      lag: L,
      pairs: (pairs[kind].get(L) ?? []).length,
      r: real[i],
      sd: sd[i],
      z: real[i] / sd[i],
      p: empiricalP(nulls[i], (x) => Math.abs(x) >= Math.abs(real[i]) - 1e-12),
      pFamily: empiricalP(maxZ, (m) => m >= Math.abs(real[i] / sd[i]) - 1e-9),
    }));
  }
  return out;
}

// ---- the machine search ---------------------------------------------------------
// Bitsets over games: HA[k] = atom k holds for the home side, HB[k] = for the
// away side; covH / covA = that side covered. A lattice picks the one side
// that fits (never both), and is scored as "back" (z > 0) or "fade" (z < 0).
const popcnt = (x) => {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
};

function universe(games) {
  const G = games.length;
  const W = Math.ceil(G / 32);
  const HA = ATOMS.map(() => new Uint32Array(W));
  const HB = ATOMS.map(() => new Uint32Array(W));
  const covH = new Uint32Array(W);
  const covA = new Uint32Array(W);
  games.forEach((g, k) => {
    const w = k >>> 5;
    const bit = 1 << (k & 31);
    const [h, a] = g.rows;
    ATOMS.forEach((at, i) => {
      if (at.test(h)) HA[i][w] |= bit;
      if (at.test(a)) HB[i][w] |= bit;
    });
    if (h.cover === 1) covH[w] |= bit;
    if (a.cover === 1) covA[w] |= bit;
  });
  return { G, W, HA, HB, covH, covA };
}

// Flip each game's cover outcome with probability 1/2 (pushes stay pushes).
function flipped(U, rand) {
  const covH = new Uint32Array(U.W);
  const covA = new Uint32Array(U.W);
  for (let w = 0; w < U.W; w++) {
    let m = 0;
    for (let b = 0; b < 32; b++) if (rand() < 0.5) m |= 1 << b;
    covH[w] = (U.covH[w] & ~m) | (U.covA[w] & m);
    covA[w] = (U.covA[w] & ~m) | (U.covH[w] & m);
  }
  return { ...U, covH, covA };
}

function evalAtoms(U, ids, bufH, bufA) {
  const { W, HA, HB, covH, covA } = U;
  let n = 0;
  let hits = 0;
  for (let w = 0; w < W; w++) {
    let h = 0xffffffff;
    let a = 0xffffffff;
    for (const i of ids) {
      h &= HA[i][w];
      a &= HB[i][w];
    }
    const ph = h & ~a;
    const pa = a & ~h;
    const graded = (ph & (covH[w] | covA[w])) | (pa & (covH[w] | covA[w]));
    n += popcnt(graded >>> 0);
    hits += popcnt((ph & covH[w]) >>> 0) + popcnt((pa & covA[w]) >>> 0);
  }
  return { n, hits };
}

export function searchLattices(U, { minN = 150, beam = 300, keep = 25 } = {}) {
  const groups = ATOMS.map((a) => a.group);
  const zOf = ({ n, hits }) => (n >= minN ? (hits - n / 2) / Math.sqrt(n / 4) : 0);
  const found = [];
  const push = (ids) => {
    const s = evalAtoms(U, ids);
    const z = zOf(s);
    found.push({ ids, ...s, z });
    return z;
  };
  const A = ATOMS.length;
  for (let i = 0; i < A; i++) push([i]);
  const pairs = [];
  for (let i = 0; i < A; i++) {
    for (let j = i + 1; j < A; j++) {
      if (groups[i] === groups[j]) continue;
      const z = push([i, j]);
      pairs.push({ ids: [i, j], z });
    }
  }
  const top = pairs.sort((a, b) => Math.abs(b.z) - Math.abs(a.z)).slice(0, beam);
  const seen = new Set();
  for (const { ids } of top) {
    for (let k = 0; k < A; k++) {
      if (ids.includes(k) || ids.some((i) => groups[i] === groups[k])) continue;
      const t = [...ids, k].sort((a, b) => a - b);
      const key = t.join(',');
      if (seen.has(key)) continue;
      seen.add(key);
      push(t);
    }
  }
  const best = found.filter((f) => f.z !== 0).sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
  return { tried: found.length, testable: best.length, best: best.slice(0, keep), maxZ: best.length ? Math.abs(best[0].z) : 0 };
}

const discoveryUniverse = (data) => universe(data.games.filter((g) => g.played && g.spread !== null && inWindow(g, WINDOWS.disc)));

// Best |z| of the whole search on each sign-flipped history (one seed each).
export function nullSearchMax(games, { seeds, minN = 150 }) {
  const disc = discoveryUniverse(buildRows(games));
  return seeds.map((seed) => searchLattices(flipped(disc, mulberry32(hashSeed('search-flip', seed))), { minN, keep: 1 }).maxZ);
}

function nullSearchParallel({ dataFile, nullReps, minN, workers }) {
  const n = Math.max(1, Math.min(workers, nullReps));
  const shares = Array.from({ length: n }, (_, w) => Array.from({ length: nullReps }, (_, k) => k + 1).filter((k) => k % n === w));
  return Promise.all(
    shares.map(
      (seeds) =>
        new Promise((resolve, reject) => {
          const worker = new Worker(new URL('./own-worker.js', import.meta.url), { workerData: { dataFile, seeds, minN } });
          worker.on('message', resolve);
          worker.on('error', reject);
        }),
    ),
  ).then((parts) => parts.flat());
}

export async function machineSearch(data, { nullReps = 200, minN = 150, keep = 25, workers = 1, dataFile = DATA_FILE, games = null } = {}) {
  const disc = discoveryUniverse(data);
  const real = searchLattices(disc, { minN, keep: keep * 3 });
  const nullMax = !nullReps
    ? []
    : workers > 1
      ? await nullSearchParallel({ dataFile, nullReps, minN, workers })
      : nullSearchMax(games, { seeds: Array.from({ length: nullReps }, (_, k) => k + 1), minN });
  const seen = new Set();
  const lattices = real.best.map((f) => {
    const lattice = { clauses: [{ atoms: f.ids.map((i) => ATOMS[i].id), side: f.z > 0 ? 'back' : 'fade' }] };
    return {
      lattice,
      text: describeLattice(lattice),
      discovery: { n: f.n, hits: f.z > 0 ? f.hits : f.n - f.hits, z: Math.abs(f.z) },
      pFamily: empiricalP(nullMax, (m) => m >= Math.abs(f.z) - 1e-9),
      ...evaluateLattice(data, lattice),
    };
  })
    .filter((x) => {
      const key = `${x.disc.n}|${x.disc.hits}|${x.valid.n}|${x.valid.hits}|${x.fresh.n}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, keep)
    .map((x, i) => ({ rank: i + 1, ...x }));
  const v = lattices.map((x) => x.valid);
  const vn = v.reduce((s, x) => s + x.n, 0);
  const vh = v.reduce((s, x) => s + x.hits, 0);
  return {
    atoms: ATOMS.length,
    tried: real.tried,
    testable: real.testable,
    minN,
    nullReps,
    nullMax: { mean: mean(nullMax), q95: quantile(nullMax, 0.95) },
    lattices,
    validation: {
      picks: vn,
      hits: vh,
      rate: vh / vn,
      above50: v.filter((x) => x.rate > 0.5).length,
      aboveBreakEven: v.filter((x) => x.rate > BREAK_EVEN).length,
    },
  };
}

// ---- forward picks (ledger) --------------------------------------------------------
export function upcomingPicks(data, lattice, { after }) {
  return data.games
    .filter((g) => !g.played && g.spread !== null && g.date > after)
    .flatMap((g) => {
      const row = pickOf(lattice, g);
      return row ? [{ game: g.id, date: g.date, pick: row.team, opp: row.opp, spread: row.spread, home: row.home }] : [];
    });
}

export function scorePickRule(data, rule) {
  const picks = [];
  for (const g of data.games) {
    if (g.date <= rule.registered || g.spread === null) continue;
    const row = pickOf(rule, g);
    if (!row) continue;
    picks.push({ game: g.id, date: g.date, pick: row.team, opp: row.opp, spread: row.spread, cover: g.played ? row.cover : null });
  }
  const graded = picks.filter((p) => decided(p.cover));
  return { picks, n: graded.length, hits: graded.filter((p) => p.cover === 1).length };
}

export async function runOwnLattices(games, { market = null, nullReps = 200, residReps = 2000, ledger = null, workers = 1, dataFile = DATA_FILE, log = () => {} } = {}) {
  const data = buildRows(games);
  log('  mechanism lattices');
  const mechanisms = MECHANISMS.map((m) => ({ ...m, text: describeLattice(m), ...evaluateLattice(data, m, { market }) }));
  // Holm correction over the mechanism lattices (all 1999-2025 seasons).
  const order = mechanisms.map((m, i) => [m.all.p, i]).sort((a, b) => a[0] - b[0]);
  let running = 0;
  order.forEach(([p, i], r) => {
    running = Math.max(running, Math.min(1, p * (order.length - r)));
    mechanisms[i].all.pHolm = running;
  });
  log('  residual lattices');
  const residual = residualLattices(data, { reps: residReps });
  log(`  machine search (${nullReps} sign-flipped histories)`);
  const search = await machineSearch(data, { nullReps, workers, dataFile, games });
  const base = evaluateLattice(data, { clauses: [{ atoms: ['home'], side: 'back' }] });
  const favs = evaluateLattice(data, { clauses: [{ atoms: ['fav'], side: 'back' }] });
  const played2026 = data.games.filter((g) => g.season === 2026 && g.played).length;
  const lastPlayed = data.games.filter((g) => g.played).at(-1)?.date;
  // The lattices written into ledger.json: forward record and open picks.
  const forward = (ledger?.rules ?? [])
    .filter((r) => r.type === 'pick')
    .map((r) => ({ id: r.id, registered: r.registered, text: describeLattice(r), ...scorePickRule(data, r) }));
  return { windows: WINDOWS, breakEven: BREAK_EVEN, baselines: { home: base, favorites: favs }, played2026, lastPlayed, mechanisms, residual, search, forward };
}
