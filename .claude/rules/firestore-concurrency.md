---
description: Padrões de acesso ao Firestore — adaptador backend, transações, locks e quota do plano gratuito. Carregue ao mexer em src/api/**, firestore.rules, adminEntities.
paths:
  - src/api/**
  - firestore.rules
  - firestore.indexes.json
  - scripts/adminEntities.js
---

# Dados — adaptador, concorrência e quota (cutover Firestore→Postgres/Neon)

**Desde o cutover** (item 2 do runbook, `docs/claude/postgres-cutover-
runbook.md`), o backend real é Postgres/Neon, não Firestore — este arquivo
descreve o Postgres, com o histórico Firestore preservado onde ainda é
relevante (rollback, `entitiesFirestoreLegacy.js`, decisões que sobrevivem à
migração). Detalhe completo do adaptador/CAS Postgres: `db/CLAUDE.md`.

## Adaptador (não fure a abstração)

Todo acesso passa por `backend` (`src/api/entities.js`): `backend.entities.<Nome>`,
`backend.locks`, `backend.tradeOps`. Nova entidade = mesmo nome lógico em
`ENTITY_TABLES` (`db/pgEntitiesCore.mjs`) — é o único registro de "nome →
tabela", tanto o cliente HTTP do browser quanto a rota genérica de entidades
(`server/routes/entities.js`) o reusam, nenhum registro duplicado. **Nunca**
importe `firebase/firestore`/faça `fetch` cru para o backend direto em
componentes/páginas. O cron usa `scripts/adminEntities.js` (mesma forma de
chamada) — ver `db/CLAUDE.md`/`scripts/CLAUDE.md` (cutover concluído
2026-09-12, ambos os lados no Postgres/Neon).

**Exceção deliberada** (item 125 achado menor, 2026-08-24; lista completada no
item 145 addendum, 2026-09-02): `strategyConfig/current`, `telegramFilters/
current` e `systemAlerts/firestoreQuota` NÃO têm entidade equivalente em
`scripts/adminEntities.js` — `scripts/adminPineConfig.js`/`adminTelegram.js`
leem esses três docs direto via `firebase-admin/firestore` (`getFirestore()`),
sem passar por nenhum adaptador. Do lado browser, `strategyConfig/current` e
`telegramFilters/current` passam por `backend` normalmente (`StrategyConfig`/
entidade equivalente em `src/api/entities.js`); `systemAlerts/firestoreQuota`
não tem lado browser nenhum — é escrito/lido só pelo cron
(`notifyFirestoreQuotaExhausted`, `docs/known-risks.md` item 138, "só cron,
não espelhado no navegador"). Não é bug — é a mesma lista de "sem `.jsonc`" já
documentada no `CLAUDE.md` (tabela de coleções) — só não estava explicitada
AQUI, onde alguém lendo só esta regra concluiria (errado) que todo acesso do
cron passa por `adminEntities.js`.

## RTDB — espelho de leitura (item 152) — ABANDONADO no cutover (item 170 addendum, 2026-09-10)

**Histórico, não mais o comportamento real desde o cutover.** O espelho
RTDB existiu para absorver o polling do dashboard sem tocar a cota diária
do Firestore — decisão explícita do usuário no item 2 do runbook
(`docs/claude/postgres-cutover-runbook.md`): Postgres/Neon não tem teto
diário de operações, então a justificativa desaparece, e nenhum espelho
Postgres→RTDB foi construído para substituí-lo. Os ~20 consumidores que
liam via `rtdbEntities.X` voltaram a ler `backend.entities.X` direto.
`src/api/rtdbEntities.js`/`src/lib/rtdbMirror.js` seguem no repositório como
código morto (zero importador real) até a Fase 11 (decomissão, só depois do
bake period) — não apague sem ler o item 170 addendum primeiro. Resto desta
seção documenta como o mirror funcionava, para quem precisar entender
`entitiesFirestoreLegacy.js` (mantido com o mirror intacto, como referência
de rollback).

`AssetState`/`MonitoredAsset`/`SignalEvent`/`SystemLog`/`TradeOperation`/
`VerificationTask` — as 6 entidades de negócio inteiras deste app — eram
espelhadas no Firebase Realtime Database (RTDB), absorvendo o polling do
dashboard (`src/api/rtdbEntities.js`) sem tocar a cota diária do Firestore.
`SignalEvent` entrou na rodada 2 (item 152 addendum) porque é o denominador
comum das 4 telas mais usadas (Dashboard/Assets/Alerts/Trades) — mesmo com
os intervalos corrigidos do item 155, cada uma sozinha custava mais que a
cota diária inteira se ficasse aberta o dia todo. A rodada 3 (item 169)
fechou a lacuna de 3 componentes que a rodada 2 não cobriu
(`GlobalSearch.jsx`/`RFHistoryChart.jsx`/`WeeklySummary.jsx`, etapa 3a) e
estendeu `rtdbEntities.js` com um 3º formato reconhecido: igualdade de campo
único (`{ campo: valorEscalar }` → `orderByChild+equalTo`), além de
order+limit e range. A etapa 3b migrou `MonitoredAsset`/`VerificationTask`
com um 4º modo — `createRtdbWholeNodeReadEntity` ("nó inteiro"): busca a
árvore inteira e filtra/ordena/limita em memória, sem precisar reconhecer
formato nem de `.indexOn` novo — escolhido por essas duas coleções serem
pequenas o bastante (dezenas/poucas centenas de docs) pra tornar isso
barato. A etapa 3c migrou `SystemLog` — coleção GRANDE (milhares de docs),
então usa o MESMO modo order+limit de `SignalEvent`/`TradeOperation`
(`createRtdbReadEntity`), não o "nó inteiro"; precisou primeiro endurecer
`toRtdbKey()` (`src/lib/rtdbMirror.js`) com truncagem por bytes + hash
determinístico, porque o `scanErrorDedupKey` de `scanner.js` embute
`err.message` (texto livre, sem contrato de tamanho) e RTDB rejeita chaves
acima de ~768 bytes — e exigiu inverter a ordem de composição do wrapper
(`makeResilientLogEntity(withRtdbMirror(...))`, resiliência por FORA do
mirror, nunca o contrário — a ordem errada mirrora `{id:null,...}` numa
falha real, gravando toda escrita que falha na mesma chave
`systemLogs/null`; travado por tripwire). Nenhuma etapa 3d está planejada —
`PriceAlert`/`User` seguem fora por falta de consumidor de produção. **Mesma
disciplina do adaptador**:
`firebase/database`/`firebase-admin/database` **nunca** são importados direto
em componente/página — só via `src/api/rtdbEntities.js` (leitura) e o mirror
interno de `src/api/entities.js`/`scripts/adminEntities.js`
(`src/lib/rtdbMirror.js`, escrita). RTDB é **read-only** para o dashboard:
toda mutação continua exclusivamente por `backend.entities`/`backend.tradeOps`
(Firestore) — o mirror só espelha DEPOIS que a transação real já resolveu,
nunca participa dela. Ver `docs/known-risks.md` item 152.

## Concorrência

- **Uma op ativa por ativo** — desde o cutover, garantida por um **índice
  único parcial** em Postgres (`trade_operations_active_anchor_uq`, coluna
  `active_ops_anchor`) em vez do doc-âncora `assetActiveOps/{assetId}` do
  Firestore — detalhe completo do mecanismo e por que `SELECT ... FOR
  UPDATE` sozinho não bastava em `db/CLAUDE.md`. `assetActiveOps` só existe
  mais dentro de `entitiesFirestoreLegacy.js` (referência de rollback);
  `clearActiveOp` virou no-op documentado no adaptador Postgres — o índice
  libera o ativo sozinho quando o `UPDATE` grava um status terminal.
- O **lock de scan** (`scannerLocks`/`scanner_locks`,
  `acquireScanLock`/`releaseScanLock`) é *fail-open* (loga e prossegue se
  falhar) — logo não é garantia forte, nos dois backends.
- Mutação de estado de `TradeOperation` **deve** ser transacional/idempotente
  quando o campo depende do valor atual (status, contadores) — ver os P0 em
  `.claude/rules/trading-engine.md`. Read-modify-write sem transação é bug
  aqui, no Postgres tanto quanto era no Firestore.

## Quota — histórico do plano Spark gratuito (~50k leituras / 20k escritas/dia)

**Não se aplica mais desde o cutover** — Postgres/Neon não tem teto diário
de operações (cobra por CU-hora/mês), motivo pelo qual o espelho RTDB acima
foi abandonado. Mantido aqui como contexto histórico de por que o código
tem os padrões que tem (buscar só o necessário, reaproveitar
`getPineConfig()` uma vez por scan, gravar log só quando há sinal/erro,
known-risks item 13) — bons padrões de qualquer forma, mas não mais uma
restrição rígida que bloqueia deploy.

## Regras

- Antes de alterar `firestore.rules`: rode `firebase deploy --only
  firestore:rules` e confirme que não sobrou `allow read, write: if true`.
  Regras/índices só valem após deploy (manual — ver `.claude/rules/ci-deploy.md`).
- Coleções de negócio: `isSignedIn()`. `users/{uid}`: dono only, sem auto-set de
  `role`. `agentConversations/*/messages`: read-only no client.

## Testes de concorrência — sem Firestore Emulator (decisão do usuário)

Teste de concorrência real deste projeto (CAS de `TradeOperation`, doc-âncora
`assetActiveOps`) usa um **backend fake em memória**
(`src/lib/__fixtures__/fakeBackend.js`, introduzido no PR #45) que
reaproveita a regra pura real (`canApplyTransition`/`isTerminalStatus`), não
o Firestore Emulator Suite — decisão formal, ver `docs/known-risks.md`
item 19.
