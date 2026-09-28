import { DATA_FILE, allTeams, isDecided, loadGames, teamSchedule } from './data.js';
import { featureNames } from './features.js';
import { runJobs } from './jobs.js';
import { loadLedger, scoreLedger } from './ledger.js';
import { MODELS, walkForward } from './models.js';
import { NET_DEFAULTS } from './nn.js';
import { predictNext, upcomingRuleCalls } from './predict.js';
import { RULES, ruleCases } from './rules.js';
import { gapStructure, intervalScan } from './scan.js';
import { empiricalP, mcnemar, mean, quantile } from './stats.js';

export const DEFAULTS = {
  team: 'SEA',
  from: 1999,
  to: 2025,
  testFrom: 2004,
  seeds: 5,
  permSeeds: 3,
  perms: 200,
  scanPerms: 2000,
  teamScanPerms: 1000,
  dataFile: DATA_FILE,
};

export const PERM_MODELS = ['nn_lattice', 'nn_sequence', 'lr_lattice', 'repeat_last'];

export const SENSITIVITY = [
  { label: 'default (16 hidden, L2 0.01, early stopping)', net: {} },
  { label: '4 hidden units', net: { hidden: 4 } },
  { label: '64 hidden units', net: { hidden: 64 } },
  { label: 'weak L2 (0.001)', net: { l2: 1e-3 } },
  { label: 'strong L2 (0.1)', net: { l2: 1e-1 } },
  { label: 'no early stopping, 200 epochs', net: { valFrac: 0, maxEpochs: 200 } },
];

const seedList = (n) => Array.from({ length: n }, (_, k) => k + 1);
const brief = (g) =>
  g && {
    date: g.date,
    season: g.season,
    gameType: g.gameType,
    weekday: g.weekday,
    opp: g.opp,
    home: g.home,
    result: g.result,
    pf: g.pf,
    pa: g.pa,
    spread: g.spread,
  };

function summarizePerms(runs, models) {
  const real = runs.find((r) => r.perm === 0);
  const nulls = runs.filter((r) => r.perm !== 0);
  return Object.fromEntries(
    models.map((k) => {
      const acc = nulls.map((r) => r.metrics[k].accuracy);
      const ll = nulls.map((r) => r.metrics[k].logLoss);
      const spread = (xs) => ({ mean: mean(xs), p05: quantile(xs, 0.05), p95: quantile(xs, 0.95) });
      return [
        k,
        {
          real: real.metrics[k],
          nullAccuracy: spread(acc),
          nullLogLoss: spread(ll),
          pAccuracy: empiricalP(acc, (a) => a >= real.metrics[k].accuracy - 1e-12),
          pLogLoss: empiricalP(ll, (l) => l <= real.metrics[k].logLoss + 1e-12),
        },
      ];
    }),
  );
}

function pairedVs(wf, a, b) {
  let onlyA = 0;
  let onlyB = 0;
  for (const i of wf.testRows) {
    const ya = (wf.preds[a][i] >= 0.5 ? 1 : 0) === wf.ctx.y[i];
    const yb = (wf.preds[b][i] >= 0.5 ? 1 : 0) === wf.ctx.y[i];
    if (ya && !yb) onlyA++;
    if (yb && !ya) onlyB++;
  }
  return { a, b, onlyA, onlyB, p: mcnemar(onlyA, onlyB) };
}

export async function runAll(options = {}, log = () => {}) {
  const o = { ...DEFAULTS, ...options };
  const games = loadGames(o.dataFile);
  const seq = teamSchedule(games, o.team);
  if (!seq.length) throw new Error(`no games found for team ${o.team}`);
  const inWindow = seq.filter((g) => g.season >= o.from && g.season <= o.to && g.result !== null);
  const wfWindow = { trainFrom: o.from, testFrom: o.testFrom, testTo: o.to };
  const jobOpts = { dataFile: o.dataFile, workers: o.workers };
  const progress = (label) => (done, total) => {
    if (done === total || done % Math.max(1, Math.round(total / 10)) === 0) log(`  ${label}: ${done}/${total}`);
  };

  log(`walk-forward: train from ${o.from}, test ${o.testFrom}-${o.to}, all models`);
  const wf = walkForward({ seq, ...wfWindow, seeds: seedList(o.seeds) });

  log(`shuffle test: real sequence + ${o.perms} within-season shuffles`);
  const permRuns = await runJobs(
    Array.from({ length: o.perms + 1 }, (_, perm) => ({ team: o.team, perm })),
    { ...jobOpts, wf: { ...wfWindow, models: PERM_MODELS, seeds: seedList(o.permSeeds) }, onProgress: progress('shuffles') },
  );

  log('robustness: other network settings');
  const sensRuns = await runJobs(
    SENSITIVITY.map((s, k) => ({ team: o.team, perm: 0, net: s.net, models: ['nn_lattice'], k })),
    { ...jobOpts, wf: { ...wfWindow, seeds: seedList(o.seeds) } },
  );

  log(`interval scan: ${o.scanPerms} shuffles`);
  const scan = intervalScan(seq, { from: o.from, to: o.to, nPerm: o.scanPerms });
  const cases = Object.fromEntries(
    Object.entries(RULES).map(([id, rule]) => [
      id,
      ruleCases(seq, rule, { from: o.from, to: o.to }).map((c) => ({
        game: brief(seq[c.game]),
        older: brief(seq[c.older]),
        newer: brief(seq[c.newer]),
        span: seq[c.game].day - seq[c.older].day,
        call: c.call,
        hit: c.hit,
      })),
    ]),
  );

  log(`all ${allTeams(games).length} teams: interval scan + results-only network`);
  const teams = allTeams(games).map((team) => {
    const s = intervalScan(teamSchedule(games, team), { from: o.from, to: o.to, nPerm: o.teamScanPerms, pairs: false });
    return {
      team,
      rule: s.focus,
      order: s.order.focus,
      best: s.chance.bestCombo,
      perfect: s.chance.perfect.real,
      rulesTested: s.rulesTested,
    };
  });
  const teamRuns = await runJobs(
    teams.map(({ team }) => ({ team, perm: 0 })),
    { ...jobOpts, wf: { ...wfWindow, models: ['nn_lattice', 'always_win'], seeds: seedList(o.permSeeds) }, onProgress: progress('teams') },
  );
  for (const r of teamRuns) Object.assign(teams.find((t) => t.team === r.team), { nn: r.metrics.nn_lattice, base: r.metrics.always_win });

  log('next game');
  const next = predictNext(seq, { seeds: seedList(o.seeds) });

  const predictions = wf.testRows.map((i) => ({
    season: seq[i].season,
    date: seq[i].date,
    opponent: seq[i].opp,
    home: seq[i].home,
    result: seq[i].result === 1 ? 'W' : 'L',
    ...Object.fromEntries(Object.keys(wf.preds).map((k) => [k, Number.isNaN(wf.preds[k][i]) ? '' : wf.preds[k][i].toFixed(4)])),
  }));

  return {
    generatedAt: new Date().toISOString(),
    options: { ...o, dataFile: undefined, net: NET_DEFAULTS },
    data: {
      games: inWindow.length,
      record: {
        w: inWindow.filter((g) => g.result === 1).length,
        l: inWindow.filter((g) => g.result === -1).length,
        t: inWindow.filter((g) => g.result === 0).length,
      },
      lastPlayed: brief(seq.findLast((g) => g.result !== null)),
      thursdays: inWindow.filter((g) => g.weekday === 'Thu').map((g) => g.date),
      latestSeason: seq.findLast((g) => g.result !== null)?.season,
    },
    features: { lattice: featureNames('lattice').length, all: featureNames('all').length },
    walkForward: {
      testGames: wf.testRows.length,
      metrics: wf.metrics,
      paired: [pairedVs(wf, 'nn_lattice', 'always_win'), pairedVs(wf, 'nn_all', 'vegas')],
    },
    permutation: { perms: o.perms, seeds: o.permSeeds, models: summarizePerms(permRuns, PERM_MODELS) },
    sensitivity: sensRuns
      .sort((a, b) => a.k - b.k)
      .map((r) => ({ label: SENSITIVITY[r.k].label, ...r.metrics.nn_lattice })),
    scan,
    rules: RULES,
    cases,
    gaps: gapStructure(seq, { from: o.from, to: o.to }),
    teams,
    next,
    upcomingRule: upcomingRuleCalls(seq).map((u) => ({
      rule: u.rule,
      game: brief(u.game),
      older: brief(u.older),
      newer: brief(u.newer),
      status: u.status,
    })),
    ledger: scoreLedger(games, loadLedger())
      .filter((r) => r.team === o.team)
      .map(({ calls, ...r }) => ({
        ...r,
        calls: calls.map((c) => ({ game: brief(c.game), older: brief(c.older), newer: brief(c.newer), call: c.call, hit: c.hit, status: c.status })),
      })),
    predictions,
    labels: Object.fromEntries(Object.entries(MODELS).map(([k, m]) => [k, m.label])),
    decidedInWindow: inWindow.filter((g) => isDecided(g.result)).length,
  };
}
