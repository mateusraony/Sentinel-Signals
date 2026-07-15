---
description: CI, deploy e o scan agendado. Carregue ao mexer em workflows, render.yaml ou scripts.
paths:
  - .github/workflows/**
  - render.yaml
  - scripts/**
  - firebase.json
---

# CI / Deploy / Scan agendado

## Workflows

- `ci.yml` — lint + `npm test` + build a cada push/PR. Alerta Telegram em falha.
- `scan.yml` — cron `*/5` (mínimo do GitHub Actions), `npm run scan`. **Relógio
  de trading**: pode atrasar e o `schedule` desativa após ~60 dias sem push
  (mitigado pelo watchdog externo `HEALTHCHECKS_PING_URL`, known-risks 12).
- `keep-warm.yml` — ping `/health` a cada 10 min (Render free não hibernar).
- `backup.yml` — backup diário das coleções de negócio → branch `backups`.
- `deploy-firestore.yml` — deploy **manual** de rules/índices.

## Deploy

- **Frontend**: Render Static Site (`render.yaml` `sentinel-signals`), automático
  a cada push em `main`. Não migrar para Vercel/Netlify (decisão do usuário).
- **`server/`**: Render `sentinel-signals-api` (Node). Secrets `sync: false` são
  setados no dashboard do Render, nunca no repo.
- **Firestore rules/índices**: passo **manual** —
  `firebase deploy --only firestore:rules,firestore:indexes` (ou o workflow).
  Plano Spark gratuito, **sem Blaze/Cloud Functions**.

## Regras

- O scan roda `src/lib/scanner.js` sem modificação via esbuild
  (`build-scan.mjs`). Ao mudar imports do scanner, verifique os 3 redirecionamentos
  Node (`adminEntities`/`adminTelegram`/`adminPineConfig`). `scripts/dist/` é
  gitignored — não commitar.
- Não adicione custo (nada que exija Blaze/cartão) sem pedido explícito.
