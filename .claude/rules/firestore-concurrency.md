---
description: Padrões de acesso ao Firestore — adaptador backend, transações, locks e quota do plano gratuito. Carregue ao mexer em src/api/**, firestore.rules, adminEntities.
paths:
  - src/api/**
  - firestore.rules
  - firestore.indexes.json
  - scripts/adminEntities.js
---

# Firestore — adaptador, concorrência e quota

## Adaptador (não fure a abstração)

Todo acesso passa por `backend` (`src/api/entities.js`): `backend.entities.<Nome>`,
`backend.locks`, `backend.tradeOps`. Nova entidade = `createEntity('colecao')`.
**Nunca** importe `firebase/firestore` direto em componentes/páginas. O cron usa
`scripts/adminEntities.js` (firebase-admin, mesma forma de chamada, ignora as
`firestore.rules`).

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

## RTDB — espelho de leitura (item 152)

`AssetState`/`TradeOperation` também são espelhadas no Firebase Realtime
Database (RTDB), absorvendo o polling do dashboard (`src/api/rtdbEntities.js`)
sem tocar a cota diária do Firestore. **Mesma disciplina do adaptador**:
`firebase/database`/`firebase-admin/database` **nunca** são importados direto
em componente/página — só via `src/api/rtdbEntities.js` (leitura) e o mirror
interno de `src/api/entities.js`/`scripts/adminEntities.js`
(`src/lib/rtdbMirror.js`, escrita). RTDB é **read-only** para o dashboard:
toda mutação continua exclusivamente por `backend.entities`/`backend.tradeOps`
(Firestore) — o mirror só espelha DEPOIS que a transação real já resolveu,
nunca participa dela. Ver `docs/known-risks.md` item 152.

## Concorrência

- **Uma op ativa por ativo** é garantida por transação de doc único em
  `assetActiveOps/{assetId}` (`createTradeOpIfNoneActive`/`clearActiveOp`) —
  Firestore não lê query dentro de transação, por isso o doc-âncora.
- O **lock de scan** (`scannerLocks`, `acquireScanLock`/`releaseScanLock`) é
  *fail-open* (loga e prossegue se falhar) — logo não é garantia forte.
- Mutação de estado de `TradeOperation` **deve** ser transacional/idempotente
  quando o campo depende do valor atual (status, contadores) — ver os P0 em
  `.claude/rules/trading-engine.md`. Read-modify-write sem transação é bug aqui.

## Quota (plano Spark gratuito: ~50k leituras / 20k escritas/dia)

Já houve corte de desperdício (known-risks item 13): buscar só o necessário
(`where(status, 'in', [...])` em vez de ler todo o histórico), reaproveitar
`getPineConfig()` uma vez por scan, gravar log só quando há sinal/erro. **Não
reintroduza** leituras/escritas que crescem com o histórico nem gravação por
passada sem candle novo.

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
