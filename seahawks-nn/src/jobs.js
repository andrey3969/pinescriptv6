// Runs walk-forward jobs across worker threads. A job is
//   { team, perm, net?, models? }
// perm 0 = the real result sequence, perm > 0 = a within-season shuffle.
import os from 'node:os';
import { Worker } from 'node:worker_threads';

export const defaultWorkers = () => Math.max(1, os.availableParallelism?.() ?? os.cpus().length);

export function runJobs(jobs, { dataFile, wf, workers = defaultWorkers(), onProgress } = {}) {
  const n = Math.max(1, Math.min(workers, jobs.length));
  const shares = Array.from({ length: n }, (_, w) => jobs.filter((_, k) => k % n === w));
  let done = 0;
  return Promise.all(
    shares.map(
      (share) =>
        new Promise((resolve, reject) => {
          const out = [];
          const worker = new Worker(new URL('./job-worker.js', import.meta.url), {
            workerData: { dataFile, wf, jobs: share },
          });
          worker.on('message', (m) => {
            out.push(m);
            onProgress?.(++done, jobs.length);
          });
          worker.on('error', reject);
          worker.on('exit', (code) => (code ? reject(new Error(`worker exited with code ${code}`)) : resolve(out)));
        }),
    ),
  ).then((parts) => parts.flat());
}
