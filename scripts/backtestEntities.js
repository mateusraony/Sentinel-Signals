// Node adapter for the historical backtest (scripts/build-backtest.mjs) —
// the '@/api/entities' redirect target for scanner.js during a backtest
// run, mirroring what adminEntities.js does for the live cron (firebase-admin)
// and what scannerStateMachine.test.js already proved works: the SAME
// in-memory fake backend (src/lib/__fixtures__/fakeBackend.js), including its
// real CAS logic from opTransition.js — only the persistence is fake, never
// the trading rules. One instance per process: run-backtest.mjs imports this
// same `backend` both to drive scanner.js (via the bundle redirect) and to
// read the final TradeOperation set for the report.
import { createFakeBackend } from '../src/lib/__fixtures__/fakeBackend.js';

export const backend = createFakeBackend();
