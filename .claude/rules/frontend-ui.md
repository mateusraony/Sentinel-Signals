---
description: Regras de UI/UX (páginas e componentes React/shadcn). Carregue em tarefas visuais. Não alterar lógica de trading/backend numa tarefa de UI.
paths:
  - src/pages/**
  - src/components/**
---

# Frontend / UI

- **Escopo isolado.** Uma tarefa visual (layout, componente, responsividade,
  acessibilidade, gráfico, hierarquia visual) **não** deve alterar lógica de
  trading, scanner, Firestore ou regras de negócio. Se aparecer necessidade de
  mudar lógica, pare e trate como tarefa separada.
- **Stack existente.** Tailwind + shadcn/ui (Radix). Reuse os componentes de
  `src/components/ui/` e o padrão de composição já presente; não traga lib de UI
  nova sem confirmar uso real (o projeto já removeu várias dependências mortas).
- **Estado/dados** via TanStack Query e o adaptador `backend` — não busque
  Firestore direto no componente.
- **Erros de render** já têm rede de segurança (`src/components/ErrorBoundary.jsx`
  em `App.jsx` e `AppLayout.jsx`) — mantenha-a; logue via `logError`.
- **Não "corrija"** warnings de `exhaustive-deps` intencionais (`useAutoScan.js`,
  `AssetCard.jsx`) sem entender o motivo documentado.
- Para revisão visual estruturada, use a skill `sentinel-ui-review`.
