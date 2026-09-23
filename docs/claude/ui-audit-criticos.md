# Raio-X de UI/UX — status dos achados

Registro de progresso da auditoria de UI/UX pedida pelo usuário em
2026-09-23 (somente leitura, relatório completo publicado como Artifact:
https://claude.ai/artifact/TMJxxVWhyQxLw9QXMR8YZF). Log cronológico da
rodada em `docs/known-risks.md` item 193; índice de pendência em
`docs/roadmap.md`. Este documento é o **status vivo**, atualizado a cada
rodada de correção — não é um resumo escrito de uma vez só. Convenção:
`[x]` feito, `[ ]` pendente/não iniciado.

## Críticos (C-1 a C-3) — priorizados a pedido do usuário em 2026-09-23

- [x] **C-1 — Tela branca sem nenhum aviso quando a autenticação falha.**
  `AuthenticatedApp` (`src/App.jsx`) só checava `isLoadingAuth`, nunca
  `authError`. Corrigido: fallback visual extraído de `ErrorBoundary.jsx`
  para `src/components/ErrorFallback.jsx` (reuso, sem mudar o visual do
  `ErrorBoundary`); `AuthenticatedApp` agora renderiza esse fallback com
  botão de recarregar quando `authError` está presente.
  **Arquivos:** `src/App.jsx`, `src/components/ErrorFallback.jsx` (novo),
  `src/components/ErrorBoundary.jsx`.
- [x] **C-2a — 4 cards de performance do Dashboard usavam amostras
  diferentes de operações** (100 vs. 500), podendo divergir entre si.
  Corrigido: `PerformanceMetricsBar.jsx`/`PerformanceOverview.jsx` passam a
  ter query própria com a mesma `queryKey: ['trade-operations-closed-all']`
  já usada por `VirtualAccountCard.jsx`/`LiveConfidenceCard.jsx` (cache
  compartilhado pelo React Query, sem requisição extra) — os 4 cards agora
  sempre concordam. A prop `tradeOps` foi removida da chamada desses dois
  em `Dashboard.jsx`; o `tradeOps` de 100 itens do Dashboard continua igual
  para tudo que já usava (contadores de prioridade/atividade recente).
  **Arquivos:** `src/components/dashboard/PerformanceMetricsBar.jsx`,
  `src/components/dashboard/PerformanceOverview.jsx`,
  `src/components/dashboard/VirtualAccountCard.jsx` (comentário),
  `src/pages/Dashboard.jsx`.
- [x] **C-2b — PnL somado de duas formas diferentes (soma simples vs.
  composto) sem aviso**, em telas vizinhas. Corrigido: rótulo curto "soma
  simples, não composta" adicionado a `PerformanceReport.jsx` (sublabel do
  card "PnL Acumulado") e `TradeEntryMarkers.jsx` (abaixo do valor de
  "Curva de Capital") — mesma redação já validada em `Backtest.jsx:224`.
  Nenhum cálculo mudou, só o texto.
  **Arquivos:** `src/components/trades/PerformanceReport.jsx`,
  `src/components/trades/TradeEntryMarkers.jsx`.
- [x] **C-3 — Falha de rede indistinguível de "nada aqui" em 8 páginas.**
  Nenhuma lia `isError` do `useQuery` principal. Corrigido: novo componente
  compartilhado `src/components/QueryErrorState.jsx` (mesmo visual já usado
  em `CorrelationWidget.jsx`/`RFHistoryChart.jsx`), aplicado com
  `isError`/`refetch` da query principal de cada página, antes do estado
  "Nenhum X encontrado" existente.
  **Arquivos:** `src/components/QueryErrorState.jsx` (novo),
  `src/pages/Dashboard.jsx`, `src/pages/Assets.jsx`, `src/pages/Trades.jsx`,
  `src/pages/TradeHistory.jsx`, `src/pages/Verification.jsx`,
  `src/pages/Backtest.jsx`, `src/pages/Alerts.jsx`, `src/pages/Logs.jsx`.

**Verificação rodada:** `npm run lint && npm test && npm run build` (ver
resultado abaixo, atualizado após rodar). Não foi possível testar
visualmente com dado real — mesma limitação de sandbox sem credenciais
Firebase já registrada na auditoria original.

## Backlog do Raio-X ainda **pendente, não iniciado**

Nada abaixo foi tocado nesta rodada — listado aqui pra não passar a
impressão de que os 3 críticos resumem o relatório inteiro. Ordem e detalhe
completo no Artifact (seções C-E do relatório); resumo dos itens de
Alta prioridade (rótulos A-1 a A-15 no relatório):

- [ ] A-1 — `RecentAlertsList` finge ser clicável, não tem `onClick`.
- [ ] A-2 — Horário de abertura do candle sempre `-1h`, ignora o timeframe.
- [ ] A-3 — Logs.jsx diz "atualiza a cada 15s", o real é 2 minutos.
- [ ] A-4 — Aba "Sincronização" do Pine Script com números desatualizados.
- [ ] A-5 — Sidebar desktop sem nome acessível em nenhum dos 12 itens.
- [ ] A-6 — `title=` nativo em vez de Tooltip acessível (~15 arquivos).
- [ ] A-7 — Foco de teclado invisível em ~15 pontos (incl. Busca Global).
- [ ] A-8 — AssetCard só abre por clique de mouse, sem suporte a teclado.
- [ ] A-9 — LIVE/STALE com threshold fixo de 2h, impreciso.
- [ ] A-10 — "Geral" na Confiança ao Vivo mistura BUY/SELL sem aviso.
- [ ] A-11 — Filtro de prioridade Média/Baixa morto em Verification.
- [ ] A-12 — Modal de edição em Trades sem acessibilidade (Esc, foco).
- [ ] A-13 — Gráfico do RFHistoryChart sem eixos visíveis.
- [ ] A-14 — Feed de "o que aconteceu" efêmero/no fim do Dashboard.
- [ ] A-15 — AssetCard com ~20 blocos de informação, sem divulgação
  progressiva.
- [ ] Todos os itens de Média prioridade (M-1 a M-17), Refinamentos e a
  reorganização completa do Dashboard (seção L do relatório) — nada iniciado.

## Como continuar

Próxima rodada sugerida (não decidida): revisar este arquivo com o usuário
e escolher os próximos itens do backlog acima — provavelmente A-1
(falsa affordance) e A-3 (texto errado em Logs) são os quick wins mais
óbvios pra seguir, mas a decisão é do usuário.
