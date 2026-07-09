# Sentinel Signals

Painel de monitoramento de sinais de trading cripto. Escaneia pares via API pública da Binance, calcula indicadores técnicos (Range Filter, RSI, MACD, EMA), gera sinais de confluência multi-timeframe e gerencia o ciclo de vida de operações (entrada → TP1/TP2/stop → fechamento), com alertas via Telegram e um assistente de IA ("Strategy Reviewer") para revisão de disciplina operacional.

Este projeto foi originalmente gerado pela plataforma no-code **Base44** e exportado para o GitHub. Toda a dependência do Base44 (auth, banco de dados, agente de IA, build tooling, branding) foi removida e substituída por **Firebase**. Não reintroduza nenhuma referência a `@base44/*`, `base44.com` ou ao ecossistema Base44.

## Stack

- **Frontend**: Vite + React 18 (JSX, não TypeScript — `checkJs` via `jsconfig.json` é só best-effort), Tailwind CSS, shadcn/ui, TanStack Query, React Router.
- **Backend**: Firebase
  - **Firestore** — banco de dados principal (NoSQL orientado a documentos).
  - **Authentication** — login por email/senha.
  - **Cloud Functions** (Firebase Functions v2, Node 20, `onCall`) — única superfície onde secrets de API de terceiros (Anthropic, Telegram) existem. **Nunca** chame uma API de terceiros com uma chave/token direto do browser — sempre passe por uma Cloud Function.

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

Outras coleções sem `.jsonc` de referência (criadas já pensando em Firestore, sem equivalente Base44): `agentConversations/{id}/messages` (chat do Strategy Reviewer), `telegramConfig/{uid}` (chat_id de destino do Telegram).

`src/api/agents.js` (`strategyReviewerAgent`, exposto como `backend.agents`) segue o mesmo espírito: mesma forma de chamada (`listConversations`, `createConversation`, `getConversation`, `addMessage`, `subscribeToConversation`) que a página `StrategyReviewer.jsx` já usava.

## Segurança — regras já estabelecidas, não regrida

1. **Secrets só em Cloud Functions.** `ANTHROPIC_API_KEY` e `TELEGRAM_BOT_TOKEN` são secrets do Firebase Functions (`firebase functions:secrets:set NOME`), lidos só dentro de `functions/index.js` via `defineSecret(...).value()`. O client nunca recebe essas chaves.
2. **`firestore.rules` é a fonte de verdade de autorização**, não confie em checagem client-side. Padrão usado: coleções de negócio liberadas para qualquer usuário `authenticated` (app single-tenant atrás de login); `users/{uid}` só pode ser criado/editado pelo próprio dono e nunca pode setar `role != 'user'` a partir do cliente (promoção a admin é manual, via Firestore console ou Admin SDK — nunca exponha esse caminho no client); `agentConversations/{id}/messages` é somente-leitura para o client (só a Cloud Function, via Admin SDK, escreve, para ninguém conseguir forjar uma resposta do "assistente").
3. Antes de mudar `firestore.rules`, rode `firebase deploy --only firestore:rules` (ou o script direto via Firebase Rules API se o `firebase-tools` reclamar de permissão — ver seção Deploy) e confira que não sobrou nenhuma regra `allow read, write: if true`.

## Rodando localmente

```
npm install
cp .env.example .env.local   # preencha com o config do Web App (Console Firebase > Configurações do projeto > Seus apps)
npm run dev
```

Scripts: `npm run dev`, `npm run build`, `npm run lint` / `npm run lint:fix`, `npm run typecheck` (ver limitação abaixo), `npm run preview`.

## Deploy (Firebase)

O projeto Firebase (`sentinel-signals`) precisa estar no **plano Blaze** (pay-as-you-go) para Cloud Functions 2ª geração e Secret Manager — o plano Spark (gratuito) não suporta. A camada gratuita do Blaze é generosa; custo esperado para uso pessoal é ~R$0, mas exige cartão cadastrado.

```
firebase deploy --only firestore:rules,firestore:indexes,functions
```

Se a conta de serviço/CLI usada não tiver as permissões de IAM (`Cloud Functions Admin`, `Cloud Build Editor`, `Secret Manager Admin`, `Service Usage Consumer`, `Service Account User` — ou simplesmente `Editor`/`Owner`), o comando falha com erros de permissão do `serviceusage.googleapis.com`. Isso já aconteceu durante a migração inicial; resolvido concedendo esses papéis à service account no Console GCP (IAM & Admin).

## Limitações conhecidas (não é regressão desta migração)

- **`npm run typecheck` não está no CI** e tem ~80 erros pré-existentes — a maioria vem do `checkJs` do TypeScript tentando inferir tipos por cima dos componentes shadcn/ui baseados em `forwardRef` (ex: `Property 'className' does not exist on type '{}'`), mais alguns gaps reais (`import.meta.env` sem os tipos do cliente Vite). Corrigir isso é um projeto separado (converter para `.d.ts`/JSDoc consistente ou migrar para TS de verdade), não algo para resolver ad-hoc.
- Bundle principal (`dist/assets/index-*.js`) passa de 500kB minificado — Vite avisa mas não falha o build. Rota para melhorar: `build.rollupOptions.output.manualChunks` ou `import()` dinâmico nas páginas mais pesadas (`MonthlyReport.jsx` usa `jspdf`, por exemplo).
- `react-hooks/exhaustive-deps` está ativo como `warn` (não `error`) — há warnings intencionais (ex: `useAutoScan.js` usa `[]` de propósito para não reiniciar o timer de polling a cada re-render; `AssetCard.jsx` depende só do `.id` do sinal/operação para não disparar a animação de novo a cada refetch). Não "corrija" esses warnings sem entender por que a dependência foi omitida.

## Convenções

- Import de módulos internos sempre via alias `@/` → `src/` (configurado em `vite.config.js` `resolve.alias` **e** `jsconfig.json` `paths` — os dois precisam ficar em sincronia, não é automático).
- Logging estruturado: use `logInfo`/`logWarn`/`logError`/`logDebug` de `src/lib/logger.js` (grava em `SystemLog`, visível no botão de Debug Log da UI) em vez de `console.*` solto ou catches vazios silenciosos.
- Não adicione dependências novas sem confirmar que serão de fato usadas — este projeto já teve várias dependências mortas removidas (`lodash`, `react-quill`, `three`, `html2canvas`, `canvas-confetti`, `react-leaflet`, pacotes do Stripe) por terem sido scaffolding do template Base44 nunca conectado a nada.
