// A slice of the machine search's null: the whole search re-run on histories
// where every game's cover outcome was flipped with probability 1/2.
import { parentPort, workerData } from 'node:worker_threads';
import { loadGames } from '../data.js';
import { nullSearchMax } from './own.js';

const { dataFile, seeds, minN } = workerData;
parentPort.postMessage(nullSearchMax(loadGames(dataFile), { seeds, minN }));
