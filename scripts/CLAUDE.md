# scripts — scan agendado, build e admin

`run-scan.mjs`/`build-scan.mjs` empacotam `src/lib/scanner.js` sem modificação
(4 imports redirecionados). `adminPineConfig.js` espelha `pineParser.js`.
`run-backtest.mjs`/`build-backtest.mjs` fazem o mesmo redirecionamento (5º
alvo) para rodar o motor de backtest histórico local — ver
`docs/claude/backtest-usage.md` e `docs/known-risks.md` item 33.
`run-backfill-check.mjs`/`build-backfill.mjs` fazem o mesmo (6º alvo), mas
contra o backend REAL (`adminEntitiesBackfillCache.js` — 4º mirror do
adaptador, envolve `adminEntities.js` com cache em memória só para
`AssetState`/`MonitoredAsset`, ver `docs/known-risks.md` item 137 addendum
2026-08-31) e janela recente ao vivo (`backfillMarketDataProvider.js`) —
checagem retroativa ao adicionar/reativar um ativo, roda em
`.github/workflows/backfill.yml` (workflow separado do scan ao vivo).
`failureClassification.mjs` é o ÚNICO lugar que decide se uma falha é cota
esgotada do Firestore ou apenas uma etapa travada — nunca classifique isso por
regex no ponto de entrada (`docs/known-risks.md` item 162); a mensagem de
`scanTimeout.mjs` diz só o que foi observado, sem chutar a causa.
`adminEntities.js` também embute o espelho de leitura RTDB pro dashboard
(`AssetState`/`TradeOperation`, `src/lib/rtdbMirror.js`, ver
`docs/known-risks.md` item 152) — ativo só quando `FIREBASE_DATABASE_URL`
está setada; sem ela, é no-op e o backfill continua idêntico a antes.
`scripts/backfill-rtdb.mjs` (rodado só manualmente via `backfill-rtdb.yml`,
nunca no cron) faz a cópia inicial Firestore→RTDB que o mirror ao vivo não
cobre sozinho — ver item 152 addendum. Seguir:

@../.claude/rules/ci-deploy.md
@../.claude/rules/trading-engine.md
@../.claude/rules/pine-parity.md
