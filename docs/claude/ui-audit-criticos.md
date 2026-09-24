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

**Verificação rodada:** `npm run lint && npm test && npm run build &&
npm run typecheck:ratchet`. Não foi possível testar visualmente com dado
real — mesma limitação de sandbox sem credenciais Firebase já registrada
na auditoria original.

**PR:** https://github.com/mateusraony/Sentinel-Signals/pull/396.

**Correções pós-push (CI + review):**
- CI acusou regressão no `typecheck:ratchet` (17 erros vs. teto 16) —
  `reloadLabel` e outros props opcionais de `ErrorFallback.jsx` sem valor
  default faziam o TypeScript inferi-los como obrigatórios. Corrigido com
  defaults explícitos na desestruturação (commit `2a6b9dd`).
- Review automático (Codex) achou um bug real no C-3: os branches de
  `isError` substituíam dado em cache já carregado por uma tela de erro
  cheia sempre que um refetch em BACKGROUND falhava (não só na carga
  inicial). Corrigido nas 8 páginas: erro cheio só quando `isError` E não
  há nenhum dado em cache (commit `1d9fba5`).

## Revisão cética pós-merge (2026-09-24) — bugs reais achados e corrigidos

O usuário perguntou se os 3 críticos estavam mesmo corretos. Resposta
honesta: não 100% — rodei 2 revisões independentes e adversariais (Explore
agents instruídos a caçar problema, não confirmar) sobre o código já em
`main`, e elas acharam 3 bugs reais que eu não tinha pego (nem no commit
original, nem nas 2 rodadas de correção pós-CI/review do PR #396). Log
completo da revisão em `docs/known-risks.md` item 194.

- [x] **Trades.jsx afirmava "Nenhuma operação ativa." com confiança total
  mesmo quando a atualização tinha falhado** (achado mais sério). Se o
  cache só tinha operações fechadas e um refetch em background falhava, a
  condição `isError && operations.length === 0` (array bruto) não pegava
  o caso — caía direto no texto vazio, que é sobre `applyFilters(active)`
  (uma dimensão diferente, que muda com o tempo). Corrigido: quando
  `isError` E a lista ativa filtrada está vazia, mostra "Não foi possível
  confirmar se há operações ativas agora" em vez do texto confiante.
  **Arquivo:** `src/pages/Trades.jsx`. **Teste de regressão** em
  `src/pages/Trades.test.jsx` (confirmei que falha sem o fix, revertendo
  temporariamente, antes de reportar como corrigido).
- [x] **PerformanceMetricsBar badge "N ativas" divergia do resto do
  Dashboard.** Ao ganhar query própria de 500 (C-2a), o `activeCount`
  interno passou a vir dessa mesma query (refetch 120s) em vez do
  `tradeOps` de 100 do Dashboard (refetch 60s, mesmo array do StatsCard
  "Operações Ativas") — resolvi uma divergência e abri outra, menor, entre
  esse badge e o resto da página. Corrigido: `activeOpsCount` passa a vir
  via prop de `Dashboard.jsx` (mesmo array de sempre), só as métricas de
  performance (win rate/PnL/drawdown) continuam da query de 500.
  **Arquivos:** `src/components/dashboard/PerformanceMetricsBar.jsx`,
  `src/pages/Dashboard.jsx`.
- [x] **PerformanceReport.jsx: o rótulo do C-2b quebrava o grid.** "soma
  simples, não composta" colado ao sublabel (`${wins}W · ${be}BE ·
  ${losses}L · soma simples, não composta`, ~44 caracteres, sem
  `truncate`) ia quebrar linha num grid de 6 colunas e esticar a altura de
  todas as cards da mesma linha. Corrigido: disclaimer virou uma legenda
  única acima do grid inteiro (mesmo padrão do `Backtest.jsx`), sublabel
  do card voltou a ser só `W · BE · L`. **Arquivo:**
  `src/components/trades/PerformanceReport.jsx`.

**Registrado como backlog, não corrigido nesta rodada (decisão
consciente):**
- Nenhuma das 8 páginas do C-3 indica visualmente quando há erro mas o
  dado exibido é de cache (nenhum "atualizado há Xs"/aviso de staleness)
  — limitação aceita do design atual, não regressão; vira item de produto
  novo se o usuário quiser.
- `src/pages/Login.jsx`/`src/components/ProtectedRoute.jsx` são código
  morto (nenhuma rota aponta pra lá) mas têm um conflito latente com o
  `authError` global do C-1: se a tela de login for religada um dia, uma
  senha errada dispararia a tela cheia de erro do C-1 por cima do
  formulário (que já tem seu próprio erro local). Documentado como
  armadilha conhecida, não corrigido agora — é código desconectado.
- `QueryErrorState`'s `onClick={onRetry}` sem `.catch` defensivo — sem
  risco real hoje (nenhuma query usa `throwOnError`), fica como quick win
  barato se algum dia alguém ligar essa opção.

**Verificação rodada:** `npm run lint && npm test && npm run build &&
npm run typecheck:ratchet` — incluindo o teste novo de regressão.

**PR:** https://github.com/mateusraony/Sentinel-Signals/pull/397.

## Terceira revisão cética (2026-09-24) — os 3 fixes acima, mais 1 achado adjacente

O usuário perguntou de novo "tem certeza que não tem mais bug?" depois do
merge do PR #397. Antes de responder, rodei uma 3ª revisão cética — desta
vez sobre os 3 fixes que ninguém tinha revisado com ceticismo ainda (os da
rodada anterior). **Resultado: os 3 fixes em si estão corretos**, sem bug
novo neles — mas a revisão achou um problema real e adjacente que nenhuma
das 2 rodadas anteriores tinha coberto.

- [x] **Trades.jsx: "Avisos em análise"/"Observações de mercado" somem da
  tela sem nenhum aviso quando `recentSignals` falha.** As duas seções só
  renderizam com `.length > 0` — uma falha nessa query secundária (fora do
  escopo do C-3 original, que mirou a query PRINCIPAL de cada página) fazia
  as seções desaparecerem por completo, mesmo silêncio enganoso que o C-3
  deveria ter eliminado. Corrigido: aviso de erro sempre visível quando
  `isError` da query de sinais, com retry. **Arquivo:** `src/pages/Trades.jsx`.
  **Teste de regressão** em `Trades.test.jsx` (confirmado que falha sem o
  fix, mesmo processo de `git stash` das rodadas anteriores).

Achados confirmados como **sem problema** nesta rodada (não é lista vazia
por preguiça — a revisão checou de verdade): a lógica `isLoading`/`isError`
de Trades.jsx não tem estado ambíguo (react-query v5 trata os dois como
mutuamente exclusivos); o `refetch` é compartilhado corretamente; o
`activeOpsCount` do `PerformanceMetricsBar` tem fonte única, sem
possibilidade de divergir de novo; nenhum import morto nem variável
residual (`activeCount`); a legenda do `PerformanceReport.jsx` não tem
risco de overflow em mobile.

**Registrado como backlog (não é infinito — mas vale nomear o que ainda
não foi checado):** o mesmo padrão ("query secundária cujo `isError` nunca
é lido, seção inteira soma sem aviso") pode existir em outras das 8
páginas do C-3 além de Trades.jsx — não foi auditado sistematicamente
ainda, só encontrado por acaso neste caso específico. Próxima rodada, se o
usuário quiser fechar essa classe de bug por completo, seria auditar as
outras 7 páginas atrás do mesmo padrão, não assumir que só Trades.jsx tinha.

## Varredura sistemática das outras 7 páginas (2026-09-24) — item 196

Pendência registrada pelo item 195 ("o mesmo padrão pode existir em
queries secundárias de outras páginas, não auditado sistematicamente")
virou tarefa: usuário pediu a varredura completa e, com os achados em
mãos, pediu para corrigir tudo na mesma rodada. Detalhe completo por
página, incluindo os textos exatos e o raciocínio de cada prop nova, em
`docs/known-risks.md` item 196 — resumo abaixo.

- [x] **`SignalChecklist.jsx` — ENTRADA LIBERADA falsa (achado mais grave
  de toda a série 193-196).** Único componente do painel que emite um
  veredito operacional afirmativo (verde/vermelho); mostrava "ENTRADA
  LIBERADA" quando a query de operações ativas só tinha FALHADO, não
  confirmado ausência real. Nova prop `tradeOpsUnavailable` degrada esse
  caso específico para "NÃO VERIFICADO" (âmbar) — um bloqueio já conhecido
  continua válido. Usado por `Verification.jsx` e `AssetDrawer.jsx`.
- [x] **Verification.jsx** — checklist escondido de todas as tarefas
  quando `monitored-assets-verification` falhava (guarda `asset &&`
  removida); `resend()` podia reenviar com o filtro POR ATIVO do Telegram
  silenciosamente substituído pelo global na mesma falha (botão desativado
  agora); badge "N pendente(s)" virava "0" implícito, agora diz "não
  verificado".
- [x] **Dashboard.jsx** — 3 queries secundárias (`asset-states`,
  `recent-signals`, `trade-operations-dashboard`) sem `isError` afetavam em
  cascata: 5 `StatsCard` (nova prop `error`, bypassa o `AnimatedNumber` que
  coage qualquer sentinel string pra 0), `RecentAlertsList`,
  `PredictiveAnalysis`, `ComparePanel` ("Livre" falso → "Não verificado"),
  `AssetCard` (badge `OP?` novo), `AssetDrawer` (mensagens distintas),
  `VerificationWidget` (`return null` incondicional escondia o widget
  inteiro numa falha), filtro de TF.
- [x] **Assets.jsx** — filtros "🎯 Próximos"/"⚡ Sinais" escondiam todos os
  ativos na mesma falha das queries correspondentes;
  `AssetDetailPanel`'s "Sem dados" virou "Falha ao carregar" quando a
  causa é a query, não ausência real de dado.
- [x] **Backtest.jsx** — `QuickBacktestTab`'s seletor de ativo ficava
  vazio e o botão travado sem explicação quando `all-assets` falhava.
- [x] **TradeHistory.jsx/Alerts.jsx/Logs.jsx** — confirmadas limpas, sem
  achado forçado.
- [x] **Efeito colateral corrigido:** duas mensagens novas sem `onRetry`
  regrediram o `typecheck:ratchet` (16→18) — `QueryErrorState` ganhou
  defaults explícitos nas props opcionais (mesma causa raiz do bug do
  `ErrorFallback.jsx` no item 193). Teto voltou a 16.

**Nota sobre o processo:** o primeiro teste de regressão do
`SignalChecklist` falhou mesmo com o fix "aplicado" — a lógica nova
(`verdictUncertain`) tinha sido computada mas esquecida no JSX. O teste
pegou isso antes de qualquer revisão externa pedir. Detalhe em
`docs/known-risks.md` item 196.

**Verificação rodada:** `npm run lint && npm test && npm run build &&
npm run typecheck:ratchet` — incluindo os testes novos
(`SignalChecklist.test.jsx`, `Verification.test.jsx`), ambos confirmados
falhando sem o fix via `git stash`.

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
