# Sentinel Signals

Painel de monitoramento de sinais de trading cripto: escaneia pares via API
pública da Binance, calcula indicadores (Range Filter, RSI, MACD, EMA, ATR, ADX,
Choppiness, estrutura SMC/ICT) e gerencia o ciclo de vida de operações (entrada,
TP1/TP2, stop, invalidação), com alertas via Telegram. Um assistente de IA
("Strategy Reviewer") existe no código mas está **pausado** (placeholder "em
breve") — ver `CLAUDE.md`.

> ⚠️ **Painel de sinalização, não de execução.** O sistema apenas calcula níveis
> e atualiza o status das operações no Firestore — **nenhuma ordem é enviada à
> Binance** (TP/Stop são virtuais). Ver `docs/known-risks.md`.

## Stack

- **Frontend**: Vite + React 18 (JSX), Tailwind CSS, shadcn/ui, TanStack Query,
  React Router. Deploy como **Static Site gratuito no Render** (`render.yaml`,
  serviço `sentinel-signals`), build automático a cada push em `main`.
- **Backend**: **Firebase — apenas Firestore + Authentication.**
  - **Firestore**: banco de dados principal.
  - **Authentication**: anônima temporária durante o desenvolvimento
    (`signInAnonymously()`), sem tela de login por ora — decisão intencional,
    ver `CLAUDE.md`.
  - **Sem Cloud Functions / sem plano Blaze** (restrição permanente do projeto —
    o usuário não quer custo possível). O diretório `functions/` existe mas
    nunca é deployado.
- **`server/`** (Express, `firebase-admin`): **deployado no Render** como o
  serviço `sentinel-signals-api`. Recebe `POST /webhook/tradingview` (só loga e
  notifica o Telegram — nunca envia ordem), `GET /health` e
  `POST /api/telegram-notify` (este último não usado pelo frontend hoje).
- **Scan 24/7**: `.github/workflows/scan.yml` roda `scripts/run-scan.mjs` a cada
  5 min (gratuito, sem navegador aberto), reusando a mesma lógica de
  `src/lib/scanner.js`. Ver a seção "Scan agendado" em `CLAUDE.md`.

## Rodando localmente

```bash
npm install
cp .env.example .env.local   # preencha com o config do Web App do Firebase
npm run dev
```

O Web App config fica em **Console do Firebase → Configurações do projeto → Seus
apps**. As variáveis `VITE_FIREBASE_*` são chaves públicas do client SDK (não
secrets). Os secrets de outros contextos (scan agendado, `server/`) estão
documentados em `.env.example` e nunca vão para este repositório.

## Scripts

- `npm run dev` — servidor de desenvolvimento
- `npm run build` — build de produção
- `npm run lint` / `npm run lint:fix` — ESLint
- `npm test` — testes (Vitest); **rodam no CI** (`.github/workflows/ci.yml`)
- `npm run typecheck` — checagem de tipos (best-effort; **não roda no CI**, ver
  "Limitações conhecidas" em `CLAUDE.md`)
- `npm run scan` — roda o scan agendado localmente (precisa dos secrets de env)

## Firebase / Firestore

- Schema: `firestore.rules` (coleções e regras) + `docs/schema-reference/`
  (schema de referência de cada entidade).
- Deploy de regras/índices (**passo manual**, plano Spark gratuito — sem Blaze):
  ```
  firebase deploy --only firestore:rules,firestore:indexes
  ```
  Também disponível como workflow manual em `.github/workflows/deploy-firestore.yml`.

## Documentação do projeto

- `CLAUDE.md` — decisões arquiteturais, restrições permanentes, comandos e o
  roteador de capacidades do Claude Code.
- `docs/known-risks.md` — riscos conhecidos (aceitos/adiados e já corrigidos).
- `.claude/rules/` e `.claude/skills/` — regras condicionais por domínio e
  skills auto-ativadas (ver `CLAUDE.md`).
