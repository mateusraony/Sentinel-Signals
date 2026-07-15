---
description: Regras de segurança — secrets, autorização Firestore, webhook e superfície do server. Carregue ao mexer em firestore.rules, server/**, telegram, .env, render.yaml.
paths:
  - firestore.rules
  - server/**
  - src/lib/telegram.js
  - src/lib/apiBackend.js
  - .env.example
  - render.yaml
---

# Segurança — não regrida

- **Secrets de terceiros nunca no client.** Exceção temporária **consciente**: o
  token do Telegram do canal "ao vivo" (`src/lib/telegram.js`, decisão do
  usuário). **Não estenda** esse padrão a novas integrações. Chaves de servidor
  (webhook, service account) só em env do Render / GitHub Actions, nunca no
  bundle nem no repo.
- **`firestore.rules` é a fonte de verdade de autorização** — não confie em
  checagem client-side. Antes de editar, `firebase deploy --only
  firestore:rules` e confira que não há `if true`. Promoção a admin (`role`) é
  manual (console/Admin SDK), nunca exposta no client.
- **Webhook `server/`** (`POST /webhook/tradingview`): valida `WEBHOOK_SECRET`,
  **só loga + notifica Telegram, nunca envia ordem**. CORS restrito a
  `ALLOWED_ORIGIN` (nunca `*` em produção). Qualquer evolução p/ execução real
  exige revisão completa (ver `.claude/rules/trading-safety.md`).
- **Nunca** imprima/commite tokens, service accounts ou `.env*`. `.env.example` é
  versionado e só documenta nomes — nunca valores.
- Mudança de segurança/secrets/execução → rode a skill `sentinel-security-review`
  (menor privilégio, blast radius, rollback).
