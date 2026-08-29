# scripts — scan agendado, build e admin

`run-scan.mjs`/`build-scan.mjs` empacotam `src/lib/scanner.js` sem modificação
(4 imports redirecionados). `adminPineConfig.js` espelha `pineParser.js`.
`run-backtest.mjs`/`build-backtest.mjs` fazem o mesmo redirecionamento (5º
alvo) para rodar o motor de backtest histórico local — ver
`docs/claude/backtest-usage.md` e `docs/known-risks.md` item 33.
`run-backfill-check.mjs`/`build-backfill.mjs` fazem o mesmo (6º alvo), mas
contra o backend REAL (`adminEntities.js`) e janela recente ao vivo
(`backfillMarketDataProvider.js`) — checagem retroativa ao adicionar/reativar
um ativo, ver `docs/known-risks.md` item 137. Seguir:

@../.claude/rules/ci-deploy.md
@../.claude/rules/trading-engine.md
@../.claude/rules/pine-parity.md
