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

## Backlog do Raio-X ainda **pendente, não iniciado**

Nada abaixo foi tocado nesta rodada — listado aqui pra não passar a
impressão de que os 3 críticos resumem o relatório inteiro. Ordem e detalhe
completo no Artifact (seções C-E do relatório); resumo dos itens de
Alta prioridade (rótulos A-1 a A-15 no relatório):

- [x] A-1 — `RecentAlertsList` finge ser clicável, não tem `onClick`. **Corrigido, ver seção acima.**
- [x] A-2 — Horário de abertura do candle sempre `-1h`, ignora o timeframe. **Corrigido, ver seção acima.**
- [x] A-3 — Logs.jsx diz "atualiza a cada 15s", o real é 2 minutos. **Corrigido, ver seção acima.**
- [ ] A-4 — Aba "Sincronização" do Pine Script com números desatualizados.
- [x] A-5 — Sidebar desktop sem nome acessível em nenhum dos 12 itens. **Corrigido, ver seção acima.**
- [ ] A-6 — `title=` nativo em vez de Tooltip acessível (~15 arquivos).
- [ ] A-7 — Foco de teclado invisível em ~15 pontos (incl. Busca Global).
- [x] A-8 — AssetCard só abre por clique de mouse, sem suporte a teclado. **Corrigido, ver seção acima.**
- [x] A-9 — LIVE/STALE com threshold fixo de 2h, impreciso. **Corrigido, ver seção acima.**
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

Próxima rodada sugerida (não decidida): A-1, A-2, A-3, A-5, A-8 e A-9 já
corrigidos. Restam 9 itens de Alta prioridade — A-6 (`title=` nativo em
~15 arquivos) e A-7 (foco de teclado invisível em ~15 pontos) fecham o
resto do cluster de acessibilidade, mas são varreduras maiores (cada
achado é 1 de ~15 ocorrências, não um bug isolado — provavelmente vale
dividir em sub-rodadas); A-4 (Pine Script desatualizado), A-10 (Confiança
ao Vivo mistura BUY/SELL), A-11 (filtro morto em Verification) são achados
isolados de médio esforço. Decisão de qual seguir é do usuário (ou "seguir
conforme achar melhor", como já autorizado nesta sessão).
