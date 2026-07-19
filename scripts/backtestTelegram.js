// Node adapter for the historical backtest — the './telegram' redirect
// target for scanner.js during a backtest run. A backtest replays months of
// history in a tight loop; firing real Telegram messages for every
// historical signal/exit would be spam at best and a rate-limit ban at
// worst. Every notify*() call in scanner.js is already a fire-and-forget
// `.catch(() => {})`, so a no-op here changes no control flow — it only
// silences an unwanted external side effect.
export function isTelegramConfigured() {
  return false;
}

async function noop() {}

export const notifyNewSignal = noop;
export const notifyTradeCreated = noop;
export const notifyTP1Hit = noop;
export const notifyTP2Hit = noop;
export const notifyStopHit = noop;
export const notifyInvalidated = noop;
export const notifyTimeStop = noop;
export const notifyChopExit = noop;
