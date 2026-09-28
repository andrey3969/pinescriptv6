import { parentPort, workerData } from 'node:worker_threads';
import { loadGames, teamSchedule } from './data.js';
import { walkForward } from './models.js';
import { hashSeed, mulberry32, shuffleWithinSeason } from './rng.js';

const { dataFile, wf, jobs } = workerData;
const games = loadGames(dataFile);
const schedules = new Map();

for (const job of jobs) {
  if (!schedules.has(job.team)) schedules.set(job.team, teamSchedule(games, job.team));
  const seq = schedules.get(job.team);
  const base = seq.map((g) => g.result);
  const results = job.perm ? shuffleWithinSeason(seq, base, mulberry32(hashSeed('nn-perm', job.team, job.perm))) : base;
  const { metrics } = walkForward({
    ...wf,
    seq,
    results,
    models: job.models ?? wf.models,
    net: { ...wf.net, ...job.net },
  });
  const slim = Object.fromEntries(
    Object.entries(metrics).map(([k, m]) => [k, { n: m.n, correct: m.correct, accuracy: m.accuracy, logLoss: m.logLoss }]),
  );
  parentPort.postMessage({ ...job, metrics: slim });
}
