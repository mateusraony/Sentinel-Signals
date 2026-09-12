# src/api — adaptador de dados (cutover Firestore→Postgres/Neon)

Todo acesso a dados passa pelo adaptador `backend` (`src/api/entities.js`).
**Desde o cutover** (item 2 do runbook, `docs/claude/postgres-cutover-
runbook.md`), `entities.js` é um cliente HTTP para o `sentinel-signals-api`
(Postgres/Neon) — mesma forma externa de sempre
(`backend.entities.<Nome>.{list,filter,get,set,create,createUnique,update,
delete,bulkCreate,deleteMany}`, `backend.locks`, `backend.tradeOps`). O
adaptador Firestore original foi preservado, intocado, como
`src/api/entitiesFirestoreLegacy.js` — referência de rollback, não importado
por nenhum código de produção. `src/api/rtdbEntities.js` (espelho de leitura
RTDB) também não tem mais nenhum consumidor real — o atalho foi abandonado
no cutover (Postgres não tem teto diário de operações, motivo original do
mirror) — fica como código morto até a Fase 11 (decomissão). Seguir:

@../../.claude/rules/firestore-concurrency.md
