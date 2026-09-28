#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crossTeamAll } from './src/crossteam.js';
import { toCsv } from './src/csv.js';
import { allTeams, isDecided, loadGames, resultChar, teamSchedule } from './src/data.js';
import { loadLedger, scoreLedger } from './src/ledger.js';
import { ALL_MODEL_KEYS, MODELS, walkForward } from './src/models.js';
import { buildPdf } from './src/pdf.js';
import { DEFAULTS, runAll } from './src/pipeline.js';
import { predictNext, upcomingRuleCalls } from './src/predict.js';
import { renderReport } from './src/report.js';
import { RULES, describeRule, ordinal, ruleCases } from './src/rules.js';
import { hashSeed, mulberry32, shuffleWithinSeason } from './src/rng.js';
import { intervalScan, windowRows } from './src/scan.js';
import { empiricalP } from './src/stats.js';

const HERE = dirname(fileURLToPath(import.meta.url));

const USAGE = `Seattle Seahawks pattern network (works for any team code)

  node cli.js report     full analysis -> results/REPORT.md, results.json, predictions.csv
  node cli.js render     rebuild REPORT.md from results.json without recomputing
  node cli.js pdf        detailed PDF analysis -> results/analysis.pdf (needs Playwright)
  node cli.js evaluate   walk-forward accuracy of every model
  node cli.js scan       calendar and game-order rule scans against shuffled seasons
  node cli.js predict    next game + upcoming calls of the named rules
  node cli.js ledger     score registered rules (ledger.json) on games after their date
  node cli.js crossteam  test the rules on the other 31 teams, and each team's own best
                         rule found in 1999-2012 on 2013-2025
  node cli.js query --lag 28 --mid 10     every game with games 28 and 10 days before
  node cli.js query --gap 10 --position 4 [--same-season]
                                          every game 10 days after the last one, compared
                                          with the 4th-previous game
  node cli.js query --lag 14 [--consecutive]   repeats/reversals for games 14 days apart
  node cli.js query --equal-gap 6 --count 3 [--all-teams]
                                          stretches of three 6-day gaps (6 x 3 = 18 days)
  node cli.js lab        lattice lab: ~300,000 lattices on all 32 teams (day lags, two- and
                         three-lookback rules, game-order rules, streaks, phases, cycles,
                         compressibility), two null models, split-half, season cycles and a
                         machine-learning suite -> results/lab.json + results/lattice-lab.pdf
                         (~12 min; --quick ~3 min; --reps 1000 --placebo-reps 300 --ml-null 20
                         --power-runs 5 --own-null 1000; --parts own,power reruns only those)
  node cli.js lab-pdf    rebuild results/lattice-lab.pdf from results/lab.json

options: --team SEA  --from 1999  --to 2025  --test-from 2004  --seeds 5
         --perms 200  --scan-perms 2000  --team-perms 1000  --workers N  --quick`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k];
    if (!a.startsWith('--')) args._.push(a);
    else if (argv[k + 1] === undefined || argv[k + 1].startsWith('--')) args[a.slice(2)] = true;
    else args[a.slice(2)] = argv[++k];
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
const int = (v, d) => (v === undefined ? d : Number.parseInt(v, 10));
const opts = {
  team: (args.team ?? DEFAULTS.team).toUpperCase(),
  from: int(args.from, DEFAULTS.from),
  to: int(args.to, DEFAULTS.to),
  testFrom: int(args['test-from'], DEFAULTS.testFrom),
  seeds: int(args.seeds, DEFAULTS.seeds),
  perms: int(args.perms, args.quick ? 20 : DEFAULTS.perms),
  scanPerms: int(args['scan-perms'], args.quick ? 300 : DEFAULTS.scanPerms),
  teamScanPerms: int(args['team-perms'], args.quick ? 100 : DEFAULTS.teamScanPerms),
  workers: args.workers ? int(args.workers) : undefined,
};
const pct = (x) => `${(100 * x).toFixed(1)}%`;
const seeds = Array.from({ length: opts.seeds }, (_, k) => k + 1);
const schedule = () => teamSchedule(loadGames(), opts.team);
const where = (g) => `${g.home === 1 ? 'vs' : '@'} ${g.opp}`;

async function report() {
  const started = Date.now();
  const R = await runAll(opts, (msg) => console.error(msg));
  const outDir = args.out ?? join(HERE, 'results');
  mkdirSync(outDir, { recursive: true });
  const { predictions, ...json } = R;
  writeFileSync(join(outDir, 'results.json'), JSON.stringify(json, null, 2) + '\n');
  writeFileSync(join(outDir, 'predictions.csv'), toCsv(predictions, Object.keys(predictions[0])));
  writeFileSync(join(outDir, 'REPORT.md'), renderReport(R));
  console.error(`done in ${((Date.now() - started) / 1000).toFixed(0)}s -> ${join(outDir, 'REPORT.md')}`);
}

function render() {
  const outDir = args.out ?? join(HERE, 'results');
  const R = JSON.parse(readFileSync(join(outDir, 'results.json'), 'utf8'));
  writeFileSync(join(outDir, 'REPORT.md'), renderReport(R));
  console.error(`rendered ${join(outDir, 'REPORT.md')}`);
}

async function pdf() {
  const outDir = args.out ?? join(HERE, 'results');
  const R = JSON.parse(readFileSync(join(outDir, 'results.json'), 'utf8'));
  const res = await buildPdf(R, {
    outFile: join(outDir, 'analysis.pdf'),
    htmlFile: args.html ? join(outDir, 'analysis.html') : undefined,
  });
  console.error(res.pdf ? `wrote ${res.pdf}` : res.reason);
}

function evaluate() {
  const seq = schedule();
  const { metrics } = walkForward({ seq, trainFrom: opts.from, testFrom: opts.testFrom, testTo: opts.to, seeds });
  console.log(`${opts.team} walk-forward, train from ${opts.from}, test ${opts.testFrom}-${opts.to}\n`);
  for (const k of ALL_MODEL_KEYS) {
    const m = metrics[k];
    const ll = MODELS[k].kind === 'rule' ? '(in-sample rule)' : `log-loss ${m.logLoss.toFixed(3)}`;
    console.log(`${MODELS[k].label.padEnd(42)} ${String(m.n).padStart(4)} games  ${pct(m.accuracy).padStart(6)}  ${ll}`);
  }
}

function scan() {
  const seq = schedule();
  const s = intervalScan(seq, { from: opts.from, to: opts.to, nPerm: opts.scanPerms });
  const f = s.focus;
  console.log(`${opts.team} ${opts.from}-${opts.to}: ${s.rulesTested} two-lookback rules with >= ${s.settings.minN} cases, ${s.settings.nPerm} shuffles\n`);
  console.log(`28/10 rule: ${f.hits}/${f.n}  alone p=${f.p.toFixed(4)}  shuffle p=${f.pPermutation.toFixed(4)}  after search p=${f.pFamily.toFixed(3)}  (shuffled mean ${pct(f.nullMeanRate)})`);
  console.log(`rules at least that strong: real ${s.chance.atLeastAsStrong.real}, shuffled mean ${s.chance.atLeastAsStrong.nullMean.toFixed(2)}\n`);
  console.log('strongest rules:');
  for (const c of s.combos.slice(0, 10)) console.log(`  ${String(c.d1).padStart(2)} & ${String(c.d2).padStart(2)} days  ${c.hits}/${c.n}  p=${c.p.toFixed(4)}  after search p=${c.pFamily.toFixed(3)}`);
  const [oa, os] = s.order.focus;
  console.log(`\n${s.order.rulesTested} game-order rules; ${s.combinedRules} rules in both families`);
  for (const f of [oa, os]) {
    console.log(
      `${f.gap}-day gap, ${ordinal(f.k)}-previous${f.sameSeason ? ', same season' : ''}: ${f.hits}/${f.n}  alone p=${f.p.toFixed(4)}  ` +
        `shuffle p=${f.pPermutation.toFixed(4)}  after order search p=${f.pFamily.toFixed(3)}  after both p=${f.pBoth.toFixed(3)}`,
    );
  }
  console.log(`positions after ${oa.gap}-day gaps: ${s.order.positions.map((p) => `${ordinal(p.k)} ${p.any.hits}/${p.any.n} (same season ${p.same.hits}/${p.same.n})`).join(', ')}`);
  console.log('\nback-to-back games by gap:');
  for (const r of s.consecutiveGaps) console.log(`  ${String(r.days).padStart(2)} days  ${r.same}/${r.n} same (${pct(r.rate)}, shuffled ${pct(r.nullRate)})  p=${r.p.toFixed(3)} q=${r.q.toFixed(3)}`);
  console.log('\nmost extreme intervals (all pairs):');
  for (const r of [...s.pairLags].sort((a, b) => a.p - b.p).slice(0, 8)) console.log(`  ${String(r.days).padStart(3)} days  ${r.same}/${r.n} same (${pct(r.rate)}, shuffled ${pct(r.nullRate)})  p=${r.p.toFixed(3)} q=${r.q.toFixed(3)}`);
}

function predict() {
  const seq = schedule();
  const nx = predictNext(seq, { seeds });
  if (!nx) return console.log('no unplayed games in the data; run `npm run update-data`');
  console.log(`next: ${nx.game.date} ${nx.game.weekday} ${where(nx.game)}  spread ${nx.game.spread ?? 'n/a'}  (trained on ${nx.trainedOn} games)`);
  for (const [k, p] of Object.entries(nx.probs)) console.log(`  ${MODELS[k].label.padEnd(42)} ${pct(p)}`);
  const calls = upcomingRuleCalls(seq);
  console.log(`\nnamed rules, rest of ${nx.game.season}:${calls.length ? '' : ' no eligible games'}`);
  for (const u of calls) {
    console.log(
      `  ${u.game.date} ${where(u.game)} [${RULES[u.rule].label}]: ${u.older.date} ${resultChar(u.older.result)}, ` +
        `${u.newer.date} ${u.newer.weekday} ${resultChar(u.newer.result)} -> ${u.status}`,
    );
  }
}

function crossteam() {
  const started = Date.now();
  const X = crossTeamAll(loadGames(), { team: opts.team, from: opts.from, to: opts.to, nPerm: opts.scanPerms, rules: RULES });
  const line = (label, r) =>
    console.log(
      `  ${label.padEnd(44)} ${String(`${r.hits}/${r.n}`).padStart(8)}  ${pct(r.rate).padStart(6)}   shuffled ${pct(r.shuffledRate)} (p=${r.pShuffle.toFixed(2)})` +
        `   market expected ${pct(r.marketExpected / r.n)} (z=${r.z.toFixed(2)})   Vegas favorite ${pct(r.favorite.hits / r.favorite.n)} of ${r.favorite.n} games`,
    );
  console.log(`1) ${opts.team}'s rules, unchanged, on the other ${31} teams (${opts.from}-${opts.to})`);
  for (const r of X.rulesOnOthers) line(RULES[r.id].label, r);
  line('10-day, 4th-previous, same season only', X.sameSeasonOnOthers);
  const s = X.splitHalf;
  console.log(`\n2) every team's best rules found in ${s.window.searchFrom}-${s.window.searchTo}, scored on ${s.window.testFrom}-${s.window.testTo}`);
  console.log(`  in the seasons they were found in: ${s.searchHits}/${s.searchN} (${pct(s.searchRate)})`);
  line(`on the later seasons (${s.rulesFound} rules)`, s);
  const st = X.splitHalfStrong;
  console.log(`\n   every rule that was 90%+ right or wrong in ${st.window.searchFrom}-${st.window.searchTo} (${st.rulesFound} rules, all teams)`);
  console.log(`  in the seasons they were found in: ${st.searchHits}/${st.searchN} (${pct(st.searchRate)})`);
  line('on the later seasons', st);
  console.log('\n3) equal-period stretches, all teams: does the last game repeat the first?');
  for (const e of X.equalGaps) {
    const mk = e.market && e.market.n ? `, market expected ${pct(e.market.marketExpected / e.market.n)} (z=${e.market.z.toFixed(2)})` : '';
    console.log(
      `  ${e.gap} x ${e.count} = ${e.gap * e.count} days: ${e.stretches} stretches, ${e.hits}/${e.n} repeated (${pct(e.rate)}), shuffled ${pct(e.shuffledRate)}, p=${e.p.toFixed(2)}${mk}`,
    );
  }
  if (args.json) writeFileSync(join(HERE, 'results', 'crossteam.json'), JSON.stringify(X, null, 2) + '\n');
  console.error(`\n(${((Date.now() - started) / 1000).toFixed(0)}s, ${opts.scanPerms} shuffles)`);
}

function ledger() {
  const games = loadGames();
  for (const r of scoreLedger(games, loadLedger())) {
    if (r.type === 'pick') {
      const open = r.picks.filter((p) => p.cover === null);
      console.log(`${r.id} (all teams, against the spread, written down ${r.registered}): ${r.description}`);
      console.log(`  forward record ${r.hits}/${r.n} covers${r.picks.length ? '' : ', no eligible games yet'}`);
      for (const p of open) console.log(`  ${p.date} ${p.game}: take ${p.pick} ${p.spread > 0 ? '-' : '+'}${Math.abs(p.spread)} vs ${p.opp}`);
      continue;
    }
    console.log(`${r.id} (${r.team}, written down ${r.registered}): ${describeRule(r)}`);
    console.log(`  forward record ${r.hits}/${r.n}${r.calls.length ? '' : ', no eligible games yet'}`);
    for (const c of r.calls) console.log(`  ${c.game.date} ${where(c.game)}: ${c.status}`);
  }
}

function listCases(rule) {
  const seq = schedule();
  const cases = ruleCases(seq, rule, { from: opts.from, to: opts.to });
  for (const c of cases) {
    const [a, b, g] = [seq[c.older], seq[c.newer], seq[c.game]];
    const verdict = c.call === null ? 'no call' : c.hit === null ? 'pending' : c.hit ? 'repeat (hit)' : 'reverse (miss)';
    console.log(
      `${a.date} ${resultChar(a.result)}  ${b.date} ${b.weekday} ${resultChar(b.result)}  ->  ${g.date} ${where(g)} ${resultChar(g.result)}` +
        `   span ${g.day - a.day}d   ${verdict}`,
    );
  }
  const fired = cases.filter((c) => c.hit !== null);
  console.log(`\n${describeRule(rule)}: ${cases.length} sequences, rule fired ${fired.length} times, ${fired.filter((c) => c.hit).length} repeats`);
}

// Stretches of `count` back-to-back gaps all `g` days long (6 x 3 = 18: four
// games, three 6-day gaps), past and scheduled; does the last game repeat the first?
function equalGaps(g, count) {
  const games = loadGames();
  const teams = args['all-teams'] ? allTeams(games) : [opts.team];
  const stretches = (seq) =>
    seq.flatMap((_, j) => {
      if (j < count) return [];
      for (let t = 0; t < count; t++) if (seq[j - t].day - seq[j - t - 1].day !== g) return [];
      return [j];
    });
  for (const team of teams) {
    const seq = teamSchedule(games, team);
    for (const j of stretches(seq)) {
      if (seq[j].season < opts.from) continue;
      const line = Array.from({ length: count + 1 }, (_, t) => seq[j - count + t])
        .map((x) => `${x.date} ${x.weekday} ${resultChar(x.result)}`)
        .join(' -> ');
      console.log(`${team.padEnd(4)} ${line}`);
    }
  }
  if (args['all-teams']) return;
  const seq = teamSchedule(games, opts.team);
  const base = seq.map((x) => x.result);
  const ends = stretches(seq).filter((j) => seq[j].season <= opts.to && seq[j].season >= opts.from);
  const stat = (res) => {
    const used = ends.filter((j) => isDecided(res[j - count]) && isDecided(res[j]));
    return { n: used.length, same: used.filter((j) => res[j] === res[j - count]).length };
  };
  const real = stat(base);
  if (!real.n) return console.log(`\nno finished ${g} x ${count} = ${g * count}-day stretches for ${opts.team} in ${opts.from}-${opts.to}: nothing to test`);
  const nulls = Array.from({ length: opts.scanPerms }, (_, k) => {
    const s = stat(shuffleWithinSeason(seq, base, mulberry32(hashSeed('equal', g, count, k))));
    return s.n ? s.same / s.n : NaN;
  }).filter((x) => !Number.isNaN(x));
  const center = nulls.reduce((a, b) => a + b, 0) / nulls.length;
  const rate = real.same / real.n;
  const p = empiricalP(nulls, (x) => Math.abs(x - center) >= Math.abs(rate - center) - 1e-12);
  console.log(
    `\n${opts.team} ${opts.from}-${opts.to}, ${g} x ${count} = ${g * count} days: last game repeated the first in ${real.same}/${real.n} ` +
      `(${pct(rate)}); shuffled seasons ${pct(center)}, p = ${p.toFixed(2)}`,
  );
}

function query() {
  if (args['equal-gap']) return equalGaps(int(args['equal-gap']), int(args.count, 3));
  if (args.gap) {
    const k = int(args.position, 4);
    return listCases({ type: 'order', gap: int(args.gap), k, sameSeason: Boolean(args['same-season']) });
  }
  const lag = int(args.lag);
  if (!lag) throw new Error('query needs --lag <days> or --gap <days>');
  if (args.mid) return listCases({ type: 'calendar', d1: lag, d2: int(args.mid) });
  const seq = schedule();
  const rows = windowRows(seq, opts.from, opts.to);
  const bySeason = new Map();
  for (let a = 0; a < rows.length; a++) {
    for (let b = a + 1; b < rows.length; b++) {
      const [i, j] = [rows[a], rows[b]];
      const d = seq[j].day - seq[i].day;
      if (d > lag) break;
      if (d !== lag || (args.consecutive && j !== i + 1)) continue;
      if (!isDecided(seq[i].result) || !isDecided(seq[j].result)) continue;
      const s = bySeason.get(seq[j].season) ?? { rep: 0, rev: 0 };
      seq[i].result === seq[j].result ? s.rep++ : s.rev++;
      bySeason.set(seq[j].season, s);
    }
  }
  let rep = 0;
  let rev = 0;
  for (const [season, s] of [...bySeason].sort((x, y) => x[0] - y[0])) {
    console.log(`${season}  repetitions ${s.rep}  reversals ${s.rev}`);
    rep += s.rep;
    rev += s.rev;
  }
  console.log(`\n${opts.from}-${opts.to}, games ${lag} days apart${args.consecutive ? ' (back-to-back only)' : ''}: ${rep} repetitions, ${rev} reversals`);
}

async function lab() {
  const { LAB_PARTS, runLab } = await import('./src/lab/run.js');
  const outDir = args.out ?? join(HERE, 'results');
  mkdirSync(outDir, { recursive: true });
  // --parts own,power recomputes just those parts and keeps the rest of lab.json
  const parts = args.parts ? String(args.parts).split(',') : LAB_PARTS;
  const bad = parts.filter((p) => !LAB_PARTS.includes(p));
  if (bad.length) throw new Error(`unknown part(s) ${bad.join(', ')}; choose from ${LAB_PARTS.join(', ')}`);
  const labFile = join(outDir, 'lab.json');
  const previous = parts.length < LAB_PARTS.length ? JSON.parse(readFileSync(labFile, 'utf8')) : null;
  const L = await runLab(loadGames(), {
    parts,
    previous,
    reps: int(args.reps, args.quick ? 200 : 1000),
    placeboReps: int(args['placebo-reps'], args.quick ? 0 : 300),
    mlNullReps: int(args['ml-null'], args.quick ? 5 : 20),
    powerRuns: int(args['power-runs'], args.quick ? 0 : 5),
    ownNullReps: int(args['own-null'], args.quick ? 100 : 1000),
    seasonPerms: args.quick ? 2000 : 10000,
    seasonMarket: args.quick ? 200 : 1000,
    workers: opts.workers,
    team: opts.team,
    quick: Boolean(args.quick),
    log: (msg) => console.error(msg),
  });
  writeFileSync(labFile, JSON.stringify(L, null, 1) + '\n');
  console.error(`lab done (${parts.join(', ')}) -> ${labFile}`);
  if (!args['no-pdf']) await labPdf();
}

async function labPdf() {
  const { buildLabPdf } = await import('./src/lab/pdf.js');
  const outDir = args.out ?? join(HERE, 'results');
  const L = JSON.parse(readFileSync(join(outDir, 'lab.json'), 'utf8'));
  const res = await buildLabPdf(L, {
    outFile: join(outDir, 'lattice-lab.pdf'),
    htmlFile: args.html ? join(outDir, 'lattice-lab.html') : undefined,
  });
  console.error(res.pdf ? `wrote ${res.pdf}` : res.reason);
}

const COMMANDS = { report, render, pdf, evaluate, scan, predict, ledger, crossteam, query, lab, 'lab-pdf': labPdf };
if (!COMMANDS[cmd]) {
  console.log(USAGE);
  process.exit(cmd ? 1 : 0);
}
await COMMANDS[cmd]();
