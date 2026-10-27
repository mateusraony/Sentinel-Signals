# Sentinel Signals

Painel de monitoramento de sinais de trading cripto: escaneia pares via API
pública da Binance, calcula indicadores (Range Filter, RSI, MACD, EMA, ATR, ADX,
Choppiness, estrutura SMC/ICT) e gerencia o ciclo de vida de operações (entrada,
TP1/TP2, stop, invalidação), com alertas via Telegram. Um assistente de IA
("Strategy Reviewer") existe no código mas está **pausado** (placeholder "em
breve") — ver `CLAUDE.md`.

> ⚠️ **Painel de sinalização, não de execução.** O sistema apenas calcula níveis
> e atualiza o status das operações no banco (Postgres/Neon) — **nenhuma ordem
> é enviada à Binance** (TP/Stop são virtuais). Ver `docs/known-risks.md`.

## Stack

- **Frontend**: Vite + React 18 (JSX), Tailwind CSS, shadcn/ui, TanStack Query,
  React Router. Deploy como **Static Site gratuito no Render** (`render.yaml`,
  serviço `sentinel-signals`), build automático a cada push em `main`.
- **Backend**:
  - **Postgres/Neon (plano gratuito)**: banco principal de **todas** as
    entidades de negócio (operações, sinais, ativos, configuração da estratégia
    etc.) desde o cutover de 2026-09-12 (`docs/claude/postgres-cutover-runbook.md`).
    ⚠️ O limite do plano gratuito que importa é a **cota de computação** (horas
    em que o banco fica acordado), não o espaço — ver `docs/known-risks.md`
    itens 282/283.
  - **Firebase (só Authentication + papel do usuário)**: autenticação anônima
    temporária (`signInAnonymously()`), sem tela de login por ora — decisão
    intencional, ver `CLAUDE.md`. O Firestore deixou de guardar dados de negócio.
  - **Sem Cloud Functions / sem plano Blaze** (restrição permanente do projeto —
    o usuário não quer custo possível). O diretório `functions/` existe mas
    nunca é deployado.
- **`server/`** (Express, `pg`, `firebase-admin`): **deployado no Render** como
  o serviço `sentinel-signals-api`. API das entidades sobre o Postgres, mais
  `POST /webhook/tradingview` (só loga e notifica o Telegram — nunca envia
  ordem), `GET /health` (keep-warm), `GET /ready` (checa o banco de verdade) e
  `POST /api/telegram-notify` (não usado pelo frontend hoje).
- **Scan 24/7**: `.github/workflows/scan.yml` roda `scripts/run-scan.mjs`
  (gratuito, sem navegador aberto), reusando a mesma lógica de
  `src/lib/scanner.js`. O ritmo de ~5 min vem de um disparo externo
  (cron-job.org → `workflow_dispatch`); o `schedule` do próprio workflow é só
  reserva horária. Ver a seção "Scan agendado" em `CLAUDE.md`.

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
- `npm run typecheck` — checagem de tipos (best-effort; no CI roda como
  **catraca** — o número de erros só pode descer, ver "Limitações conhecidas"
  em `CLAUDE.md`)
- `npm run scan` — roda o scan agendado localmente (precisa dos secrets de env)

## Banco de dados (Postgres/Neon) e Firebase

- **Postgres/Neon**: tabelas registradas em `ENTITY_TABLES`
  (`db/pgEntitiesCore.mjs`); schema de referência de cada entidade em
  `docs/schema-reference/`. **Mudança de schema é manual**, pelo workflow
  `.github/workflows/db-migrate.yml` (diferente do código, que sobe sozinho a
  cada push em `main`). Backup diário: `backup-postgres.yml`; restauração:
  `restore-postgres.yml` (manual — ainda não testada, ver `docs/known-risks.md`
  item 283).
- **Firebase** (plano Spark gratuito — sem Blaze): só Authentication e o papel
  do usuário (`users/{uid}.role`). Regras em `firestore.rules`; deploy
  (**passo manual**):
  ```
  firebase deploy --only firestore:rules,firestore:indexes
  ```
  Também disponível como workflow manual em `.github/workflows/deploy-firestore.yml`.

## Documentação do projeto

- `CLAUDE.md` — decisões arquiteturais, restrições permanentes, comandos e o
  roteador de capacidades do Claude Code.
- `docs/known-risks.md` — riscos conhecidos (aceitos/adiados e já corrigidos).
- `docs/roadmap.md` — o que está pendente e em que ordem (começa pelas
  prioridades de hoje).
- `.claude/rules/` e `.claude/skills/` — regras condicionais por domínio e
  skills auto-ativadas (ver `CLAUDE.md`).
