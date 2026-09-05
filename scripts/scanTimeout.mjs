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
      // A mensagem diz só O QUE FOI OBSERVADO: qual etapa não respondeu e em
      // quanto tempo. A causa provável (retry de cota do Firestore) fica no
      // comentário acima, NÃO no texto do erro — enquanto ela estava na
      // mensagem, quem classificava a falha por regex casava com a própria
      // hipótese e reportava TODO timeout como "cota esgotada", inclusive com
      // a cota inteira disponível (docs/known-risks.md item 162, incidente ao
      // vivo de 2026-09-05).
      reject(new Error(
        `Timeout: ${label} não retornou em ${ms}ms `
        + '(ver docs/known-risks.md itens 142 e 162).'
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
