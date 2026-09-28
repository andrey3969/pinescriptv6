// One slice of null histories for the family engine: pass 1 (moments) for
// every null kind, then pass 2 (z-scores and statistics) once the main thread
// sends back the merged moments.
import { parentPort, workerData } from 'node:worker_threads';
import { loadGames } from '../data.js';
import {
  MOMENT_OFFSET,
  addExceed,
  addMoments,
  countAll,
  fillZ,
  newExceed,
  newMoments,
  newZBuffers,
  nullGenerators,
  prepare,
  replicateStats,
} from './engine.js';

const { dataFile, opts, start, end, kinds } = workerData;
const ctx = prepare(loadGames(dataFile), opts);
const gen = nullGenerators(ctx);

for (const kind of kinds) {
  const mom = newMoments(ctx);
  for (let rep = start; rep < end; rep++) {
    addMoments(ctx, mom, countAll(ctx, gen[kind](MOMENT_OFFSET + rep)));
    parentPort.postMessage({ type: 'progress' });
  }
  parentPort.postMessage({ type: 'moments', kind, mom });
}

let pending = kinds.length;
parentPort.on('message', ({ kind, std, realZ }) => {
  const zbuf = newZBuffers(ctx);
  const exceed = newExceed(ctx);
  const stats = [];
  for (let rep = start; rep < end; rep++) {
    fillZ(ctx, std, countAll(ctx, gen[kind](rep)), zbuf);
    stats.push(replicateStats(ctx, zbuf));
    addExceed(ctx, exceed, realZ, zbuf);
    parentPort.postMessage({ type: 'progress' });
  }
  parentPort.postMessage({ type: 'stats', kind, start, stats, exceed });
  if (--pending === 0) parentPort.close();
});
