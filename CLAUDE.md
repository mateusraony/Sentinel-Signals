# Sentinel Signals

Painel de monitoramento de sinais de trading cripto. Escaneia pares via API
pública da Binance, calcula indicadores técnicos (Range Filter, RSI, MACD, EMA,
ATR, ADX, Choppiness, estrutura SMC/ICT), gera sinais de confluência
multi-timeframe e gerencia o ciclo de vida de operações (entrada → TP1/TP2/stop
→ fechamento), com alertas via Telegram. **É um painel de sinalização — nenhuma
ordem é enviada à exchange (TP/Stop são virtuais).**

Originado na plataforma no-code **Base44** e migrado para **Firebase**. Não
reintroduza `@base44/*`, `base44.com` nem nada do ecossistema Base44.

> Detalhe por domínio vive em `.claude/rules/`; riscos em `docs/known-risks.md`.
> Este arquivo é o índice permanente — mantê-lo **abaixo de ~200 linhas**.

## Stack

- **Frontend**: Vite + React 18 (JSX, não TS — `checkJs` é best-effort),
  Tailwind, shadcn/ui, TanStack Query, React Router. **Static Site gratuito no
  Render** (`render.yaml`, serviço `sentinel-signals`, deploy a cada push em `main`).
- **Backend**: Firebase — **apenas Firestore + Authentication**.
  - **Firestore**: banco principal (NoSQL).
  - **Auth**: anônima temporária (ver decisões abaixo).
  - **Sem Cloud Functions / sem Blaze** — restrição **permanente** (o usuário
    recusou cartão/custo). `functions/` existe mas nunca é deployado. Não sugira
    Cloud Functions/Blaze de novo sem pedido explícito.
- **`server/`** (Express + `firebase-admin`): **está deployado** no Render como
  `sentinel-signals-api`. Recebe `POST /webhook/tradingview` (só loga + notifica
  Telegram, **nunca envia ordem**), `GET /health`, `POST /api/telegram-notify`
  (não usado pelo frontend hoje). Secrets via env do Render (nunca no repo).

## Arquitetura de dados

`src/api/entities.js` exporta `backend`, um adaptador fino sobre o Firestore
(`backend.entities.<Nome>.{list,filter,create,update,delete,bulkCreate,deleteMany}`,
além de `backend.locks` e `backend.tradeOps`). ~20 arquivos consomem isso sem
conhecer o Firestore direto. Ao adicionar entidade, use `createEntity('colecao')`
— nunca chame `firebase/firestore` direto nos componentes.

| Schema de referência (`docs/schema-reference/*.jsonc`) | Coleção Firestore |
|---|---|
| `MonitoredAsset.jsonc` | `monitoredAssets` |
| `AssetState.jsonc` | `assetStates` |
| `SignalEvent.jsonc` | `signalEvents` |
| `TradeOperation.jsonc` | `tradeOperations` |
| `PriceAlert.jsonc` | `priceAlerts` |
| `SystemLog.jsonc` | `systemLogs` |
| `User.jsonc` | `users` (`{ role }`, chave = uid) |

Sem `.jsonc`: `scannerLocks` (lock de scan), `assetActiveOps/{assetId}` (garante
1 op ativa por ativo via transação de doc único), `strategyConfig/current`
(parâmetros de estratégia sincronizados painel↔cron), `agentConversations`
(Strategy Reviewer, pausado), `telegramConfig/{uid}` (não usado — chat_id vive no
`localStorage` hoje).

## ⚠️ Decisões intencionais — não "corrija" sem pedido

Revertidas/pausadas de propósito a pedido do usuário (ver `docs/known-risks.md`):

1. **Sem tela de login.** `AuthContext.jsx` faz `signInAnonymously()` — qualquer
   URL entra. `firestore.rules` ainda exige `isSignedIn()`. `Login.jsx` existe,
   só não é renderizado. Reativar exige mexer em `App.jsx` + `AuthContext.jsx`.
2. **Telegram direto no navegador (canal "ao vivo").** `src/lib/telegram.js` /
   `TelegramSettings.jsx`: token + chat_id em `localStorage`, envio direto do
   browser. Só funciona com a aba aberta. O **canal 24h** (scan agendado) é
   separado e usa o token com segurança, fora do browser.
3. **Strategy Reviewer pausado.** `src/pages/StrategyReviewer.jsx` é placeholder;
   `src/api/agents.js` segue implementado mas desconectado.

Outras decisões permanentes: **não** reintroduzir Base44; **não** usar Vercel/
Netlify (manter GitHub + Render + Firebase); **não** habilitar trading real;
**não** alterar algo funcional sem necessidade demonstrada.

## Scan agendado (GitHub Actions) — roda sem navegador

`.github/workflows/scan.yml` roda `scripts/run-scan.mjs` a cada 5 min (mínimo do
GitHub Actions, gratuito). `run-scan.mjs` chama `scanAllAssets()` /
`priceCheckActiveOps()` **de `src/lib/scanner.js` sem modificação** — mesma
lógica no browser e no cron. `scripts/build-scan.mjs` empacota com esbuild e
redireciona 3 imports para versões Node:

- `@/api/entities` → `scripts/adminEntities.js` (firebase-admin, ignora rules)
- `./telegram` → `scripts/adminTelegram.js` (lê token/chat_id de env)
- `./pineParser` → `scripts/adminPineConfig.js` (**lê `strategyConfig/current` do
  Firestore** — o mesmo doc que a página Pine Script escreve via `syncPineToAssets`;
  mantenha o par `DEFAULTS`/`SYNCED_STRATEGY_KEYS` espelhado com `src/lib/pineParser.js`).

Rodar local: `npm run scan`. Secrets do workflow (Settings → Secrets → Actions):
`FIREBASE_SERVICE_ACCOUNT_JSON`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`,
`HEALTHCHECKS_PING_URL` (opcional, watchdog). `scripts/dist/` é gitignored.

**Outros workflows**: `ci.yml` (lint + `npm test` Vitest + build a cada PR/push),
`backup.yml` (backup diário → branch `backups`), `keep-warm.yml` (ping `/health`
a cada 10 min p/ não hibernar o Render free), `deploy-firestore.yml` (deploy
manual de rules/índices).

## Segurança — não regrida (detalhe em `.claude/rules/security.md`)

1. Secrets de terceiros **nunca no client** (exceção temporária consciente: o
   token do Telegram do canal "ao vivo", decisão do usuário — não estenda).
2. **`firestore.rules` é a fonte de verdade de autorização.** Coleções de negócio
   liberadas p/ qualquer `isSignedIn()`; `users/{uid}` não pode setar `role` no
   client; promoção a admin é manual. Antes de mudar rules, rode
   `firebase deploy --only firestore:rules` e confira que não sobrou `if true`.
3. **Trading é read-only/virtual.** Nenhuma skill/ferramenta pode criar/cancelar
   ordem, mexer em posição/alavancagem ou habilitar live. Ver
   `.claude/rules/trading-safety.md`.

## Comandos

`npm run dev` · `npm run build` · `npm run lint` / `lint:fix` · `npm test` ·
`npm run typecheck` (best-effort) · `npm run scan` · `npm run preview`.

## Roteador de capacidades (o que carregar por tarefa)

Sempre **considere** todas as capacidades; **carregue/execute** só a relevante.
Skills em `.claude/skills/`, regras em `.claude/rules/` (carregam pelos
`CLAUDE.md` aninhados nas pastas de cada domínio).

| Tarefa | Ative |
|---|---|
| Bug | `sentinel-bug-audit` (reproduzir → teste de regressão → verificar) |
| Motor de trading | `sentinel-trading-engine-review` + `sentinel-state-machine-test` (concorrência, replay temporal) |
| Pine/indicador | `sentinel-pine-parity` (comparação barra a barra) |
| Visual/UI | `sentinel-ui-review` (não tocar lógica de negócio) |
| Segurança/secrets/exec | `sentinel-security-review` (menor privilégio, blast radius, rollback) |
| Milestone grande | `sentinel-release-gate` + plan mode |
| Decisão crítica | `sentinel-council-review` (revisores independentes) |
| Consulta histórica | `CLAUDE.md` → `.claude/rules/` → memória nativa |

## Limitações conhecidas (não são regressões)

- `npm run typecheck` **não está no CI** e tem ~80 erros pré-existentes (maioria
  `checkJs` sobre shadcn/ui `forwardRef`). Corrigir é projeto à parte.
- Bundle principal passa de 500kB (Vite avisa, não falha). Rota: `manualChunks`
  ou `import()` dinâmico (`MonthlyReport.jsx` usa `jspdf`).
- `react-hooks/exhaustive-deps` é `warn`; há omissões **intencionais**
  (`useAutoScan.js`, `AssetCard.jsx`) — não "corrija" sem entender o porquê.

## Convenções

- Imports internos via alias `@/` → `src/` (sincronizar `vite.config.js` +
  `jsconfig.json` — não é automático).
- Logging estruturado: `logInfo`/`logWarn`/`logError`/`logDebug` de
  `src/lib/logger.js` (grava em `SystemLog`) em vez de `console.*` ou catch vazio.
- Não adicione dependência nova sem confirmar uso real (este projeto já removeu
  várias dependências mortas do template Base44).

## Regras sempre carregadas (imports)

Princípios do dia a dia e política de trading valem em toda sessão. As demais
regras de `.claude/rules/` carregam pelos `CLAUDE.md` aninhados nas pastas de
cada domínio (`src/lib/`, `src/api/`, `src/pages/`, `src/components/`, `server/`,
`scripts/`, `.github/workflows/`).

@.claude/rules/operating-principles.md
@.claude/rules/trading-safety.md
