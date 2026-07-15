---
name: sentinel-trading-engine-review
description: Revisão do motor de trading do Sentinel (scanner.js, ciclo de vida de operações, concorrência, temporalidade). Use ao alterar ou revisar src/lib/scanner.js, a lógica de entrada/TP/stop/trailing/invalidação, os loops persistScanResults/priceCheckActiveOps, locks ou scripts de scan. Não use para UI ou para cálculo puro de indicador isolado (use sentinel-pine-parity).
---

# sentinel-trading-engine-review

## Quando usar
Qualquer mudança/review no motor: entrada, TP1/TP2, stop, trailing, invalidação,
Time Stop, os dois loops de atualização, locks, `assetActiveOps`, scripts de scan.

## Quando NÃO usar
Tarefa visual; cálculo isolado de um indicador (use `sentinel-pine-parity`);
pergunta conceitual sem alteração.

## Arquivos relevantes
`src/lib/scanner.js`, `scripts/run-scan.mjs`, `scripts/adminEntities.js`,
`.claude/rules/trading-engine.md`, `.claude/rules/firestore-concurrency.md`,
`.claude/rules/trading-safety.md`.

## Procedimento
1. Reler os **P0 confirmados** em `.claude/rules/trading-engine.md` e verificar se
   a mudança os agrava, corrige ou ignora.
2. **Análise de concorrência**: a mutação é segura se browser + cron (locks
   diferentes) rodarem juntos? É idempotente contra o status atual do banco?
3. **Replay temporal**: candle de entrada, gap, stop+TP no mesmo candle, trailing
   no fechamento, scans perdidos — a lógica se comporta?
4. **Estado**: nenhuma transição a partir de terminal; uma op ativa por ativo.
5. Se tocar cálculo → `sentinel-pine-parity`. Rodar `sentinel-state-machine-test`.
6. Verificar: `npm run lint && npm test && npm run build`.

## Critérios de sucesso
Nenhuma regressão de estado sob concorrência · nenhuma transição terminal→X ·
contagens por candle (não por scan) · trailing sem look-ahead · P0 não agravados.

## Testes obrigatórios
Máquina de estados + concorrência + temporalidade (`.claude/rules/testing.md`).
Paridade se houver cálculo.

## Limites de permissão
**Nunca** adicionar execução real de ordem (`.claude/rules/trading-safety.md`).
Não introduzir um 3º caminho de mutação de op. Não push/PR sem pedido.
