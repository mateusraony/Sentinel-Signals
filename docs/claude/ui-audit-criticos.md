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

## Backlog Alta prioridade — 1ª rodada (2026-09-24): A-1 e A-3 corrigidos

Primeiros 2 itens do backlog abaixo, pedido explícito do usuário pra
continuar pelos quick wins já sugeridos. Confirmado antes de mexer que os
dois ainda existiam no código atual (mudou bastante nas rodadas 194-196).

- [x] **A-1 — `RecentAlertsList` sem `onClick`, falsa affordance.**
  Reusado o padrão já existente em `AssetCard.jsx` (`onClick` → abre
  `AssetDrawer` via `setSelectedAsset`). Nova prop `onSelectAsset` +
  `assets` (pra resolver `asset_id` → objeto ativo); clique só age quando
  o ativo é encontrado. Limitação herdada (não nova): só mouse, sem
  teclado — mesmo gap já registrado como A-8, não duplicado aqui.
  **Arquivos:** `src/components/dashboard/RecentAlertsList.jsx`,
  `src/pages/Dashboard.jsx`. **Teste novo:**
  `RecentAlertsList.test.jsx` (falha sem o fix, confirmado via
  `git stash`).
- [x] **A-3 — `Logs.jsx` dizia "15s", real é 2min.** Texto trocado por
  valor derivado de `POLL_DIAGNOSTIC_MS` (não descola de novo se a
  constante mudar). **Arquivo:** `src/pages/Logs.jsx`.

**Verificação rodada:** `npm run lint && npm test && npm run build &&
npm run typecheck:ratchet` limpos (1977 testes). Revisão cética própria
do diff antes de reportar como pronto (pedido padrão do usuário para
toda implementação nesta sessão) — sem achado novo, detalhe completo em
`docs/known-risks.md` item 198.

## Backlog Alta prioridade — 2ª rodada (2026-09-24): A-2 corrigido

Usuário pediu pra seguir pelo que eu achasse melhor, sempre com os mesmos
padrões. Escolhido A-2 por já ter evidência concreta de uma leitura
anterior e por ser bug de DADO exibido (horário errado), não só
affordance/texto.

- [x] **A-2 — Horário de abertura do candle sempre `-1h`, ignora o
  timeframe.** `AssetCard.jsx` calculava a abertura subtraindo 1h fixa do
  fechamento (`last_candle_time`) — certo só pro TF 1h; com 4h/1d
  selecionados no "TF Quick Switcher", mostrava uma janela de candle
  errada (ex.: candle 4h real aparecia como se durasse 1h). Confirmado
  antes do fix que `last_candle_time` é mesmo o fechamento
  (`scanner.js:1491`) e que nenhum outro componente tinha o mesmo padrão
  (grep em todo `src/`). Nova constante local `TF_DURATION_HOURS`
  substitui o `1` fixo. **Arquivo:**
  `src/components/dashboard/AssetCard.jsx`. **Teste novo:**
  `AssetCard.test.jsx` (3 casos — 1h/4h/1d; 4h e 1d confirmados falhando
  sem o fix via `git stash`, 1h já estava correto).

**Verificação rodada:** `npm run lint && npm test && npm run build &&
npm run typecheck:ratchet` limpos (1980 testes). Revisão cética própria
sem achado novo, detalhe completo em `docs/known-risks.md` item 199.

## Backlog Alta prioridade — 3ª rodada (2026-09-24): A-9 corrigido

Investigação mostrou que o problema era mais profundo que um número errado
— `AssetCard.jsx`/`Assets.jsx` tinham cada um sua cópia duplicada do
cálculo, com threshold arbitrário (2h vs. cadência real de ~5min) e cego
ao caso "falha toda passada mas segue tocado". Perguntei ao usuário se o
fix devia ficar só na UI ou reusar a lógica de domínio já existente
(`assetHealthcheckReason`, o dead-man's-switch real do sistema) — a regra
`frontend-ui.md` pede pra parar e tratar como tarefa separada quando
aparece necessidade de mexer em lógica. **Usuário escolheu o fix
completo.**

- [x] **A-9 — LIVE/STALE com threshold fixo de 2h, impreciso.** Os 2
  cálculos duplicados (`lastScanMs > 2h`) viram uma chamada à mesma função
  pura `assetHealthcheckReason` (`src/lib/assetHealthcheck.js`,
  `graceMs=30min`, já testada, já usada pelo cron) — elimina a duplicação
  por construção e distingue 2 motivos (`'persistent_error'`, mais grave,
  vs `'silent'`) em vez de um "STALE" genérico. `scan_status` (ícone da
  ÚLTIMA passada, em `Assets.jsx`) fica intocado — sinal complementar, não
  o mesmo dado. **Arquivos:**
  `src/components/dashboard/AssetCard.jsx`, `src/pages/Assets.jsx`.
  **Testes novos:** `AssetCard.test.jsx` (+4 casos) e `Assets.test.jsx`
  (novo arquivo, 1 teste) — confirmados falhando sem o fix via
  `git stash` (o caso do `Assets.test.jsx` é revelador: sem o fix, os 3
  ativos de teste — inclusive os "velhos" — aparecem TODOS como "LIVE").

**Verificação rodada:** `npm run lint && npm test && npm run build &&
npm run typecheck:ratchet` limpos (1985 testes). Revisão cética própria
sem achado novo, detalhe completo em `docs/known-risks.md` item 200.

## Backlog Alta prioridade — 4ª rodada (2026-09-24): A-5 e A-8 corrigidos (metade do cluster de acessibilidade)

Cluster A-5/A-6/A-7/A-8. Começado pelos 2 itens concretos e bem
delimitados (A-5, A-8) — A-6 (`title=` nativo em ~15 arquivos) e A-7 (foco
de teclado invisível em ~15 pontos) são varreduras maiores, ficam pra uma
rodada separada.

- [x] **A-5 — Sidebar desktop sem nome acessível.** `MobileBottomNav` (no
  mesmo arquivo) já tinha o padrão certo (`aria-label`/`aria-current`) —
  só replicado pro `DesktopSidebar`, sem inventar nada novo. Nenhuma
  mudança visual. **Arquivo:** `src/components/layout/Sidebar.jsx`.
  **Teste novo:** `Sidebar.test.jsx` (2 casos; o 2º foi reforçado depois
  de notar que a 1ª versão passava mesmo sem o fix, porque
  `MobileBottomNav` já garantia sozinho).
- [x] **A-8 — AssetCard só abre por clique de mouse.** `role="button"` +
  `tabIndex={0}` + `onKeyDown` (Enter/Espaço). Achado da investigação: o
  precedente do projeto (`TradeHistory.jsx`) não cobre o caso do AssetCard
  porque ele tem 2 botões FILHOS interativos — resolvido com um guard
  (`e.target !== e.currentTarget`) em vez de mexer nos filhos. Foco
  visível via `focus-visible:ring-ring`, mesmo token já usado em ~7
  lugares do projeto. **Trade-off registrado, não corrigido**: aninhar
  `<button>`s reais dentro do `div[role="button"]` pede atenção extra de
  leitor de tela — aceito, sem alternativa simples sem redesenhar o card.
  **Arquivo:** `src/components/dashboard/AssetCard.jsx`. **Teste novo:**
  +4 casos em `AssetCard.test.jsx`, incluindo o caso de não duplicar a
  ação quando o Enter é apertado num botão filho.

**Verificação rodada:** `npm run lint && npm test && npm run build &&
npm run typecheck:ratchet` limpos (1991 testes). Revisão cética própria
sem achado novo, detalhe completo em `docs/known-risks.md` item 201.

## Backlog Alta prioridade — 6ª rodada (2026-09-24): A-4, A-10 e A-11 corrigidos

Usuário pediu pra seguir pelo que eu achasse melhor. Investigados os 3
itens isolados restantes de médio esforço (A-4, A-10, A-11) com 3 agentes
Explore em paralelo — todos confirmados como esforço pequeno, escopo
100% contido na camada de UI, em 3 arquivos independentes entre si.
Corrigidos na mesma rodada.

- [x] **A-4 — Aba "Sincronização" do Pine Script com números hardcoded.**
  `SYNC_NOTES` era um array de strings literais no escopo do módulo,
  nunca lia `parsedConfig` (o state que a aba "Editor" já usa
  corretamente). Virou `syncNotes`, um `useMemo` dentro do componente
  interpolando `parsedConfig.rng_per`/`.rng_qty`/`.minScore`/`.tp1R`/
  `.tier2Threshold`/`.timeStopT1/T2/T3`. O multiplicador de stop por Tier
  (2x/2.5x/3x ATR) continua literal de propósito — constante real do
  Pine, não editável. **Arquivo:** `src/pages/PineScript.jsx`. **Teste
  novo:** `PineScript.test.jsx` (não existia).
- [x] **A-10 — "Geral" na Confiança ao Vivo mistura BUY/SELL sem aviso.**
  `buy`/`sell` já eram calculados no mesmo `useMemo` que produz `all` —
  heurística nova (sinal bruto de `expectancyR` oposto nos 2 lados, sem
  exigir `conclusive` — quase sempre `false` neste projeto) mostra um
  badge "DIVERGENTE" em "Geral" quando os lados discordam, reusando o
  padrão visual do badge CONCLUSIVO/INCONCLUSIVO já existente. **Arquivo:**
  `src/components/dashboard/LiveConfidenceCard.jsx`. **Testes novos:** +3
  casos em `LiveConfidenceCard.test.jsx`.
- [x] **A-11 — Filtro de prioridade Média/Baixa morto em Verification.**
  `VerificationTask.priority` é sempre `'high'` por desenho
  (`scanner.js` só cria a tarefa dentro de `if (signal.priority ===
  'high')`) — "Média"/"Baixa" nunca mudavam o resultado da lista.
  Removidas as 2 opções mortas de `PRIORITY_FILTERS`. **Arquivo:**
  `src/pages/Verification.jsx`. **Teste novo:** describe block em
  `Verification.test.jsx` (já existia).

**Verificação rodada:** `npm run lint && npm test && npm run build &&
npm run typecheck:ratchet` limpos (1997 testes). Revisão cética própria
sem achado novo, detalhe completo em `docs/known-risks.md` item 202.

## Backlog Alta prioridade — 7ª rodada (2026-09-24): A-12, A-13 e A-14 corrigidos

Investigados os 4 itens restantes (A-12 a A-15) com 3 agentes Explore em
paralelo. A-12/A-13/A-14 confirmados como esforço pequeno, escopo 100%
contido na UI, corrigidos na mesma rodada. **A-15 deliberadamente deixado
de fora** — resolvê-lo por completo exige reorganizar a hierarquia visual
inteira do `AssetCard` (~470 linhas), melhor tratado junto da
reorganização completa do Dashboard (seção L do relatório), não como
correção pontual.

- [x] **A-12 — Modal de edição em Trades sem acessibilidade.**
  `EditModal` era uma `<div>` de overlay manual, sem Esc/focus trap/
  `role="dialog"`. Migrado pro `Dialog` do Radix (`src/components/ui/
  dialog.jsx`), mesmo padrão já usado em `Assets.jsx`/`Alerts.jsx` — corpo
  dos campos e botões de ação ficaram intactos. **Arquivo:**
  `src/pages/Trades.jsx`. **Teste novo:** describe block em
  `Trades.test.jsx` (role="dialog" + Esc fecha).
- [x] **A-13 — Gráfico RFHistoryChart sem eixos visíveis.** `<YAxis
  hide />`/`<XAxis hide />` removiam os eixos por completo. Removido
  `hide`, aplicado o padrão de estilo já usado em `PortfolioVsMarket.jsx`.
  **Arquivo:** `src/components/assets/RFHistoryChart.jsx`. **Teste novo:**
  describe block em `RFHistoryChart.test.jsx` (`.recharts-xAxis`/
  `.recharts-yAxis` presentes).
- [x] **A-14 — Feed "Alertas Recentes" no fim do Dashboard, sem link pra
  ver todos.** Movido pra logo após `TelegramStatusBanner` (antes do grid
  de ativos); adicionado link "Ver todos →" pra `/alerts`. **Arquivos:**
  `src/pages/Dashboard.jsx`, `src/components/dashboard/
  RecentAlertsList.jsx`. **Testes novos:** describe block em
  `RecentAlertsList.test.jsx` (link) + `Dashboard.test.jsx` (novo — ordem
  das seções via `compareDocumentPosition`).

**Verificação rodada:** `npm run lint && npm test && npm run build &&
npm run typecheck:ratchet` limpos (2001 testes). Revisão cética própria
sem achado novo, detalhe completo em `docs/known-risks.md` item 203.

## Backlog Alta prioridade — 8ª rodada (2026-09-24): A-6 (1ª sub-rodada) corrigido

Investigado A-6 (`title=` nativo em vez de `Tooltip` acessível) com
varredura completa: **a contagem real é 43 ocorrências em 16 arquivos**
(a auditoria original estimou "~15 arquivos" — a contagem de arquivos
bateu, a de ocorrências não). Grande demais pra uma rodada só, dividido
em sub-rodadas por padrão de fix (detalhe completo em
`docs/known-risks.md` item 204). Esta rodada cobre só a 1ª sub-rodada:
`Backtest.jsx` (3 ocorrências), escolhida por já usar `Tooltip` no mesmo
arquivo — menor risco, serve de piloto.

- [x] **A-6 (1ª sub-rodada) — `Backtest.jsx`.** Cabeçalhos "Expectância"/
  "Profit Factor" da tabela "Por cascata" (2 `<th title=...>`) viraram
  `Tooltip`/`TooltipTrigger asChild` envolvendo `<span tabIndex={0}>`
  (preserva semântica de tabela). Botão "Aplicar ao Scanner" desabilitado
  (1 `title=` condicional) ganhou wrapper focável em volta — achado
  adicional: eventos de mouse não chegam a `<button disabled>` nativo,
  então um Tooltip direto no botão nunca dispararia. **Arquivo:**
  `src/pages/Backtest.jsx`. **Teste novo:** `Backtest.test.jsx` (não
  existia).

**Verificação rodada:** `npm run lint && npm test && npm run build &&
npm run typecheck:ratchet` limpos (2003 testes). Revisão cética própria
sem achado novo, detalhe completo em `docs/known-risks.md` item 204
(inclui a divisão sugerida das próximas sub-rodadas de A-6 e a exceção
de código morto em `src/components/ui/sidebar.jsx`).

## Backlog Alta prioridade — 9ª rodada (2026-09-24): A-6 (2ª sub-rodada, Grupo 1) corrigida

Grupo 1 da divisão sugerida no item 204: botões interativos com `title=`
nativo, fix mecânico com `TooltipTrigger asChild`. 6 arquivos, 11
ocorrências reais.

- [x] **A-6 (2ª sub-rodada) — Grupo 1: botões ícone-só/interativos.**
  `Trades.jsx` (3), `Verification.jsx` (2), `VerificationWidget.jsx` (2),
  `TopBar.jsx` (2), `DebugLogButton.jsx` (1), `TriggerBacktestPanel.jsx`
  (1). **Achado real durante a implementação:** `title=` nativo também
  serve de fallback de nome acessível — botões ÍCONE-SÓ perderam o nome
  acessível por completo ao trocar só pelo Tooltip (visual/hover-only).
  Corrigido adicionando `aria-label` em todo botão ícone-só (os com texto
  visível não precisaram). Pego pela disciplina de rodar a suíte completa
  antes de declarar pronto — um teste pré-existente
  (`DebugLogButton.test.jsx`) quebrou por depender do `title=` removido.
  **Testes novos:** `VerificationWidget.test.jsx`/`TopBar.test.jsx`
  (componentes sem teste dedicado antes), + describe blocks novos em
  `Trades.test.jsx`/`Verification.test.jsx`/`Backtest.test.jsx`, +
  correção do teste pré-existente de `DebugLogButton.test.jsx`.

**Verificação rodada:** `npm run lint && npm test && npm run build &&
npm run typecheck:ratchet` limpos (2011 testes). Revisão cética própria,
detalhe completo em `docs/known-risks.md` item 205.

## Backlog Alta prioridade — 10ª rodada (2026-09-25): A-6 (3ª sub-rodada, `TradeCard.jsx`) corrigida

Componente mais usado do projeto (card de operação em `Trades.jsx`). 9
ocorrências, perfil diferente das duas rodadas anteriores: todas em
`<div>`/`<span>` não focáveis (nenhum `<button>`), mais parecido com o
padrão dos `<th>` de `Backtest.jsx` que com os botões do Grupo 1.

- [x] **A-6 (3ª sub-rodada) — `TradeCard.jsx`, 9 ocorrências.** 8
  viraram `Tooltip`/`TooltipTrigger asChild` com `tabIndex={0}` novo
  (badges "aberta"/status, "Tier", fonte do mercado, MFE/MAE, legenda de
  PnL em aberto, aviso de cotação desatualizada, célula de nível —
  preservando a condicional original de quando cada uma renderiza). A 9ª
  (agulha de preço na `LevelRail`, sem texto/foco) só perdeu o `title=`,
  sem `Tooltip` — decisão de design (Grupo 5): é decorativa e o
  `aria-label` do `<div role="img">` pai já cobre a mesma informação.
  **Testes novos:** `TradeCard.test.jsx` ganhou `TooltipProvider` no
  harness de render (mesma quebra já vista no item 205) + mock de
  `fetchCurrentPrice` (padrão de `useLivePrice.test.jsx`) pra exercitar
  as 2 ocorrências que dependem de preço real.

**Verificação rodada:** `npm run lint && npm test && npm run build &&
npm run typecheck:ratchet` limpos (2020 testes; teto de typecheck 16,
inalterado). Revisão cética própria (sem verificação visual via
navegador real — padrão mecânico idêntico às rodadas anteriores),
detalhe completo em `docs/known-risks.md` item 206.

## Backlog Alta prioridade — 11ª rodada (2026-09-25): A-6 (4ª sub-rodada, `EventTimeline.jsx`) corrigida

Componente compartilhado (`CandleBoundTag`/`DetectionLag` usados por
`TradeCard.jsx` e `TradeHistory.jsx`; `EventTimeline`/`fmtBRT` usados
direto por `Trades.jsx`). Rodada pequena: só 2 ocorrências de `title=`
nativo no arquivo inteiro, ambas em `<span>` não focável, mesmo Padrão 3
já usado nas 2 rodadas anteriores.

- [x] **A-6 (4ª sub-rodada) — `EventTimeline.jsx`, 2 ocorrências.**
  `CandleBoundTag` ("(vela)") e `DetectionLag` ("(detectado Xh depois)")
  viraram `Tooltip`/`TooltipTrigger asChild` com `tabIndex={0}` novo, sem
  casos especiais (nenhuma ícone-só, `disabled` ou decorativa).
  **Testes novos:** `EventTimeline.test.jsx` (não existia) — 2 casos do
  achado A-6 + 1 caso confirmando que o gate de `LAG_THRESHOLD_MS` do
  `DetectionLag` não foi alterado.

**Verificação rodada:** `npm run lint && npm test && npm run build &&
npm run typecheck:ratchet` limpos (2023 testes; teto de typecheck 16,
inalterado). Revisão cética própria (sem verificação visual via
navegador real — mesma ressalva de sempre), detalhe completo em
`docs/known-risks.md` item 207.

## Backlog Alta prioridade — 12ª rodada (2026-09-25): A-6 (5ª sub-rodada, `TradeHistory.jsx` + achado extra em `Trades.jsx`) corrigida

Varredura fresca do que sobrou do "Grupo 2" (badges/textos com
abreviação) encontrou 15 ocorrências reais restantes em 6 arquivos —
maior bloco isolado: `TradeHistory.jsx` (5). Durante a implementação,
achado extra: um `title=` de `Trades.jsx` (badge "desde {data}") tinha
ficado pra trás na 2ª sub-rodada (só cobriu botões) e a varredura nova
também o pulou por engano (excluiu o arquivo inteiro por já constar
"corrigido"). Corrigido junto.

- [x] **A-6 (5ª sub-rodada) — `TradeHistory.jsx` (5) + `Trades.jsx:282`
  (1).** Tier, "Situação rara", MFE, MAE e o resumo "N ambíguo(s)" do
  rodapé viraram `Tooltip`/`TooltipTrigger asChild` com `tabIndex={0}`
  novo — mesmo Padrão 3 das rodadas anteriores. **Testes novos:** 4 em
  `TradeHistory.test.jsx` (MFE/MAE exigem expandir o card primeiro) + 1
  em `Trades.test.jsx`.

**Verificação rodada:** `npm run lint && npm test && npm run build &&
npm run typecheck:ratchet` limpos (2028 testes; teto de typecheck 16,
inalterado). Revisão cética própria (sem verificação visual via
navegador real — mesma ressalva de sempre), detalhe completo em
`docs/known-risks.md` item 208.

## Backlog Alta prioridade — 13ª rodada (2026-09-25): A-6 (6ª sub-rodada, `AssetCard.jsx`/`SignalToast.jsx`/`SignalAlertBanner.jsx`) corrigida

3 arquivos pequenos, agrupados numa rodada só (5 ocorrências). 3 dos 5
compartilham o mesmo texto de tooltip ("Confluência de indicadores
técnicos..."); decisão: não extrair componente compartilhado (ganho de
DRY mínimo, markup em volta diferente em cada um) — mantido o padrão
mecânico de sempre.

- [x] **A-6 (6ª sub-rodada) — `AssetCard.jsx` (3) + `SignalToast.jsx`
  (1) + `SignalAlertBanner.jsx` (1).** Badges "OP?"/"Confl."/"Fund."
  (`AssetCard.jsx`) e "Score .../100" (`SignalToast.jsx`,
  `SignalAlertBanner.jsx`) viraram `Tooltip`/`TooltipTrigger asChild`
  com `tabIndex={0}` novo. Nuance verificada (não achado novo): o card
  do `AssetCard.jsx` já é `role="button"`/`tabIndex={0}` inteiro (A-8) —
  confirmado que a guarda existente no `onKeyDown` do card
  (`e.target !== e.currentTarget`) já protege contra duplicar a ação ao
  focar um filho, mesmo mecanismo que já protegia os `<button>`
  aninhados (TF Quick Switcher). **Testes novos:**
  `SignalToast.test.jsx`/`SignalAlertBanner.test.jsx` (não existiam) +
  3 casos novos em `AssetCard.test.jsx` (badge "Fund." exigiu mock
  controlável de `fetchMarkPrice`).

**Verificação rodada:** `npm run lint && npm test && npm run build &&
npm run typecheck:ratchet` limpos (2033 testes; teto de typecheck 16,
inalterado). Revisão cética própria (sem verificação visual via
navegador real — mesma ressalva de sempre), detalhe completo em
`docs/known-risks.md` item 209.

## Backlog Alta prioridade — 14ª rodada (2026-09-25): A-6 (7ª sub-rodada, `StatsCard.jsx` + `Assets.jsx:292`) corrigida

Fecha o que restava de **mecânico** em A-6. 2 ocorrências: badge "—" de
erro em `StatsCard.jsx` e badge "backfill pendente" em `Assets.jsx`.
**Deliberadamente não tocado:** os 3 ícones SVG de `Assets.jsx`
(status de scan) — são ícone-só sem nenhum wrapper focável, corrigir
de verdade exige primeiro decidir/implementar o tema A-7.

- [x] **A-6 (7ª sub-rodada) — `StatsCard.jsx` (1) + `Assets.jsx:292`
  (1).** `Tooltip`/`TooltipTrigger asChild` + `tabIndex={0}` novo,
  mesmo Padrão 3 de sempre. **Testes novos:** `StatsCard.test.jsx`
  (não existia) + 1 caso novo em `Assets.test.jsx`.

**Verificação rodada:** `npm run lint && npm test && npm run build &&
npm run typecheck:ratchet` limpos (2036 testes; teto de typecheck 16,
inalterado). Revisão cética própria (sem verificação visual via
navegador real — mesma ressalva de sempre), detalhe completo em
`docs/known-risks.md` item 211 (item 210 foi ocupado em paralelo por
outra correção não relacionada — `lazyWithReload.js`, PR #413 — resolvido
por conflito de merge nesta rodada, renumerado sem perda de conteúdo).

## Backlog Alta prioridade — 15ª rodada (2026-09-25): A-6 (8ª sub-rodada, botão "Reenviar" de `Verification.jsx`) corrigida

Fecha o último item isolado de A-6 que não exige decisão de escopo
maior: o botão "Reenviar", com `title=` condicional em **3 textos**
(não binário como o já resolvido "Aplicar ao Scanner" de `Backtest.jsx`).

- [x] **A-6 (8ª sub-rodada) — `Verification.jsx`, botão "Reenviar"
  (1).** Mesmo padrão do "Aplicar ao Scanner" (item 204), adaptado pra
  3 textos de tooltip: `Tooltip` sempre presente; wrapper
  `<span tabIndex={0}>` só quando `disabled` (por ativos indisponíveis
  OU Telegram não configurado). **Testes novos:** 3 casos em
  `Verification.test.jsx`, um por motivo de desabilitar + o caso
  habilitado; `isTelegramConfigured` (mock) virou controlável por
  teste.

**Verificação rodada:** `npm run lint && npm test && npm run build &&
npm run typecheck:ratchet` limpos (2040 testes; teto de typecheck 16,
inalterado). Revisão cética própria (sem verificação visual via
navegador real — mesma ressalva de sempre), detalhe completo em
`docs/known-risks.md` item 212.

## Limpeza (2026-09-25): `src/components/ui/sidebar.jsx` removido (dead code)

Sinalizado como código morto em toda investigação de A-6 desde o item
204 (primitivo shadcn vendorizado, zero imports — o sidebar real é
`src/components/layout/Sidebar.jsx`, componente próprio). Reconfirmado
de novo (grep case-insensitive em todo `src/`) e removido — nenhuma
dependência ficou órfã. Detalhe completo em `docs/known-risks.md` item
213. Com esta remoção, **A-6 fica com só 1 item pendente**: os 3 ícones
SVG de `Assets.jsx` (precisam do tema A-7 resolvido primeiro).

## Backlog Alta prioridade — 16ª rodada (2026-09-25): A-7 (varredura fresca + 1ª sub-rodada, `TriggerBacktestPanel.jsx`) corrigida

Com A-6 praticamente fechado, investiguei A-7 ("foco de teclado
invisível em ~15 pontos, incl. Busca Global") com uma varredura fresca
via agente Explore — mesmo processo do item 204 (que fez o mesmo por
A-6). **A estimativa original também ficou abaixo da realidade:**
contagem real de **24 ocorrências em ~11 arquivos únicos**, em duas
categorias — (1) `outline-none` sem substituto de foco visível, 17
ocorrências/8 arquivos; (2) clicável sem foco por teclado, 7
ocorrências/4 arquivos (inclui os 3 ícones de `Assets.jsx` já
conhecidos e 2 modais caseiros que exigem decisão de design). Detalhe
completo, com a lista arquivo-por-arquivo e a divisão em 5 sub-rodadas
sugerida, em `docs/known-risks.md` item 214.

- [x] **A-7 (1ª sub-rodada) — `TriggerBacktestPanel.jsx` (6
  ocorrências).** Escolhida como piloto: único arquivo, mesmo padrão
  mecânico repetido 6x (`outline-none` → `outline-none
  focus-visible:ring-1 focus-visible:ring-ring`, o mesmo já em produção
  em `Assets.jsx`/`Logs.jsx`/`Dashboard.jsx`/`PineScript.jsx`). **Teste
  novo:** `TriggerBacktestPanel.test.jsx` (não existia) — 3 casos
  confirmando o foco visível nos 6 campos.

**Verificação rodada:** `npm run lint && npm test && npm run build &&
npm run typecheck:ratchet` limpos (2043 testes; teto de typecheck 16,
inalterado). Revisão cética própria (sem verificação visual via
navegador real — mesma ressalva de sempre), detalhe completo em
`docs/known-risks.md` item 214.

## Backlog Alta prioridade — 17ª rodada (2026-09-25): A-7 (2ª sub-rodada, `outline-none` avulsos) corrigida

Fecha os 11 achados avulsos restantes da Categoria 1 de A-7 — inclui o
input da própria **Busca Global** (`GlobalSearch.jsx`, citada
explicitamente no achado original).

- [x] **A-7 (2ª sub-rodada) — 11 ocorrências, 7 arquivos.**
  `GlobalSearch.jsx` (1, Busca Global), `PredictiveAnalysis.jsx` (1),
  `Alerts.jsx` (1), `Verification.jsx` (2), `MonthlyReport.jsx` (1),
  `Trades.jsx` (1), `Backtest.jsx` (4). Mesmo fix mecânico da 1ª
  sub-rodada: `outline-none` → `outline-none focus-visible:ring-1
  focus-visible:ring-ring`. **Testes novos:** `PredictiveAnalysis.test.jsx`,
  `Alerts.test.jsx` e `MonthlyReport.test.jsx` (não existiam) + casos
  novos em `GlobalSearch.test.jsx`/`Verification.test.jsx`/
  `Trades.test.jsx`/`Backtest.test.jsx`.

**Verificação rodada:** `npm run lint && npm test && npm run build &&
npm run typecheck:ratchet` limpos (2053 testes; teto de typecheck 16,
inalterado). Com esta rodada, **A-7 tem a Categoria 1 inteira fechada**
(17/17) — 17 de 24 ocorrências totais (correção 2026-09-25: dizia "13"
por erro de aritmética, ver `docs/known-risks.md` item 215). Detalhe
completo em `docs/known-risks.md` item 215.

## Backlog Alta prioridade — 18ª rodada (2026-09-25): A-7 (3ª sub-rodada, linhas clicáveis sem foco por teclado) corrigida

Fecha a Categoria 2 mecânica de A-7: 2 linhas clicáveis sem `role`/
`tabIndex`/`onKeyDown`.

- [x] **A-7 (3ª sub-rodada) — 2 ocorrências.** `RecentAlertsList.jsx:52-56`
  e `Alerts.jsx:185-197`. Mesmo padrão já em produção em
  `AssetCard.jsx`/`TradeHistory.jsx` (achado A-8): `role="button"` +
  `tabIndex={0}` + `aria-label` + `focus-visible:ring` + `onKeyDown`
  (Enter/Espaço). `Alerts.jsx` precisou do mesmo guard de bubbling do
  botão filho já usado em `AssetCard.jsx` (o botão "dispensar" já faz
  `stopPropagation()` no clique). **Testes novos:** casos novos em
  `RecentAlertsList.test.jsx`/`Alerts.test.jsx` (ambos já existiam).

**Verificação rodada:** `npm run lint && npm test && npm run build &&
npm run typecheck:ratchet` limpos (2056 testes; teto de typecheck 16,
inalterado). Com esta rodada, **A-7 tem Categoria 1 inteira + as 2
linhas de Categoria 2 fechadas** — 19 de 24 ocorrências totais
(correção 2026-09-25: dizia "15" e "Categoria 2 mecânica inteira" por
erro de aritmética — Categoria 2 tem 7 no total, não 2; ver
`docs/known-risks.md` item 216). Detalhe completo em
`docs/known-risks.md` item 216.

## Backlog Alta prioridade — 19ª rodada (2026-09-25): A-7 (4ª sub-rodada, 3 ícones de `Assets.jsx`) corrigida — fecha A-6

Fecha a 4ª sub-rodada de A-7 e, ao mesmo tempo, **o último item
pendente de A-6**: os 3 ícones de status de scan em `Assets.jsx`
(`XCircle`/`CheckCircle2`/`MinusCircle`) tinham `title=` nativo E eram
ícone-só sem wrapper focável — por isso ficaram esperando A-7 (foco de
teclado) resolvido antes de poderem ser corrigidos de verdade.

- [x] **A-7 (4ª sub-rodada) — 3 ícones de `Assets.jsx` (284-288).**
  Mesmo padrão do badge "backfill pendente" no mesmo arquivo (item
  211): cada ícone envolvido num `<span tabIndex={0}>` carregando
  `TooltipTrigger asChild`, texto do `title=` movido pro
  `TooltipContent`. **Testes novos:** 3 casos em `Assets.test.jsx`
  (já existia).
  **Efeito colateral:** o teto do `typecheck:ratchet` baixou de 16
  pra 13 (os `title=` nativos removidos dos ícones lucide-react
  provavelmente eram atrito de tipagem) — atualizado via `--update`.

**Verificação rodada:** `npm run lint && npm test && npm run build &&
npm run typecheck:ratchet` limpos (2060 testes; teto de typecheck
baixado de 16 pra 13). Com esta rodada, **A-7 fica com 22 de 24
ocorrências fechadas** (só restam os 2 modais caseiros, 5ª sub-rodada)
e **A-6 fica 100% fechado**. Detalhe completo em `docs/known-risks.md`
item 217.

## Backlog Alta prioridade — 20ª rodada (2026-09-25): A-7 (5ª e última sub-rodada, os 2 modais caseiros) corrigida — A-7 100% fechado

Fecha o último item de A-7: `OwnerKeySettings.jsx` e
`TelegramSettings.jsx` eram modais caseiros (`<div className="fixed
inset-0...">`) sem `role="dialog"`, focus-trap, Escape ou devolução de
foco.

- [x] **A-7 (5ª sub-rodada) — 2 modais migrados pro `Dialog` do
  Radix.** Decisão de design: reaproveitar `src/components/ui/dialog.jsx`
  (já usado em `Trades.jsx`, achado A-12, e em `Assets.jsx`) em vez de
  focus-trap manual — ganha focus-trap/Escape/overlay-click/devolução
  de foco de graça. Botão X caseiro removido (`DialogContent` já tem o
  seu). `TelegramSettings.jsx` ganhou um wrapper `max-h-[70vh]
  overflow-y-auto` interno (mesmo padrão de `AssetConfigPanel.jsx`),
  já que o `DialogContent` do Radix não trata overflow sozinho e o
  corpo (com "Filtros Avançados" expandido) facilmente passa da altura
  da viewport. **Testes novos:** `OwnerKeySettings.test.jsx` (3 casos)
  e `TelegramSettings.test.jsx` (4 casos) — nenhum dos 2 componentes
  tinha teste dedicado antes.

**Verificação rodada:** `npm run lint && npm test && npm run build &&
npm run typecheck:ratchet` limpos (2067 testes; teto de typecheck em
13, inalterado). **Com esta rodada, A-7 fica 100% fechado: 24 de 24
ocorrências.** Detalhe completo em `docs/known-risks.md` item 218.

## Backlog do Raio-X ainda **pendente, não iniciado**

Nada abaixo foi tocado nesta rodada — listado aqui pra não passar a
impressão de que os 3 críticos resumem o relatório inteiro. Ordem e detalhe
completo no Artifact (seções C-E do relatório); resumo dos itens de
Alta prioridade (rótulos A-1 a A-15 no relatório):

- [x] A-1 — `RecentAlertsList` finge ser clicável, não tem `onClick`. **Corrigido, ver seção acima.**
- [x] A-2 — Horário de abertura do candle sempre `-1h`, ignora o timeframe. **Corrigido, ver seção acima.**
- [x] A-3 — Logs.jsx diz "atualiza a cada 15s", o real é 2 minutos. **Corrigido, ver seção acima.**
- [x] A-4 — Aba "Sincronização" do Pine Script com números desatualizados. **Corrigido, ver seção acima.**
- [x] A-5 — Sidebar desktop sem nome acessível em nenhum dos 12 itens. **Corrigido, ver seção acima.**
- [x] A-6 — `title=` nativo em vez de Tooltip acessível. **100%
  fechado (19ª rodada, item 217).** Contagem original de 43
  ocorrências/16 arquivos revista numa varredura fresca (item 208):
  ~40 reais no total. 8 sub-rodadas mecânicas (itens 204/205/206/207/
  208/209/211/212, ver 8ª-15ª rodadas acima) + `src/components/ui/
  sidebar.jsx` removido (dead code, item 213) + os 3 últimos ícones
  SVG de `Assets.jsx` (284-288), que dependiam de A-7 (foco de
  teclado) resolvido primeiro, corrigidos na 19ª rodada (item 217).
  Nenhum item mecânico ou de decisão isolada pendente.
- [x] A-7 — Foco de teclado invisível em ~15 pontos (incl. Busca
  Global). **100% fechado (20ª rodada, item 218).** Varredura fresca
  (16ª rodada, item 214) revisou a contagem original pra 24 ocorrências
  reais em ~11 arquivos, divididas em 5 sub-rodadas: 1ª
  (`TriggerBacktestPanel.jsx`, 16ª rodada), 2ª (11 ocorrências avulsas,
  inclui `GlobalSearch.jsx`, 17ª rodada), 3ª (2 linhas clicáveis —
  `Alerts.jsx`/`RecentAlertsList.jsx`, 18ª rodada), 4ª (os 3 ícones de
  `Assets.jsx`, 19ª rodada, também fechou A-6) e 5ª (os 2 modais
  caseiros migrados pro `Dialog` do Radix, 20ª rodada) — **24 de 24
  ocorrências fechadas.** Detalhe em `docs/known-risks.md` item
  214/215/216/217/218.**
- [x] A-8 — AssetCard só abre por clique de mouse, sem suporte a teclado. **Corrigido, ver seção acima.**
- [x] A-9 — LIVE/STALE com threshold fixo de 2h, impreciso. **Corrigido, ver seção acima.**
- [x] A-10 — "Geral" na Confiança ao Vivo mistura BUY/SELL sem aviso. **Corrigido, ver seção acima.**
- [x] A-11 — Filtro de prioridade Média/Baixa morto em Verification. **Corrigido, ver seção acima.**
- [x] A-12 — Modal de edição em Trades sem acessibilidade (Esc, foco). **Corrigido, ver seção acima.**
- [x] A-13 — Gráfico do RFHistoryChart sem eixos visíveis. **Corrigido, ver seção acima.**
- [x] A-14 — Feed de "o que aconteceu" efêmero/no fim do Dashboard. **Corrigido, ver seção acima.**
- [ ] A-15 — AssetCard com ~20 blocos de informação, sem divulgação
  progressiva. **Investigado, deliberadamente adiado pra junto da
  reorganização do Dashboard (seção L) — ver 7ª rodada acima.**
- [x] M-3 — WeeklySummary: rótulo de dia colide em "S" (1ª letra só). **Corrigido, ver seção "Backlog Média prioridade" abaixo.**
- [x] M-7 — TradeHistory: badge "ambíguo" via `title=` nativo. **Já
  estava corrigido incidentalmente na 12ª rodada de A-6 — não foi uma
  correção nova desta leva.**
- [x] M-14 — CorrelationWidget: botão de remover símbolo sem aria-label. **Corrigido, ver seção "Backlog Média prioridade" abaixo.**
- [x] M-16 — StatsCard: cor de "atenção" fixa mesmo com valor 0. **Corrigido (bug estava em `Dashboard.jsx`, não em `StatsCard.jsx`) — ver seção "Backlog Média prioridade" abaixo.**
- [x] M-1 — WeeklySummary: sem estado de carregamento, mostra "+0.00%"/0 como resultado real. **Corrigido, ver 2ª rodada abaixo.**
- [x] M-2 — WeeklySummary: "Sinais Processados" conta qualquer fonte, não só Range Filter. **Corrigido, ver 2ª rodada abaixo.**
- [x] M-5 — AssetCard/SignalToast: animações de flash/pulso sem prefers-reduced-motion. **Corrigido, ver 3ª rodada abaixo.**
- [x] M-6 — PerformanceReport (Trades): cards de métrica sem tooltip. **Corrigido (só Profit Factor, único com texto já validado) — ver 3ª rodada abaixo.**
- [x] M-8 — Verificação: RSI/MACD/EMA sem cor de zona. **Corrigido, ver 3ª rodada abaixo.**
- [x] M-12 — Settings/Pine Script sem link cruzado. **Corrigido, ver 3ª rodada abaixo.**
- [x] M-9 — 17 gráficos Recharts sem role="img"/aria-label em 10 arquivos. **Fechado: 3 sub-rodadas, 17/17 instâncias — ver seção própria abaixo.**
- [~] M-17 — termos técnicos sem explicação (glossário, seção I). **2ª de ~4 sub-rodadas feita (4/8 arquivos-alvo) — ver seção própria abaixo.**
- [ ] Demais itens de Média prioridade (M-4, M-10, M-11, M-13, M-15),
  Refinamentos e a reorganização completa do Dashboard (seção L do
  relatório) — nada iniciado.

## Como continuar

**A-1 a A-14 estão todos corrigidos (14 de 15 itens de Alta
prioridade) — A-6 e A-7 fechados 100% (19ª e 20ª rodadas, itens 217 e
218).** Só resta A-15 do bloco de Alta prioridade, e é deliberadamente
adiado (ver abaixo).

A-7 (foco de teclado invisível) teve varredura fresca completa (item
214, 24 ocorrências reais em ~11 arquivos) resolvida em 5 sub-rodadas:
1ª (`TriggerBacktestPanel.jsx`), 2ª (11 ocorrências avulsas, inclui
`GlobalSearch.jsx`), 3ª (2 linhas clicáveis —
`Alerts.jsx`/`RecentAlertsList.jsx`), 4ª (os 3 ícones SVG de
`Assets.jsx`, que também fechou A-6) e 5ª (os 2 modais caseiros —
`OwnerKeySettings.jsx`/`TelegramSettings.jsx` — migrados pro `Dialog`
do Radix, mesmo componente já usado em `Trades.jsx`/`Assets.jsx`).

A-15 (AssetCard sem divulgação progressiva) fica deliberadamente pra
junto da reorganização completa do Dashboard (seção L), não como item
isolado.

**Backlog de Média prioridade em andamento (1ª rodada, item 220 —
M-3/M-14/M-16; 2ª rodada, item 221 — M-1/M-2; 3ª rodada, item 222 —
M-5/M-6/M-8/M-12; M-9 fechado em 3 sub-rodadas, itens 223/225/226/227;
M-17 em sub-rodadas, itens 229/230 — 2 de ~4 feitas; M-7 descoberto já
corrigido).** Restam 5 dos 17 itens M inteiros (M-4, M-10, M-11, M-13,
M-15) + 4 dos 8 arquivos-alvo de M-17. M-4/M-10/M-13/M-15 se
sobrepõem à reorganização do Dashboard (seção L, que também inclui
A-15) — decisão de produto maior, não mexer sem alinhamento explícito.
M-11 (632 ocorrências de fonte arbitrária em 51 arquivos) é varredura
grande, merece rodada própria.

## Backlog M-9 — 1ª sub-rodada (2026-09-25): 4 widgets do Dashboard

M-9 (17 instâncias de gráfico Recharts sem `role="img"`/`aria-label`
em 10 arquivos, mapa completo no item 222 do known-risks.md) é grande
demais pra rodada única — dividido em sub-rodadas por área, mesmo
padrão de A-6/A-7. Esta 1ª cobre `WeeklySummary.jsx`,
`CorrelationWidget.jsx`, `PredictiveAnalysis.jsx` e
`PerformanceOverview.jsx` (1 gráfico cada).

Padrão de fix: `role="img"` + `aria-label` descritivo no `<div>` que
envolve o `<ResponsiveContainer>` — o próprio `ResponsiveContainer` não
repassa essas props pro DOM (confirmado lendo o código-fonte do
Recharts), então precisam ir no wrapper. Deliberadamente **não** usei
`accessibilityLayer` (prop do Recharts que adiciona navegação por
teclado dentro do gráfico) — mudança de comportamento maior que o
achado pede, registrada como opção separada se o achado de navegação
por teclado for levantado no futuro.

4 testes novos (`PerformanceOverview.test.jsx` é arquivo novo, os
outros 3 já existiam por achados anteriores). `npm run lint && npm
test && npm run build && npm run typecheck:ratchet` limpos (2091
testes, teto de typecheck em 13, sem mudança). Detalhe completo em
`docs/known-risks.md` item 223. Restam 13 das 17 instâncias (6
arquivos): `Backtest.jsx` (4), `MonthlyReport.jsx` (3),
`RFHistoryChart.jsx`, `TradeEntryMarkers.jsx`, `PnLChart.jsx`,
`PortfolioVsMarket.jsx` (1 cada).

**Correção pós-merge (item 224 do known-risks.md):** o PR #426
mesclou antes da review do Codex chegar — 2 achados reais (P2):
`WeeklySummary.jsx` anunciava "+0.00%" falso no `aria-label` durante o
carregamento (mesma classe de bug que M-1 já tinha corrigido no card
visível, só não propagada pro `aria-label` novo); `PredictiveAnalysis.jsx`
tinha `role="img"` escondendo o dado de cada faixa de score (label/
winRate/n) da árvore de acessibilidade — o `aria-label` só citava a
contagem de faixas. Ambos corrigidos num PR de acompanhamento pequeno
(o original já estava fechado).

## Backlog M-9 — 2ª sub-rodada (2026-09-26): Backtest.jsx + MonthlyReport.jsx

Continuação da 1ª sub-rodada (item 223). Esta cobre os 7 gráficos dos
2 relatórios de performance: `Backtest.jsx` (4 — curva ingênua,
distribuição de resultados, curva de capital real, funil de rejeição
de entrada) e `MonthlyReport.jsx` (3 — evolução de P&L, taxa de
acerto, distribuição de status). Mesmo padrão de fix da 1ª sub-rodada
(`role="img"` + `aria-label` no `<div>` wrapper do
`ResponsiveContainer`), aplicando desde o início a lição do achado do
Codex review na 1ª sub-rodada (item 224): todo `aria-label` cita o
dado subjacente completo (valores/rótulos de cada série/fatia), não
só uma contagem genérica.

2 testes novos (`Backtest.test.jsx` já existia, ganhou um `describe`
novo; `MonthlyReport.test.jsx` já existia, ganhou um `describe` novo +
mock de `TradeOperation.filter` refatorado pra ser controlável por
teste, mesmo padrão de `PredictiveAnalysis.test.jsx`). `npm run lint
&& npm test && npm run build && npm run typecheck:ratchet` limpos
(2095 testes, teto de typecheck em 13, sem mudança). Detalhe completo
em `docs/known-risks.md` item 225. Restam 4 das 17 instâncias (4
arquivos, 1 cada): `RFHistoryChart.jsx`, `TradeEntryMarkers.jsx`,
`PnLChart.jsx`, `PortfolioVsMarket.jsx` — candidato a sub-rodada final,
fechando M-9 por completo (17/17).

**Correção pós-merge (item 226 do known-risks.md):** o Codex review
pegou 2 achados reais (P2) ainda dentro da janela do próprio PR desta
vez (CI ainda não tinha fechado): `MonthlyReport.jsx` ("Evolução de
P&L") não enumerava os dias individuais (meses com mesmo nº de dias e
mesmo total geravam o mesmo `aria-label`) — corrigido enumerando cada
dia (dataset bounded, ≤31 entradas). `Backtest.jsx` (curva ingênua e
curva de capital real) só citava o ponto final, não cada operação —
como o nº de operações não tem teto, a correção usou uma técnica nova
nesta sessão: tabela `sr-only` (Tailwind, oculta visualmente, presente
na árvore de acessibilidade) linkada via `aria-describedby`, carregando
o dado ponto a ponto sem inflar o `aria-label`. Ambos corrigidos com
push adicional no mesmo PR (não precisou de PR de acompanhamento desta
vez).

## Backlog M-9 — 3ª sub-rodada, final (2026-09-26): fecha M-9 (17/17)

Última sub-rodada: os 4 arquivos com 1 instância cada —
`RFHistoryChart.jsx`, `TradeEntryMarkers.jsx`, `PnLChart.jsx`,
`PortfolioVsMarket.jsx`. Todos tinham nº de pontos sem teto (histórico
completo de operações, ou até 60 candles no RF) — mesma classe de
problema do achado do Codex na 2ª sub-rodada (item 226), então a
técnica de tabela `sr-only` + `aria-describedby` já validada ali foi
aplicada desde o início aqui (não repetiu o erro de tentar enumerar
tudo direto no `aria-label`). `RFHistoryChart.jsx` usa um resumo
curto com as métricas já calculadas no componente (bias/mudança RF/
estabilidade/volatilidade/flips); os outros 3 citam nº de
trades/W-L/acumulado.

4 testes novos (`RFHistoryChart.test.jsx` já existia, ganhou um caso
novo; `TradeEntryMarkers.test.jsx`/`PnLChart.test.jsx`/
`PortfolioVsMarket.test.jsx` são arquivos novos — nenhum tinha teste
dedicado antes). `npm run lint && npm test && npm run build && npm run
typecheck:ratchet` limpos (2103 testes, teto de typecheck em 13, sem
mudança). Detalhe completo em `docs/known-risks.md` item 227.

**M-9 fechado: 17 de 17 instâncias, 3 sub-rodadas, 0 restante.**

## Backlog M-17 — 1ª sub-rodada (2026-09-26): `AssetCard.jsx` + `AssetDetailPanel.jsx`

M-17 ("termos técnicos sem explicação") tem a redação completa do
glossário na seção I do relatório original (Artifact), com o texto
exato sugerido pra cada termo — reaproveitado aqui sem invenção.
Rodei um agente Explore pra mapear onde cada termo (RF, SMC, RSI,
MACD, EMA, Confl., Funding, R:R, Expectância, Tier, ADX, Choppiness,
Runner, Time Stop/Chop Exit, TP1/TP2, CAGR) aparece como rótulo "nu"
em `src/pages`/`src/components` — 8 arquivos-alvo identificados
(`AssetCard.jsx`, `AssetDetailPanel.jsx`, `AssetConfigPanel.jsx`,
`TelegramSettings.jsx`, `Alerts.jsx`, `ComparePanel.jsx`,
`TradeHistory.jsx`, `Backtest.jsx`), mais `PerformanceMetricsBar.jsx`
como baixa prioridade (sub-texto, não título). Muitos termos já
estavam resolvidos em outros componentes (`TradeCard.jsx`,
`SignalToast.jsx`, `LiveConfidenceCard.jsx`, `PortfolioVsMarket.jsx`,
`decisionExplanation.js`) — mapa completo em `docs/known-risks.md`
item 229.

Esta 1ª sub-rodada cobre `AssetCard.jsx` (RF/MACD/EMA/RSI no
`IndicatorDots`, TP1/TP2 no grid de preços) e `AssetDetailPanel.jsx`
(RSI/MACD/EMA no mini-grid `TFStateCard` e no `ParamCard` dos
parâmetros do RF) — mesmo padrão `Tooltip`/`TooltipTrigger asChild`/
`TooltipContent` já usado no resto do projeto (achado A-6).

**Achado durante a implementação**: a 1ª versão dos testes de
`AssetCard.jsx` usava `.closest('[tabindex="0"]')`, que dava falso
positivo — o card inteiro já é `role="button"`/`tabIndex={0}`
(achado A-8), então o seletor encontrava o card mesmo sem o fix
aplicado (só descoberto ao reproduzir via `git stash`, disciplina
padrão desta sessão — sem isso, o teste teria passado "verde" sem
testar nada). Corrigido pra `.closest('.cursor-help')`, classe
exclusiva do novo wrapper, e reconfirmado que falha sem o fix.

2 arquivos de teste (`AssetCard.test.jsx` já existia, ganhou 2 casos
novos; `AssetDetailPanel.test.jsx` é novo — arquivo não tinha teste
dedicado antes). `npm run lint && npm test && npm run build && npm run
typecheck:ratchet` limpos (2107 testes, teto de typecheck em 13, sem
mudança). Detalhe completo em `docs/known-risks.md` item 229. Restam
6 arquivos-alvo (+ 1 de baixa prioridade): `AssetConfigPanel.jsx`,
`TelegramSettings.jsx`, `Alerts.jsx`, `ComparePanel.jsx`,
`TradeHistory.jsx`, `Backtest.jsx` (+ `PerformanceMetricsBar.jsx`).

## Backlog M-17 — 2ª sub-rodada (2026-09-26): `AssetConfigPanel.jsx` + `TelegramSettings.jsx`

Continuação da 1ª sub-rodada (item 229). `AssetConfigPanel.jsx` e
`TelegramSettings.jsx` compartilham o mesmo array de badges (RF/SMC/
MACD/EMA Cross/RSI) renderizado pelo componente **compartilhado**
`src/components/ui/multi-toggle.jsx` — o fix foi feito uma vez ali
(campo opcional `tooltip` por opção) e resolveu os 2 arquivos ao
mesmo tempo, sem duplicar lógica. `AssetConfigPanel.jsx` também
ganhou tooltip nas labels de seção "RSI"/"MACD" do form de parâmetros
(fora do MultiToggle).

**Achado durante a implementação**: o teste de `TelegramSettings.jsx`
lançou "`Tooltip` must be used within `TooltipProvider`" — o Radix
desta versão exige um `TooltipProvider` ancestor pra `Tooltip`
funcionar (em produção vem de `App.jsx`, que envolve todo o app; o
teste renderiza o componente isolado). Corrigido envolvendo o
`renderModal` helper existente num `TooltipProvider`.

2 arquivos de teste (`TelegramSettings.test.jsx` já existia, ganhou 1
caso novo; `AssetConfigPanel.test.jsx` é novo — arquivo não tinha
teste dedicado antes). `npm run lint && npm test && npm run build &&
npm run typecheck:ratchet` limpos (2110 testes, teto de typecheck em
13, sem mudança). Detalhe completo em `docs/known-risks.md` item 230.
Restam 4 arquivos-alvo (+ 1 de baixa prioridade): `Alerts.jsx`,
`ComparePanel.jsx`, `TradeHistory.jsx`, `Backtest.jsx` (+
`PerformanceMetricsBar.jsx`) — plano completo das 2 sub-rodadas
restantes já escrito em
`/root/.claude/plans/quero-melhorar-a-ui-ux-lazy-anchor.md`.

## Backlog Média prioridade — 3ª rodada (2026-09-25): M-5, M-6, M-8, M-12 corrigidos

Agente Explore confirmou 5 candidatos (M-5, M-6, M-8, M-9, M-12)
contra o código atual antes de implementar — todos confirmados sem
divergência. M-9 ficou de fora (17 instâncias/10 arquivos, escopo
grande demais pra rodada mecânica — mapa completo registrado pra
rodada futura).

- **M-5** — animações de flash/pulso (`AssetCard.jsx`, `index.css`
  `.signal-zone-pulse`, `SignalToast.jsx`) sem `prefers-reduced-motion`,
  mesmo padrão já correto em `TradeCard.jsx`. Todas ganharam o guard
  (CSS `@media` ou `motion-reduce:`/`matchMedia` conforme o caso).
- **M-6** — `PerformanceReport.jsx` sem tooltip nos cards de métrica,
  diferente de `Backtest.jsx`/`MonthlyReport.jsx`. Adicionado tooltip
  só no card "Profit Factor" (texto reaproveitado ipsis litteris de
  `Backtest.jsx`) — os outros 5 cards não têm precedente de tooltip em
  nenhuma tela do projeto.
- **M-8** — `Verification.jsx`: RSI/MACD/EMA sem cor de zona no
  `ContextGrid`. Cor recalculada a partir dos valores brutos de
  `signal_context`, reaproveitando `getRSIZone`
  (`src/lib/indicators/rsi.js`) e a mesma lógica de sinal/comparação
  já usada em `AssetDetailPanel.jsx`/`quickBacktest.js`.
- **M-12** — `Settings.jsx`/`PineScript.jsx` sem aviso cruzado sobre
  editarem os mesmos parâmetros. Cada página já tinha uma caixa de
  aviso pronta — estendida com um `Link` pra outra página + "quem
  salvar por último vence", em vez de criar caixa nova.

Testes novos: `AssetCard.test.jsx` (caso novo), `src/
indexCssReducedMotion.test.js` (novo, lê CSS via `fs`),
`SignalToast.test.jsx` (2 casos novos), `PerformanceReport.test.jsx`
(novo — componente não tinha teste), `Verification.test.jsx` (5 casos
novos), `Settings.test.jsx` (novo) e `PineScript.test.jsx` (1 caso
novo). `npm run lint && npm test && npm run build && npm run
typecheck:ratchet` limpos (2087 testes, teto de typecheck em 13, sem
mudança). Detalhe completo em `docs/known-risks.md` item 222.

## Backlog Média prioridade — 2ª rodada (2026-09-25): M-1 e M-2 corrigidos

Mesmo arquivo da 1ª rodada (`WeeklySummary.jsx`, M-3) — investigação
direta confirmou os 2 exatamente como descritos no relatório.

- **M-1** — nenhuma das 2 queries lia `isLoading`; os 3 cards de stat
  mostravam "+0.00%"/0 como resultado real antes do fetch responder.
  Agora mostram `···` enquanto carrega.
- **M-2** — "Sinais Processados" contava sinal de qualquer `source`,
  inconsistente com `buySignals`/`sellSignals` do Dashboard (só
  `range_filter`). Filtro adicionado.

3 testes novos em `WeeklySummary.test.jsx`, falha reproduzida via
`git stash` antes do fix. `npm run lint && npm test && npm run build
&& npm run typecheck:ratchet` limpos (2073 testes, teto de typecheck
em 13, sem mudança). Detalhe completo em `docs/known-risks.md` item
221.

## Backlog Média prioridade — 1ª rodada (2026-09-25): M-3, M-14, M-16 corrigidos

Reli o relatório completo do Raio-X (Artifact, seções D/E/L/M/N/O) pra
recuperar a lista M-1 a M-17 (nunca documentada aqui além dos IDs).
Agente Explore confirmou o estado atual de 4 candidatos a "quick win"
contra o código de hoje antes de implementar — M-7 já estava corrigido
incidentalmente (12ª rodada de A-6); M-16 tinha o bug num arquivo
diferente do descrito no relatório original.

- **M-3** — `WeeklySummary.jsx:129`: rótulo de dia usava só `l[0]` (1ª
  letra), colidindo em "S" pra Segunda/Sexta/Sábado. Trocado por `{l}`
  (rótulo completo de 3 letras, já único).
- **M-14** — `CorrelationWidget.jsx:140`: botão de remover símbolo
  (ícone `X` puro) sem `aria-label`. Adicionado.
- **M-16** — `Dashboard.jsx:284`: StatsCard "Alta Prioridade" recebia
  cor de atenção fixa (`#ff9f43`) independente de `highPriorityCount`.
  Agora condicional: neutra (`#00e5ff`, mesma de "Monitorados") quando
  zero, atenção quando há contagem real. `StatsCard.jsx` não foi
  tocado — a lógica errada estava em quem consome o componente.

Testes novos: `WeeklySummary.test.jsx` e `CorrelationWidget.test.jsx`
(nenhum dos dois tinha teste antes), + 2 casos em `Dashboard.test.jsx`
(cor neutra/atenção). Falha de cada um reproduzida via `git stash`
antes do fix. `npm run lint && npm test && npm run build && npm run
typecheck:ratchet` limpos (2071 testes, teto de typecheck em 13, sem
mudança). Detalhe completo em `docs/known-risks.md` item 220.

## Pente fino pós-A-14 (2026-09-25): 14 itens confirmados corretos

Auditoria rigorosa de A-1 a A-14 com 3 agentes Explore em paralelo
(suite completa + integridade do histórico git + conteúdo de cada
achado contra o código atual). **Os 14 itens confirmados corretos,
nenhuma regressão entre rodadas.** Suite completa verde (2067 testes,
lint/build/typecheck limpos). Achou e corrigiu 1 erro de aritmética
residual (item 211: "2036"→"2037" testes) e registrou 1 achado novo
fora do escopo original — `src/components/layout/Sidebar.jsx`, 3
botões ícone-só (`QuickToggleButton`/`QuickActionButton`/
`ClearLogsButton`) sem `aria-label` e com tooltip caseiro inacessível
por teclado, nunca pego por nenhuma sub-rodada de A-6 (usa uma prop
`title` de componente, não o atributo HTML nativo que os greps
buscavam). Não corrigido ainda — candidato a rodada futura, mesmo
padrão mecânico já usado no resto de A-6/A-7. Detalhe completo em
`docs/known-risks.md` item 219.
