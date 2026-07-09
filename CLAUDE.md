# Sentinel Signals

Painel de monitoramento de sinais de trading cripto. Escaneia pares via API pública da Binance, calcula indicadores técnicos (Range Filter, RSI, MACD, EMA), gera sinais de confluência multi-timeframe e gerencia o ciclo de vida de operações (entrada → TP1/TP2/stop → fechamento), com alertas via Telegram e um assistente de IA ("Strategy Reviewer") para revisão de disciplina operacional.

Este projeto foi originalmente gerado pela plataforma no-code **Base44** e exportado para o GitHub. Toda a dependência do Base44 (auth, banco de dados, agente de IA, build tooling, branding) foi removida e substituída por **Firebase**. Não reintroduza nenhuma referência a `@base44/*`, `base44.com` ou ao ecossistema Base44.

## Stack

- **Frontend**: Vite + React 18 (JSX, não TypeScript — `checkJs` via `jsconfig.json` é só best-effort), Tailwind CSS, shadcn/ui, TanStack Query, React Router. Hospedado como Static Site gratuito no **Render** (`render.yaml`, serviço `sentinel-signals`), build automático a cada push em `main`.
- **Backend**: Firebase
  - **Firestore** — banco de dados principal (NoSQL orientado a documentos).
  - **Authentication** — ver aviso abaixo, atualmente anônima temporária.
  - ~~Cloud Functions~~ — **não usadas.** O usuário recusou explicitamente o plano Blaze (não quer cadastrar cartão, não quer nenhum custo possível). Isso é uma restrição permanente do projeto, não temporária — não sugira Cloud Functions/Blaze de novo sem o usuário pedir. O código em `functions/` existe mas nunca foi (nem será) deployado.
- **`server/`** — pequeno backend Node/Express (verifica Firebase ID token, lê Firestore com `firebase-admin`), **não está deployado nem referenciado pelo frontend agora**. Foi construído para segurar secrets de API fora do browser, mas o usuário optou explicitamente por configurar o Telegram direto na página (ver "Estado atual — Telegram e Strategy Reviewer" abaixo). Fica reservado para quando o Strategy Reviewer precisar de um lugar para guardar a chave da Anthropic — só nesse momento adicione o serviço de volta a `render.yaml` e aponte o frontend para ele.

## Arquitetura de dados

`src/api/entities.js` exporta `backend`, um adaptador fino sobre o Firestore que espelha `backend.entities.<Nome>.{list,filter,create,update,delete,bulkCreate,deleteMany}`. Ele existe para que ~20 arquivos consumidores (`src/lib/scanner.js`, `src/lib/logger.js`, `src/lib/pineParser.js`, a maioria das páginas/componentes) não precisem conhecer detalhes do Firestore diretamente. Ao adicionar uma nova entidade, siga o mesmo padrão (`createEntity('nomeDaColecao')`) em vez de chamar `firebase/firestore` direto nos componentes.

Coleções (nome do arquivo em `docs/schema-reference/*.jsonc` → coleção real):

| Schema de referência | Coleção Firestore |
|---|---|
| `MonitoredAsset.jsonc` | `monitoredAssets` |
| `AssetState.jsonc` | `assetStates` |
| `SignalEvent.jsonc` | `signalEvents` |
| `TradeOperation.jsonc` | `tradeOperations` |
| `PriceAlert.jsonc` | `priceAlerts` |
| `SystemLog.jsonc` | `systemLogs` |
| `User.jsonc` | `users` (perfil `{ role: 'admin'|'user' }`, chave = uid do Firebase Auth) |

Outras coleções sem `.jsonc` de referência (criadas já pensando em Firestore, sem equivalente Base44): `agentConversations/{id}/messages` (chat do Strategy Reviewer, não usada no momento — ver abaixo), `telegramConfig/{uid}` (também não usada no momento — o chat_id do Telegram vive só no `localStorage` do navegador agora).

`src/api/agents.js` (`strategyReviewerAgent`, exposto como `backend.agents`) segue o mesmo espírito: mesma forma de chamada (`listConversations`, `createConversation`, `getConversation`, `addMessage`, `subscribeToConversation`) que a página `StrategyReviewer.jsx` usava — hoje `StrategyReviewer.jsx` está substituída por um placeholder "em breve" (ver aviso abaixo) e não chama mais essas funções.

## ⚠️ Estado atual — auth, Telegram e Strategy Reviewer

A pedido explícito do usuário, três pontos do plano original de segurança (Fases 1 e 4 da migração) foram deliberadamente revertidos ou pausados. Não "corrija" nenhum dos três sem o usuário pedir — cada reversão já foi discutida e é intencional:

1. **Sem tela de login.** `AuthContext.jsx` faz `signInAnonymously()` automaticamente em vez de exigir email/senha — qualquer pessoa com a URL entra sem senha (as regras do Firestore continuam exigindo `isSignedIn()`, então o banco não fica 100% público, mas também não há controle de quem acessa). `Login.jsx` e `UserNotRegisteredError.jsx` continuam no repo, só não são renderizados por `App.jsx`. Reativar exige: voltar a ramificação `isAuthenticated`/`Login` em `App.jsx` (ver histórico do arquivo) e desligar o `signInAnonymously` de `AuthContext.jsx`.
2. **Telegram configurado direto no navegador (canal "ao vivo").** `src/lib/telegram.js`/`TelegramSettings.jsx` voltaram ao modelo original: Bot Token + Chat ID salvos em `localStorage`, mensagens enviadas direto do browser para `api.telegram.org` — só funciona com a aba aberta. Isso reintroduz o risco de exposição do token via XSS/devtools que a Fase 4 da migração original corrigiu — decisão consciente do usuário, que preferiu simplicidade a essa camada de segurança para esse canal específico. `server/` e `src/lib/apiBackend.js` (a versão que mandava tudo por um backend) existem no repo, só não são usados. **O canal 24h (ver seção "Scan agendado" abaixo) é separado e usa o token com segurança, fora do browser.**
3. **Strategy Reviewer pausado.** `src/pages/StrategyReviewer.jsx` mostra só uma mensagem "em breve" — o chat de IA real (`src/api/agents.js`, tabela `agentConversations`) segue implementado mas não conectado a nenhum backend. Para reativar: adicionar uma rota em `server/` que chame a API da Anthropic (mesmo padrão do `/api/telegram-notify` que já existe lá), colocar o serviço de volta em `render.yaml`, reconectar `StrategyReviewer.jsx` a `backend.agents.*`.

## Scan agendado (GitHub Actions) — funciona sem navegador aberto

O escaneamento de mercado normalmente só roda enquanto alguém tem a aba do app aberta (`src/hooks/useAutoScan.js`, client-side). Para não depender disso, `.github/workflows/scan.yml` roda a cada 5 minutos (mínimo permitido pelo GitHub Actions), gratuito, sem cartão, mesmo com o navegador/computador do usuário desligados.

- `scripts/run-scan.mjs` chama `scanAllAssets()`/`priceCheckActiveOps()` **de `src/lib/scanner.js` sem modificação** — a mesma lógica de trading roda no browser e no cron job, evitando duas implementações divergindo com o tempo.
- Isso só é possível porque `scripts/build-scan.mjs` empacota o script com `esbuild` antes de rodar, redirecionando três imports para versões compatíveis com Node (o resto do grafo de dependências — indicadores, `marketDataProvider.js` — já era puro/sem API de browser):
  - `@/api/entities` → `scripts/adminEntities.js` (mesma forma de chamada de `src/api/entities.js`, mas com `firebase-admin` em vez do SDK client — usa a service account, ignora as `firestore.rules`, como convém a um job de confiança)
  - `./telegram` → `scripts/adminTelegram.js` (mesmas funções `notify*`, mas lê `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` de variáveis de ambiente em vez de `localStorage`)
  - `./pineParser` → `scripts/adminPineConfig.js` (retorna os `DEFAULTS` fixos — não existe cópia server-side do Pine Script customizado pelo usuário; se `minScore`/`tp1R`/`tp1QtyPercent`/`trailAtrMult` forem alterados na página Pine Script, atualize os dois lugares manualmente. `rf_period`/`rf_multiplier` não têm esse problema, já ficam salvos por ativo no Firestore via `syncPineToAssets`.)
- Rodar localmente: `npm run scan` (variáveis de ambiente `FIREBASE_SERVICE_ACCOUNT_JSON`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` — as duas últimas podem ser qualquer string para testar sem enviar mensagem real).
- Segredos do workflow (GitHub → repo → Settings → Secrets and variables → Actions): `FIREBASE_SERVICE_ACCOUNT_JSON` (chave de service account do Firebase — Console Firebase → Configurações do projeto → Contas de serviço), `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.
- `scripts/dist/` é o output do esbuild — gitignored (via a entrada genérica `dist` no `.gitignore`), não commitar.

## Segurança — regras já estabelecidas, não regrida

1. **Secrets de terceiros nunca no client, quando existirem.** Isso está temporariamente violado para o Telegram (ver item 2 acima, decisão do usuário) — não estenda esse padrão para novas integrações sem perguntar. Se/quando o Strategy Reviewer for religado, a chave da Anthropic vai para `server/` (env var do Render), nunca para o bundle do frontend.
2. **`firestore.rules` é a fonte de verdade de autorização**, não confie em checagem client-side. Padrão usado: coleções de negócio liberadas para qualquer usuário `authenticated` (inclusive anônimo, ver aviso acima); `users/{uid}` só pode ser criado/editado pelo próprio dono e nunca pode setar `role != 'user'` a partir do cliente (promoção a admin é manual, via Firestore console ou Admin SDK — nunca exponha esse caminho no client); `agentConversations/{id}/messages` é somente-leitura para o client.
3. Antes de mudar `firestore.rules`, rode `firebase deploy --only firestore:rules` (ou o script direto via Firebase Rules API se o `firebase-tools` reclamar de permissão) e confira que não sobrou nenhuma regra `allow read, write: if true`.

## Rodando localmente

```
npm install
cp .env.example .env.local   # preencha com o config do Web App (Console Firebase > Configurações do projeto > Seus apps)
npm run dev
```

Scripts: `npm run dev`, `npm run build`, `npm run lint` / `npm run lint:fix`, `npm run typecheck` (ver limitação abaixo), `npm run preview`.

## Deploy

**Frontend (Render, 100% gratuito, sem cartão):** `render.yaml` define o Static Site `sentinel-signals`. Um Blueprint do Render conectado ao repo republica automaticamente a cada push em `main`.

**Firestore (Firebase, plano Spark/gratuito — suficiente, não precisa de Blaze):**
```
firebase deploy --only firestore:rules,firestore:indexes
```
Se a conta de serviço/CLI usada não tiver permissão (erro de `serviceusage.googleapis.com`), use o script direto via Firebase Rules API em vez do `firebase-tools` (ver histórico do PR de migração para o padrão usado).

## Limitações conhecidas (não é regressão desta migração)

- **`npm run typecheck` não está no CI** e tem ~80 erros pré-existentes — a maioria vem do `checkJs` do TypeScript tentando inferir tipos por cima dos componentes shadcn/ui baseados em `forwardRef` (ex: `Property 'className' does not exist on type '{}'`), mais alguns gaps reais (`import.meta.env` sem os tipos do cliente Vite). Corrigir isso é um projeto separado (converter para `.d.ts`/JSDoc consistente ou migrar para TS de verdade), não algo para resolver ad-hoc.
- Bundle principal (`dist/assets/index-*.js`) passa de 500kB minificado — Vite avisa mas não falha o build. Rota para melhorar: `build.rollupOptions.output.manualChunks` ou `import()` dinâmico nas páginas mais pesadas (`MonthlyReport.jsx` usa `jspdf`, por exemplo).
- `react-hooks/exhaustive-deps` está ativo como `warn` (não `error`) — há warnings intencionais (ex: `useAutoScan.js` usa `[]` de propósito para não reiniciar o timer de polling a cada re-render; `AssetCard.jsx` depende só do `.id` do sinal/operação para não disparar a animação de novo a cada refetch). Não "corrija" esses warnings sem entender por que a dependência foi omitida.

## Convenções

- Import de módulos internos sempre via alias `@/` → `src/` (configurado em `vite.config.js` `resolve.alias` **e** `jsconfig.json` `paths` — os dois precisam ficar em sincronia, não é automático).
- Logging estruturado: use `logInfo`/`logWarn`/`logError`/`logDebug` de `src/lib/logger.js` (grava em `SystemLog`, visível no botão de Debug Log da UI) em vez de `console.*` solto ou catches vazios silenciosos.
- Não adicione dependências novas sem confirmar que serão de fato usadas — este projeto já teve várias dependências mortas removidas (`lodash`, `react-quill`, `three`, `html2canvas`, `canvas-confetti`, `react-leaflet`, pacotes do Stripe) por terem sido scaffolding do template Base44 nunca conectado a nada.
