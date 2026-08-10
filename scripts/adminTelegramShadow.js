// Shadow-mode counterpart to scripts/adminTelegram.js — Fase 1 modo sombra
// prospectivo (docs/known-risks.md item 56 "Modo sombra"). Same exported
// names src/lib/scanner.js imports from './telegram', all no-ops:
// isTelegramConfigured() always returns false, so every one of the 9
// isTelegramConfigured()-gated call sites in scanner.js short-circuits
// without ever reaching a notify* function. The notify* functions are still
// implemented as safe async no-ops (not simply absent) in case any future
// change to scanner.js calls one without the gate — defense in depth, not a
// currently-reachable path.
export function isTelegramConfigured() {
  return false;
}

async function noop() {}

export const notifyNewSignal = noop;
export const notifyVerificationTask = noop;
export const notifyTradeCreated = noop;
export const notifyTP1Hit = noop;
export const notifyTP2Hit = noop;
export const notifyStopHit = noop;
export const notifyInvalidated = noop;
export const notifyTimeStop = noop;
export const notifyChopExit = noop;
