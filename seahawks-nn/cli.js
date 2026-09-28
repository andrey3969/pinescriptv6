#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toCsv } from './src/csv.js';
import { isDecided, loadGames, resultChar, teamSchedule } from './src/data.js';
import { loadLedger, scoreLedger } from './src/ledger.js';
import { ALL_MODEL_KEYS, MODELS, walkForward } from './src/models.js';
import { DEFAULTS, runAll } from './src/pipeline.js';
import { predictNext, upcomingRuleCalls } from './src/predict.js';
import { renderReport } from './src/report.js';
import { RULES, describeRule, ordinal, ruleCases } from './src/rules.js';
import { intervalScan, windowRows } from './src/scan.js';

const HERE = dirname(fileURLToPath(import.meta.url));

const USAGE = `Seattle Seahawks pattern network (works for any team code)

  node cli.js report     full analysis -> results/REPORT.md, results.json, predictions.csv
  node cli.js render     rebuild REPORT.md from results.json without recomputing
  node cli.js evaluate   walk-forward accuracy of every model
  node cli.js scan       calendar and game-order rule scans against shuffled seasons
  node cli.js predict    next game + upcoming calls of the named rules
  node cli.js ledger     score registered rules (ledger.json) on games after their date
  node cli.js query --lag 28 --mid 10     every game with games 28 and 10 days before
  node cli.js query --gap 10 --position 4 [--same-season]
                                          every game 10 days after the last one, compared
                                          with the 4th-previous game
  node cli.js query --lag 14 [--consecutive]   repeats/reversals for games 14 days apart

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

function ledger() {
  const games = loadGames();
  for (const r of scoreLedger(games, loadLedger())) {
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

function query() {
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

const COMMANDS = { report, render, evaluate, scan, predict, ledger, query };
if (!COMMANDS[cmd]) {
  console.log(USAGE);
  process.exit(cmd ? 1 : 0);
}
await COMMANDS[cmd]();
