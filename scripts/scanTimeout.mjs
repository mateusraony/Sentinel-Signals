// Shared "fail fast" guard for the scheduled scan entry point that hits the
// REAL Firestore (run-scan.mjs) — docs/known-risks.md item 142.
//
// @google-cloud/firestore's admin client retries RESOURCE_EXHAUSTED
// internally with its own backoff, with no documented way to opt out per
// error code (community-confirmed: googleapis/nodejs-firestore#1387) — a
// single exhausted-quota query can hang for MINUTES before the library
// finally gives up and rejects (measured live: ~9min on one call chain).
// Because scan.yml runs on a ~5min external cadence inside a `concurrency`
// group, a hung run collides with the NEXT trigger and gets cancelled
// mid-retry instead of failing cleanly — repeating every cycle until the
// daily quota resets, turning a transient exhaustion into hours of total
// outage (confirmed live: 2026-09-01, ~18:15-20:37 UTC, dozens of
// cancelled/failed runs in a row).
//
// withTimeout races the real call against a much shorter deadline so the
// script fails FAST (like a normal error, triggering the existing Telegram
// quota alert) instead of hanging.

export function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(
        `Timeout: ${label} não retornou em ${ms}ms — provável travamento em retry de `
        + 'RESOURCE_EXHAUSTED do Firestore (ver docs/known-risks.md item 142).'
      ));
    }, ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

// Node keeps the process alive while any timer/socket is pending — the
// LOSER of the race above (the real Firestore call, still retrying in the
// background) would otherwise keep the process — and therefore the GitHub
// Actions job — alive for as long as the library's own retry would have
// taken, defeating the fast-fail above. process.exit() force-terminates
// instead of waiting for the event loop to drain on its own.
export function forceExit(code) {
  process.exitCode = code;
  process.exit(code);
}
