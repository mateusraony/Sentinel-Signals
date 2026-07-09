# Sentinel Signals

Painel de monitoramento de sinais de trading cripto: escaneia pares via API pública da Binance, calcula indicadores (Range Filter, RSI, MACD, EMA) e gerencia o ciclo de vida de operações (entrada, TP1/TP2, stop, invalidação), com alertas via Telegram e um assistente de IA para revisão de estratégia.

## Stack

- **Frontend**: Vite + React 18, Tailwind CSS, shadcn/ui, TanStack Query
- **Backend**: Firebase — Firestore (dados), Authentication (login por email/senha), Cloud Functions (chat do Strategy Reviewer via API da Anthropic e envio de alertas do Telegram, ambos com secrets só no servidor)

## Rodando localmente

1. `npm install`
2. Crie um Web App no [Console do Firebase](https://console.firebase.google.com/) do seu projeto e copie a config para um `.env.local` (veja `.env.example`):
   ```
   VITE_FIREBASE_API_KEY=
   VITE_FIREBASE_AUTH_DOMAIN=
   VITE_FIREBASE_PROJECT_ID=
   VITE_FIREBASE_STORAGE_BUCKET=
   VITE_FIREBASE_MESSAGING_SENDER_ID=
   VITE_FIREBASE_APP_ID=
   ```
3. `npm run dev`

## Firebase

- Schema do Firestore: `firestore.rules` (coleções e regras de segurança) + `docs/schema-reference/` (schema original de cada entidade, como referência).
- Cloud Functions ficam em `functions/` e exigem o plano Blaze (pay-as-you-go) do Firebase, além dos secrets `ANTHROPIC_API_KEY` e `TELEGRAM_BOT_TOKEN` (`firebase functions:secrets:set <NOME>`).
- Deploy: `firebase deploy --only firestore,functions`.

## Scripts

- `npm run dev` — servidor de desenvolvimento
- `npm run build` — build de produção
- `npm run lint` / `npm run lint:fix` — ESLint
- `npm run typecheck` — checagem de tipos (JSDoc/TS via `jsconfig.json`)
