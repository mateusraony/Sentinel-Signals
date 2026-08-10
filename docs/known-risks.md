# Riscos conhecidos — aceitos e adiados de propósito

Estes três pontos foram levantados numa revisão de segurança/arquitetura e
**deliberadamente não corrigidos** nesta rodada, por decisão explícita do
usuário. Não "corrija" nenhum deles sem pedido explícito — ver também
`CLAUDE.md`, seção "Estado atual — auth, Telegram e Strategy Reviewer".

## 1. Autenticação anônima + regras Firestore abertas

`AuthContext.jsx` faz `signInAnonymously()` automaticamente — qualquer pessoa
com a URL entra sem senha. `firestore.rules` libera leitura/escrita para
qualquer usuário `isSignedIn()` (inclusive anônimo) nas coleções de negócio
(`monitoredAssets`, `assetStates`, `signalEvents`, `tradeOperations`,
`priceAlerts`, `systemLogs`, `scannerLocks`, `strategyConfig`). Adiado para a
fase final do projeto, quando uma tela de login real for reativada.

## 2. Token do Telegram no navegador

`src/lib/telegram.js`/`TelegramSettings.jsx` guardam bot token e chat id em
`localStorage` e chamam `api.telegram.org` direto do browser — decisão
consciente do usuário para simplicidade do "canal ao vivo". O canal 24h
(scan agendado via GitHub Actions, `scripts/adminTelegram.js`) já usa o token
com segurança, via variável de ambiente, fora do browser — isso não muda.

## 3. TP/Stop são apenas virtuais (sem ordem real na exchange)

Hoje o sistema só compara preço/candle contra os níveis calculados e atualiza
o status da `TradeOperation` no Firestore — nenhuma ordem `STOP_MARKET`/
`TAKE_PROFIT` é enviada à Binance, nenhum `orderId` é salvo. Isso é esperado
enquanto o projeto for só um painel de sinalização. **Pré-requisito
arquitetural** para quando (e se) o projeto evoluir para execução automática
de ordens: só marcar uma operação como ativa depois de confirmar o fill da
entrada e o aceite do stop pela exchange; nunca operar sem stop confirmado na
corretora.

## 4. Dados de mercado divergentes entre painel (Futures) e cron 24h (Spot) — ACEITO FORMALMENTE

A partir da migração híbrida para Binance Futures, o navegador consulta
`fapi.binance.com` (Futures) enquanto o scan agendado via GitHub Actions
continua em `data-api.binance.vision` (Spot) — a API de Futures da Binance
bloqueia com 451 qualquer IP de datacenter dos EUA (onde os runners do
GitHub Actions rodam), e não existe mirror público gratuito de Futures
equivalente ao `data-api.binance.vision`. Isso significa que preço, sinais e
preço de entrada podem divergir levemente entre o painel e o scan 24/7
quando ambos estão ativos ao mesmo tempo.

> **Atualização (P1, pesquisa de comunidade) — status mudou de "risco
> pendente" para "limitação conhecida e aceita definitivamente".** Pesquisa
> em ccxt issues, fóruns da Binance e comunidade de bots cripto confirmou:
> **não existe workaround gratuito e confiável** dentro das restrições do
> projeto (sem proxy pago, sem servidor fora dos EUA). Especificamente:
> - Proxy via Cloudflare Workers (gratuito) é bloqueado pela própria Binance
>   (a rede da Cloudflare é detectada e recebe 403 — relatos confirmados na
>   comunidade Cloudflare).
> - Self-hosted runner fora dos EUA e VPN pago resolveriam, mas violam as
>   restrições explícitas do projeto (100% gratuito, sem infraestrutura
>   própria fora do GitHub Actions/Render/Firebase free tier).
> - A única alternativa tecnicamente viável seria **trocar a fonte de dados
>   de Futures para outra exchange que não bloqueia IPs dos EUA** (Bybit,
>   OKX, etc., via bibliotecas como `ccxt`) — mas isso troca uma divergência
>   por outra (o preço de Futures de outra exchange também não é idêntico ao
>   da Binance) e é uma **decisão de produto separada**, não uma correção de
>   infraestrutura. Não implementado; não recomende sem pedido explícito do
>   usuário.
>
> Decisão: aceitar a divergência como limitação permanente enquanto o
> projeto for 100% gratuito. Não é mais item de backlog — não reabrir sem
> mudança de contexto (ex.: usuário decidir migrar de exchange ou aceitar
> custo de infraestrutura).

## 5. AÇÃO NECESSÁRIA — deploy manual de `firestore.rules`/`firestore.indexes.json`

Estes dois arquivos só têm efeito no banco real depois de rodar, uma vez:

```
firebase deploy --only firestore:rules,firestore:indexes
```

Não existe nenhuma automação de CI que faça isso (`ci.yml` só roda lint/build,
`scan.yml` só roda o scanner) — é sempre um passo manual, documentado em
`CLAUDE.md`/README. **Se este comando ainda não foi rodado depois da adição
das coleções `scannerLocks`, `assetActiveOps` e `strategyConfig`**, o projeto
Firebase real ainda está com as regras antigas, que não conhecem essas três
coleções e caem no catch-all final (`allow read, write: if false`). Nesse
caso, no navegador (não no cron — o cron usa Admin SDK e ignora
`firestore.rules`):

- O lock do scanner falha ao adquirir/liberar (`acquireScanLock`/
  `releaseScanLock`) — o código foi endurecido para *fail-open* (loga um
  `logError` em `SystemLog` e prossegue sem lock em vez de abortar o scan
  inteiro), mas a proteção contra execução concorrente fica inoperante até
  o deploy ser feito.
- Leitura/escrita de `strategyConfig/current` falha — o painel cai de volta
  para os defaults/localStorage (`getPineConfig` tem try/catch e loga um
  aviso), mas a sincronização painel↔cron não funciona.
- `createTradeOpIfNoneActive`/`clearActiveOp` (coleção `assetActiveOps`)
  falham — isso é capturado pelo tratamento de erro por-operação/por-ativo já
  existente (aparece como `scan_status: 'error'` no ativo ou um `logError`
  por operação), não derruba o scan inteiro, mas a garantia de "uma única
  operação ativa por ativo" fica sem o reforço extra da transação.

**Rode o comando de deploy assim que possível** e confirme no Console do
Firebase (Firestore → Regras, Firestore → Índices) que `scannerLocks`,
`assetActiveOps` e `strategyConfig` aparecem nas regras publicadas.

> Atualização: já deployado via `.github/workflows/deploy-firestore.yml`
> (workflow manual, rodado com sucesso) — as regras/índices novos já estão
> live no projeto Firebase real.

> **Incidente real (2026-07-19) — confirma o risco descrito acima.** O
> PR #59 (item 28) adicionou o campo `notified` ao índice composto de
> `signalEvents` em `firestore.indexes.json`, mas `deploy-firestore.yml` não
> foi rodado de novo depois desse PR — o índice novo nunca existiu no
> projeto Firebase real. Sintoma no Telegram: alerta "ativo falhando
> continuamente" com `9 FAILED_PRECONDITION: The query requires an index`
> (o "9" é só o código gRPC do Firestore, não algo do app). A criação do
> índice foi disparada (provavelmente via o link de "criar índice" que o
> próprio erro do Firestore oferece) e terminou de construir sozinha em
> menos de uma hora — confirmado comparando os logs do `scan.yml`: passadas
> antes mostravam falha nesse ativo, a passada das 14:55 (2026-07-19) já
> mostrou `scanAllAssets: 8 ativo(s), 0 falha(s)`. Nenhum dado foi perdido —
> só aquele ativo pulou a checagem de cooldown daquele tipo de sinal
> enquanto o índice não estava pronto. **Lição**: sempre rodar
> `deploy-firestore.yml` na MESMA sessão em que `firestore.indexes.json`
> muda, não depois — um índice composto novo não é automático.

## 6. Render free tier hiberna após inatividade (webhook do TradingView)

O serviço `sentinel-signals-api` no plano gratuito do Render hiberna após
~15 min sem tráfego, levando ~30-60s para "acordar" — mais do que o
TradingView espera antes de desistir da entrega do webhook. Isso já
causou falhas reais confirmadas ("Entrega do webhook falhou — request
took too long and timed out").

> Atualização: mitigado por `.github/workflows/keep-warm.yml`, que faz
> ping em `/health` a cada 10 min (gratuito, GitHub Actions) para manter
> o serviço sempre acordado.

## 7. Webhook do TradingView grava mas não executa ordens

`POST /webhook/tradingview` (`server/index.js`) só registra o alerta em
`tradingviewWebhookEvents` e notifica Telegram — nenhuma ordem é enviada à
Binance. Ver risco #3 acima (TP/Stop virtuais) — a mesma ressalva vale
aqui. Se/quando o projeto evoluir para execução real, essa rota precisará
de uma revisão completa de segurança (chave de API de trading, validação
mais forte do payload, idempotência por estado de posição em vez de só
por `signal_id`).

## 8. Paridade matemática validada por engenharia, não por taxa de acerto

As correções de RSI-crossover, Tier automático, ADX/Choppiness, Time Stop e
Trailing ATR (alinhando o scanner em JavaScript ao Pine v13.2 real) tornam
o bot mais fiel ao script do TradingView e operacionalmente mais protegido
(mais filtros antes de abrir operação, saídas automáticas mais robustas).
Isso é diferente de garantir uma taxa de acerto alta — a taxa de acerto é
uma característica da ESTRATÉGIA (o Pine em si), não do código que a
replica. Bugs de paridade corrigidos aqui reduzem divergência entre o
painel e o TradingView, mas não alteram se a estratégia em si é lucrativa.
Pontos que ainda precisam de validação numérica lado a lado com o
TradingView (não são bugs conhecidos, mas nuances de implementação):
seeding da EMA no Range Filter, convenções de suavização do ADX/DMI, e a
contagem do Time Stop por tempo decorrido (em vez do contador nativo de
barras do Pine).

## 9. Cascata SMC/ICT 1h→5m — porte fiel, não validado por taxa de acerto

`src/lib/indicators/smcStructure.js` porta `detect_swings`/`detect_pivot`/
`detect_structure` (BOS/CHoCH), liquidity sweep e zonas Premium/Discount/
Equilibrium do Pine real do usuário ("SMC+A Unified v2.3") — validado com
testes sintéticos (o CHoCH dispara exatamente na barra de rompimento, não
antes/depois) mas **não** lado a lado com o TradingView real. Desligado por
padrão (`MonitoredAsset.smc_enabled` e `smc_confirm_4h15m`), então não afeta
a cascata 4h/15m existente enquanto não for ativado por ativo.

Escopo desta fase: só o núcleo self-contained do indicador (estrutura,
sweep, zonas PD, PDH/PDL). Order Blocks e Fair Value Gaps (que dependem do
`track_obs`, uma máquina de estados própria, e do alinhamento com volume
profile) ficam para uma fase futura.

Parâmetros que ainda não foram calibrados numericamente contra o script
real: `swing_len` (50 no 1h/4h, igual ao default do Pine; 10 no 5m/15m de
confirmação — um valor menor escolhido para reagir mais rápido no timeframe
de entrada, sem equivalente direto no script original) e o Time Stop da
cascata SMC (96 barras de 1h, valor fixo — não existe um sistema de tier
próprio para essa cascata ainda).

**Atualização (2026-07-22):** o Pine real "SMC+A Unified v2.3" — antes
citado só de nome, nunca salvo no repositório — foi fornecido pelo usuário e
está em `docs/reference-pine/smc-a-unified-v2.3.pine` (núcleo de lógica:
`detect_structure`/BOS-CHoCH, `track_obs`/Order Block, `fvgs_objects`/FVG,
Equal High/Low; regiões puramente visuais do script original omitidas, ver
nota no próprio arquivo). Isso fecha a lacuna "segundo Pine Script não está
no repo" para futura paridade — mas **não muda o escopo atual**: Order
Block e FVG continuam fora de `smcStructure.js`, para uma fase futura com
sua própria suíte de testes de paridade (`.claude/rules/pine-parity.md`).

## 10. Bug de paridade corrigido — Time Stop/Chop Exit/Invalidação/trailing ATR nunca rodavam

Até esta correção, o loop de atualização de `TradeOperation`s ativas
(`persistScanResults`) buscava os dados do indicador por `results[op.timeframe]`
— mas `op.timeframe` sempre foi o candle de CONFIRMAÇÃO de entrada ('15m'),
que nunca existiu como chave em `results` (só '1h'/'4h'/'1d' são buscados).
Na prática isso significa que Time Stop, Chop Exit, Invalidação por RF e o
trailing stop via ATR — todos implementados numa sessão anterior — nunca
executaram de verdade em produção; toda operação ativa só era fechada por
stop/TP via preço (o outro loop, `priceCheckActiveOpsInner`, que é mais
simples e não tinha esse bug). Corrigido adicionando `signal_timeframe` a
cada `TradeOperation` (timeframe do sinal/viés, não da confirmação de
entrada) e trocando a busca para `results[op.signal_timeframe || '4h']`.
Operações abertas antes desta correção não têm `signal_timeframe` gravado —
o fallback para `'4h'` as trata corretamente, já que todas vieram da
cascata 4h/15m (a única que existia até aqui).

**Atenção operacional**: como essa correção liga o Time Stop/Chop
Exit/Invalidação/trailing ATR pela primeira vez em produção, qualquer
`TradeOperation` já aberta há mais tempo que o `tier_time_stop_bars` do seu
tier pode ser fechada automaticamente já no primeiro scan após o deploy
desta correção — não é um bug novo, é o Time Stop (que já era `useTimeStop:
true` por padrão) executando pela primeira vez de verdade. Confira operações
abertas há muito tempo antes de fazer deploy, se isso importar.

## 11. Bugs corrigidos na saída pós-TP1 da cascata SMC (auditoria independente)

Uma auditoria independente (pesquisa de comunidade + revisão de código)
encontrou dois problemas reais na cascata SMC 1h→5m, corrigidos nesta
revisão:

1. **Invalidação pós-TP1 usava o Range Filter do 1h, não a estrutura.** O
   loop de atualização de operações ativas tinha um único branch de
   invalidação pós-TP1 (RF-based) compartilhado pelas duas cascatas — uma
   operação SMC que batesse TP1 podia ser fechada porque o RF do 1h virou,
   mesmo sem a estrutura (CHoCH) ter revertido, contradizendo o próprio
   campo `invalidates_if` gravado na operação. Corrigido: operações com
   `cascade: '1h_5m'` agora invalidam o runner por reversão de estrutura
   (`tfData.smc.trend` contra a posição), não mais pelo RF.
2. **`buildSmcTradeOpData` reusava `pineConfig.trailAtrMult` para o stop
   inicial** — o mesmo erro que o comentário de `buildTradeOpData` já
   alertava para não cometer (esse campo é reservado para o trailing pós-TP1
   do runner, não para o stop inicial). Corrigido com uma constante própria
   (`SMC_INITIAL_STOP_ATR_MULT = 2.0`), desacoplada do parâmetro Pine que
   controla o trailing da cascata RF.

Ponto de metodologia levantado na mesma auditoria — stop inicial ATR-based
sem relação com o nível que invalidaria a tese: **migrado para stop
estrutural** a pedido do usuário (2026-07), ver item 24.

## 12. Testes automatizados (Vitest) e watchdog externo do scan (healthchecks.io)

**Testes**: `src/lib/indicators/*.test.js` cobre as funções puras mais
críticas para decisão de entrada (RSI crossover-de-50, estrutura SMC
BOS/CHoCH, liquidity sweep, zonas PD, ADX, Choppiness Index, classificação
de Tier) com casos de valor conhecido e casos-limite (dados insuficientes,
candles totalmente planos). Rodam via `npm test` (Vitest — escolhido por já
reaproveitar `vite.config.js` sem configuração extra) e bloqueiam o merge:
`ci.yml` roda os testes antes do build, e o job `build` precisa estar
marcado como "required" em Settings → Branches → Branch protection rules
pra realmente impedir o merge com teste quebrado (não é automático só por
existir no workflow). Se um teste falhar, o CI também manda uma mensagem no
Telegram (usa os mesmos secrets do scan) — assim dá pra saber que algo
quebrou sem precisar checar o GitHub manualmente. Cobertura inicial é
parcial por design: ATR/MACD/EMA/RangeFilter/Confluence ainda não têm
testes commitados, é o próximo passo natural quando houver tempo.

**Watchdog do scan**: nada até aqui alertava se o scan agendado parasse de
rodar de verdade (silenciосо) — o Telegram só notifica sobre sinais/operações.
Pesquisa confirmou um risco real do GitHub Actions: workflows agendados
(`schedule`) são desativados automaticamente depois de ~60 dias sem nenhum
push no repositório, sem aviso visível na interface. Um "vigia" feito só
dentro do GitHub sofreria do mesmo problema (se o repo ficar 60 dias
parado, o próprio vigia seria desligado junto). A solução implementada usa
um serviço externo e gratuito (healthchecks.io ou compatível,
`HEALTHCHECKS_PING_URL` como secret opcional): `scripts/run-scan.mjs` avisa
esse serviço a cada scan bem-sucedido (`pingHealthcheck()`, com timeout de
5s e falha silenciosa — nunca derruba o scan de verdade) e avisa
explicitamente via `/fail` se o scan inteiro falhar. O serviço externo, por
sua vez, manda a mensagem de "scanner parado" pro Telegram se não receber
sinal de vida dentro da janela configurada — isso roda fora do GitHub, então
não sofre do mesmo problema dos 60 dias. Erros por-ativo (`scan_status:
'error'` num ativo específico) não contam como "scan parado" — só uma falha
completa do `main()` (`scanAllAssets`/`priceCheckActiveOps` lançando exceção)
interrompe o ping de sucesso.

> **Atualização — healthcheck por ativo (P1, pesquisa de comunidade: padrão
> "dead man's switch" por item).** O gap acima (erro por-ativo não é
> detectado) foi fechado: `MonitoredAsset.scan_error_since` (novo campo)
> rastreia desde quando um ativo está falhando **continuamente** — necessário
> porque `last_scan_at` sozinho não serve, já que é atualizado tanto no
> sucesso quanto no erro (toda passada "toca" o ativo). `scripts/run-scan.mjs`
> roda `checkAssetHealthchecks()` após cada passada: se `scan_error_since`
> (falha persistente) ou `last_scan_at` (silêncio total, ativo parou de ser
> processado) ultrapassar 30 min (6× o cadenciamento de 5 min do cron), manda
> um alerta Telegram (`notifyAssetStale`) — deduplicado via
> `stale_alert_sent_at` para não repetir a cada passada, limpo quando o ativo
> se recupera. Lógica de decisão pura e testada em
> `src/lib/assetHealthcheck.js`. Nunca bloqueia o scan principal (try/catch
> isolado em `run-scan.mjs`).

## 13. Rede de segurança contra tela branca + corte de desperdício no Firestore

**Error Boundary**: até aqui nenhum componente React tinha proteção contra
erro de renderização — qualquer exceção durante o render deixava a tela
inteira em branco, sem nenhuma mensagem. Adicionado `src/components/
ErrorBoundary.jsx` (classe React simples, sem lib nova) em duas camadas:
uma em `src/App.jsx` (aplicativo inteiro) e outra em `src/components/
layout/AppLayout.jsx` (só a página atual, navegação continua funcionando).
Cada erro capturado é registrado via `logError` (mesmo padrão do Debug
Log). Testado manualmente (candle de erro proposital + screenshot,
removido antes do commit) confirmando que o fallback aparece em vez de
tela branca.

**Uso do Firestore perto do limite gratuito**: auditoria encontrou
desperdício real de leituras/escritas no plano Spark (gratuito, 50k
leituras / 20k escritas por dia) — com 10 ativos monitorados, a estimativa
diária de escrita já passava de 90% do limite. Causas corrigidas:
- `getPineConfig()` era buscado 2x por ativo por scan (uma vez em
  `scanAsset`, outra em `persistScanResults`) — agora buscado 1x e
  reaproveitado.
- Um log de "scan completo" era gravado incondicionalmente pra cada ativo
  a cada passada, mesmo quando nada aconteceu — agora só grava quando há
  sinal novo ou erro (`last_scan_at` no `MonitoredAsset` e o watchdog do
  item 12 continuam cobrindo o caso "nada aconteceu, sistema ok").
- A checagem "esse ativo já tem operação ativa?" (`TradeOperation.filter`)
  rodava até 4x por ativo por passada (blocos de entrada e retry das duas
  cascatas) — consolidada numa única busca reaproveitada.
- `priceCheckActiveOpsInner` (checagem de preço) e a checagem periódica de
  anomalias no navegador (`src/lib/logger.js`) buscavam **todas** as
  operações já criadas na história do projeto, descartando a maioria no
  cliente — corrigido pra filtrar direto no Firestore pelos status ativos
  (`SIGNAL_CONFIRMED`/`RUNNER_ACTIVE`, via `where(..., 'in', [...])`), um
  custo que não cresce mais junto com o histórico de operações.
- Aviso automático: o scan agora conta (de forma aproximada, não exata)
  quantas leituras/escritas usou numa passada e, se a extrapolação para um
  dia inteiro passar de 80% do limite gratuito, grava um aviso no Debug Log
  — sem precisar abrir o Console do Firebase pra descobrir.

## 14. Backup diário do Firestore (branch `backups`)

Não existia nenhuma cópia de segurança dos dados — se a conta do Firebase
tivesse um problema, o histórico de sinais/operações sumiria sem
recuperação possível. O export oficial do Firestore (`gcloud firestore
export`) exige um bucket do Cloud Storage, que por sua vez exige o plano
pago Blaze — não é opção aqui (restrição permanente, sem cartão).

Alternativa gratuita implementada: `.github/workflows/backup.yml` roda
todo dia de madrugada, chama `scripts/backup-firestore.mjs` (reusa a mesma
service account do scan agendado) pra ler as coleções de negócio
(`monitoredAssets`, `assetStates`, `signalEvents`, `tradeOperations`,
`priceAlerts`, `strategyConfig` — `systemLogs` e `users` ficam de fora, são
ruído operacional/registros de auth anônima) e publica um snapshot JSON
numa branch `backups`, mantendo os últimos 30 dias. Desde o item 25 abaixo,
o destino é a branch `backups` de um repositório **privado separado**
(`mateusraony/sentinel-signals-backups`), não mais uma branch do próprio
`Sentinel-Signals` (que é público).

Restauração é **deliberadamente manual**, não automática — evita
sobrescrever dado bom por engano numa hora de pânico. Procedimento
documentado em `docs/restore-firestore.md`, usando
`scripts/restore-firestore.mjs` (suporta `--dry-run` e pede confirmação
explícita antes de escrever qualquer coisa).

## 15. "Dois cérebros" (browser + cron escaneando independentemente) — avaliado, sem mudança

O painel (via `src/hooks/useAutoScan.js`, montado sempre que a aba está
aberta: full scan a cada 60min, price-check a cada 2min) e o cron do GitHub
Actions (a cada 5min) chamam as mesmas funções de `src/lib/scanner.js` de
forma independente. Isso foi levantado como risco P1 e avaliado via
`sentinel-council-review` (3 revisores locais independentes: arquitetura,
concorrência, UX/produto+segurança) antes de qualquer mudança de código.

**Veredito: não mexer.** A justificativa original ("consenso de que dois
escritores só valem a pena com exigência real de latência") mirava a
corrida perigosa de concorrência entre os dois — que **já foi corrigida**
pelo CAS transacional (`transitionTradeOp`, ver item P0-a em
`.claude/rules/trading-engine.md`). O ganho de segurança adicional de tornar
o browser somente-leitura hoje é ~zero, e o custo é real:

- **`src/components/layout/TopBar.jsx`** tem um botão manual "Scan" que
  chama as mesmas funções — é a única via de recuperação DENTRO do painel
  quando o cron falha (não há tela de login, então o usuário do painel pode
  não ter acesso ao GitHub Actions para disparar `workflow_dispatch`
  manualmente). Nenhuma versão da proposta considerada remove esse botão.
- O **canal Telegram "ao vivo"** (decisão intencional #2 do `CLAUDE.md`) está
  estruturalmente entrelaçado com a escrita do scan no browser
  (`notifyNewSignal`/etc. disparam logo após a escrita em `persistScanResults`)
  — removê-lo reverteria uma decisão intencional documentada sem pedido
  explícito.
- O browser busca **Futures** (`fapi.binance.com`) enquanto o cron busca
  **Spot** (item 4 acima) — tornar o painel somente-leitura significa que,
  com a aba aberta, o usuário deixaria de ver a visão Futures mais fresca e
  passaria a ver só o que o cron (Spot, a cada 5min) escreveu. Não é um
  refactor neutro de "só simplificação", é uma troca de característica de
  produto.
- O CAS/locks não ficam "código morto" mesmo com o cron como único escritor
  automático: execuções do cron podem se sobrepor entre si (timeout de 8min
  do workflow vs cadência de 5min — os TTLs dos locks foram calibrados
  exatamente para esse cenário) e o botão manual do `TopBar` ainda pode
  colidir com o cron.

Se um dia fizer sentido revisitar: a única mudança de baixo risco discutida
(não implementada) seria remover **só** o timer automático silencioso
(`useAutoScan.js` + `AutoScanRunner` em `AppLayout.jsx`), mantendo o botão
manual do `TopBar` intacto — mas isso exigiria decidir e documentar
explicitamente a perda da visão Futures automática ao vivo, não é um
cleanup silencioso. Não reabrir sem pedido explícito do usuário.

> **Adendo (segunda auditoria externa, 2026-07-18) — ângulo específico
> verificado e confirmado, sem mudança de código.** O `TradeOperation` não
> grava qual fonte de mercado (Spot/Futures) nem qual executor
> (browser/cron) o criou — `priceCheckActiveOpsInner` e `persistScanResults`
> aplicam transições a QUALQUER operação ativa, então uma op criada com
> dado Spot (cron) pode ter TP1/stop decidido por preço Futures (browser
> aberto), e vice-versa. O CAS já garante que a transição de ESTADO é
> atômica (P0-a) — o que não garante é que a fonte de mercado do preço que
> decide essa transição é a mesma que originou a operação. É decorrência
> lógica do que este item já aceita (dois escritores independentes, sem
> fonte canônica); não é um risco novo, mas o ângulo específico não estava
> escrito em nenhum lugar até agora. Não implementar `market_source`/
> `manager_source` sem pedido explícito — mudaria o schema e o
> comportamento de `priceCheckActiveOpsInner` para algo não solicitado.

## 16. Queries Firestore sem corte de histórico — corrigido (P2-1)

Complemento ao item 13 (que já corrigira `priceCheckActiveOpsInner` e a
checagem de anomalias): sobravam 6 queries que buscavam a coleção inteira
(ou todo o histórico de um ativo) e filtravam/ordenavam **no cliente**, cujo
custo de leitura crescia junto com o histórico acumulado:

- `scanner.js` — `hasActiveOp` (`symbol`+`asset_id`) e o loop final de
  atualização de status (`asset_id`) buscavam TODAS as `TradeOperation` do
  ativo/símbolo e filtravam status terminal no cliente — agora ambas passam
  `status: ['SIGNAL_CONFIRMED', 'RUNNER_ACTIVE']` como filtro `in` direto no
  Firestore (o loop final mantém o `continue` de status terminal como defesa
  em profundidade contra uma transação concorrente entre a query e a iteração).
- `scanner.js` — o cooldown de sinal repetido buscava TODOS os `SignalEvent`
  daquele símbolo/timeframe/tipo/fonte e comparava data no cliente — agora
  busca só o mais recente (`sort: '-created_date', limit: 1`).
- `scanner.js` — os dois loops de retry (4h→15m e 1h→5m) buscavam todo o
  histórico de sinais daquele `asset_id`+fonte+timeframe — agora limitados
  aos 10 mais recentes (`sort: '-created_date', limit: 10`; o filtro de
  staleness no cliente continua igual, só a busca ficou limitada).
- `RFHistoryChart.jsx` — buscava todo o histórico de `SignalEvent` do ativo
  para desenhar um gráfico de 30 pontos — agora limitado a 60 mais recentes
  (`sort: '-created_date', limit: 60`; o filtro por `rf_value` presente e o
  `.slice(-30)` seguem no cliente). Nuance aceita: como o limite de 60 não
  filtra por presença de `rf_value` no servidor — o adaptador só suporta
  `==`/`in`, sem operador "existe" — um ativo com muitos sinais SMC
  intercalados poderia ocasionalmente render menos de 30 pontos no gráfico;
  degrada de forma graciosa (menos pontos), nunca quebra.

**Índices compostos novos/estendidos** (`firestore.indexes.json`) —
**exige `firebase deploy --only firestore:indexes` manual** (mesmo passo do
item 5): `signalEvents[symbol,timeframe,signal_type,source,created_date]`,
`signalEvents[asset_id,source,timeframe,created_date]`,
`signalEvents[asset_id,created_date]` (novo), `tradeOperations[symbol,
asset_id,status]`, `tradeOperations[asset_id,status]` (novo). Se o deploy do
índice for esquecido, cada asset é isolado por try/catch em
`scanAllAssetsInner` — o scan não cai inteiro, só aquele ativo marca
`scan_status: 'error'` até o índice ser criado (Firestore geralmente sugere
o índice faltante no próprio erro).

> Atualização: deployado via `.github/workflows/deploy-firestore.yml`
> (workflow manual, disparado pelo usuário, run #2, commit `704d0e6` — já
> inclui todos os índices deste item — concluído com sucesso em
> 2026-07-16). Os índices novos/estendidos já estão live no projeto
> Firebase real.

## 17. Escrita de `AssetState` a cada passada, mesmo sem mudança — corrigido (P2-2)

`persistScanResults` gravava (`AssetState.update`) um doc por timeframe **a
cada passada do scan** (a cada 5min via cron), mesmo quando o candle fechado
mais recente e todos os valores de indicador eram idênticos ao que já estava
salvo — desperdício que cresce linear com o número de timeframes×ativos
monitorados, no mesmo espírito do item 13. Corrigido com
`hasAssetStateChanged` (`src/lib/assetStateDiff.js`, função pura testada em
`assetStateDiff.test.js`): compara os campos de estado (candle, RF, RSI,
MACD, EMA) excluindo `processed_at`, e só grava quando algo realmente mudou.

**Nuance de UX aceita (documentada, não é bug):** como `processed_at` só é
regravado junto de uma mudança real, o rótulo "há quanto tempo" em
`AssetDetailPanel.jsx` deixa de refletir "a última vez que o scan rodou" e
passa a refletir "a última vez que este timeframe teve uma mudança real" —
para timeframes lentos (4h/1d) isso significa mostrar horas em vez de
minutos mesmo com o scan saudável. Isso não é uma regressão de
monitoramento: o healthcheck por ativo (item 12, `MonitoredAsset.last_scan_at`)
é a fonte de verdade sobre se o scan está rodando, independente deste campo.

## 18. GitHub Actions `schedule:` atrasa sob carga — mitigação opcional documentada (P2, decisão do usuário)

Diferente do item 12 (desativação automática após 60 dias sem push — já
mitigado pelo watchdog externo), o `schedule:` do GitHub Actions tem um
segundo problema, menor mas real: pesquisa de comunidade confirma atraso
consistente sob carga (relatos de ~30min de atraso recorrente e casos de
drift passando de 4h em cenários piores) — a própria GitHub documenta que
jobs agendados entram numa fila global sem SLA. Isso significa que o cron
`*/5 * * * *` deste projeto pode, na prática, rodar com menos frequência do
que os 5 minutos configurados.

**Decisão do usuário: sim, configurar um disparo externo.**
`.github/workflows/scan.yml` já expõe `workflow_dispatch: {}` (presente desde
a criação do workflow) — um serviço externo gratuito (cron-job.org, pesquisa
confirma até 60 execuções/hora no plano grátis, headers customizados sem
cartão) pode chamar esse mesmo endpoint via API na hora exata, sem entrar na
fila de agendamento do GitHub. Passo a passo completo em
`docs/claude/external-cron-setup.md` — configuração **fora do repositório**
(conta pessoal + PAT pessoal do usuário), nada para commitar além do guia.

**Não manter os dois gatilhos a cada 5min** (revisão automática do PR #46
corrigiu essa recomendação inicial): dobraria as passadas reais/dia (até 576
em vez de 288), o que o guard de quota do Firestore em `scanner.js`
(`PASSES_PER_DAY`) não detectaria. O guia documenta a sequência correta:
confirmar que o disparo externo funciona primeiro, só então reduzir o
`schedule:` interno para um fallback de baixa frequência (a cada hora) e
ajustar `PASSES_PER_DAY` de 288 para 312 — nessa ordem, para não deixar o
scan ao vivo rodando só 1x/hora achando que ainda roda a cada 5min.
Não substitui o watchdog do item 12 (continua sendo a rede de segurança real
contra "nenhum scan rodou").

> **Atualização — concluído.** Disparo externo (cron-job.org) configurado e
> confirmado funcionando pela própria execução **agendada** (não só o teste
> manual — a run do `scan.yml` disparada pelo cron-job.org apareceu em
> Actions com sucesso). Passo 3 do guia aplicado: `schedule:` interno
> reduzido para `7 * * * *` (fallback horário, minuto 7 — não `0`, que a
> própria documentação do GitHub aponta como pico de carga/atraso) e
> `PASSES_PER_DAY` ajustado de 288 para 312. O relógio de trading volta a
> rodar próximo dos 5min configurados, resolvendo a causa raiz de
> sinais/notificações raríssimos descrita no parágrafo de medição abaixo.
> O fallback horário não é rede de segurança de 30min — se o disparo
> externo falhar logo após uma passada do fallback, a próxima só vem em
> ~1h; quem detecta/alerta dentro de ~30min é o watchdog do item 12.

> **Atualização — medido no projeto real (não mais só pesquisa de
> comunidade).** Analisando o histórico de execuções do `scan.yml` via API
> do GitHub (30 execuções, todas `event: schedule`, span de 48.2h): intervalo
> médio real de **~100 minutos** entre passadas (mínimo 55min, máximo
> quase **3h26**), contra os 5 minutos configurados — uma taxa de execução
> de **~5% do esperado** (30 rodadas reais contra ~578 esperadas no
> período). Isso é bem mais grave do que os "~30min de atraso" que a
> pesquisa de comunidade original sugeria — na prática o `schedule:` deste
> projeto está rodando na faixa de 1x/hora, não 1x/5min, o que reduz
> drasticamente a chance de qualquer sinal/evento ser detectado a tempo de
> gerar notificação. **Reforça a prioridade do disparo externo** — não é
> mais uma otimização, é a correção do relógio de trading estar
> efetivamente quebrado.

## 19. Firestore Emulator Suite rejeitado para teste de concorrência (P2, decisão do usuário)

Cogitado como forma de testar a concorrência real de `TradeOperation`
(CAS transacional, doc-âncora `assetActiveOps`) contra um Firestore de
verdade em vez de um fake em memória. Pesquisa de comunidade + documentação
oficial confirmam que o Emulator **não reproduz fielmente a semântica de
transação/concorrência de produção**:

- A [documentação oficial do Google Cloud](https://docs.cloud.google.com/firestore/native/docs/emulator)
  declara explicitamente: o emulador "não tenta imitar o comportamento de
  transação visto em produção e usa uma abordagem de lock simples" em vez
  dos modos de concorrência reais (pessimista/otimista) do serviço de
  produção.
- [firebase-tools issue #1624](https://github.com/firebase/firebase-tools/issues/1624)
  documenta locks de transação do emulador demorando até 30s para liberar
  sob escritas concorrentes no mesmo documento — ordem de grandeza
  incompatível com testes rápidos de CI.
- A própria documentação recomenda testar contra uma instância real do
  Firestore (não o emulador) quando o comportamento sob teste depende de
  limites/semântica de produção — exatamente o caso do CAS deste projeto.

**Decisão do usuário: não montar o Emulator Suite.** Concordância explícita
com a recomendação: um "verde" no Emulator não provaria nada sobre a
garantia real de concorrência do CAS, e o custo de configurar/manter o
Emulator (mais uma dependência de CI, mais tempo de execução) não se paga
para uma prova que ele não consegue dar. A cobertura de concorrência
adotada em vez disso — introduzida no PR #45 (`src/lib/scannerStateMachine.test.js`),
independente deste PR (que é só documentação) — é um **backend fake em
memória**
(`src/lib/__fixtures__/fakeBackend.js`) que reaproveita a regra pura REAL
(`canApplyTransition`/`isTerminalStatus` de `src/lib/opTransition.js`) e
deixa `persistScanResults`/`priceCheckActiveOps` racearem de verdade via
`Promise.all` sem await individual (interleaving determinístico de
microtask, sem I/O real) — testa a regra de decisão, não a infraestrutura de
lock do Firestore em si (essa parte é responsabilidade do SDK/serviço, fora
do controle deste código). Não reabrir sem mudança de contexto (ex.: um bug
de concorrência real em produção que só reproduza contra um Firestore de
verdade).

## 20. Botão "Scan" manual dava falsa impressão de sucesso quando pulado pelo lock — corrigido

Reportado pelo usuário usando o painel no celular: apertou "Scan" no
`TopBar`, o carregamento terminou rápido demais, sem confiança se realmente
varreu tudo. Causa raiz: `scanAllAssets()` (`scanner.js:1299-1305`) tenta
adquirir o lock `'full-scan'` — o **mesmo nome de lock** usado pelo cron do
GitHub Actions — antes de escanear; se estiver ocupado (cron rodando
naquele instante), a função retorna imediatamente `{ total: 0, results: [],
skipped: true }`, sem tocar em nenhum ativo e sem nunca chamar a callback de
progresso. `TopBar.jsx`'s `handleScan` descartava esse retorno por completo:
atualizava "última atualização" e invalidava as queries mesmo quando nada
tinha rodado — indistinguível, na UI, de um scan bem-sucedido.

Isso é especialmente sensível porque esse botão é a **única via de
recuperação manual dentro do painel** quando o cron falha (item 15) — um
usuário que confiasse na falsa confirmação de sucesso não saberia que
precisa tentar de novo.

**Correção** (`src/components/layout/TopBar.jsx`, só UI — nenhuma mudança
em `scanner.js`): captura o retorno de `scanAllAssets` e usa o componente de
toast que já existia no projeto (mas nunca tinha sido usado —
`@/components/ui/use-toast` + `<Toaster />` já montado em `App.jsx`) para
avisar explicitamente cada caso: pulado por lock ocupado (não atualiza
"última atualização"), concluído com contagem de ativos com erro, ou falha
inesperada — em vez de silêncio ou falso sucesso.

## 21. Retry de sinal re-apontava `assetActiveOps` para operação terminal — corrigido (P0-f)

Encontrado ao verificar uma auditoria técnica externa (2026-07): era o único
P0 dela ainda válido — os demais (candle pré-entrada, corrida entre loops,
trailing look-ahead, contador RF por scan) já estavam corrigidos (itens
P0-a/c/d/e em `.claude/rules/trading-engine.md`).

**O bug**: `createTradeOpIfNoneActive` (`src/api/entities.js` + espelho
`scripts/adminEntities.js`), no ramo em que a operação com ID determinístico
já existia, regravava o ponteiro `assetActiveOps/{assetId}` para ela **sem
verificar estado terminal**. Caminho real: sinal → op criada → stop rápido
via `priceCheckActiveOps` (transição terminal limpa o ponteiro) → o loop de
retry reprocessa o mesmo sinal dentro da janela de frescor e reusa o mesmo ID
→ ponteiro volta a apontar para a op terminal. Como `canApplyTransition`
rejeita qualquer transição em op terminal, a limpeza em-transação do
`transitionTradeOp` nunca mais roda — o ativo fica **bloqueado para novas
entradas para sempre**. O fake de teste replicava o comportamento, mascarando.

**Correção** (auto-reparo, sem script one-shot): a decisão foi extraída para
`planTradeOpCreation` em `src/lib/opTransition.js` (mesmo padrão do
`canApplyTransition` — uma regra pura compartilhada por browser, cron e fake).
A transação agora lê também a op apontada pelo ponteiro: ponteiro cujo alvo
não existe ou é terminal conta como **vago** (auto-reparo — ponteiros já
corrompidos no banco são consertados na primeira tentativa de entrada
seguinte); op determinística terminal **nunca** volta a ser apontada como
ativa; op determinística viva sem ponteiro (janela de crash entre criar a op
e gravar o ponteiro) continua restaurando o ponteiro como antes. Custo: até
1 leitura extra por tentativa de entrada com ponteiro setado. Regressão
coberta em `opTransition.test.js` (regra pura) e
`scannerStateMachine.test.js` (cenário completo de retry pós-stop — falhava
antes da correção).

## 22. Win rate inconsistente entre telas — corrigido (rodada de métricas)

Apontado pela mesma auditoria externa e confirmado no código: os cards do
dashboard contavam vitória apenas quando `status === 'TP2_HIT'`
(`PerformanceBar.jsx`, `PerformanceMetricsBar.jsx`, `PerformanceOverview.jsx`,
`TradeHistory.jsx`, `Trades.jsx` — breakeven pós-TP1 fora das vitórias),
enquanto `MonthlyReport.jsx`/`PerformanceReport.jsx` contavam PnL > 0, e
`PerformanceReport.jsx`/`PortfolioVsMarket.jsx` aplicavam um peso heurístico
0.5. Uma op que bateu TP1 (parcial positiva) e saiu no breakeven aparecia
como não-vitória nos cards. Havia 10 cópias inline de `calcPnl`, nenhuma
usando o `partial_percent` persistido nem o `initial_stop`.

**Atualização — resolvido.** Fonte única em `src/lib/tradeMetrics.js`
(funções puras, padrão `opExitRules.js`; testes hand-computed em
`tradeMetrics.test.js`), consumida por todas as 10 superfícies de
performance. Política adotada (convenção de comunidade R-multiple/expectancy):

- **R = resultado realizado / risco inicial** (`|entry_price −
  initial_stop|`) — nunca `current_stop`, que pós-TP1 já é breakeven/trailing
  (isso também corrigiu o `calcRR` de `TradeHistory.jsx`).
- **Parcial ponderada por perna**: com `tp1_hit`, resultado =
  `partial_percent`·(TP1 − entry) + runner·(saída − entry), em qualquer
  status final (incl. INVALIDATED/CLOSED pós-TP1). O preço da perna TP1 é o
  nível teórico (`tp1_hit_price ?? tp1` — ambos os loops gravam o teórico),
  proxy sem slippage, coerente com trading virtual.
- **WIN/LOSS/BE pelo resultado realizado**, nunca pelo status: WIN se
  R > +0.05, LOSS se R < −0.05, BE no meio (ε parametrizável). Uma
  INVALIDATED lucrativa é WIN; TP1+breakeven (=+0.75R com 50/50 e tp1R 1.5)
  é WIN — antes era "BE" em toda tela.
- **winRate = W/(W+L+BE)** em todas as telas (antes havia 3 denominadores).
  Curva de capital/drawdown ordenada por data de fechamento.
- Ops legadas degradam em vez de sumir: sem `initial_stop` → classifica por
  PnL%; sem `partial_percent` → 50/50; sem `exit_price` → fallback por
  status; edição manual (`exit_price` editado) é respeitada como verdade.

**Consequência esperada**: os números exibidos mudaram — win rate tende a
subir (BE-pós-TP1 e INVALIDATED lucrativa viram WIN) e os totais de
`PerformanceReport`/`PortfolioVsMarket` divergem do histórico (peso 0.5
removido em favor do modelo por pernas, estritamente mais correto). É
mudança de metodologia, não bug.

**Limitações mantidas (aceitas)**: perna TP1 a preço teórico; `scanner.js`
intocado nesta rodada (tudo calculado dos campos já persistidos).

**SUPERADO pela Fase 5 (item 44)**: este item declarava "sem taxas, funding ou
slippage (trading virtual, sem fills reais)" como limitação aceita. Deixou de
valer — `tradeMetrics.js` passou a descontar taxa, slippage e funding **por
padrão**, no painel e no backtest. A justificativa original ("trading virtual,
sem fills reais") era coerente enquanto o módulo servia só para exibir
histórico; deixou de ser quando os relatórios de backtest viraram o critério
de ativação das Fases 2-4 e o custo omitido passou a inflar exatamente o
número que decide. Ver item 44.

## 23. Gaps menores da auditoria externa — fechados (arbitragem entre cascatas observável + corte de escrita por passada)

Dois resíduos apontados na verificação da auditoria externa (2026-07), itens
8 e 12d dela:

1. **Sinal descartado por operação ativa era silencioso.** As duas cascatas
   (RF 4h→15m e SMC 1h→5m) compartilham o guard de 1 operação por ativo
   (`assetActiveOps`), então uma bloqueia a entrada da outra — mas o descarte
   não deixava rastro, impossibilitando avaliar depois se o filtro protege ou
   elimina boas oportunidades. **Fechado**: os blocos de entrada de
   `persistScanResults` agora gravam `SystemLog` estruturado
   (`reason: 'active_op_exists'`, `candidate_signal`, `candidate_cascade`,
   `active_op_id`, `active_op_cascade`, `confirmation_checked: false` — a
   confirmação do timeframe menor NÃO é avaliada para candidato bloqueado,
   de propósito: evita um fetch de candles extra e a op ativa bloqueia a
   janela de retry inteira; o campo deixa o dado honesto, apontamento do
   review do Codex no PR) — 1 log por sinal novo persistido
   (o dedup por `createUnique` garante que re-scans do mesmo sinal não
   repetem; os loops de retry permanecem silenciosos de propósito para não
   logar a cada passada de 5 min). Testes em `scannerStateMachine.test.js`.
2. **Escrita transitória `scan_status: 'scanning'` a cada passada.** Uma
   escrita em `MonitoredAsset` por ativo por passada que nenhum componente
   consumia (o feedback de progresso do botão Scan vem do callback
   `onProgress`, não do Firestore): ~2.3k escritas/dia desperdiçadas com 8
   ativos na cadência de 5 min, sobre a cota gratuita de 20k/dia. **Fechado**:
   escrita removida; o status real (success/error) continua gravado ao fim da
   passada por `persistScanResults` — `last_scan_at`/`scan_error_since`, dos
   quais o healthcheck por ativo depende, não mudaram. O valor `'scanning'`
   ficou como legado no enum do schema (`MonitoredAsset.jsonc`).

## 24. Stop estrutural na cascata SMC 1h→5m — implementado (era o item de design pendente do 11)

A pedido do usuário (2026-07), o stop inicial da cascata SMC deixou de ser
2×ATR(1h) fixo e passou a ser **estrutural**: além do nível que invalida a
tese do gatilho 5m, com salvaguardas ATR. Pesquisa de comunidade (ICT/SMC)
validou o desenho: stop **além** do extremo varrido/swing protetor — nunca
exatamente no nível, que é tocado rotineiramente em spikes de indução — com
buffer, piso mínimo de ~0.5×ATR contra ruído e cap de risco.

- **Nível estrutural** (calculado em `check5mSmcConfirmation`): gatilho
  `sweep` → o próprio pavio do candle de sweep (por construção, o extremo
  além do swing de 20 barras que ele varreu); gatilho `structure`
  (BOS/CHoCH) → extremo protetor da mesma janela de 10 barras usada pelo
  cálculo de estrutura 5m.
- **Regra pura** `computeStructuralStop` (`src/lib/opExitRules.js`, testada):
  `stop = nível ∓ 0.1×ATR(1h)` (buffer), com piso `0.5×ATR` (ruído 5m não
  gera stop colável) e cap `2.0×ATR` = `SMC_INITIAL_STOP_ATR_MULT` — **o
  comportamento antigo virou o pior caso**: o risco nunca excede o modelo
  pré-migração; nível ausente/do lado errado cai no fallback ATR puro.
- TP1/TP2 continuam derivados de `riskR` (tp1R/tp2R do Pine), então escalam
  automaticamente com o stop mais justo. Trailing pós-TP1, invalidação por
  estrutura e Time Stop não mudam.
- Observabilidade: a op grava `stop_basis`
  (`structural|structural_floored|structural_capped|atr_fallback`) e
  `structural_level` (schema atualizado) — dá para medir depois quanto cada
  regime de stop contribui em R (via tradeMetrics, item 22).
- A cascata RF 4h→15m **não muda** (segue tier ATR — é paridade com o Pine
  v13.2). Nota de paridade: o stop estrutural é decisão de produto local da
  cascata SMC portada, divergência consciente registrada aqui.

## 25. Backup diário publicava dados de negócio em branch pública — corrigido (P0 de segurança)

Encontrado por uma segunda auditoria externa (2026-07-18), verificado no
código e confirmado ativo: o repositório é **público**, e a branch `backups`
(item 14 acima) já tinha snapshots diários reais — `backup-2026-07-15.json`
até `backup-2026-07-18.json` no momento da verificação — publicando
`monitoredAssets`, `assetStates`, `signalEvents`, `tradeOperations`,
`priceAlerts` e `strategyConfig` de qualquer forma acessíveis a qualquer
pessoa. Não é risco preventivo: é exposição ativa há pelo menos 4 dias
quando encontrada.

Duas ressalvas técnicas importantes, verificadas antes de agir:
- **Apagar arquivos antigos com `git rm` + commit não purga o histórico.**
  O workflow (`.github/workflows/backup.yml`) já fazia isso para manter
  "só os últimos 30 dias" — mas os commits anteriores continuam recuperáveis
  por qualquer clone (`git show <sha>:backup-X.json`). A retenção de 30 dias
  nunca foi uma garantia de remoção, só de tamanho da branch.
- **A sugestão comum de "usar GitHub Actions artifact privado" não funciona
  aqui** — verificado (pesquisa + docs oficiais): em repositório público, os
  artifacts de workflow runs também são baixáveis publicamente via API REST
  sem autenticação. Só um destino verdadeiramente fora do repo público
  resolve.

**Ação tomada nesta rodada**: o `schedule:` do workflow foi removido
(`workflow_dispatch` continua disponível para rodar manualmente). Isso para
novos snapshots de vazarem a partir de agora. A branch `backups` existente
**não foi apagada** — ela é a única cópia de segurança do Firestore que
existe hoje, e apagá-la não desfaz a exposição para quem já clonou/viu o
conteúdo, então removê-la só reduziria a rede de segurança sem reduzir o
vazamento já ocorrido.

**Limitação desta sessão**: criar um repositório privado novo para receber
os backups exigiria uma chamada de API (`create_repository`) que retornou
`403 Resource not accessible by integration` — o app do GitHub desta sessão
só tem acesso ao repositório já escopado, não pode criar recursos novos na
conta do usuário. Requer ação manual.

### Passo a passo para reativar com segurança (ação do usuário)

1. Criar um repositório **privado** novo (gratuito, ilimitado no plano
   free do GitHub) — sugestão de nome: `sentinel-signals-backups`.
2. Gerar um **fine-grained personal access token** com acesso de escrita
   (`Contents: write`) restrito só a esse repositório novo.
3. Adicionar esse token como secret no repositório `Sentinel-Signals`
   (Settings → Secrets and variables → Actions), sugestão de nome:
   `BACKUP_REPO_TOKEN`.
4. Avisar numa sessão do Claude Code — o passo do workflow que faz
   `git push origin backups` é trocado para clonar/pushar no repositório
   privado usando esse token, e o `schedule:` é restaurado.

Até esse passo ser concluído, o Firestore fica **sem backup automático**
(rede de segurança do item 14 temporariamente suspensa) — trade-off
deliberado: nenhum backup é mais seguro que um backup público.

> **Atualização (2026-07-19) — concluído.** Repositório privado
> `mateusraony/sentinel-signals-backups` criado pelo usuário. A autenticação
> não usou PAT/token — depois de **4 tentativas** com token (fine-grained e
> depois clássico) falhando com `remote: Repository not found` mesmo com
> conta, secret e tamanho do token todos conferidos corretos (diagnóstico
> por um passo temporário no workflow que imprimia só o *tamanho* do token,
> nunca o valor — confirmou 40 caracteres, ou seja, não vazio/não
> incompleto), a causa mais provável identificada foi confusão entre a
> caixinha `repo` (a certa) e `public_repo` (parecida, mas sem acesso a
> repositório privado) na tela de escopos do GitHub — um erro fácil de
> cometer e impossível de diagnosticar remotamente, já que ninguém (nem o
> dono do token) consegue ver de novo quais caixinhas foram marcadas depois
> de gerado.
>
> Trocado para **deploy key SSH** em vez de token: uma chave ed25519 gerada
> pela sessão do Claude Code (verificada localmente com `ssh-keygen -y`
> antes de entregar, confirmando que pública/privada batem), com a chave
> pública cadastrada como Deploy Key (**write**) só no repositório privado
> de backup, e a privada como secret `BACKUP_DEPLOY_KEY` no `Sentinel-Signals`.
> Deploy key elimina a classe inteira de erro do PAT — não tem lista de
> escopos, é só um par leitura/escrita ligado a exatamente um repositório.
> `.github/workflows/backup.yml` troca a URL de push de
> `https://x-access-token:$TOKEN@github.com/...` para
> `git@github.com:mateusraony/sentinel-signals-backups.git`, com
> `ssh-keyscan` fixando a chave do host antes do push (evita prompt
> interativo de host desconhecido) e `GIT_SSH_COMMAND` apontando pra chave
> privada baixada do secret.
>
> Confirmado por execução manual (`workflow_dispatch`) bem-sucedida em
> 2026-07-19 — o snapshot do dia apareceu na branch `backups` do repositório
> privado no horário esperado. `schedule` reativado (`23 3 * * *`, fora do
> topo da hora — ver item 18 sobre o minuto 0 ser o de maior atraso).
> Backup automático diário voltou a rodar, agora com destino privado.

## 26. Candle pós-sinal-mas-pré-entrada podia gerar TP/stop falso em confirmações atrasadas — corrigido (P0-g)

Achado real de uma segunda auditoria externa (2026-07-18), distinto e mais
fino que o P0-c já corrigido — verificado no código antes de agir:
`entry_candle_time_15m`/`entry_candle_time_5m` (o horário real da
confirmação 15m/5m) já eram gravados na criação de toda operação, mas **não
eram lidos em lugar nenhum** — a guarda temporal (`isCandleUsableForExits`)
e o Time Stop (`barsOpen`) usavam `op.candle_close_time`, o candle do
SINAL (4h/1h), não o da entrada.

**O bug**: um sinal 4h fechado às 08:00 cuja confirmação 15m só chega às
11:45 (retry — pode levar até ~4h) tem seu primeiro candle "utilizável"
(08:00–12:00) considerado seguro pela guarda antiga, porque o fechamento
dele (12:00) é posterior ao fechamento do candle de sinal (08:00) — mesmo
esse candle contendo ~3h45 de movimento de preço de ANTES da operação
existir. Um wick nessa janela podia disparar STOP_HIT/TP1 retroativamente.
O mesmo horário errado também alimentava o Time Stop, fazendo uma entrada
atrasada "envelhecer" antes de nascer.

**Correção**: `isCandleUsableForExits` (`src/lib/opExitRules.js`) passou a
comparar o **open** do candle candidato (não o close) contra o horário real
da entrada via nova função `getEntryReferenceTime` (prioriza
`entry_candle_time_15m`/`_5m`, cai para `candle_close_time` quando ausente —
ops legadas/manuais/webhook mantêm o comportamento anterior). Só um candle
que COMEÇA no ou após o instante da entrada está garantidamente livre de
contaminação. No caminho rápido (confirmação sem atraso) o resultado é
idêntico ao P0-c original — a correção só muda o comportamento quando há
atraso de retry, exatamente onde o bug existia; o intervalo entre o sinal e
a criação da op continua coberto pelo price-check em tempo real (preço
spot ao vivo, não histórico), que nunca dependeu desses campos.

Regressão: `opExitRules.test.js` (regra pura, incluindo o cenário exato do
bug com valores hand-computed) e `scannerStateMachine.test.js` (dois casos
de integração via `persistScanResults` — candle contaminado por retry e
Time Stop prematuro — ambos confirmados falhando contra o código antigo
antes da correção).

## 27. Pine e scanner podiam divergir silenciosamente em EMA/RSI/volume/ATR — corrigido

Segunda auditoria externa (2026-07-18) + verificação: `pineParser.js`
tinha `emaFastLen:20, emaSlowLen:50, rsiLen:14, volLen:20, atrLen:14` em
`DEFAULTS` desde sempre, mas **nenhum desses cinco estava em
`SYNCED_STRATEGY_KEYS`** — nunca eram escritos em `strategyConfig/current`.
Enquanto isso, `scanner.js` calculava:

- EMA: `asset.ema_short || 9` / `asset.ema_long || 21` — fallback hardcoded
  **divergente** do Pine real (20/50), nunca lendo `pineConfig`;
- RSI: `asset.rsi_period || 14` — mesma desconexão (coincidência numérica
  com o default do Pine, não conexão real);
- Volume: `const VOL_PERIOD = 20;` — constante local, surda a `pineConfig`;
- ATR do stop/TP: `calculateATR(closedCandles, 14)` — hardcoded, também
  surdo (só o ATR% do Tier já lia `pineConfig.atrLen`, mas essa chave
  também não estava sincronizada, então só refletia o `DEFAULTS` local).

Ou seja: mudar o EMA/RSI no Pine Script e sincronizar **não alterava** o
score real calculado pelo scanner — o placar de 20 pontos de EMA e o
threshold de RSI usados pra decidir sinais reais continuavam nos valores
antigos. A própria UI já expunha essa divergência sem perceber: telas
diferentes mostravam fallbacks diferentes para o mesmo campo (20/50 numa,
9/21 noutra).

Risco adicional descoberto durante a correção (não estava na auditoria):
`AssetConfigPanel.jsx` pré-preenchia o formulário com os valores errados
(9/21/14) e `handleSave` grava o objeto inteiro de volta a cada save —
então abrir o painel de qualquer ativo por qualquer motivo (ex.: só mudar o
cooldown) e salvar **gravava permanentemente** os valores errados no
Firestore daquele ativo, o que teria neutralizado a correção do scanner
para esse ativo especificamente.

**Correção**:
- `emaFastLen`, `emaSlowLen`, `rsiLen`, `volLen`, `atrLen` adicionados a
  `SYNCED_STRATEGY_KEYS` em `src/lib/pineParser.js` e
  `scripts/adminPineConfig.js` (mantidos espelhados à mão, como o resto).
- Nova função pura `resolveIndicatorParams(asset, pineConfig)`
  (`src/lib/scanner.js`) resolve cada parâmetro como
  `asset.campo ?? pineConfig.campo ?? literal` — **preserva a customização
  por-ativo como recurso** (continua podendo sobrescrever), só corrige o
  *fallback*, que passou a ser o valor real do Pine em vez de um literal
  desatualizado. Volume e ATR do stop não têm campo por-ativo — vêm só do
  Pine ou do literal.
- `AssetConfigPanel.jsx` passou a inicializar o formulário com
  `getLocalPineConfig()` (síncrono, mesmo padrão já usado no resto do
  browser) em vez do literal errado — fecha o loop do risco descrito acima.
- Displays alinhados: `AssetDetailPanel.jsx` (9/21→20/50); rótulo
  "MACD Fast" em `PineScript.jsx` tinha `pine: 'emaFastLen'` (cópia-e-cola
  errada, MACD não é parâmetro sincronizado) — removido.
- Schema (`MonitoredAsset.jsonc`) atualizado: `ema_short`/`ema_long`
  documentavam default 9/21 (o valor errado que estava em produção),
  agora 20/50.

**Deliberadamente não conectado** (mesma auditoria apontou, decisão
registrada, não bug): `onlyClosedCandles` continua sincronizado mas nunca
lido por `scanner.js` — vestigial, o scanner já sempre filtra candles
fechados incondicionalmente; ligar esse parâmetro só faria sentido para
permitir `false` (avaliar candles não fechados), o que seria uma troca de
segurança, não uma correção.

> **Atualização — `confirmBars` implementado** (rodada própria, como
> planejado aqui). `src/pages/PineScript.jsx` contém o Pine real do usuário
> como string/JSX — a implementação real (`ta.barssince` + um loop
> `close[i]>filt[i] && fdir[i]==dir` sobre os últimos `confirmBars` candles
> já fechados) é **retroativa**, não um contador que precisa de estado entre
> scans: computável inteiramente a partir das séries que
> `calculateRangeFilter` já produz. Nova função pura `calculateConfirmedSignal`
> (`src/lib/indicators/rangeFilterConfirmation.js`) porta esse bloco;
> `scanAsset` resolve `confirmBars` de `pineConfig` (parâmetro global do
> Pine, sem override por-ativo — decisão preservada) e passa o sinal
> confirmado para o bloco de geração de `newSignals` e para
> `calculateSignalStrength` (que já somava +25 de "follow-through", antes
> derivado só de `rfResult.direction` no candle atual — mesmo mecanismo Pine,
> agora correto para `confirmBars>1` também).
>
> **Provado matematicamente, não só testado**: em `confirmBars=1` (o default
> sincronizado hoje), `calculateConfirmedSignal` é idêntico ao sinal bruto de
> sempre — `longCond`/`shortCond` (`rangeFilter.js`) exigem `close>filt &&
> upward` em ambos os ramos do OR, então sempre que o flip dispara essa
> condição já vale por construção. Medido sobre 500 candles reais
> (`goldenCandles(500)`): equivalência bar a bar, sem exceção
> (`rangeFilterConfirmation.test.js`). **Nenhuma mudança de comportamento até
> o usuário subir `confirmBars` acima de 1 no editor Pine e sincronizar.**
>
> Regressão adicional: casos sintéticos de whipsaw (quebra a confirmação,
> oportunidade perdida — não adiada) e confirmação limpa (dispara exatamente
> na N-ésima barra, nem antes nem depois); consistência por prefixo
> (`goldenParity.test.js`, sem look-ahead); prova de wiring fim a fim contra
> o `scanAsset` real, reusando o candle de flip já empírico de
> `backtestEngine.test.js` (BUY na barra 102) — confirmado sem sinal na
> barra do flip e com sinal exatamente 2 barras depois em `confirmBars=3`.
> Todos os novos testes confirmados falhando contra o código anterior antes
> da correção.
>
> Fora de escopo desta rodada: campo de observabilidade `rf_confirmed_signal`
> em `AssetState` (bruto vs. confirmado lado a lado) — aditivo, baixo risco,
> mas não pedido; clamp de `confirmBars` ao `maxval=5` do input Pine — sem
> clamp, mesmo padrão de outros campos sincronizados (`minScore`/`tp1R`).

Regressão: `resolveIndicatorParams` testado em `scannerStateMachine.test.js`
(override por-ativo, fallback pro Pine real, fallback pro literal, campos
sem override por-ativo, formato de produção).

## 28. Cooldown de alertas bloqueava o sinal inteiro, não só a notificação — corrigido

Segunda auditoria externa (2026-07-18) + verificação: em `persistScanResults`
(`src/lib/scanner.js`), o `continue` de conflito de cooldown rodava **antes**
até de `SignalEvent.createUnique` — ou seja, um sinal dentro da janela de
cooldown não era só silenciado no Telegram: **nunca era gravado**. Isso
bloqueava, para aquele sinal: o registro do `SignalEvent`, toda a avaliação
do motor de entrada (confirmação 15m/5m, criação de `TradeOperation`) e a
elegibilidade do loop de retry (que relê `SignalEvent`s persistidos — um
sinal nunca gravado nunca pode ser re-tentado). Aumentar
`alert_cooldown_minutes` no painel para reduzir spam de notificação
eliminava silenciosamente entradas válidas — o texto da UI ("minutos entre
**alertas** iguais") já prometia só afetar notificação; era o código que
quebrava essa promessa.

**Correção**: a checagem de cooldown continua rodando **antes** de persistir
(mesma query, mesma janela — `recentSame` naturalmente exclui o sinal atual,
ainda não gravado), mas seu resultado (`notificationOnCooldown`) agora só
guarda a chamada `notifyNewSignal` — `SignalEvent.createUnique` e todo o
motor de entrada rodam **incondicionalmente**, independente de cooldown. O
dedup por `dedup_key` (proteção contra sinal exatamente duplicado) não muda.

Regressão em `scannerStateMachine.test.js`: sinal dentro do cooldown é
persistido (`persistedSignals === 1`), a notificação é suprimida, e o motor
de entrada é alcançado (log de "aguardando confirmação 15m"); um segundo
teste confirma que fora da janela de cooldown a notificação dispara
normalmente. Confirmado que o primeiro caso falha contra o código antigo
(`persistedSignals` ficava 0 — o sinal nunca era persistido).

> **Atualização (review do Codex, PR #59) — dois gaps reais encontrados e
> corrigidos na mesma rodada:**
>
> 1. **A âncora do cooldown podia se esticar indefinidamente.** Como todo
>    sinal passa a persistir independente do resultado do cooldown, a query
>    "sinal mais recente do mesmo tipo" podia encontrar um sinal
>    **suprimido** (não notificado) como âncora — numa sequência de sinais
>    frequentes, isso podia suprimir o Telegram por muito mais tempo do que
>    os N minutos configurados, mesmo com o último alerta real há muito
>    tempo. Corrigido: novo campo `notified` (persistido em cada
>    `SignalEvent`, refletindo `!notificationOnCooldown && isTelegramConfigured()`
>    no momento da criação) e a query de cooldown passou a filtrar
>    `notified: true` — a âncora agora é sempre o último alerta **de
>    verdade**, nunca um sinal só registrado. Índice do Firestore
>    (`firestore.indexes.json`) atualizado com esse campo — **exige
>    `firebase deploy --only firestore:indexes`** (mesmo passo manual do
>    item 5) antes de valer em produção.
> 2. **Toast, banner e notificação do navegador ignoravam o cooldown.** A
>    correção original só gateava o `notifyNewSignal` (Telegram) — mas o
>    Dashboard lê todo `SignalEvent` recente e alimenta `SignalToast`,
>    `SignalAlertBanner` e `useBrowserNotifications` (API de notificação do
>    SO) com filtros próprios de frescor/fonte, sem noção de cooldown. Um
>    sinal suprimido no Telegram ainda geraria toast/banner/notificação do
>    SO com o painel aberto. Corrigido: os três consumidores agora checam o
>    mesmo campo `notified` (registros antigos sem o campo contam como
>    notificados, para não esconder histórico pré-2026-07-18).
>
> Resultado: `notified` é hoje a fonte única de "este sinal deveria alertar
> alguém", consumida por Telegram e por todo canal in-app/OS — nenhum
> precisa mais re-derivar o estado de cooldown por conta própria.

## 29. Fechamentos INVALIDATED/TIME_STOP/CHOP_EXIT nunca notificavam no Telegram — corrigido

Segunda auditoria externa (2026-07-18): `persistScanResults` (`src/lib/scanner.js`)
só tinha branches de notificação para `STOP_HIT`, `TP2_HIT` e TP1 (`tp1Hit`) no
bloco único de notificação pós-transição. As outras três formas terminais de
saída de uma operação — `INVALIDATED` (reversão de estrutura/RF), e `CLOSED`
com `closed_reason` `TIME_STOP` (prazo máximo sem TP1) ou `CHOP_EXIT` (mercado
lateralizado) — fechavam a operação silenciosamente: o usuário só descobria
olhando o painel, mesmo essas saídas sendo tão relevantes quanto um stop
atingido (é dinheiro saindo de uma posição sem alerta).

De quebra, ao investigar o bloco de transição pós-TP1 (`RUNNER_ACTIVE`), as
duas branches que levam a `INVALIDATED` (reversão de estrutura SMC e reversão
do RF) não gravavam `updatePayload.closed_reason = 'INVALIDATION'` — só a
branch pré-TP1 fazia isso. Inconsistência sem efeito visível até agora (nada
lia `closed_reason` para um `INVALIDATED`), mas corrigida junto por ser a
mesma superfície de código e por já ter teste de regressão cobrindo o campo.

**Correção**: três novas funções em `src/lib/telegram.js` (espelhadas em
`scripts/adminTelegram.js`) — `notifyInvalidated`, `notifyTimeStop`,
`notifyChopExit` — adicionadas a `DEFAULT_FILTERS.events` (ligadas por padrão,
mesmo critério dos outros eventos de fechamento) e à lista `EVENT_OPTIONS` de
`TelegramSettings.jsx`. O bloco único de notificação em `persistScanResults`
ganhou três `else if` novos (INVALIDATED; CLOSED+TIME_STOP; CLOSED+CHOP_EXIT),
e as duas branches pós-TP1 de INVALIDATED passaram a setar `closed_reason`
consistentemente com a branch pré-TP1.

`priceCheckActiveOpsInner` (o loop baseado em preço ao vivo) não precisou de
mudança — confirmado por leitura que esse loop só produz
`STOP_HIT`/`RUNNER_ACTIVE`/`TP2_HIT`, nunca `INVALIDATED`/`CLOSED` (essas duas
dependem de indicador de candle — RF, SMC, choppiness, tempo decorrido — só
disponíveis no loop `persistScanResults`).

Regressão em `scannerStateMachine.test.js`: 5 testes existentes (TIME_STOP,
CHOP_EXIT, INVALIDATED pré-TP1 via contador RF, INVALIDATED pós-TP1 via RF,
INVALIDATED pós-TP1 via SMC) ganharam asserções de que a função `notify*`
correta é chamada com `(op, price)` quando `isTelegramConfigured()` é `true`;
os dois casos pós-TP1 também passaram a checar `closed_reason === 'INVALIDATION'`.
Confirmado via `git stash` que os 5 falham contra o código anterior (as 3
notificações não disparavam; os 2 `closed_reason` vinham `undefined`) e
voltam a passar com a correção restaurada.

> **Atualização (2026-08-02, limpeza de achados "já conhecidos"):**
> `runner_active` (opção em `EVENT_OPTIONS`, `TelegramSettings.jsx`) nunca
> teve função `notify*` correspondente — ficava na tela sem fazer nada se
> marcado. Não era uma implementação faltando, era um toggle morto:
> **removido** de `EVENT_OPTIONS` nesta rodada (pedido explícito do
> usuário, decisão de limpeza, não implementação da notificação).
> Usuários com esse id salvo em `localStorage` não são afetados — o id só
> deixa de aparecer na UI, sem efeito em nenhum outro filtro.

> **Atualização (review do Codex, PR #60) — gap real de migração
> encontrado e corrigido na mesma rodada:** `getTelegramFilters()`
> (`src/lib/telegram.js`) só aplica `DEFAULT_FILTERS` (com os 3 eventos
> novos) quando **nada** está salvo em `localStorage`. Um usuário que já
> tinha salvo filtros do Telegram **antes** desta mudança continuaria com o
> array `events` antigo — os 3 eventos novos ficariam suprimidos por
> `shouldSend()` até o usuário abrir Configurações manualmente, mesmo eles
> sendo "ligados por padrão" na intenção da mudança. Corrigido: na leitura,
> se o objeto salvo ainda não tem a flag `_migratedEvents20260718`, os
> eventos novos ausentes são mesclados no array **e a migração é persistida
> de volta** via `setTelegramFilters` — a flag existe justamente para que
> essa mesclagem rode uma única vez; sem ela, uma leitura futura veria o
> evento "ainda ausente" e o adicionaria de novo, tornando impossível
> desligar `invalidated`/`time_stop`/`chop_exit` depois de ligados uma vez.
> `scripts/adminTelegram.js` (canal 24h/cron) não precisou do mesmo fix —
> não tem filtros persistidos, sempre usa `DEFAULT_FILTERS` diretamente.
> Regressão em `src/lib/telegram.test.js` (novo arquivo): filtros antigos
> sem os 3 eventos são migrados e persistidos; filtros já migrados onde o
> usuário desligou um evento não o recebem de volta; confirmado via `git
> stash` que o teste de migração falha contra o código anterior.

## 30. `rsi_overbought`/`rsi_oversold` do ativo eram salvos mas nunca lidos — corrigido (P1)

Item restante da segunda auditoria externa (2026-07-18), verificado direto no
código: `calculateRSI` (`src/lib/indicators/rsi.js`) hardcodava a zona em
`>=70`/`<=30`. Já existia uma função pura `getRSIZone(value, overbought=70,
oversold=30)` fazendo essa mesma classificação de forma parametrizada, mas
**nunca era chamada em lugar nenhum** — código morto duplicando a lógica.
`scanner.js` chamava `calculateRSI(closedCandles, indicatorParams.rsiPeriod)`
sem passar limiares. `AssetConfigPanel.jsx` deixa o usuário editar/salvar
`rsi_overbought`/`rsi_oversold` por ativo — o valor era persistido no
Firestore, mas nada a jusante o lia para cálculo, só para exibição
(`AssetDetailPanel.jsx`, `ParamCard`). Configurar esses campos não tinha
**nenhum** efeito real.

Isso não é cosmético: `r.rsi.zone !== 'neutral'` em `scanner.js` gera um
`SignalEvent` real (`source: 'rsi'`) que pode virar `TradeOperation` — um
usuário que configurou limiares mais largos/estreitos para reduzir ruído de
RSI num ativo mais volátil continuava recebendo sinais na banda 70/30 padrão,
sem saber.

**Correção**: `calculateRSI(candles, period=14, overbought=70, oversold=30)`
passou a delegar a classificação para `getRSIZone(lastRSI, overbought,
oversold)` (reusa a função pura já existente, não duplica lógica). Nova
função pura `resolveRsiZoneThresholds(asset)` em `scanner.js` — **irmã** de
`resolveIndicatorParams`, não dentro dela: estes campos não têm equivalente
sincronizado do Pine (não estão em `SYNCED_STRATEGY_KEYS`), e misturar ali
mudaria o shape exato que um teste de `scannerStateMachine.test.js` já fixa
via `toEqual()`. A função guarda o **par** atomicamente — um par inválido
(invertido, fora de `(0,100)`, ou um lado ausente/NaN) cai inteiro para o
default 70/30, nunca uma mistura de um lado válido com o outro default, mesmo
espírito do `firstPositive` já existente no arquivo. `docs/schema-reference/
MonitoredAsset.jsonc` atualizado para documentar esse fallback.

Regressão: novos testes em `rsi.test.js` (limiar customizado classifica como
overbought/oversold um valor que os 70/30 padrão classificariam como neutral;
delegação a `getRSIZone` sem duplicar lógica de fronteira) e em
`scannerStateMachine.test.js` (`resolveRsiZoneThresholds` — par válido, par
default quando ausente, par invertido/igual, fora de faixa, parcial, NaN).
Confirmado via `git stash` que os 9 novos casos falham contra o código
anterior (zona sempre 70/30 apesar do 3º/4º argumento; função nova
inexistente) e voltam a passar com a correção restaurada.

## 31. Validação numérica ausente nos formulários de configuração do ativo — corrigido

Confirmado: todo `Input type="number"` em `AssetConfigPanel.jsx` (RF, RSI,
MACD, EMA, cooldown) usava `Number(e.target.value)` cru a cada tecla, sem
guarda de NaN/min/max/relação entre campos, e `handleSave` gravava o objeto
inteiro no Firestore incondicionalmente. No `scanner.js`, `rf_period`/
`rf_multiplier`/`macd_fast`/`macd_slow`/`macd_signal` ainda usavam `asset.X ||
default` — isso barra `0`/`NaN` (falsy) mas **não** um valor negativo
(`-5 || 20` avalia `-5`); só `rsi_period`/`ema_short`/`ema_long` já passavam
pelo `firstPositive` (guarda de uma revisão anterior).

**Achado adicional confirmado nesta rodada** (além do item já sinalizado pela
auditoria): se `ema_short > ema_long`, `calculateEMAs` não falha — ainda
dispara um cruzamento, só que com o rótulo **invertido**
(`golden_cross`/`death_cross` trocados), e `scanner.js` transforma isso
diretamente no `signal_type` errado (BUY quando deveria ser SELL). Não havia
nenhuma guarda de ordem relativa entre `ema_short`/`ema_long` antes desta
correção — mesma classe de bug do item 30, em outro indicador.

Pesquisa (UX de input numérico em React): consenso é permitir digitação livre
no `onChange` (inclusive estados transitórios inválidos) e validar/clampar só
no blur/submit — validar a cada tecla atrapalha o usuário
([fonte](https://dev.to/akshay_patil_131930887e40/best-way-to-handle-number-input-validation-in-react-18mk)).
Por isso a validação roda no **Save**, não a cada `onChange`.

**Correção**:
- Novo módulo `src/lib/assetConfigValidation.js` (padrão `opTransition.js`/
  `opExitRules.js` — função pura, testável, sem I/O — este repo não tem
  nenhum teste dentro de `src/components/`, então a lógica precisa viver em
  `src/lib/`): `validateAssetConfig(config)` retorna um array de erros.
  Regras: todo período/multiplicador `> 0` e finito; `alert_cooldown_minutes
  >= 0`; `rsi_overbought > rsi_oversold` com ambos em `(0,100)`; `macd_fast <
  macd_slow`; **`ema_short < ema_long`** (o achado novo).
- `AssetConfigPanel.jsx`: `handleSave` chama o validador; havendo erros,
  mostra (mesmo padrão visual de `AddAssetForm.jsx` — `AlertCircle` + texto
  `#ff1478`) e **não** grava no Firestore.
- `scanner.js` (defesa em profundidade, para dado que já esteja salvo errado —
  linha legada ou edição direta no Firestore): `rf_period`/`rf_multiplier`/
  `macd_fast`/`macd_slow`/`macd_signal` passaram de `asset.X || default` para
  `firstPositive(asset.X, default)`, fechando o buraco do valor negativo.
  `resolveIndicatorParams` ganhou uma guarda de par para EMA (só valores, não
  muda o shape do retorno): se `emaFast >= emaSlow`, ambos caem para o par
  Pine/literal.

Regressão: `src/lib/assetConfigValidation.test.js` (uma regra por caso,
válido/inválido/limite) e um novo teste em `scannerStateMachine.test.js`
(`resolveIndicatorParams` rejeita par EMA invertido/igual). Confirmado via
`git stash` que ambos falham contra o código anterior.

> **Atualização (review do Codex, PR #61) — período fracionário passava a
> validação e quebrava o RSI silenciosamente:** `calculateRSI`
> (`src/lib/indicators/rsi.js`) e `calculateATR` usam `period` diretamente
> como índice de array/limite de loop (`avgGain[period]`, `for (let i =
> period; i < n; i++)`). Um período fracionário como `14.5` nunca cai num
> índice INTEIRO a partir daquele ponto — a série inteira fica presa no
> valor de `.fill()` (RSI sempre lê 50/`'neutral'`, para sempre), silencioso,
> sem erro. `isPositiveNumber` só rejeitava `<=0`/`NaN`, não fracionário —
> um usuário digitando `14.5` no período do RSI passava pela validação e
> quebrava o indicador sem aviso.
>
> Corrigido: `assetConfigValidation.js` ganhou `isPositiveInteger` (exige
> `Number.isInteger`), aplicado a todos os campos de período/contagem de
> barras (`rf_period`, `rsi_period`, `macd_fast/slow/signal`, `ema_short/
> long`) — `rf_multiplier` continua aceitando fracionário (é multiplicador
> de verdade, não contagem de barras). Defesa em profundidade espelhada em
> `scanner.js`: nova `firstPositiveInteger(...)` (mesmo padrão do
> `firstPositive` já existente, exigindo também `Number.isInteger`),
> substituindo `firstPositive` nos mesmos campos de período em
> `resolveIndicatorParams` e nas chamadas diretas de RF/MACD em `scanAsset`
> — cobre dado legado ou editado direto no Firestore, não só o caminho da UI.
>
> Regressão: novo teste "rejects a fractional period on every period/bar-count
> field" em `assetConfigValidation.test.js`; novo teste em
> `scannerStateMachine.test.js` confirmando que `resolveIndicatorParams`
> rejeita um override fracionário (cai para Pine/literal, igual a
> zero/negativo/NaN); nova `describe('firstPositiveInteger')` espelhando os
> casos de `firstPositive`. Confirmado via `git stash` que os 6 novos casos
> falham contra o código anterior.

## 32. Gate "existe operação ativa?" do browser (`useAutoScan.js`) estava errado — corrigido (P1)

Confirmado: `useAutoScan.js` buscava as **50 `TradeOperation` mais recentes
por `created_date`** (qualquer status) e checava se alguma delas estava ativa
— se a op ativa genuína fosse **mais antiga** (por criação) que 50 outras
criadas depois (plausível: usuário monitorando vários ativos, ops
abrindo/fechando com frequência enquanto uma fica `RUNNER_ACTIVE` dias
esperando TP2), ela caía fora dessa janela e o gate errava para `false` —
`priceCheckActiveOps()` (a proteção de stop/TP por preço ao vivo) **parava de
rodar no browser** para aquela operação, silenciosamente, mesmo com a aba
aberta. Confirmado que o cron (`scripts/run-scan.mjs`) não tem esse gate —
chama `priceCheckActiveOps()` sempre —, então o bug era exclusivo do browser.
`priceCheckActiveOpsInner` já fazia a query certa
(`TradeOperation.filter({status: [...]})`, `where...in`, sem índice composto
necessário) — só o gate do hook reimplementava (mal) a mesma pergunta.

**Correção**: nova função `hasActiveTradeOps()` em `scanner.js`, ao lado de
`priceCheckActiveOpsInner`, reusando o mesmo filtro server-side com
`limitCount=1` (só precisamos saber se existe — mais barato em leituras
Firestore que os 50 docs de antes, não só mais correto).  `useAutoScan.js`
passou a chamar essa função em vez de reimplementar a lógica; o import de
`backend` (usado só para essa query) foi removido do arquivo.

Regressão em `scannerStateMachine.test.js`: semeadas 55 ops terminais com
`created_date` recente + 1 op ativa com `created_date` bem mais antiga (fora
da janela "últimas 50"); confirma que `hasActiveTradeOps()` continua
enxergando a op ativa. Caso trivial adicional: `false` quando não há nenhuma
ativa. Confirmado via `git stash` que ambos falham contra o código anterior
(função nova inexistente).

## 33. Pedido de "pelo menos 75% de win" — não é meta saudável; decisão de sequenciar backtest→qualidade (P2, decisão do usuário)

Pedido do usuário: mais acertividade no motor, com meta explícita de **75%+
de win rate**. Antes de tocar em qualquer parâmetro do motor (score mínimo,
alinhamento multi-timeframe, filtros de regime ADX/Choppiness), pesquisa de
comunidade foi feita (fóruns de trading sistemático, material de
sistemas trend-following, discussões sobre ICT/SMC) para checar se 75% é uma
meta plausível para a estrutura de R deste projeto (TP1 em 1.5R, TP2 em 3R).
**Não é.**

- Sistemas trend-following clássicos com R:R favorável tipicamente rodam
  **30-50% de win rate** e são lucrativos assim mesmo — o caso mais citado
  (Turtle Trading) operava com **menos de 40%** de acerto e R:R>3:1, ainda
  assim com retornos anuais reportados acima de 80%.
- A comunidade ICT/SMC é cética quanto às taxas de 70-80% divulgadas pelo
  método — relatos reais de praticantes ficam mais perto de 50-65%, com
  casos documentados de resultados forjados por vendedores de curso.
- Regra de expectância (`Win% × ganho médio − Loss% × perda média`): a 3:1
  de R:R, **35% de win rate já dá +0.40R por operação** — lucrativo e
  saudável, bem abaixo de 75%.
- Limiares citados por fontes quantitativas como sinal de **overfitting**
  em backtest: win rate > 75%, Sharpe > 3.5, drawdown < 5%. Perseguir 75%
  literal empurraria o ajuste de parâmetros exatamente para essa zona de
  alerta, não para um motor mais robusto.

**Decisão** (explicitamente escolhida pelo usuário entre as opções
apresentadas): em vez de perseguir os 75% literais — o que exigiria encurtar
TP1/TP2 e provavelmente pioraria a expectância/robustez do motor — ou ajustar
parâmetros às cegas, **primeiro construir um motor de backtest histórico**
(`src/lib/backtestEngine.js` + adaptadores em `scripts/backtest*.js`, ver
`docs/claude/backtest-usage.md`) que reusa `scanAsset`/`persistScanResults`
de `scanner.js` sem modificação (mesmo padrão de redirecionamento de import
do browser/cron), com um relógio simulado e janela de candles sem
look-ahead. Qualquer ajuste de qualidade de sinal (fase 2, ainda não
iniciada) deve ser validado contra dados históricos reais produzidos por
esse motor — não contra achismo — exatamente o oposto do que os sinais de
overfitting acima recomendam evitar.

Fora de escopo desta rodada (fica para a fase 2, só depois do backtest
rodar com dado histórico real): subir o score mínimo (75→85+), exigir
alinhamento forte 1h/4h/1d, apertar ADX/Choppiness, qualquer mudança de
TP/R.

## 34. Cascata SMC 1h→5m nunca disparava na prática — janela de candles insuficiente para `swingLen=50` — corrigido

Rodando o motor de backtest (item 33) em 7 ativos reais (BTCUSDT, ETHUSDT,
PENDLEUSDT, ONDOUSDT, FETUSDT, ZROUSDT, DYDXUSDT) × 6 meses cada com a
cascata SMC ligada, o resultado foi **0 operações SMC em todos os 7** — a
cascata RF 4h/15m gerou dezenas no mesmo período, então não era falha geral
do motor.

Investigação (conselho de revisão multi-papel, skill `sentinel-council-review`,
mais pesquisa de comunidade) **confirmou empiricamente** a causa raiz, medida
rodando `calculateStructure` de verdade contra candles sintéticos (não
suposição): `scanAsset` busca só os **últimos 150 candles fechados** por
timeframe (`scanner.js`, antes um único `fetchCandles(asset.symbol, tf,
150)` para todo o loop). A estrutura SMC do 1h (`calculateStructure`,
`src/lib/indicators/smcStructure.js`) usa `swingLen=50` (default real do
Pine do usuário, "SMC+A Unified v2.3") e **não recebe nenhum estado entre
scans** — recomputa do zero a cada chamada, só com os candles daquela vez.

Medido: numa série sintética de 800 candles (`goldenCandles`, mesma fixture
determinística já usada por `goldenParity.test.js`), histórico contínuo
produz exatamente 1 evento BOS/CHoCH com `swingLen=50`; a mesma série
processada em janela de 150 sem estado (como a produção faz) produz **0** —
perda total. Com `swingLen=10` (o valor já usado na confirmação 5m,
`check5mSmcConfirmation`), 6 de 6 eventos sobrevivem — a janela de 150 é
quase inofensiva lá. Pesquisa de comunidade (docs da LuxAlgo, guias de
BOS/CHoCH) confirmou que `swingLen=50` é o piso da faixa de "estrutura
maior" (50-100), deliberadamente rara por design — não é bug do Pine, a
prática comum em 1h é swing_len~5-10. Produção é ainda mais restritiva que a
medição acima (o gate só olha a ÚLTIMA barra fechada e ainda precisa
coincidir com a confirmação 5m no mesmo scan) — zero em 7 ativos × 6 meses
era o resultado matematicamente esperado, não anomalia de mercado.

**Isso afetava a produção ao vivo, não só o backtest** — `smc_enabled` é
default `true` pra ativos novos desde a mudança que habilitou a cascata por
padrão (ver histórico de PRs), então qualquer ativo com essa cascata ligada
provavelmente nunca a viu disparar de verdade.

**Correção**: só o fetch do timeframe 1h (o que alimenta o viés de estrutura
SMC) passou a buscar 500 candles em vez de 150
(`SMC_1H_STRUCTURE_CANDLE_LIMIT`, `scanner.js`) — 4h/1d/15m/5m continuam em
150, suficiente pros indicadores convergentes (RF/RSI/MACD/EMA/ATR/ADX/
Choppiness, warm-up de ~6× o período já basta). Não persiste estado entre
scans (permanece função pura, sem novo risco de concorrência entre
browser/cron) e cabe numa única chamada da API da Binance (teto documentado
1000).

**Importante**: essa correção não faz o SMC disparar "muito" —
`swingLen=50` é deliberadamente raro por design do Pine real. O ganho é
fazer a cascata se comportar como desenhada (raro, alta convicção) em vez de
artificialmente quase silenciada por uma limitação de implementação não
relacionada à estratégia em si.

Regressão: novo `describe` em `src/lib/indicators/smcStructure.test.js`
reproduz a medição acima como teste determinístico (contínuo vs. janela de
150, `swingLen=50` perde o único evento / `swingLen=10` não perde nada).

**Observação separada, não corrigida agora**: durante a investigação, os
eventos BOS/CHoCH naturais gerados em dados sintéticos caíram
sistematicamente no gate de zona Premium/Discount errado para a própria
direção do sinal (`zoneOk` em `scanner.js`, ex.: uma quebra de alta
aterrissando em zona "premium", que o gate rejeita para BUY) — não deu pra
descartar se é coincidência da amostra sintética ou um padrão real (faz
sentido geométrico: um rompimento de estrutura tende a empurrar o preço
para o extremo do range recente, exatamente o que o gate de zona rejeita).
Não investigado a fundo nem corrigido — fica registrado para uma rodada
futura se o backtest real (agora com a janela corrigida) mostrar sinais SMC
sendo gerados mas sistematicamente descartados por esse gate.

**Fora de escopo desta correção**: a estrutura SMC do **4h** (usada só pelo
gate opcional `smc_confirm_4h15m`, não testado nesta rodada) pode ter uma
versão mais branda do mesmo problema — não corrigida sem medir primeiro.

## 35. Gate de zona PD da cascata SMC 1h→5m descartava sinal silenciosamente — agora observável (não redesenhado)

> **Superseded pelo item 38** (2026-07-21): o redesenho que este item deixava
> deliberadamente em aberto ("não corrigido/redesenhado ainda") foi
> implementado — o gate foi removido do candle de viés 1h e movido para o
> gatilho de entrada 5m, medido contra a perna do rompimento. Este item
> permanece como registro da investigação/evidência que motivou a decisão
> (não apagado).

Investigação de continuação da "Observação separada" do item 34, a pedido do
usuário ("qual das lacunas é do motor, pra que fique tudo perfeito?").
Confirmado no código (não mais suspeita): `zoneOk` (`scanner.js:628-630`) —
o gate que decide se uma quebra de estrutura 1h vira `SignalEvent` — usa o
MESMO `closedCandles` de `calculateStructure`/`calculatePdZone`. Quando
rejeita, **não deixa rastro nenhum**: sem `SignalEvent`, sem log, sem chance
de retry (o loop de retry só reprocessa `SignalEvent`s já persistidos) —
diferente do gate irmão opcional `smc_confirm_4h15m`, que já reavalia
`zoneOk` a cada passada por até 4h e já loga cada bloqueio
(`scanner.js:924-937`, `1085-1088`) — só o gate 1h→5m é silencioso e
definitivo.

**Reproduzido deterministicamente**: no `goldenCandles(800)` já usado pelo
item 34, o único evento de estrutura em `swingLen=50` (uma quebra SELL) cai
exatamente na zona `discount` — a zona que `zoneOk` rejeita para SELL
(`smcStructure.test.js`, describe "calculatePdZone vs calculateStructure —
signal-direction zone bias"). `calculatePdZone` usa uma janela de 20 barras
que **exclui o candle atual**, então geometricamente o `close` de um
rompimento de alta tende a ficar acima do range antigo (→ `premium`,
rejeitado para BUY) e o de um rompimento de baixa abaixo (→ `discount`,
rejeitado para SELL) — viés real, medido, ainda que não determinístico (a
magnitude depende de quão longe o nível de estrutura rompido está da janela
de 20 barras).

**Pesquisa de comunidade** (LuxAlgo, guias ICT, via WebSearch): o padrão é
checar a zona PD **depois** de um retracement, no momento do GATILHO de
entrada — não no candle exato do rompimento de estrutura. O código atual
checa no lugar errado do pipeline (na barra de viés 1h, não no gatilho 5m).

**Corrigido nesta rodada (observabilidade apenas)**: `scanAsset` agora
retorna `zoneGateDrops`; `persistScanResults` grava um `SystemLog`
estruturado por descarte (`reason: 'smc_zone_gate_rejected'`, deduplicado
por candle via `SystemLog.createUnique`, mesmo padrão do item 23).
**Nenhum comportamento de trading muda** — o candidato continua sem virar
`SignalEvent`/`TradeOperation`, exatamente como antes.

**Não corrigido/redesenhado ainda**: mover ou duplicar o gate para o momento
do gatilho 5m é uma divergência deliberada do porte 1:1 do Pine (mesma
categoria do stop estrutural, item 24), com decisões de produto em aberto —
contra qual dado rodar a checagem no 5m (reavaliar o mesmo `pdZone` do 1h,
quase sempre um no-op dentro da janela de confirmação, ou introduzir um
`calculatePdZone` em escala 5m sem equivalente no Pine para calibrar); se o
gate 1h deve virar filtro secundário, ser afrouxado, ou removido; se o gate
irmão `smc_confirm_4h15m` (mesmo viés geométrico, mas já observável e
retriável) merece a mesma revisão por simetria. Mesmo critério do item
"RESIDUAL" de precedência stop>TP em `trading-engine.md`: só investir num
redesenho quando os logs (`reason: 'smc_zone_gate_rejected'`) mostrarem
volume/impacto real, não a partir de uma amostra sintética de 800 candles.

Regressão: `smcStructure.test.js` reproduz o viés geométrico; três novos
testes em `scannerStateMachine.test.js` (log único por descarte, dedup entre
passadas do mesmo candle, nenhum log quando não há descarte) confirmados
falhando contra o código anterior antes da correção.

> **Atualização — backtests reais confirmam 0 operações SMC, mas o relatório
> não distinguia "sem evento" de "evento rejeitado pela zona" (2026-07-21).**
> Rodadas reais via `.github/workflows/backtest.yml` (BTCUSDT e PENDLEUSDT,
> ~18 meses cada, `--smc` no próprio ativo) continuaram mostrando 0
> operações na cascata `1h_5m` — mas o `SystemLog` gerado durante um
> backtest (backend fake em memória) nunca era agregado no relatório final,
> então não dava pra saber, só olhando o JSON, se a causa era "nenhuma
> quebra de estrutura no período" (item 34) ou "quebra ocorreu e foi
> descartada pela zona" (este item). **Corrigido**: `runBacktest`
> (`src/lib/backtestEngine.js`) agora acumula, a cada passada simulada, o
> total de `zoneGateDrops` e de `newSignals` com `source: 'smc_structure'`
> ao longo de todo o replay, e `buildReport` expõe isso como
> `report.smcDiagnostics` (`structureEventsTotal`, `rejectedByZoneGate`,
> `confirmedSignals`, `tradeOpsCreated`) — ver `docs/claude/backtest-usage.md`.
> Regressão reproduz o cenário já conhecido do `goldenCandles(800)` (o único
> evento em `swingLen=50`, um `bearChoch` na barra 418, cai em zona
> `discount` — rejeitada pelo gate para SELL) através do `runBacktest` real,
> não só das funções puras: `smcDiagnostics` bate `{structureEventsTotal: 1,
> rejectedByZoneGate: 1, confirmedSignals: 0, tradeOpsCreated: 0}`,
> confirmado falhando contra o código anterior antes da correção. Próximo
> passo natural: rodar o backtest de novo nos ativos já testados e ler esse
> campo — se `structureEventsTotal` continuar 0, é o item 34 (raro por
> design); se vier > 0 com `confirmedSignals: 0`, é este item (gate de zona)
> acontecendo de verdade, não só em amostra sintética.

## 36. Ambiguidade stop/TP no mesmo candle — política já correta, agora formalizada e observável

Quarto item da lista de lacunas "do motor" (a pedido do usuário). Quando um
candle fechado toca tanto o stop quanto o TP1 (ou stop e TP2, pós-TP1), o
OHLC sozinho não diz qual aconteceu primeiro intrabar.

**Confirmado no código**: só o loop baseado em candle (`persistScanResults`)
tem esse problema — o loop baseado em preço (`priceCheckActiveOpsInner`)
compara um único preço por tick, sequencialmente, sem essa ambiguidade. A
política já existente em `scanner.js` ("Check stop first (stop has priority
over TP on same candle for safety)") é exatamente o padrão de mercado:
pesquisa de comunidade (backtesting.py, QuantConnect, NinjaTrader) confirma
que assumir o stop primeiro (postura pessimista/conservadora) é o baseline
padrão da indústria — reconstrução via dado de granularidade menor é
refinamento opcional, citado só quando o problema já foi sentido na prática,
não requisito de baseline.

**O que faltava de fato**: a regra era puramente inline, sem função pura
testável; nenhum teste cobria o cenário "candle toca os dois níveis"
(correto por convenção, nunca verificado); e quando a ambiguidade realmente
ocorria, ficava indistinguível de um stop limpo no registro da operação.

**Achado que restringe a alternativa "reconstruir via timeframe menor"**:
dado de 15m/5m não fica disponível no momento da avaliação de saída hoje —
`results` só é populado para `1h/4h/1d`; 15m/5m são buscados só uma vez, na
confirmação de entrada, nunca guardados para reuso no loop de saída.
Reconstruir a ordem real exigiria buscar candles novos a cada operação
ativa, a cada passada — custo de API/latência recorrente, não uma mudança
pequena.

**Corrigido (formalização + observabilidade, sem mudar o resultado)**: nova
função pura `resolveCandleExit({ stopTouched, targetTouched })`
(`src/lib/opExitRules.js`) nomeia e testa a política; `scanner.js` passou a
computar `tp1Touched`/`tp2Touched` ao lado de `stopHit`/`runnerStopHit` (em
vez de só na cauda do `else if`) para alimentar essa função nos dois pontos
(pré-TP1 contra TP1, pós-TP1 contra TP2). Toda operação que hoje fecha em
STOP_HIT continua fechando no mesmo preço — a única mudança observável é o
novo campo `exit_ambiguous` (boolean, `TradeOperation.jsonc`), gravado
`true` só quando o stop venceu por uma escolha conservadora sob ambiguidade
real, nunca num stop inequívoco.

**Não implementado**: reconstrução via timeframe menor — mesmo critério já
usado no gate de zona (item 35) e no residual de precedência stop>TP
(`trading-engine.md`): só investir nisso se `exit_ambiguous` mostrar volume
real depois que o motor rodar por um tempo, não a partir de suposição.

Regressão: `opExitRules.test.js` cobre `resolveCandleExit` isoladamente (só
stop, só alvo, nenhum, os dois); `scannerStateMachine.test.js` cobre os três
cenários via `persistScanResults` real (ambíguo pré-TP1, limpo pré-TP1,
ambíguo pós-TP1 contra TP2) — os três confirmados falhando contra o código
anterior antes da correção.

## 37. Proposta do usuário — cascata hierárquica de operações independentes por timeframe (1h→4h→1D), NÃO implementada, registrada pra decisão futura

Pedido do usuário (2026-07): em vez de (ou além de) descobrir por que a
cascata SMC 1h→5m está com 0 operações, ele propôs um formato novo — cada
timeframe (1h, 4h, 1D) teria sua **própria operação independente**, com sua
própria confirmação de entrada (1h→5m, 4h→15m, e um 1D→algum timeframe
menor ainda não definido), e a ideia de continuidade: se a operação de um
timeframe menor estiver indo bem (volume/cenário favorável), o sistema
avalia abrir *também* uma operação no timeframe maior seguinte, e assim por
diante até o 1D. Explicitamente: "cada um tem sua operação em 1h e 4h" —
rodando **simultaneamente**, não uma substituindo a outra.

**Fato, confrontado com o código antes de registrar** (não é bug, é uma
mudança de arquitetura que ainda não existe):

- Hoje só existem duas cascatas (`4h_15m` e `1h_5m`), **mutuamente
  exclusivas por ativo** — `assetActiveOps/{assetId}` trava **uma única
  operação ativa por ativo**, independente de qual cascata a criou
  (`createTradeOpIfNoneActive`, ver `.claude/rules/trading-engine.md`). A
  proposta do usuário exige o oposto: mais de uma operação ativa
  simultânea no mesmo ativo (uma por timeframe). Isso não é um ajuste de
  parâmetro — é trocar o invariante central da máquina de estados (viraria
  algo como "uma operação ativa por ativo **por cascata**", não por
  ativo), com implicações diretas em concorrência (o CAS/lock atuais
  assumem 1 operação por ativo) e em risco (duas ou três operações abertas
  ao mesmo tempo no mesmo ativo multiplicam a exposição, mesmo sendo
  virtual).
- **Não existe cascata de 1D hoje.** O 1D só alimenta `analyzeAlignment`
  (viés macro de leitura, não uma cascata com sinal/entrada/stop/TP
  próprios). Construir uma cascata 1D do zero — timeframe de confirmação de
  entrada, cálculo de stop/TP, tier — é trabalho novo, não uma extensão
  direta do padrão 4h/15m ou 1h/5m.
- O conceito em si ("pyramiding"/escalonamento de posição por confluência
  multi-timeframe crescente) é reconhecido na comunidade de trading
  sistemático, mas **não faz parte do Pine real do usuário** (nem "NEW ERA
  - Range Filter Strategy v13.2" nem "SMC+A Unified v2.3" têm esse
  mecanismo) — seria estratégia nova, não port de algo existente.

**Decisão registrada**: **não implementar agora.** Fica gravado aqui como
proposta explícita do usuário para uma rodada futura dedicada, que antes de
qualquer código precisa (mesmo padrão de todo o resto deste arquivo):
pesquisa de comunidade sobre position pyramiding/scaling multi-timeframe
(o que a prática real usa: tamanho de cada perna, critério de
"continuidade" — volume, alinhamento de indicador, score mínimo por
timeframe), desenho explícito de como o invariante de 1-operação-por-ativo
muda sem reabrir os riscos de concorrência já fechados (P0-a a P0-h), e
provavelmente uma revisão em conselho (`sentinel-council-review`) dado que
mexe no núcleo da máquina de estados. Não iniciar essa implementação sem
pedido explícito e uma rodada de planejamento própria.

### Pesquisa (2026-08-03) — insumo para uma rodada futura, decisão de sequenciamento reafirmada

Usuário pediu pra avançar a pesquisa (Explore agent, código + WebSearch).
**A própria pesquisa é o motivo pra não ir além disso agora**: já existe
uma decisão de sequenciamento formal, de uma revisão de conselho anterior
(item 56, "Ação 3"/Arquiteto) — abrir este "Bloco 4" está **bloqueado
atrás do Bloco 0** (vantagem direcional da estratégia) **por desenho, não
esquecimento**, porque multiplicar operações simultâneas por ativo
multiplica exposição numa estratégia cuja vantagem direcional ainda não
está provada. O Bloco 0 **continua aberto** (item 48, recomendação mais
recente registrada 2026-08-02: não desbloquear ainda, aguardando 3ª janela
independente de backtest). Avançar um desenho detalhado do item 37 agora
contradiria essa sequência já decidida — por isso esta rodada ficou só em
pesquisa/registro, sem desenho final nem código.

**Fatos confirmados por leitura de código** (não estavam documentados com
este nível de detalhe antes):
- O invariante "1 operação ativa por ativo" está estrutural, não é um
  parâmetro solto: o doc-âncora `assetActiveOps/{assetId}` guarda 1 ID
  escalar (`active_trade_op_id`), nunca lista — confirmado nos dois
  backends espelhados (`src/api/entities.js:176-222`,
  `scripts/adminEntities.js:154-196`). `groupActiveOpsByAsset`
  (`src/lib/opTransition.js:105-153`) trata hoje **mais de 1 operação
  ativa por ativo como corrupção de dado**, não como caso válido — e o
  scanner já **suspende arbitragem e novas entradas no ativo inteiro**
  quando detecta isso (`scanner.js:1479-1505`/`:2963-2972`). Habilitar a
  proposta do usuário exigiria trocar esse invariante pra "1 por (ativo,
  cascata)" — mudança estrutural real, com risco de regressão silenciosa
  se `groupActiveOpsByAsset` não mudar junto (o próprio guard que hoje
  protege contra corrupção passaria a suspender todo ativo com 2+
  cascatas ativas, exatamente o estado que a proposta quer tornar normal).
- `TradeOperation.cascade` já existe e já é usado pra logging/arbitragem —
  o dado pra particionar por cascata já existe na operação, só o mecanismo
  de trava (`assetActiveOps`) e o gate (`hasActiveOp`, hoje uma única
  variável compartilhada pelas 2 cascatas, `scanner.js:1462-1467`) não o
  usam.
- **Não existe cascata 1D hoje**, confirmado ponto a ponto: `TIMEFRAMES =
  ['1h','4h','1d']` busca 1D, mas ele só alimenta `analyzeAlignment` (viés
  macro) — o Entry Motor bloqueia explicitamente qualquer sinal RF
  não-4h (`scanner.js:1662-1675`, comentário "Non-4H RF signals ... do NOT
  trigger entries"). Sem confirmação de entrada, stop, TP ou tier próprios
  pra 1D — seria trabalho novo, não extensão do padrão 4h/15m ou 1h/5m.

**Pesquisa de comunidade (WebSearch, 2026-08-03)** — pyramiding/scaling
multi-timeframe:
- É estritamente trend-following: adiciona posição só a favor do
  movimento, nunca pra promediar perda ([TradersPost](https://blog.traderspost.io/article/pyramiding-trading-strategies-guide),
  [LuxAlgo](https://www.luxalgo.com/blog/pyramiding-strategies-scaling-into-trades-to-boost-returns/)).
- Cada perna adicional deve ser **progressivamente MENOR** que a
  anterior (forma de pirâmide de fato), tipicamente 3-5 camadas
  ([QuantStrategy](https://quantstrategy.io/blog/the-3-golden-rules-for-pyramiding-success-entry-points/)).
- Critério de "continuidade" documentado: alinhamento com o timeframe
  MAIOR antes de adicionar camada (não só o timeframe da perna em si),
  confirmação de volume/estrutura ([LuxAlgo](https://www.luxalgo.com/blog/pyramiding-strategies-scaling-into-trades-to-boost-returns/)).
- **Risco central pra esta proposta especificamente**: a prática trata
  posições correlacionadas do MESMO ativo (mesmo em timeframes
  diferentes) como **um único bucket de risco agregado** ("portfolio
  heat"), não como riscos somáveis independentes
  ([journalplus](https://journalplus.co/metrics/portfolio-heat/),
  [Lunaro](https://lunaro.com/the-desk/desk-briefings/correlation-and-portfolio-risk-in-multi-asset-trading/)).
  **Esse conceito não existe hoje** em nenhuma forma no motor — cada
  operação só conhece o próprio risco (`initial_stop`/`entry_price`),
  nada soma risco entre operações do mesmo ativo. Se 2-3 cascatas
  passassem a operar simultaneamente, as métricas de `tradeMetrics.js`/
  relatórios de backtest que hoje assumem "1 operação = 1 risco isolado
  por ativo" subestimariam risco agregado correlacionado.

**Perguntas em aberto pra uma eventual `sentinel-council-review`** (não
resolvidas aqui, de propósito):
1. O invariante vira "1 op ativa por (ativo, cascata)" simples, ou a
   "continuidade" pedida exige um bucket de risco agregado unificado
   (stop compartilhado entre pernas, como a pesquisa de pyramiding
   recomenda) — modelagem de dado bem mais profunda que só trocar a
   chave do doc-âncora?
2. A arbitragem entre cascatas (item 39, já fechada e testada) precisa
   ser preservada intacta DENTRO de cada cascata, e a continuidade vira
   uma camada nova por cima — ou o modelo de arbitragem inteiro precisa
   ser redesenhado porque a premissa "só existe 1 op ativa pra arbitrar
   contra" deixa de valer?
3. Critério de "continuidade" (volume? alinhamento de indicador? score
   mínimo?) — qual escolher, e isso precisa de validação por backtest
   ANTES de virar gate, mesma disciplina das Fases 2-4.
4. Como Time Stop/MFE-MAE/custo real (`tradeMetrics.js`, já em produção)
   se comportam com múltiplas operações simultâneas no mesmo ativo, sem
   sub-relatar risco agregado.
5. Qual timeframe de confirmação de entrada pra uma eventual cascata 1D
   (ainda não definido no pedido original do usuário) — bloqueia
   qualquer desenho de stop/TP/tier pra ela.

**Reafirmado**: continua bloqueado atrás do Bloco 0. Não avançar desenho
final nem código sem o usuário decidir explicitamente prosseguir mesmo
com essa sequência em aberto, ou sem o Bloco 0 fechar primeiro.

**Separado, não confundir**: o pedido imediato do usuário (rodar o
backtest de novo e olhar `smcDiagnostics`, item 35) é sobre a cascata
1h→5m **que já existe** — independente desta proposta de arquitetura nova.

## 38. Gate de zona PD da cascata SMC 1h→5m — removido do viés 1h, movido para o gatilho 5m (redesenho do item 35)

Continuação direta do item 35. Pedido do usuário (2026-07-21) após rodar o
backtest real estendido de novo (BTCUSDT, ~18,5 meses,
`.github/workflows/backtest.yml`, run com o `smcDiagnostics` do item 35 já
em produção): **74 rompimentos de estrutura 1h reais no período, 74/74
(100%) rejeitados** pelo gate de zona (`zoneOk`, `scanner.js`). Isso
substitui a amostra sintética única do item 35 (`goldenCandles(800)`) por
evidência real e volumosa — o próprio critério que o item 35 definiu para
reconsiderar o redesenho ("só investir num redesenho... se os logs
mostrarem volume/impacto real, não a partir de uma amostra sintética") foi
satisfeito.

**Diagnóstico confirmado (não é falta de sorte estatística, é tautologia
geométrica)**: `calculatePdZone` (janela genérica de 20 velas, exclui a
vela atual) e `calculateStructure` (confirma BOS/CHoCH quando o `close`
ultrapassa um pivô protegido) rodam sobre o **mesmo** `closedCandles`. O
`close` que confirma um rompimento de alta é, por definição, candidato a
estar no extremo superior dessa mesma janela de 20 velas — exatamente a
zona (`premium`) que o gate rejeitava para BUY (simetricamente `discount`/
SELL). Mais dados nunca resolveria isso.

**Pesquisa de comunidade (ICT/SMC, via WebSearch)** confirmou que a
checagem estava no lugar errado do pipeline: a prática real é aguardar um
**recuo (pullback)** para dentro da zona de desconto/premium **da perna do
próprio movimento**, no momento do **gatilho de entrada** — não rejeitar o
candle de rompimento em si (conceito OTE — Optimal Trade Entry).

**Nota de paridade** (per `.claude/rules/pine-parity.md`): esta é uma
**divergência deliberada e documentada** do porte 1:1 do Pine "SMC+A
Unified v2.3", mesma categoria do stop estrutural (item 24) — não existe
equivalente no Pine real para "zona sobre a perna do rompimento" nem para o
discriminador `rejectReason`.

**Redesenho implementado**:

1. **Gate removido do candle de viés 1h** (`scanner.js`, bloco `smc_structure`
   de `scanAsset`) — não afrouxado, **removido**: nenhum tamanho de banda
   resolve uma rejeição autorreferente. `pd_zone` continua calculado e vira
   metadado observável (`context.pd_zone`), nunca mais condição de `if`.
   Toda quebra de estrutura 1h com `asset.smc_enabled` agora sempre vira
   `SignalEvent`. `zoneGateDrops` (todo o caminho de observabilidade
   construído em cima do gate antigo, item 35) foi removido por completo —
   código morto, não só desativado.
2. **Zona introduzida no gatilho de entrada 5m** (`check5mSmcConfirmation`,
   `scanner.js`), medida sobre a **perna (leg)** do próprio rompimento 1h —
   não uma janela nova desconectada, que reproduziria o mesmo paradoxo
   agora no gatilho 5m. `buildOteLeg`
   (`src/lib/indicators/smcStructure.js`) ancora a perna usando os pivôs
   protegidos que `calculateStructure` já carrega (`lastSwingHigh`/
   `lastSwingLow`, já reaproveitados pelo stop estrutural do item 24): BUY
   → `legLow = lastSwingLow` (origem do impulso), `legHigh = close` do
   rompimento; SELL é o espelho. Fixada **uma única vez**, no instante do
   sinal 1h (persistida em `SignalEvent.context.ote_leg_high/low`) — nunca
   recalculada a cada retry, para não "derivar" enquanto o candidato aguarda
   confirmação 5m. `classifyZone` (extraída de dentro de `calculatePdZone`,
   que virou wrapper fino) é reaproveitada contra `(legHigh, legLow)` em vez
   do range de 20 velas — mesma convenção de zona favorável do gate antigo
   (BUY rejeita só `premium`, SELL só `discount`), só que medida contra algo
   que não é autorreferente.
3. **Fail-open sempre que a perna não for avaliável** (pivô protegido
   ausente, ou `SignalEvent` legado pré-migração sem `ote_leg_high/low`) —
   "não avaliável" nunca é tratado como veredito desfavorável.
4. **Gate bloqueante de verdade no 5m** (não "observação apenas" outra vez)
   — trading é virtual, custo de errar é ruído em paper trading; deixar
   não-bloqueante repetiria o padrão do item 35 de medir e nunca decidir.

**Alternativas descartadas** (não escondidas):
- Reavaliar o mesmo `pdZone` 1h no momento do 5m — já era quase sempre um
  no-op dentro da janela de retry (item 35). Ineficácia já medida.
- Novo `calculatePdZone` em escala 5m sobre o mesmo `closed` de
  `calculateStructure(closed, {swingLen:10})` — reproduziria o MESMO
  acoplamento geométrico self-referente, agora no gatilho `structure` do
  5m. Risco analítico direto, exatamente o padrão que motivou este item.
- Flag por-ativo para rollout gradual — contraria o padrão do item 24 (sem
  flag) e "não introduza um terceiro caminho" de `trading-engine.md`.

**Modelo de dados (aditivo)**: `SignalEvent.context.ote_leg_high/low`;
`TradeOperation.ote_leg_high/low/ote_zone_at_entry` (só observabilidade,
não tocam `initial_stop`/`tp1`/`tp2`); `check5mSmcConfirmation` ganha
`rejectReason` (`null | 'no_trigger' | 'ote_zone_unfavorable'`).
`report.smcDiagnostics` (backtest): `rejectedByZoneGate` →
`rejectedByOteZone` (mudança de semântica real — agora é a rejeição no
gatilho 5m, não mais no viés 1h); `structureEventsTotal` passa a espelhar
`confirmedSignals` diretamente (sem gate nenhum entre a detecção 1h e a
criação do `SignalEvent`, os dois são idênticos por construção agora) —
mantido como campo separado como sinal de regressão: os testes concretos
em `backtestEngine.test.js` fixam ambos contra uma contagem de evento
real conhecida (não uma igualdade abstrata), então uma reintrodução futura
de gate no estágio 1h apareceria como uma queda abaixo dessa contagem.

**Limitação assumida, não corrigida agora**: `persistScanResults` só
registra uma rejeição de zona no 5m na **primeira** avaliação de um sinal
1h novo (o caminho de retry de até 4h permanece silencioso em cada
tentativa rejeitada, mesmo padrão deliberado que a cascata 4h/15m já usa
para não gerar uma escrita no Firestore a cada ~5 minutos por sinal
pendente). `smcDiagnostics.rejectedByOteZone` é portanto uma **amostra**
(primeira tentativa), não o volume exaustivo de rejeições ao longo de toda
a janela de retry — suficiente para distinguir o item 34 (sem evento) do
item 35/38 (evento aconteceu, gate rejeitou a entrada) sem adicionar volume
de escrita novo.

Regressão: `smcStructure.test.js` (`classifyZone`, `buildOteLeg`, casos de
fronteira); `scannerStateMachine.test.js` (novo describe "5m OTE zone gate
— leg-relative": favorável cria `TradeOperation`, desfavorável loga
`SystemLog` com `reason: 'ote_zone_unfavorable'` sem op, fail-open com
`SignalEvent` sem contexto legado); `backtestEngine.test.js` (dois cenários
ponta-a-ponta contra `goldenCandles(800)` bar 418 — mesmo evento real já
conhecido do item 34/35 — com candles 5m sintéticos aterrissando em
`discount`/rejeitado vs. `premium`/confirmado, usando os limites exatos da
perna calculados e verificados diretamente contra `calculateStructure`).

**Próximo passo natural** (não feito nesta rodada): rodar o backtest real
de novo (BTCUSDT e os outros 6 ativos já testados) e comparar
`smcDiagnostics` antes/depois — esperado `confirmedSignals` permanecer em
74 (já era, item 35), e `tradeOpsCreated`/`rejectedByOteZone` a medir pela
primeira vez (não previsível de antemão: depende de quantos dos 74
tiveram um recuo real para o lado favorável da perna antes do gatilho 5m
disparar).

## 39. Arbitragem entre cascatas `4h_15m`/`1h_5m` — Fase 1 (PR #78), fechada após auditoria externa encontrar 7 problemas reais

Substitui o bloqueio cego do item 23 (candidato descartado sem comparação
quando já existe operação ativa) por uma função central de decisão
(`src/lib/signalArbitration.js` + `scanner.js:handleActiveOpArbitration`).
**Nunca** duplica operação nem reabre a proposta do item 37 (operações
simultâneas por timeframe) — só ajusta a gestão da operação já existente,
sempre via a mesma transação CAS (`transitionTradeOp`) que já protegia o
resto do motor.

PR #78 mergeado em `main` implementou a base (score real para a cascata
SMC antes sempre 0, checagem de risco:retorno, proveniência de
dado — `market_source`/`data_exchange`/`executor`). Uma auditoria
externa em seguida encontrou **7 problemas reais** (nenhum refutado após
checar contra o código), corrigidos numa segunda rodada antes de dar a
Fase 1 por encerrada:

1. **Bug real — `ReferenceError`**: o log de rejeição de CAS referenciava
   uma variável (`logPayload`) nunca declarada no escopo — lançava exceção
   exatamente no caminho que deveria só registrar que a proteção de
   concorrência funcionou. Corrigido com um payload local explícito;
   regressão coberta em `scannerStateMachine.test.js`.
2. **Promoção virou dois estágios.** A versão original "promovia" uma
   operação `1h_5m` só porque um sinal 4H qualificado chegou — sem nunca
   checar se o 15m (a confirmação que a própria cascata `4h_15m` exige)
   realmente confirmava aquele contexto. Redesenhado: um sinal 4H
   qualificado (`score >= arbPromoteMinScore`) só abre
   `promotion_status: PENDING_15M` (Estágio A). Uma nova retry step em
   `persistScanResults` resolve o pendente reaproveitando a MESMA
   `check15mConfirmation` da cascata nativa — `CONFIRMED` (Estágio B, só
   aqui `trade_mode` vira `PROMOTED_4H` e o Time Stop alonga) ou `EXPIRED`
   (janela de 4h sem confirmação, operação segue `TACTICAL_1H`). Um sinal
   oposto de timeframe maior chegando com o pendente aberto cancela para
   `REJECTED` em vez de deixá-lo solto. `EXPIRED`/`REJECTED` permitem um
   novo ciclo a partir de um sinal novo — não travam a operação para
   sempre.
3. **Score de entrada agora é imutável.** A versão original decrementava
   `score` diretamente quando um sinal oposto menor chegava, misturando
   "qualidade da entrada" com "confiança atual" — e um histórico de
   correções ficava impossível de auditar. `entry_score` (imutável,
   herdado do `score` legado na criação) nunca mais muda; sinais opostos
   só reduzem `current_confidence_score` (piso 0, teto 100), com
   `confidence_penalty_total` acumulando o histórico. `score` continua
   existindo só por compatibilidade com leitores antigos (UI/backtest),
   também nunca mais alterado.
4. **Duplicidade de operação ativa nunca era detectada.**
   `activeOpsAtStart[0] || null` escolhia silenciosamente a primeira
   operação ativa encontrada — se por corrupção histórica, bug antigo ou
   edição manual existisse mais de uma (violando a invariante central do
   motor), a arbitragem agiria sobre uma escolha arbitrária. Agora, quando
   `activeOpsAtStart.length > 1`, o scanner suspende arbitragem, criação
   de novas entradas E o loop de atualização de stop/TP para aquele ativo,
   e grava `SystemLog` nível `error` com `reason:
   'duplicate_active_ops_detected'` listando todos os IDs/status/cascatas
   — nunca corrige automaticamente (política de reconciliação fica de fora
   de propósito, é decisão para um humano).
5. **Reforço/correção sem piso de score.** `continuation_confirmation`
   (mesma direção, timeframe menor) e `correction_warning` (direção
   oposta) processavam qualquer candidato, mesmo com score baixíssimo.
   Agora exigem `candidateScore >= arbReinforceMinScore` — abaixo disso,
   `candidate_below_arbitration_threshold`: o `SignalEvent` continua
   persistido (observabilidade preservada), mas a operação ativa não é
   tocada. `critical_opposite` (direção oposta, timeframe MAIOR) fica
   deliberadamente isento desse piso — uma reversão de contexto maior
   sempre gera alerta, mesmo vindo de um candidato de score baixo.
6. **R:R documentado honestamente.** `passesRiskReward` já documentava no
   código a limitação (ver item anterior sobre TP1/TP2 serem múltiplos
   configurados do próprio risco, não distância real até uma barreira de
   mercado) — mas nada no schema/painel deixava isso visível. Novos campos
   `rr_gate_mode: 'CONFIGURED_MULTIPLE'` e `rr_target_basis: 'R_MULTIPLE'`
   em cada `TradeOperation`, ao lado de `rr_at_entry`. `passesRiskReward`
   não foi removido — segue útil como proteção contra `tp1R` configurado
   abaixo do mínimo e como gate pronto para um futuro alvo estrutural.
7. **Logs sem ID correlacionável.** Cada decisão de arbitragem agora carrega
   `arbitration_version` (versão da matriz de decisão) e
   `arbitration_event_id` (`dedup_key::op_id`), além de
   `relation_direction`/`relation_tf`, score de entrada e confiança atual —
   não depende só do texto da mensagem para reconstruir o que aconteceu
   numa análise posterior.

**Modelo de dados (aditivo, com fallback seguro para operações legadas)**:
`TradeOperation.promotion_status/promotion_candidate_at/score_4h/signal_id`,
`promotion_confirmed_at/confirm_candle_time`, `trade_mode`,
`management_timeframe`, `origin_cascade`, `entry_score`,
`current_confidence_score`, `confidence_penalty_total`,
`last_opposing_signal_at`, `rr_gate_mode`, `rr_target_basis`. Leitores de
operações antigas (sem esses campos) caem em `entry_score ?? score` /
`current_confidence_score ?? entry_score ?? score` — nunca quebram.

**Não implementado nesta rodada, permanece Fase 1 dentro do escopo
combinado** (registrado para não ser esquecido, não é um problema):
promoção não recalcula TP1/TP2/runner automaticamente (só prazo/gestão —
documentado explicitamente no plano).

Regressão: `signalArbitration.test.js` (32 testes — matriz de decisão pura,
todas as combinações direção×timeframe, os dois estágios de promoção,
piso de score, cancelamento de pendente); `scannerStateMachine.test.js`
(91 testes no arquivo, ~30 novos nesta rodada — dois estágios ponta-a-
ponta com `check15mConfirmation` real via `fetchCandles` mockado,
CAS-rejeitado sem exceção, duplicidade de operação ativa, imutabilidade
do score de entrada, piso de gestão, correlação de logs, concorrência via
`Promise.all`).

### 39.1 Guarda de operações duplicadas estendida ao `priceCheckActiveOpsInner` (último hardening da Fase 1)

Fechamento da limitação residual registrada acima: até aqui, a guarda de
operações ativas duplicadas só existia em `persistScanResults` —
`priceCheckActiveOpsInner` (o loop baseado em preço, mais leve e mais
frequente — ver `.claude/rules/trading-engine.md`) seguia fazendo
`filter({status:[...]})` sem agrupar por ativo, então uma corrupção
histórica que já deixasse o full scan suspenso para um ativo ainda teria
seu stop/TP mutado pelo price check, escolhendo implicitamente a primeira
op da lista.

**Correção**: a regra de agrupamento/detecção foi extraída para uma função
pura nova, `groupActiveOpsByAsset(ops)` (`src/lib/opTransition.js`, mesmo
módulo puro e compartilhado — sem I/O — de `canApplyTransition`/
`clampMonotonicStop`/`planTradeOpCreation`). Ela descarta ops terminais
defensivamente, agrupa por `asset_id` (com fallback por `symbol` para
operações legadas sem esse campo, para que ainda agrupem com segurança em
vez de escapar da checagem) e devolve `{ validGroups, duplicateGroups }` —
independente da ordem em que o backend devolveu os documentos.
`persistScanResults` foi refatorado para consumir a mesma função (a query
já filtra por `asset_id` daquele ativo, então o comportamento observável
não muda — só a regra passou a viver num único lugar).
`priceCheckActiveOpsInner` agora chama a mesma função sobre a lista
completa de ops ativas (todos os ativos, é o formato da sua query), loga
cada grupo duplicado e só processa `[...validGroups.values()]` no loop de
preço/stop/TP/trailing — nunca mais escolhe `activeOps[0]` implicitamente
para um ativo corrompido; ativos sem duplicidade continuam processados
normalmente na mesma passada.

**Log sem spam**: o price check roda com frequência muito maior que o
scan completo, então o log crítico usa
`SystemLog.createUnique(dedupKey, {...})` (mesmo mecanismo atômico já
usado por `SignalEvent.createUnique` para o dedup de sinal) com
`dedupKey = 'duplicate_active_ops::<asset_id>::<ids ordenados>'` — enquanto
o mesmo conjunto de IDs duplicados persistir, `createUnique` só retorna o
doc já existente (nenhuma escrita nova); qualquer mudança no conjunto
(uma op resolvida, adicionada ou removida) muda a chave e gera um evento
novo. O log inclui IDs, status, cascata, **lado** (`op_sides` — campo novo
nesta rodada, não existia no log irmão de `persistScanResults`) e datas de
criação de todas as ops envolvidas.

Regressão: `opTransition.test.js` (função pura — agrupamento simples,
duplicidade, ordem irrelevante, exclusão de op terminal, fallback legado
sem `asset_id`) e `scannerStateMachine.test.js` (`priceCheckActiveOps` real
contra o `fakeBackend` — nenhuma mutação em op duplicada, outro ativo
continua sendo processado, log único criado, mesmo conjunto de IDs não
repete o log, conjunto diferente gera log novo).

## 40. Gatilho de reteste — Fase 2 rodada 1 (`retestEnabled`), DESLIGADO por padrão — não ativar sem comparar backtest antes

**Status: DESLIGADO.** `pineConfig.retestEnabled = false` por padrão nos três
arquivos de config sincronizada. **Não ative sem antes rodar `npm run
backtest` duas vezes (com e sem `retestEnabled`, via `--pine-config` —
`docs/claude/backtest-usage.md`) e comparar as métricas de win rate/R:R/
expectância entre as duas rodadas.** Este item é o lembrete: qualquer sessão
(humana ou Claude Code) que for tocar o motor de entrada esbarra nele antes
de decidir ligar o flag.

Fase 1 (arbitragem, item 39) está congelada — esta é a primeira rodada da
Fase 2 (novos gatilhos de confirmação). O roadmap original listava "reteste
simples" e "rompimento+reteste" como dois itens separados; investigando o
código, são o MESMO mecanismo aqui dentro — o único nível disponível para
retestar, nas duas cascatas, é sempre o nível que o próprio sinal candidato
acabou de romper (não existe, nem está no escopo criar, um detector de nível
genérico independente do sinal). Uma rodada fecha os dois itens do roadmap.
O 3º item (candle de "deslocamento" com volume) foi implementado na rodada
seguinte — ver item 41. Com as duas rodadas fechadas, a Fase 2 pode ser
considerada completa.

**Pesquisa antes de implementar** (3 agentes em paralelo — mapeamento de
código real, pesquisa de comunidade sobre reteste/rompimento+reteste,
pesquisa sobre displacement/volume ICT): o achado mais forte foi estatístico,
não de opinião de blog — Bulkowski (thepatternsite.com, dados reais de
milhares de padrões em ações/gráfico diário, não cripto/intraday) mede que em
91–97% dos casos o padrão teria tido desempenho MELHOR sem esperar o reteste,
e que 42–57% dos rompimentos válidos nunca retestam. Isso contraria a
"sabedoria" comum de trading de varejo de que reteste = entrada mais segura.
Não há como transferir esse número 1:1 para cripto intradiário, mas é
evidência real o suficiente para justificar por que o gatilho nasce desligado
e adicional (nunca substitui a confirmação 15m/5m já existente) em vez de já
vir ativo por padrão.

Um primeiro desenho (antes da verificação linha a linha) presumiu que
`structuralLevel` — já retornado por `check5mSmcConfirmation` — poderia ser
reaproveitado como "nível a retestar" na cascata SMC. **Isso estava errado**:
`structuralLevel` (`scanner.js`, dentro de `check5mSmcConfirmation`) é o pivô
PROTEGIDO OPOSTO (`lastSwingLow` para BUY / `lastSwingHigh` para SELL) —
já consumido como STOP em `buildSmcTradeOpData`. O nível de fato rompido
(`lastSwingHigh` para BUY / `lastSwingLow` para SELL) já era calculado em
`scanner.js` (bloco `smc_structure` de `scanAsset`) mas nunca tinha sido
persistido — exigiu 1 campo novo, `SignalEvent.context.smc_broken_level`.
Registrado aqui porque é exatamente o tipo de erro que a etapa de
pesquisa/verificação existe para pegar antes de virar código — foi pego e
corrigido antes do merge, não depois.

**Design**: nova função pura `detectRetest` (`src/lib/indicators/retest.js`,
sem I/O, sem paridade Pine a manter — não porta nada do Pine real do
usuário). Chamada por um helper novo em `scanner.js`, `evaluateRetestGate`
(faz o próprio `fetchCandles` do timeframe de confirmação, calcula
`tolerancePrice = retestToleranceAtrMult × ATR(14)` desse mesmo timeframe),
posicionado como um gate ADICIONAL, ANTES de `check15mConfirmation`/
`check5mSmcConfirmation` — que continuam 100% intocadas — nos 4 pontos de
chamada existentes (1ª passada + retry, RF e SMC). Quando
`pineConfig.retestEnabled` é `false` (o padrão), o gate é pulado
inteiramente: zero `fetchCandles` extra, comportamento byte-idêntico ao
anterior a esta rodada. Nível-âncora por cascata: RF usa
`SignalEvent.context.rf_value` (já existente, o valor do próprio filtro RF no
instante do sinal); SMC usa o novo `context.smc_broken_level`, com fail
**fechado** quando ausente (sinal legado, ou pivô ainda não confirmado) —
diferente do fail-open do gate de zona OTE (item 38): aqui "nível
desconhecido" não tem o mesmo risco de tautologia geométrica, e falhar
fechado é mais conservador (o sinal só continua sendo re-tentado até expirar
pela janela de 4h já existente, nunca entra sem checagem).

**Campos novos** (aditivos, nunca alteram `entry_price`/`initial_stop`/
`tp1`/`tp2` — só auditoria): `TradeOperation.retest_gate_enabled/
retest_anchor_level/retest_price/retest_candle_time/
retest_bars_to_confirm/retest_touch_mode`; `SignalEvent.context.
smc_broken_level` (SMC apenas). `retestTouchMode` ('close'|'wick') resolve
explicitamente a divergência real que a pesquisa encontrou (comunidade sem
consenso sobre se um pavio já conta como toque válido, ou só o fechamento) —
deixado configurável em vez de escolher uma regra só, default `'close'` (mais
conservador).

**Backtest**: nova seção `retest` em `buildReport`
(`src/lib/backtestEngine.js`, mesmo padrão da seção `arbitration` da Fase 1)
— `{enabled, total, confirmed, pending, avgBarsToConfirm, byCascade}`.
`enabled` é inferido de `retestOutcomes` não estar vazio (nada é empurrado
enquanto o flag está desligado), sem precisar de um import redirecionado
novo em `backtestEngine.js`. Esta seção é o mecanismo central de "não deixar
cair no esquecimento": qualquer comparação de dois relatórios já mostra se o
reteste estava ligado em cada um, e `avgBarsToConfirm` é o dado real pra
calibrar `retestToleranceAtrMult`/timeout depois — nenhum dos dois é
validado nesta rodada, só implementados com defaults de partida.

Regressão: `src/lib/indicators/retest.test.js` (14 testes — função pura:
confirmação por close/wick, direção-consciência do pavio, exclusão da vela
do próprio sinal, fronteira de tolerância, entradas inválidas, primeira vela
qualificada); `scannerStateMachine.test.js` (6 testes — flag desligado sem
mudança de comportamento nem fetch extra, RF e SMC aguardando/confirmando
reteste, nível SMC correto — não `structural_level`/`ote_leg_low` —, fail
fechado sem `smc_broken_level`, confirmação via loop de retry sem duplicar
operação); `backtestEngine.test.js` (2 testes — seção `retest` do
relatório, contagem por cascata, média de `barsToConfirm` só sobre
confirmados).

**Rodada de hardening (pós-auditoria externa das PRs #81/#82)**: uma
auditoria externa apontou 10 problemas; cada um foi confrontado com o código
real antes de decidir corrigir ou refutar (nunca aceito às cegas). Bug real
confirmado e corrigido em `retest.js`: o modo `touchMode: 'wick'` comparava
só UM ponto (`candle.low` para BUY / `candle.high` para SELL) contra a banda
`[level±tolerancePrice]` — um pavio que atravessa a banda inteira (ex.:
low=98 com banda [99,101]) tinha esse ponto fora da banda e o toque não era
reconhecido, mesmo o candle tendo cruzado fisicamente a zona. Corrigido para
interseção de faixa (`candle.high >= lowerBound && candle.low <= upperBound`);
a resolução da direção (`resumedDirection`) continua julgada pelo `close`,
intocada. Bug **dormente em produção** — `retestTouchMode` default é
`'close'`, que nunca exercitava esse ramo. `report.retest` (backtest) ganhou
`byReason` (contagem por `reason` dentre os pendentes — antes só existia
`pending` agregado, misturando "ainda aguardando" com "parâmetro inválido"/
"dados insuficientes"). Itens da auditoria refutados para este gate
(justificativa completa no item 41, que os compartilha): helper de
normalização de timestamp (todo o pipeline já usa `new Date(x).getTime()`
consistentemente, sem caso real divergente); estados explícitos
`RETESTED/NOT_YET/INVALIDATED` (não duplica proteção que
`check5mSmcConfirmation`/OTE já fazem contra estrutura invalidada, mesmo
princípio do item 38).

### Primeiro A/B real: gate praticamente mata a cascata RF nos parâmetros default (2026-08-02)

Contexto: Bloco 0 (item 48) ficou ambíguo — critério "positivo nas duas
janelas" não bateu ao pé da letra. Discutido com o usuário um caminho de
meio-termo (nem aceitar a ambiguidade e destravar tudo, nem esperar uma 3ª
janela): desbloquear só o flag do Bloco 1 que toca a cascata RF —
`retestEnabled` é o único dos quatro (os outros três são só SMC, componente
já desincentivado por expectância negativa, item 56) — usando o dado JÁ
medido em vez de esperar mais amostra. Usuário autorizou o teste.

Backtest real (`trial_label: com-reteste`, mesmo período/símbolos do item
58: fev-dez/2025, 7 símbolos, `retestEnabled: true`, tolerância/touchMode no
default): **0 operações fechadas** (contra 87 no baseline sem reteste, mesmo
período). `report.retest`: 105 sinais confirmados pela RF entraram na fila
de reteste, só **1 (0,95%)** alguma vez teve o reteste confirmado dentro da
janela de retry (máx. 18 tentativas) — e mesmo esse não virou operação.
`entryFunnel['4h_15m'].byReason.retest_pending = 1729` — de longe o maior
motivo de rejeição do funil inteiro, muito acima de `regime_rejected`
(1000).

**Leitura**: não é bug — `detectRetest` é função pura, determinística, já
teve auditoria externa e regressão (14 casos). É o parâmetro. Com
`retestToleranceAtrMult: 0.3` (banda estreita) e `retestTouchMode: 'close'`
(exige o candle FECHAR dentro da banda, não só tocar por pavio), a exigência
é: depois que a RF confirma um rompimento — que por definição já se afastou
decisivamente do nível — o preço precisa voltar e FECHAR dentro de 0,3×ATR
do nível original, dentro de no máximo 18 tentativas de retry. Nos dados
reais isso quase nunca acontece. Consistente com (e mais extremo que) a
pesquisa de comunidade já citada acima (Bulkowski: 42–57% dos rompimentos
válidos nunca retestam, em ações/diário — aqui a fração que retesta E fica
dentro da janela de retry é ~1%, não ~50%).

**Decisão**: `retestEnabled` **não ativado** com os parâmetros default —
não é "amostra pequena demais pra confiar" (como o padrão de vela), é "o
gate mata quase toda a cascata que estava sendo testada". Testar de novo
exigiria parâmetros bem diferentes (tolerância maior e/ou
`retestTouchMode: 'wick'`) — um experimento novo, não uma confirmação do
que já está configurado. Não decidido se vale a pena perseguir essa
recalibração agora.

**Gap de ferramental encontrado nesta investigação**: `scripts/
analyze-backtest.mjs` nunca ganhou uma seção pra imprimir `report.retest`
(diferente de `report.candlePattern`/`smcRegime`/`smcTrigger`, que têm
`renderXSection`) — `docs/claude/backtest-usage.md` descreve `report.retest`
como se fosse inspecionável pelo fluxo normal, mas o diagnóstico impresso no
Summary do `backtest.yml` nunca mostra essa seção. Só foi possível
diagnosticar este resultado baixando o artifact `backtest-report.json` bruto
e lendo o JSON direto. **Não corrigido nesta rodada** — registrado para
quando alguém for estender `analyze-backtest.mjs` de novo.

## 41. Gatilho de candle de deslocamento — Fase 2 rodada 2 (`displacementEnabled`), DESLIGADO por padrão, só cascata SMC — fecha a Fase 2

**Status: DESLIGADO.** `pineConfig.displacementEnabled = false` por padrão
nos três arquivos de config sincronizada, aplicado **só à cascata SMC
(1h→5m)** — a cascata Range Filter (4h→15m) não tem nenhum conceito análogo
no seu Pine de referência, então não recebeu este gatilho. **Não ative sem
antes rodar `npm run backtest` duas vezes (com e sem `displacementEnabled`,
via `--pine-config`) e comparar as métricas de win rate/R:R/expectância entre
as duas rodadas** — mesma disciplina do item 40.

Segunda (e última planejada) rodada da Fase 2 — fecha o 3º item do roadmap
original (item 40 registrava que "reteste simples"/"rompimento+reteste" eram
o mesmo mecanismo; este item é o 3º item distinto, "candle de deslocamento
com volume"). Com as duas rodadas fechadas, **a Fase 2 pode ser considerada
completa**.

**Pesquisa já feita antes de planejar** (mesma rodada de pesquisa do item 40):
nem o Pine de referência do projeto
(`docs/reference-pine/smc-a-unified-v2.3.pine`) usa o termo "displacement" —
tem um filtro de corpo/ATR(200)×3 só para confirmar Order Block (`is_bac`,
sem checagem de pavio nem de volume) e um filtro de momentum via
corpo/ATR(3) OU assimetria de pavio para validar BOS/CHoCH
(`filter_insignificant_internal_breaks`) — nenhum dos dois ligado a volume ou
a FVG. A comunidade ICT externa também não tem número consenso (razão
corpo/range citada em 60%, 60–70% ou 80%; múltiplo de ATR de 2× a 3–5×;
divergência real sobre exigir 1 candle vs. sequência de 2–3). Volume **não é
parte da definição canônica ICT** — o conceito nasceu em Forex, mercado sem
dado de volume real — tratado por implementações mais algorítmicas como
upgrade opcional, não regra. Cripto tem volume real disponível, então este
projeto expõe a checagem de volume como **opcional** (`displacementMinVolumeRatio`,
`null` por padrão = nunca exigido, modo puramente price-action — a leitura
mais "purista" do ICT), não como parte obrigatória do gatilho.

**Design**: nova função pura `detectDisplacement`
(`src/lib/indicators/displacement.js`, sem I/O, sem paridade Pine a manter —
não porta nada do Pine real). Diferente do gatilho de reteste (item 40, que
varre uma JANELA de candles futuros procurando um toque de nível),
displacement classifica **um único candle já conhecido** — o candle de
gatilho que `check5mSmcConfirmation` já identificou (sweep ou BOS/CHoCH) —
então não precisa de busca por janela nem de estado de retry próprio: roda
DEPOIS que a confirmação 5m já confirmou, ANTES de criar a `TradeOperation`.
`check5mSmcConfirmation` ganhou 1 campo aditivo no retorno
(`closedCandles`, a mesma série de candles 5m que a função já buscou) para
que o novo gate reaproveite os dados já obtidos em vez de fazer um
`fetchCandles` redundante — nenhuma linha de decisão existente dentro de
`check5mSmcConfirmation` foi alterada. Quando `pineConfig.displacementEnabled`
é `false` (o padrão), o gate é pulado inteiramente: zero custo extra,
comportamento byte-idêntico ao anterior a esta rodada. Se o candle de
gatilho não atende ao limiar de corpo/ATR (e, se configurado, de volume), a
operação **não é criada nesta passada** — o sinal continua sendo
re-avaliado pelo loop de retry já existente (silencioso a cada tick, mesmo
padrão do item 40) até um candle de gatilho qualificado aparecer ou a
janela de 4h expirar.

**Campos novos** (aditivos, nunca alteram `entry_price`/`initial_stop`/
`tp1`/`tp2` — só auditoria, SMC apenas): `TradeOperation.
displacement_gate_enabled/displacement_body_ratio/displacement_volume_ratio/
displacement_min_body_atr_mult/displacement_min_volume_ratio`.
`displacement_volume_ratio` fica `null` sempre que
`displacementMinVolumeRatio` não estiver configurado para aquela entrada
(modo price-action puro).

**Backtest**: nova seção `displacement` em `buildReport`
(`src/lib/backtestEngine.js`, mesmo padrão de `retest`/`arbitration`) —
`{enabled, total, confirmed, pending, avgBodyRatio, byCascade}`, `enabled`
inferido de `displacementOutcomes` não estar vazio. `avgBodyRatio` (só sobre
confirmados) é o dado real para calibrar `displacementBodyAtrMult` — não
validado nesta rodada, só implementado com um default de partida (1.5).

Regressão: `src/lib/indicators/displacement.test.js` (16 testes — função
pura: corpo abaixo/acima do limiar, fronteira inclusiva, volume exigido
abaixo/acima do mínimo, fronteira de volume, dado de volume ausente quando
exigido, parâmetros inválidos sem lançar exceção, direção errada/doji
rejeitados, `bodyAtrMult<=0` inválido); `scannerStateMachine.test.js`
(6 testes específicos do gate + 2 testes combinados com o reteste — flag
desligado sem mudança de comportamento, corpo insuficiente rejeitado com
log, corpo suficiente sem exigir volume confirma com os 5 campos corretos,
volume insuficiente rejeita mesmo com corpo ok, volume suficiente confirma,
confirmação via loop de retry sem duplicar operação, os dois gates juntos
aprovando, reteste aprova mas deslocamento reprova); `backtestEngine.test.js`
(2 testes — seção `displacement` do relatório, contagem por cascata, média
de `bodyRatio` só sobre confirmados).

**Rodada de hardening (pós-auditoria externa das PRs #81/#82)**: cada
alegação da auditoria foi confrontada com o código real antes de decidir
corrigir ou refutar. Três bugs reais confirmados e corrigidos:

1. **Direção do candle não validada.** `detectDisplacement` media só
   `Math.abs(close-open)`, sem checar se o candle é líquido a favor da
   direção do sinal. Alcançável de verdade no gatilho por ESTRUTURA
   (BOS/CHoCH): `calculateStructure` só exige que o `close` cruze um pivô
   relativo ao close anterior, sem exigir `close > open`/`close < open` no
   próprio candle — um candle que abre em gap, vende ao longo do candle mas
   fecha acima do pivô (BOS de alta) tinha corpo líquido de baixa e ainda
   passava como deslocamento válido para uma entrada BUY. Corrigido: novo
   parâmetro obrigatório `direction` (`'BUY'|'SELL'`), checagem
   `close > open` (BUY) / `close < open` (SELL) ANTES de qualquer outra
   verificação, novo `reason: 'wrong_direction'` (doji reprova nos dois
   lados de graça). `bodyAtrMult` também passou a rejeitar `<= 0` (não só
   `< 0`) — um valor `0` deixava qualquer candle, inclusive doji, passar.
2. **ATR do gate incluía o próprio candle avaliado (self-normalization).**
   `evaluateDisplacementGate` calculava `calculateATR(closedCandles, ...)`
   sobre a série completa, que termina no próprio candle-gatilho — um
   candle grande inflava seu próprio denominador, reduzindo artificialmente
   seu `bodyRatio`.
3. **Média de volume do gate incluía o próprio candle avaliado** — mesmo
   padrão do item 2, a fatia usada para `volumeMa` incluía o candle-gatilho.

Os itens 2 e 3 foram corrigidos juntos: `evaluateDisplacementGate` agora
localiza o candle-gatilho por `findIndex` (não mais `.find() ?? último`),
falha **fechado** com `reason: 'trigger_candle_not_found'` se não achar, e
fatia `history = closedCandles.slice(0, triggerIndex)` — ATR e média de
volume passam a ser calculados só sobre `history` (nunca sobre o
candle-gatilho nem candles futuros), mesmo princípio de
`isCandleUsableForExits` (P0-g, `.claude/rules/trading-engine.md`) — nunca
deixar o candle sendo julgado contaminar sua própria régua. Essa mesma
correção também fechou de graça um item **parcialmente confirmado** da
auditoria (fallback silencioso para o último candle quando o gatilho não é
encontrado): verificado que hoje é inalcançável na prática
(`entryCandleTime` sempre vem do mesmo array que gera `closedCandles`), mas
o `findIndex`+fail-closed deixa o comportamento explícito e correto mesmo
se essa garantia mudar no futuro. `report.displacement` (backtest) ganhou
`byReason` (mesmo padrão do item 40).

**Itens da auditoria refutados ou fora de escopo, com justificativa**:
helper de normalização de timestamp compartilhado (todo o pipeline —
retest.js, displacement, scanner.js — já usa `new Date(x).getTime()` de
forma consistente ponta a ponta; sem caso real de formato divergente,
só hipotético); validação exaustiva `Number.isFinite`/NaN/Infinity em todo
parâmetro (desproporcional — nenhuma outra função pura do projeto faz esse
nível de guarda, e candle real da Binance não produz NaN/Infinity na
prática; só o ponto concreto e barato achado — `bodyAtrMult<=0` — foi
corrigido); campos extras de auditoria (`atr_baseline`, `volume_ma_baseline`,
`displacement_candle_direction`) — valor marginal (o candle confirmado
SEMPRE tem direção alinhada, por construção do gate — persistir isso é
sempre `true`) frente ao custo de mais campos de schema; matriz de 14
testes combinados — 2 testes focados cobrem a interação NOVA de verdade
(os dois gates juntos aprovando; reteste aprova mas deslocamento reprova),
o resto (CAS, concorrência, duplicidade de operação) já está coberto por
testes da Fase 1 não relacionados a esta feature; backtest real com matriz
de configurações/walk-forward — não é alegação de bug, é validação de
estratégia em si, e continua **estruturalmente impossível** nesta sessão
(Binance inacessível a partir de sessões do Claude Code) — a pendência já
estava registrada e continua registrada, nenhum resultado foi fabricado.

## 42. Tier/regime na cascata SMC 1h→5m — Fase 3 (`smcTierEnabled`), DESLIGADO por padrão — fecha a assimetria RF vs SMC

**Status: DESLIGADO.** `pineConfig.smcTierEnabled = false` por padrão nos três
arquivos de config sincronizada. **Não ative sem antes rodar `npm run
backtest` duas vezes (com e sem `smcTierEnabled`, via `--pine-config`) e
comparar `report.smcRegime` e as métricas de win rate/R:R/expectância entre
as duas rodadas** — mesma disciplina dos itens 40/41.

**Contexto**: o roadmap original da Fase 3 era "timeframe de confirmação
adaptativo" — trocar QUAL timeframe menor confirma a entrada (ex. 15m↔30m,
5m↔15m) conforme volatilidade. Pesquisa de comunidade (fóruns quant,
QuantConnect, ICT/SMC, documentação de repaint do Pine Script) não achou
nenhum precedente real pra essa técnica específica — a comunidade ICT/SMC
mantém o timeframe de confirmação FIXO por convenção (pares padrão
5m→1h/15m→4h/1h→D; a única coisa "adaptativa" que usam é horário/sessão —
"kill zones" —, não volatilidade); achou riscos concretos (overfitting —
QuantConnect forum "Rage Against the Regimes"; repaint/look-ahead no
indicador de volatilidade se ele ler dados de uma vela ainda não fechada,
documentado nos próprios docs do Pine Script sobre `request.security`); e
não achou nenhuma evidência de backtest real a favor OU contra. Diante
disso, optou-se por uma versão mais estreita e mais segura: em vez de
trocar timeframe, levar pra cascata SMC o sistema de tier/regime que a
cascata RF já tem e já usa há tempo — sem inventar mecanismo novo.

**O problema real que motivou esta rodada**: a cascata RF (4h→15m) já
classifica cada ativo num tier de volatilidade (T1/T2/T3, via
`classifyTier`/`calculateAtrPctSmooth`, `src/lib/indicators/tier.js`) e usa
isso pra bloquear entrada em mercado sem tendência/lateralizado (ADX fraco
ou Choppiness alto, `evaluateRegime`) e pra definir o prazo do Time Stop. A
cascata SMC (1h→5m) nunca teve nada disso — `tier_time_stop_bars` era um
literal fixo `96` (`scanner.js`, `buildSmcTradeOpData`), sem ADX/Choppiness
computados pra 1h em lugar nenhum. Assimetria real entre as duas cascatas,
confirmada por leitura direta do código antes deste plano.

**Design**: reuso total — `classifyTier`/`calculateAtrPctSmooth`/
`calculateADX`/`calculateChoppiness` (já testadas, já usadas pra 4h) passam
a rodar também pra `tf === '1h'` dentro de `scanAsset`, guardado atrás do
flag (`if (tf === '4h' || (tf === '1h' && pineConfig.smcTierEnabled))`) —
mesma tabela de limiares da RF, sem calibração nova pra 1h (decisão
deliberada, sem evidência pra inventar limiares próprios). `evaluateRegime`
(`scanner.js`) já era agnóstica de timeframe (só lê `.tier`/`.adx`/`.chop`
do objeto que recebe, retorna passthrough `{ok:true}` quando `tier`/`adx`
são `null`) — reaproveitada tal qual, chamada com `tf1hData` nos 2 pontos de
entrada da cascata SMC (1ª passada + retry), na MESMA posição relativa que
a RF já usa: ANTES do `if (!hasActiveOp)`, não dentro — consequência
deliberada e simétrica com a RF: quando o regime SMC reprova, a arbitragem
cross-cascade (`handleActiveOpArbitration`) também é pulada pra esse sinal,
igual já acontece com a RF hoje.

**Campos**: `tier`/`adx_at_entry`/`chop_at_entry` NÃO são campos novos — são
os MESMOS 3 campos que `buildTradeOpData` (RF) já stampa; só passam a ser
preenchidos pela SMC também, quando o flag populou `tf1hData.tier`.
`tier_time_stop_bars` deixa de ser o literal `96` e passa a ler
`tf1hData.tier?.timeStopBars ?? 96` — o `?? 96` preserva exatamente o
comportamento de hoje quando o flag está desligado ou tier indisponível.

**`tier.atrStopMult` continua sem uso em SMC — decisão explícita, não
esquecimento.** O stop da SMC é estrutural (nível de rompimento + buffer/
piso/teto em ATR via `computeStructuralStop`), nunca um multiplicador ATR
puro por tier como a RF. Conectar `tier.atrStopMult` ao cálculo de preço do
stop seria um mecanismo novo, matemática de preço diferente — fora do
escopo aprovado nesta rodada. `SMC_INITIAL_STOP_ATR_MULT` continua uma
constante fixa, documentado no próprio código pra não ser reaberto por
engano.

**Efeito colateral real, verificado e testado — Chop Exit passa a valer pra
SMC "de graça".** O loop de gestão de operações ativas dentro de
`persistScanResults` já lê `tfData = results[op.signal_timeframe || '4h']`
de forma genérica, tanto pro Time Stop quanto pro Chop Exit
(`pineConfig.useChopExit === true && tfData.chop != null && tfData.tier &&
tfData.chop > tfData.tier.chopMaxVal`). No momento em que `smcTierEnabled`
popular `results['1h'].tier`/`.chop`, se `useChopExit` (flag independente,
já existe, default `false`) TAMBÉM estiver ligado, o Chop Exit passa a
valer pra operações SMC sem nenhuma linha de código nova — puro efeito
colateral de popular o dado que já era lido de forma genérica. Não é bug —
é coerente com "fechar a assimetria RF vs SMC" — mas fica documentado aqui
pra não ser redescoberto por acidente em produção. Coberto por par de
testes (`scannerStateMachine.test.js`) provando que o efeito acontece só
quando `tier` está de fato populado.

**`useADX`/`useChop` são toggles globais, não exclusivos da RF.** Ligar
`smcTierEnabled` sem tocar neles já ativa os dois sub-gates (ADX e
Choppiness) pra SMC simultaneamente, herdando o estado global atual — não
há flag independente "só ADX" ou "só Chop" por cascata.

**Suposição não validada**: a mesma tabela de limiares da RF (thresholds de
`atrPctSmooth`, `adxMinVal`, `chopMaxVal` por tier) aplicada a candles de 1h
é uma hipótese razoável, não uma calibração provada — ATR% num candle de 1h
tem magnitude diferente de um candle de 4h pro mesmo ativo. A classificação
RELATIVA entre ativos deve se manter razoável, mas isso não foi validado.
Mesma disciplina da Fase 2: default de partida, comparar via backtest antes
de ativar.

**Backtest**: nova seção `smcRegime` em `buildReport`
(`src/lib/backtestEngine.js`, mesmo padrão de `retest`/`displacement`) —
`{enabled, total, passed, rejected, byReason}`, `enabled` inferido de
`smcRegimeOutcomes` não estar vazio. `byReason` separa `adx_weak`/`choppy`/
`adx_and_chop`.

Regressão: `scannerStateMachine.test.js` (8 testes novos — flag desligado
sem mudança de comportamento nem log; regime reprovado bloqueia entrada E
arbitragem cross-cascade; regime aprovado stampa os 4 campos corretos;
confirmação via loop de retry sem duplicar operação; par de testes do
efeito colateral do Chop Exit; 2 testes unitários diretos de
`buildSmcTradeOpData` com/sem `tf1hData.tier`); `backtestEngine.test.js` (2
testes — seção `smcRegime` do relatório, contagem de `passed`/`rejected`,
`byReason` com as 3 combinações adx/chop).

## 43. Order Block / Fair Value Gap — Fase 4 (`smcObFvgEnabled`), DESLIGADO por padrão, informativos e nunca gate

**Status: DESLIGADO, e com pesos de score em 0 mesmo quando ligado** (ativação
em dois estágios, explicada abaixo). **Não suba peso nenhum sem antes rodar
`npm run backtest` com `smcObFvgEnabled: true` e olhar `report.smcObFvg`** —
esse relatório é literalmente o único efeito observável do estágio 1, e é o
dado que responde "vale a pena dar peso a isso?".

### Correção de registro — a nota anterior estava errada

O arquivo `docs/reference-pine/smc-a-unified-v2.3.pine` era **parcial** (só as
regiões `LIB SMC` e `ADAPTIVE HELPERS`) e trazia uma nota afirmando que as
regiões omitidas — inclusive Order Block, FVG e os alertas — eram "puramente de
VISUALIZAÇÃO no TradingView, sem contrapartida de decisão de trading". O usuário
forneceu o script COMPLETO nesta rodada e **essa afirmação foi refutada**: existe
uma região `#region CONFLUENCE SCORE` onde `ob_bull_active`, `ob_bear_active`,
`fvg_bull_active` e `fvg_bear_active` são **4 dos 7 componentes** de um score
0–7 (`bull_score`/`bear_score`) exibido em tabela. A nota tinha sido escrita por
uma sessão anterior que não tinha o arquivo inteiro — exatamente o caso que
`.claude/rules/documentation-truth.md` manda confrontar com a fonte antes de
registrar. O arquivo de referência foi **substituído pelo script completo** e a
nota corrigida, fechando de vez a lacuna do item 9.

O que a correção NÃO muda: o script continua sendo um `indicator()`, não um
`strategy()` — não há `strategy.entry()`/`strategy.exit()` em lugar nenhum dele.
OB/FVG alimentam um score e disparam `alertcondition()`, nunca uma ordem. E o
scanner do Sentinel não consome alertas do TradingView (recomputa tudo a partir
de candles da Binance), então a região de alertas não gera obrigação de porte.
Ou seja: a descoberta **confirma** o escopo escolhido (OB/FVG como entrada de
score) em vez de ampliá-lo.

### Pesquisa antes de implementar

Três agentes em paralelo (extração literal do Pine, mapeamento do JS existente,
pesquisa de comunidade ICT/SMC):

- **Definição de FVG tem consenso real** (3 velas, wick a wick) — porte fiel é
  possível e foi feito.
- **Definição de Order Block NÃO tem consenso**: a pesquisa achou pelo menos 3
  variantes legítimas (qualquer última vela contrária × exigir FVG associado ×
  detecção por pico de volume) e **nenhum limiar numérico canônico** para "OB
  válido" — diferente de ADX 25 (Wilder, 1978) ou Choppiness 61.8 (Dreiss,
  1992), que têm autor e origem rastreáveis. Por isso os múltiplos usados aqui
  são os do **próprio Pine do usuário** (ATR(50) × [0.5, 2.5]), única âncora
  defensável.
- **Evidência empírica de que OB/FVG funcionam como gatilho é fraca** e o campo
  é dominado por fontes de baixa qualidade (SEO/content farm; o único "estudo
  acadêmico" localizado é de periódico sinalizado como predatório). A crítica
  metodológica mais substantiva encontrada aponta o problema real: SMC/ICT não
  tem definição objetiva/falsificável, então dois analistas rotulam o mesmo
  gráfico de formas diferentes. Isso não invalida usar como **informação de
  confluência** — que é como o próprio Pine do usuário usa — mas invalida
  tratar como gatilho, e é a razão dos pesos nascerem em 0.

### O que foi portado, o que foi simplificado e o que é IMPOSSÍVEL

**FVG (`src/lib/indicators/fvg.js`) — porte fiel da lógica.** Condição de 3
velas idêntica (`low[0] - high[2]` / `low[2] - high[0]`), filtro de tamanho
`ATR(50) × 0.5` (o `min_fvg_atr_mult` real), preenchimento a **60%** por
FECHAMENTO (`fvg_fill_target_ratio = 60/100`, `LevelBreakMode.CLOSE` — não é
preenchimento total, não é 50%, não é por pavio). Única divergência: o Pine
acumula FVGs num array `var` desde o início do gráfico; aqui não há estado entre
scans, então a varredura é limitada a `lookback` (default 60 velas). Registrado,
não é falha de paridade.

**Correção pós-review do Codex (PR #85) — limiar por barra de formação.** A
primeira versão passava um `sizeThreshold` escalar (ATR da última barra) e o
aplicava a TODOS os candidatos da janela de 60 velas. O Pine faz diferente, e a
diferença é observável: `fvg_size_threshold` é série por barra, a checagem
`sz > size_threshold` ocorre no instante da **formação**, e o objeto criado vive
até ser preenchido — `remove_insignificant` só re-testaria tamanho com
`gc_cycle > 0`, e a chamada real **omite** esse argumento (fica `na`,
desligado). Com o escalar, um gap antigo aparecia e sumia conforme o ATR de hoje
oscilava: gap válido formado em baixa volatilidade desaparecia quando o ATR
subia, e gap reprovado em alta volatilidade reaparecia quando caía. Isso enviesa
justamente `report.smcObFvg`, que é o único entregável do estágio 1. Corrigido:
`detectFvg` aceita `sizeThreshold` como **array alinhado a `candles`** e julga
cada candidato pelo limiar da sua própria barra; `scanner.js` passa
`calculateATRSeries(closedCandles, obFvgAtrLen) × fvgMinAtrMult`. O escalar
segue aceito por conveniência em teste de limiar fixo. 4 testes novos, incluindo
a contraprova de que o escalar de fato falharia.

**O Order Block não tem esse problema**: é avaliado uma única vez, na barra do
rompimento (`candles[n-1]`), então o ATR corrente É o de formação — o escalar
está correto ali e foi mantido.

**Order Block (`src/lib/indicators/orderBlock.js`) — aproximação geométrica
deliberada.** Porta a definição mainstream ("última vela contrária antes do
impulso que rompe estrutura") e o filtro de tamanho do Pine real. **Não** porta:
a máquina de estados `trailing→extending→awaiting_confirmation→confirmed` (o
Pine rastreia candidatos barra a barra com estado `var`, incompatível com um
scanner que recalcula tudo do zero a cada passada), as 5 vias alternativas de
confirmação, `soft_confirm`, `has_fvg_out`, `is_bac`, e os arrays
`tracking_blocks_*`/`broken_blocks_*`.

**E parte é IMPOSSÍVEL, não questão de esforço**: a chamada real do usuário usa
`align_edge_to_value_area=true` e `align_break_price_to_poc=true`, ou seja, as
bordas do bloco e o `break_price` (nível de invalidação) vêm de um **perfil de
volume** (VAH/VAL/POC) calculado pela biblioteca externa `robbatt/lib_profile/44`,
cujo código não existe neste repositório nem é acessível. Por isso a invalidação
aqui é uma regra única e explicável (fechamento além da zona no sentido
contrário ao rompimento) em vez do `update_broken` original.

**Consequência para paridade**: OB/FVG **não são candidatos a golden test contra
o TradingView**, diferente de BOS/CHoCH/sweep/PD (porte fiel). Os testes de
`goldenParity.test.js` para eles validam causalidade/não-repaint da lógica
simplificada contra ela mesma. Registrado também em
`.claude/rules/pine-parity.md`.

### Ativação em dois estágios (decisão central desta rodada)

Os 7 pesos do score SMC somam exatamente 100 e o score termina em
`Math.min(100, ...)`. Adicionar peso novo sem redistribuir comprime o topo da
distribuição — e esse score **já é consumido em produção** pelos limiares de
arbitragem da Fase 1 (`arbPromoteMinScore: 75`, `arbReinforceMinScore: 50`).
Mexer nos pesos existentes seria mudança de comportamento real, não aditiva.
Daí o desenho:

1. **Estágio 1 — medir**: ligar `smcObFvgEnabled` com os pesos no default (0)
   produz os campos de auditoria (`SignalEvent.context.ob_active`/`fvg_active`)
   e a seção `report.smcObFvg` do backtest, com o **score numericamente
   idêntico** ao de antes da Fase 4. Coberto por teste dedicado.
2. **Estágio 2 — dar peso**: subir `smcScoreObWeight`/`smcScoreFvgWeight`,
   redistribuindo os demais para continuar somando 100, é decisão separada e
   deliberada, informada pelo backtest do estágio 1. **Não feita nesta rodada.**

### Campos e configuração

`SignalEvent.context.ob_active` / `context.fvg_active` (`boolean|null`) —
observacionais, nunca consumidos por stop/TP nem por gate. `null` = não avaliado
(flag desligado ou sem rompimento naquela vela), `false` = avaliado e não ativo.
Nada novo em `TradeOperation` (o score já carrega o efeito — sem redundância).

Config sincronizada nos 3 arquivos: `smcObFvgEnabled: false`, `obFvgAtrLen: 50`,
`obMinAtrMult: 0.5`, `obMaxAtrMult: 2.5`, `fvgMinAtrMult: 0.5`,
`fvgFillTargetRatio: 0.6`, `smcScoreObWeight: 0`, `smcScoreFvgWeight: 0` — todos
os numéricos espelhando o Pine real.

**Custo**: zero `fetchCandles` extra (o 1h já é buscado com 500 velas para a
estrutura SMC). O cálculo só roda quando a última vela 1h de fato rompeu
estrutura — isto é, só nos scans em que um sinal SMC nasce.

### Backtest

Nova seção `smcObFvg` em `buildReport` — `{enabled, total, obActive, fvgActive,
both, neither}`, `enabled` inferido de array não vazio (mesma convenção de
`retest`/`displacement`/`smcRegime`).

Regressão: `fvg.test.js` (16 testes — bordas do gap nas duas direções, fronteira
estrita do limiar, alvo de 60%, preenchimento sim/não, pavio que entra e fecha
fora não preenche, mais recente vence, lookback, entradas inválidas);
`orderBlock.test.js` (11 testes — acha a vela contrária certa nas duas direções,
pula velas da mesma cor, filtro de tamanho nas duas fronteiras, ativo/inativo
pelo close, invalidação nas duas direções, sem vela contrária, maxLookback,
entradas inválidas); `goldenParity.test.js` (3 testes de não-repaint/prefixo,
booleanos com `toBe`, nunca float); `scannerStateMachine.test.js` (5 testes do
contrato do score — flag off idêntico, **ativação em 2 estágios com score
idêntico**, peso somando exatamente, `false` não somando, teto de 100);
`backtestEngine.test.js` (4 testes — seção do relatório vazia/populada e 2 de
wiring fim a fim contra `scanAsset` real, com o flag ligado e desligado).

## 44. Custos reais (taxa/slippage/funding) e gate de amostra — Fase 5, LIGADO por padrão no painel E no backtest

**Status: LIGADO por padrão** — diferente das Fases 2-4, esta rodada NÃO nasce
desligada, e por um motivo específico: ela não adiciona um mecanismo novo de
trading, ela **corrige uma medição que estava errada**. Um flag que deixasse o
custo desligado por padrão manteria a medição errada como default.

### O problema que motivou a fase

Toda Fase 2, 3 e 4 terminou com a mesma instrução: *"não ative sem comparar os
relatórios de backtest antes"*. Mas o backtest **não descontava nenhum custo** —
entrada e saída eram registradas no preço cru do candle. Ou seja: o número que
decidia toda ativação estava sistematicamente otimista.

**O número que torna isso concreto**: taxa taker Binance USDⓈ-M VIP0 = 0,05% por
lado → 10 bps de ida e volta. Isso só vira decisão quando expresso **em R**:
com stop a 1% do preço de entrada são 0,10 R por operação; com stop a 0,5%
(entradas apertadas de 5m) são **0,20 R**. Uma configuração mostrando +0,15 R de
expectância no backtest antigo é, na prática, **negativa**. Daí `avgCostR` ser a
métrica central desta fase, e não o custo em %.

### Pesquisa antes de implementar

- **Taxas**: Binance USDⓈ-M VIP0 taker 0,05% / maker 0,02%; Spot 0,1%. Taker
  nos dois lados é o default **conservador e correto**: entrada em fechamento
  de candle é ordem a mercado, e stop dispara a mercado. Só o TP é
  genuinamente uma ordem limite em repouso — `feeBpsExit` fica exposto para
  quem quiser modelar maker, mas nunca assumido. ✅ **CONFIRMADO pelo usuário
  (2026-07-26)** direto nas páginas oficiais, que nem a sessão nem o agente de
  pesquisa conseguem abrir (403 no proxy para todo o domínio Binance):
  [`/en/fee/futureFee`](https://www.binance.com/en/fee/futureFee) →
  **0,0200% / 0,0500%** (maker/taker USDⓈ-M) e
  [`/en/fee/schedule`](https://www.binance.com/en/fee/schedule) →
  **0,100% / 0,100%** (Spot). O default `feeBpsEntry/Exit: 5` está **correto**;
  o 0,04% que aparecia no LEAN da QuantConnect é valor desatualizado de lá.
  Pendência encerrada.
- **Slippage**: *nenhum* framework tem default diferente de zero
  (backtesting.py, vectorbt, Backtrader, QuantConnect, freqtrade — todos zero).
  Não existe convenção a herdar. 1 bp/lado para BTC/ETH é **escolha registrada
  deste projeto**, não padrão de mercado. É ~20% do custo de taxa: segunda
  ordem, mas custa uma constante implementar.
- **Funding**: cobrado só se a posição está aberta **no instante exato** da
  liquidação (00/08/16 UTC) — fecha 07:59 e não paga nada. Para posições de
  horas, o esperado é 2,5% a 10% do custo de taxa. Por isso é **contado e
  reportado como constante**, e **não** existe pipeline de funding histórico:
  seria trabalho real por um termo de 1/20 da taxa, sem virar decisão. Se o
  relatório mostrar funding acima de ~20% do custo de taxa, é sinal de que as
  posições estão durando mais que o previsto — telemetria útil, e aí sim vira
  caso para pipeline.
- **Ordem importa (Bajgrowicz & Scaillet, *Journal of Financial Economics*
  2012** — 7.846 regras técnicas em 110+ anos de DJIA): a vantagem in-sample foi
  *"completamente anulada pela introdução de custos de transação"*. Corolário
  operacional adotado como regra: **congelar os custos ANTES de calibrar
  qualquer parâmetro**, nunca calibrar a custo zero e recalibrar depois — isso
  dobra a contagem de tentativas e contamina a segunda busca.
  **Consequência direta**: os pesos de OB/FVG da Fase 4 (item 43, hoje em 0)
  só devem ser calibrados **depois** desta fase.

### Onde o custo entra

`calcRealizedDelta` (`src/lib/tradeMetrics.js`) é o chokepoint único de todo
PnL — `calcRealizedPnlPct`, `calcRealizedR`, `classifyOutcome` e `summarizeOps`
derivam dele, então o custo propaga sozinho para win rate, drawdown e profit
factor. Modelo: taxa e slippage cobrados **por fill, sobre o preço do próprio
fill**, ponderados pela fração da posição (3 fills com parcial no TP1: entrada +
parcial + runner; 2 sem). Funding conta **fronteiras de 8h cruzadas**, não
duração.

**Por que o default é o custo real e não zero**: este módulo é a fonte única de
métricas, consumido por 10 superfícies do painel. Um default zero que cada tela
tivesse que sobrescrever acabaria com uma tela mostrando bruto e outra líquido
— exatamente a divergência de 6 implementações copiadas que o **item 22** criou
este módulo para matar. `ZERO_COST` é o opt-out explícito.

### Mudança de metodologia visível no painel (decisão do usuário)

Perguntado se o custo deveria valer só no backtest ou também no painel, o
usuário escolheu **nos dois**. Consequência: win rate, curva de PnL e relatório
mensal passam a mostrar resultado **líquido**. Nenhuma operação mudou — mudou a
metodologia. Mesmo tipo de mudança que o item 22 já registrou uma vez.

### Gate de amostra — o conserto do processo de decisão

`summarizeOps` passou a devolver `expectancyRStdErr`, `expectancyRCI95`,
`conclusive` e `inconclusiveReason`. O CLI imprime **RESULTADO INCONCLUSIVO** em
destaque quando o veredito é negativo, em vez de deixar um win rate de aparência
normal calculado sobre 3 operações embasar uma decisão.

`minTrades = 30` é **apenas** o limiar do Teorema Central do Limite — o ponto em
que a média amostral fica aproximadamente normal e um IC *pode* ser calculado.
**Não** é o ponto em que o IC fica estreito o bastante para decidir. O cálculo
de poder (não folclore — deriva do erro-padrão da média, `sd(R)/√N`, mesma base
de Lo, *Financial Analysts Journal* 2002):

| Expectância real | Operações necessárias (80% de poder, 5%) |
|---|---|
| 0,50 R (excepcional) | ~45 |
| 0,25 R (muito boa) | ~181 |
| 0,10 R (boa realista) | ~1.130 |
| 0,05 R (marginal) | ~4.500 |

Um relatório com 30 operações e IC cruzando zero continua inconclusivo, e é isso
que `conclusive` reporta. O "mínimo de 200-500 operações" que circula em blogs
não foi rastreável a nenhuma publicação de López de Prado — é folclore; a tabela
acima é a versão defensável.

### Correções de registro (documentation-truth)

Duas afirmações do repositório ficaram **falsas** e foram corrigidas, não
apagadas: `backtestEngine.js` e `docs/claude/backtest-usage.md` diziam que o
replay *"só pode fazer o win rate parecer pior que ao vivo, nunca
melhor/inflado"*. Isso vale só quanto à granularidade de candle — a ausência de
custos empurrava na direção oposta. O item **22** também declarava "sem taxas,
funding ou slippage" como limitação aceita; deixou de valer.

### Fora de escopo, com justificativa

- **Walk-forward / WFE**: estatisticamente sem sentido abaixo de ~100 operações
  (ver tabela). Com as ~0-5 operações que os backtests reais deste projeto
  produziram (itens 34/35), cada janela teria ~1 operação — produziria número
  bonito e sem informação, o que é **pior** que não ter, porque um gate que não
  mede nada lava decisão ruim. Revisitar quando alguma configuração produzir
  100+ operações de forma confiável.
- **Deflated Sharpe / PBO / CSCV**: mecanicamente inaplicáveis nesta escala —
  exigem estimar 3º e 4º momentos de uma série de retornos, ou uma matriz
  N configurações × T períodos. Com poucas operações, retornariam número
  calculado de ruído. O valor aproveitável da literatura é o *hábito* (contar
  tentativas, reportar intervalo, congelar custo), implementado aqui.
- **Pipeline de funding histórico**: ~5% do custo (ver acima).
- **Slippage por fração de ATR**: fica como cenário de sensibilidade futuro,
  não como base — conflaria volatilidade com custo de liquidez.
- **Recalibrar pesos existentes**: proibido nesta rodada pela própria regra
  "congelar custo antes de calibrar".

Regressão: `tradeMetrics.test.js` (41 testes — as ~28 asserções de valor
existentes passaram a receber `ZERO_COST` **explicitamente**, preservadas como
documentação da fórmula bruta, mais 13 novos: fills com/sem parcial, custo
sempre contra o trader em BUY e SELL, operação marginalmente vencedora virando
LOSS por causa do custo, `calcCostR` crescendo quando o stop aperta, funding
contando fronteiras e não duração, fronteira de `minTrades` 29 vs 30, IC
cruzando zero com amostra suficiente); `backtestEngine.test.js` (4 testes —
modelo ecoado no relatório, `--no-costs` reproduzindo exatamente o bruto,
líquido = bruto − custo, e o veredito inconclusivo descrevendo o mesmo agregado
que `overall`).

### PRIMEIRA MEDIÇÃO REAL (2026-07-26) — o achado que muda a prioridade do projeto

Primeiro backtest com dado real já com custos ligados
([run 30179598343](https://github.com/mateusraony/Sentinel-Signals/actions/runs/30179598343)):
**12 meses** (2025-07-25 → 2026-07-25), **7 símbolos**, cascata RF 4h→15m
(SMC desligada — `smcDiagnostics` zerado), **109 operações fechadas**.

```
avgCostR:          0.0422        grossExpectancyR: -0.0611
totalCostPct:     32.56%         netExpectancyR:   -0.1034
countedTrades:      109          CI 95%: [-0.3136, +0.1069]
conclusive: false (ci_straddles_zero)
```

**Três conclusões, e a segunda reordena o roadmap:**

1. **Amostra é suficiente** — 109 operações, muito acima do mínimo de 30. A
   premissa que motivou adiar o walk-forward ("~0-5 operações") vale para a
   cascata **SMC**, não para a **RF**. Se algum dia houver walk-forward, é na
   RF que ele tem material.
2. **A expectância já era NEGATIVA antes do custo** (−0,061 R). Este é o
   achado central: a Fase 5 foi construída sob a hipótese de que o custo
   omitido poderia estar escondendo uma vantagem real. **Não havia vantagem
   para o custo esconder.** O custo agravou (−0,061 → −0,103), não causou.
3. **O IC cruza zero** mesmo com 109 operações — não dá para afirmar com rigor
   que a estratégia perde, mas muito menos que ganha. A estimativa pontual é
   negativa e é a melhor informação disponível.

**Consequência prática — a prioridade mudou.** Calibrar os pesos de OB/FVG
(item 43) ou ligar os gates das Fases 2-3 são otimizações *em cima de uma base
com expectância negativa*. Otimizar parâmetro numa estratégia sem vantagem
demonstrada é exatamente a busca que Bailey/López de Prado descrevem: com
tentativas suficientes você **vai** achar uma configuração que parece boa
in-sample, e ela não sobrevive. A pergunta que passou a ser prioritária é
"esta estratégia tem vantagem?", não "qual parâmetro ajustar?".

**Hipótese sobre a composição do custo (não confirmada, exige o JSON por
operação)**: `avgCostR` deu 0,042, mas taxa+slippage (12 bps ida e volta)
sobre stops desta largura (as perdas na curva vão de −7% a −15%, logo o risco
é ~10-15% do preço) daria ~0,010 R. A diferença sugere que **o funding é o
maior componente aqui** — a cascata RF segura posição por dias (Time Stop de
48 barras de 4h = 8 dias), não por horas como a pesquisa assumiu, então cruza
muitas fronteiras de 8h. É literalmente o caso de alerta previsto nesta
seção ("se o funding passar de ~20% do custo de taxa, as posições estão
durando mais que o previsto"). Confirmar decompondo `calcTradeCost` por
operação no artifact antes de tratar como fato.

✅ **CONFIRMADA (2026-07-26)** pelo diagnóstico rodado no runner
([run 30210747843](https://github.com/mateusraony/Sentinel-Signals/actions/runs/30210747843)
e o de 12 meses): **funding é 57,9% do custo** (61,2% no recorte de 6 meses),
contra 35,1% de taxa e 7,0% de slippage — ou seja **1,65× o custo de taxa**, não
os 2,5-10% que a pesquisa desta seção assumiu. Errou por um fator de ~20. A
causa está na mesma tabela: **18,1 fronteiras de 8h atravessadas por operação**,
tempo médio em posição de **5,9 dias** (mediana 4,5, máximo 17,5). A pesquisa
raciocinou sobre "posições de horas"; esta cascata segura por dias.

**Consequência para o modelo de custo**: `fundingBpsPer8h: 1` é a taxa-base da
Binance, não o funding realizado de cada período — e num regime em que o funding
domina, essa aproximação passa a ser o maior termo de erro do modelo, não o
menor. Não muda nada hoje (a estratégia é negativa antes do custo), mas invalida
a justificativa "é 5% do custo, não vale pipeline" caso alguma configuração
sobreviva ao gate de amostra. Registrado em `docs/roadmap.md`, Bloco 3.

**Hipótese vizinha REFUTADA no mesmo diagnóstico**: a de que o prejuízo poderia
estar concentrado no Time Stop, caso em que a alavanca seria a regra de saída
por tempo. Não está — `CLOSED:TIME_STOP` é o balde mais bem comportado da
tabela, **positivo** nos dois recortes (11W/1L e 5W/0L, contribuição +0,041 e
+0,026). O prejuízo está em `STOP_HIT`, e a matemática por trás dele é
estrutural: 43,1% de acerto com payoff 1,08 quando 1,32 seria o empate.

### Ferramenta de diagnóstico (`src/lib/backtestAnalysis.js`)

A hipótese acima — e a pergunta maior, "de onde vem o −0,061 R?" — deixaram de
depender de análise manual. `npm run analyze-backtest -- --report <json>` lê um
relatório **já gerado** e o decompõe por motivo de saída, por símbolo, por
componente de custo (taxa/slippage/funding separados) e por tempo em posição.
O workflow `backtest.yml` publica a mesma saída no resumo do job, então o
diagnóstico não exige baixar o artifact.

**Não consome tentativa.** Não roda replay, não altera parâmetro, não escolhe
configuração — é leitura do que já foi medido. Essa é a diferença que importa
frente a varrer combinações de flags: são 4 flags opcionais (`retestEnabled`,
`displacementEnabled`, `smcTierEnabled`, `smcObFvgEnabled`), 16 combinações, e
cada uma corta a amostra por ser filtro. Com o `sd(R) ≈ 1,1` derivado do IC
medido neste run e ~55 operações após um filtro, o **máximo de 16 tentativas
totalmente inúteis ainda é esperado em torno de +0,2 R** — indistinguível de
uma descoberta real. Testar flags antes de saber onde está o problema é
comprar esse falso positivo.

Métrica central: **`contributionR` = `sumR` do balde ÷ operações com R do
conjunto TODO**. Os baldes somam **exatamente** a expectância geral
(propriedade testada), o que torna a decomposição aditiva em vez de uma
comparação de médias entre grupos de tamanhos diferentes — um balde de 3
operações com média −2 R chama atenção e contribui menos que um de 60 com
média −0,1 R.

A decomposição do custo usa três chamadas isoladas a `calcCostR` (só taxa, só
slippage, só funding) em vez de reimplementar a fórmula: o custo é linear em
cada termo de bps, então os componentes reconstroem o total exato e a
decomposição nunca pode divergir do custo que o relatório cobrou.
`resolveCostModel` passou a ser exportado de `tradeMetrics.js` pelo mesmo
motivo — a lógica de fallback vive num lugar só.

**O que o diagnóstico NÃO faz**: não valida nada. Um relatório inconclusivo
continua inconclusivo depois de decomposto, e o CLI reimprime o veredito no
fim justamente para uma tabela bem formatada não passar a sensação de que o
resultado virou decisão.

### Janela longa e estabilidade temporal (2026-07-26)

Avaliação de um documento externo de arquitetura quantitativa (27 seções,
propondo motor de dados versionado, feature store, motor de regimes, 5
estratégias novas, portfólio, paper/shadow, meta-modelo). Veredito registrado
porque a decisão de NÃO adotar a maior parte dele precisa de justificativa
rastreável — e porque três achados dele eram reais.

**Confirmado contra o código e corrigido**: os outcomes dos gates eram
acumulados em `Map` por `dedup_key` (`backtestEngine.js`), último-escreve-ganha.
Como o loop de retry recomputa cada gate do zero a cada passada dentro da janela
de 4h, N avaliações do mesmo sinal colapsavam em 1 — o relatório não distinguia
"1 sinal que tentou 5× e falhou" de "1 sinal que falhou 1×". Agora cada seção
carrega `attempts: {evaluations, retried, maxAttempts}` ao lado de `total`
(sinais únicos). O `Map` continua guardando o estado final, que é o correto para
as contagens de confirmado/pendente.

**Refutado contra o código**: a crítica de que o Time Stop contaria barras
compartilhadas entre timeframes. `scanner.js` já converte por
`SIGNAL_TF_MS[op.signal_timeframe]` e conta tempo decorrido real — 48 barras de
4h já valem 8 dias e 48 de 1h já valem 2 dias, por construção. Custos,
look-ahead e ambiguidade intrabar também já estavam resolvidos (Fases 5 e 1,
item 36).

**Fora de escopo por colisão com restrição permanente**: o documento assume
`usdm-futures` para sinal, backtest e execução, e pede funding/open
interest/basis/liquidações — todos bloqueados por 451 de datacenter US (item 4).
Paper trading, shadow mode, kill switch, reconciliação e circuit breakers
pressupõem processo persistente e ordens reais (sem Cloud Functions por decisão
permanente; trading real proibido por `.claude/rules/trading-safety.md`).

**A tensão que decidiu o escopo**: os critérios de aprovação do próprio
documento (300 operações, expectância ≥ +0,10 R, profit factor ≥ 1,20) reprovam
a estratégia atual (109, −0,103, 0,808) sem construir nada. E o motivo de haver
só 109 operações é a **janela de 12 meses**, não a estratégia. Daí a ordem
adotada: medir com amostra de verdade ANTES de construir aparato para medir.

**Mudanças desta rodada**:
- `backtest.yml` `timeout-minutes` 90 → 350 (o run de 12 meses gastou ~35 min;
  4 anos projeta ~2,3 h; teto do GitHub para repo público é 6 h).
- `backtestAnalysis.js` ganhou `byPeriod` (ano-trimestre do fechamento) e
  `positivePeriodsShare`. Única tabela do diagnóstico em ordem **cronológica**,
  não por contribuição: aqui a sequência é a informação. Responde ao veto
  "resultado não pode depender de uma janela curta" sem construir walk-forward.
- Trimestre e não mês de propósito: a 109 operações/ano, buckets mensais dariam
  ~9 operações cada — ruído puro.

**Ressalva ao ler um run longo**: ONDO (listada ~2024), ZRO (~2024) e PENDLE
(~2023) não existem no começo de uma janela de 4 anos, então o recorte pesa
BTC/ETH/FET/DYDX. O `bySymbol` do diagnóstico expõe isso, mas comparar um run de
4 anos com o de 12 meses como se fossem a mesma carteira seria erro de leitura.

### Replay superlinear — por que o run de 4 anos não terminou (2026-07-27)

O run de 4 anos × 7 símbolos
([30218382227](https://github.com/mateusraony/Sentinel-Signals/actions/runs/30218382227))
**não falhou: foi cancelado ao bater o `timeout-minutes: 350`**. Download 24,6
min (ok), replay 5h25min sem terminar. A projeção era 2,3 h — erro de ~5×, o
segundo erro grande de estimativa de tempo de replay nesta linha de trabalho.
Por isso o gargalo foi **medido**, não deduzido.

**Termo dominante: `fakeBackend.filter`** (`src/lib/__fixtures__/fakeBackend.js`)
materializa a coleção inteira (`[...store.values()]`), filtra e **ordena**, a
cada chamada. `scanner.js:1915` (e 1440, 2015) chamam isso por ativo a cada
passo do replay, sobre um store de `SignalEvent` que só cresce. Medição direta:

| Store de SignalEvent | custo por `filter()` |
|---|---|
| 1.000 | 0,39 ms |
| 5.000 | 1,68 ms |
| 20.000 | 6,72 ms |
| 50.000 | 17,04 ms |

Linear no tamanho do store × chamado a cada passo (cujo número também cresce
com a janela) = **quadrático no período**.

**Termo secundário, corrigido**: `sliceClosedAsOf` localizava o candle corrente
varrendo o array de trás para frente — ~137 mil iterações por chamada com 4
anos de 15m. Trocado por busca binária (o array já é ordenado por `closeTime`,
pré-condição que a versão linear também assumia). Benchmark: 5× mais rápido na
função. **Não era o termo dominante** — a cópia dos 500 candles do resultado
domina o custo restante — mas era defeito real e o teste de equivalência
exaustiva contra a implementação linear está em `backtestEngine.test.js`.

**O `fakeBackend` NÃO foi indexado, de propósito.** 12 meses × 20 símbolos cabe
no timeout, e esse fake é compartilhado com `scannerStateMachine.test.js` — a
suíte que protege a máquina de estados. Mexer nele para acelerar um run que já
cabe seria risco sem necessidade demonstrada. Quando uma janela longa voltar à
mesa, a correção é índice secundário por `asset_id` (campo de toda consulta
quente). Registrado em `docs/roadmap.md`, Bloco 0.

**Nota de produção**: nada disto afeta o app. `fakeBackend` só existe em teste e
backtest; em produção as mesmas consultas vão para o Firestore, que é indexado.

## 45. Auditoria do funil SMC e da composição do score (2026-07-28)

Auditoria em resposta a um documento externo de reestruturação. Registra seis
achados **verificados no código**, separados das alegações do documento que não
pude verificar. O documento em si tinha erro de premissa relevante (descreve o
projeto como Python; é JavaScript) e ~60% de sobreposição com o que já existe.

### 45.1 Medição: 75 eventos de estrutura → 0 operações

Run [29883950343](https://github.com/mateusraony/Sentinel-Signals/actions/runs/29883950343)
(2025-01-01 → 2026-07-22): `structureEventsTotal: 75, confirmedSignals: 75,
rejectedByOteZone: 0, tradeOpsCreated: 0`. A cascata SMC é, na prática, **código
morto em produção** — não por estar desligada, mas por não conseguir confirmar.

### 45.2 Hipótese de causa: tensão geométrica entre gatilho e zona

`check5mSmcConfirmation` (`scanner.js:374-408`) exige, **no mesmo candle de 5m**:

1. um **gatilho** — sweep ou BOS/CHoCH (`swingLen=10`) disparando exatamente na
   última barra fechada daquela passada (evento pontual, não estado);
2. uma **zona favorável** — o close dessa mesma barra em retração de **≥45%** da
   perna 1h (`buildOteLeg` + `classifyZone`, banda de equilíbrio de 5% do range),
   e sem ter rompido o pivô protegido do outro lado.

A perna é **fixa** no instante da emissão: para BUY, `legHigh` = o close do
rompimento de 1h, `legLow` = `lastSwingLow` de 1h (`smcStructure.js:277-282`).
Ela não acompanha o 5m.

**O que é fato:** na **1ª passada**, o close de 5m é praticamente o próprio close
do rompimento de 1h — retração ≈ 0% ⟹ `premium` ⟹ BUY rejeita. Aí a rejeição é
quase certa por construção, e isso é a tautologia dos itens 35/38 atenuada (o
item 38 tirou o caso extremo do viés 1h, mas `legHigh` continua sendo o close do
próprio rompimento).

**O que NÃO é fato — correção de uma afirmação forte demais** (revisão externa do
PR #94): uma versão anterior deste item dizia que as duas condições "se anulam por
construção". **Não se anulam.** Um BOS/CHoCH de 5m só significa que o close
cruzou um **pivô local de 5m** (`swingLen=10`, ~50 min) — não que o close esteja
perto do `legHigh` de 1h. Ao longo da janela de retry (4h), o preço pode recuar
50-60% da perna e ali produzir um BOS de alta local **estando em `discount`**, que
é exatamente a zona que BUY aceita. O correto é dizer que as duas condições são
**negativamente correlacionadas**, não mutuamente exclusivas: o gatilho empurra o
close na direção que a zona penaliza, mas o limiar do gatilho é local e o da zona
é fixo em 1h — não há impossibilidade geométrica.

Consequência metodológica: os 75 → 0 do 45.1 são **medição**; este mecanismo é
**hipótese**. Distinguir "gatilho nunca dispara no retry" de "dispara e a zona
rejeita" exige a instrumentação do 45.3 (hoje o retry faz `continue` mudo) — não
se resolve por argumento geométrico.

### 45.3 `rejectedByOteZone` é cego (mede 0 com 75 eventos perdidos)

Só amostra a **1ª passada**; o loop de retry (`scanner.js:2068`) faz `continue`
sem empurrar nada em `smc5mZoneRejections`. E na 1ª passada a rejeição por zona é
quase certa (no instante do rompimento a retração é ~0% ⟹ premium), então o
contador mede justamente o caso menos informativo. O relatório é cego onde o
funil aperta.

Agravante: `no_trigger` (`scanner.js:366`) colapsa três causas distintas — sem
gatilho, histórico 5m < 60 candles, e exceção no fetch. Num replay longo, falha
de dado é indistinguível de ausência de sinal.

### 45.4 Expiração silenciosa na cascata SMC

Um `SignalEvent` SMC deixa de ser re-tentado ao completar 4h (`scanner.js:2022`)
— sem transição, sem log, sem contador. Um sinal que tentou ~48 vezes e falhou é
indistinguível de um nunca tentado. A cascata RF tem `promotion_status: EXPIRED`
com log; a SMC não tem equivalente.

### 45.5 Defeito latente: `smc_confirm_4h15m` usa o gate de zona ANTIGO

`scanner.js:1551-1565` ainda calcula `zoneOk` com `calculatePdZone` sobre o mesmo
`closedCandles` de `calculateStructure` — **exatamente o mecanismo que o item 35
provou tautológico e que o item 38 removeu do viés 1h**. A migração do item 38 não
alcançou este gate. Se `smc_confirm_4h15m` estiver ligado em algum ativo, está
estrangulando a cascata RF por um caminho já comprovadamente defeituoso.
Flag off por padrão — por isso é latente, não ativo.

### 45.6 Única assimetria BUY/SELL real do motor

`smcStructure.js:88` (`let trend = 1;`) semeia a estrutura como **altista** no
início de cada janela, e `calculateStructure` é path-dependent sem estado entre
scans. Enquanto nenhum CHoCH ocorrer na janela, um rompimento de alta é rotulado
**BOS** e um de baixa **CHoCH** — e `structure_type` alimenta `chochBonus` em
`smcConfluence.js`. Isso é diferença de score entre BUY e SELL.

Pode ser fidelidade ao `var trend = 1` do Pine; é assimetria de fato de qualquer
modo. **No resto, BUY e SELL são espelhos exatos** — verificado em `rangeFilter.js`,
`confluence.js`, `opExitRules.js` e nos pontos de saída de `scanner.js`. A tabela
de tier não tem dimensão de lado, e `evaluateRegime` não consulta `side`.

### 45.7 A redundância do score é maior do que "componentes correlacionados"

`calculateSignalStrength` (`confluence.js:98-156`) soma follow-through 25, MACD
20, EMA 20, RSI 15, volume 10, preço-vs-RF 10 = 100. **Sem teto por família e sem
tratamento de redundância.** E:

- **`followThrough` (25) e `preço vs Range Filter` (10) são a MESMA condição.**
  No caminho sem `confirmed` (`confluence.js:110`), `followThrough` é literalmente
  `isBuy ? direction === 1 : direction === -1` — byte-idêntico à condição dos 10
  pontos (`:136-137`). No caminho com `confirmed`, a de 25 **contém** a de 10.
  São **35 pontos de uma variável booleana** — a mesma que gerou o sinal.
- MACD (20) e EMA (20) derivam ambos de cruzamento de EMAs.
- Consequência: com `minScore=75`, um sinal passa com RF(35) + EMA(20) + MACD(20)
  = **duas famílias de informação**, uma delas tautológica em relação à emissão.

Isso explica por que score 75, 80 e 100 tiveram desempenho parecido: acima de um
certo ponto o score mede a mesma coisa várias vezes.

### 45.8 Eixos de verificação adicionados (esta rodada)

`backtestAnalysis.js` ganhou `bySide`, `byTier`, `bySideTier` e
`byArbitrationWarning`, mesma propriedade aditiva dos eixos existentes. Servem
para verificar as três afirmações empíricas do documento externo — que vêm do
artifact e **não puderam ser confirmadas** nesta sessão (blob storage bloqueado).

**Armadilha codificada explicitamente**: operação da cascata SMC não recebe
`tier` quando `smcTierEnabled` está desligado (`scanner.js:634`, o default), e
`tier_time_stop_bars` cai no literal `96` — o mesmo valor de T3 sem ser T3
(`scanner.js:637`). `tierKey` devolve `SEM_TIER` nesses casos e o CLI avisa.
Inferir tier daí produziria uma tabela de aparência completa e errada.

**Critério declarado ANTES de olhar o resultado**: `bySideTier` cria 6 baldes
sobre a mesma janela; escolher o pior e removê-lo melhora o resultado in-sample
por construção. Pela conta do documento, BUY T3 seria −0,414 R sobre ~159
operações = **4,6 erros-padrão**, o que sobrevive à correção de Bonferroni para
6 comparações (limiar 2,64). Se a medição confirmar essa ordem de grandeza, é
efeito real; se vier em 1-2 σ, é seleção e deve ser descartado.

### 45.9 RESULTADO da verificação (2026-07-29) — 1 passa, 2 reprovam

Diagnóstico rodado sobre o artifact do run 30278687522 (344 operações,
2025-07-27 → 2026-07-27). Os três números do documento externo bateram **até a
terceira casa** — quem o escreveu rodou esta mesma análise. O que não sobrevive
é a interpretação. σ medidos com o desvio-padrão REAL de cada balde, não com o
1,13 assumido no critério:

| Afirmação | Medido | σ | Veredito (limiar 2,64) |
|---|---|---|---|
| BUY Tier 3 = −0,414 R | −0,414 (N=159, sd 0,976) | **−5,35** | passa |
| SELL isolado positivo | +0,199 (N=166, sd 1,184) | **+2,17** | **reprova** |
| `correction_warning` = −0,709 R | −0,709 (N=82, sd 0,753) | −8,52 | passa, mas inutilizável |

**Por que o `correction_warning` é inutilizável como filtro**: o aviso chega
**depois** da entrada em **82 de 82** casos (mediana 64 h, máximo 420 h). Filtrar
por ele é selecionar operações com informação que não existia no momento de
decidir. Pior, a causalidade é provavelmente invertida — o aviso dispara quando a
cascata de 1h emite sinal contrário, o que acontece quando o preço anda contra a
posição: 92,7% das avisadas terminaram em stop contra 81,7% das não avisadas. É
indicador **coincidente de operação perdendo**, não preditor. Hoje ele só reduz
`current_confidence_score` (`signalArbitration.js:137`) e não existe flag para
fechar nele (`arbInvalidateOnOppositeMajor` só vale para `critical_opposite`).

**Por que "BUY Tier 3" é o rótulo errado para um achado real**: T3 é **87,5%** da
amostra (301/344) e **89,3%** de todos os BUY; só 19 operações BUY não são T3. O
eixo tier não separa nada dentro de BUY. O achado robusto é mais simples —
**BUY −0,332 R (t=−4,32) × SELL +0,199 R (t=+2,17)** — e apontar para tier
mandaria mexer na alavanca errada.

**E a causa dessa assimetria é regime, não defeito** — ver item 46.1.

## 46. Geometria de saída: o runner do TP1 (2026-07-29)

Primeira rodada a mexer na saída, e não na entrada. As Fases 2-4 construíram
quatro filtros de ENTRADA; o déficit medido sempre foi de **payoff**. Este item
registra o que a medição mostrou e o que foi (e não foi) mudado.

### 46.1 A janela medida foi um bear market profundo — e isso muda a leitura

Reconstruído a partir dos preços de entrada das próprias 344 operações (não é
dado externo: `entry_price` ordenado por data desenha o caminho do ativo):

| Ativo | início | fim | variação |
|---|---|---|---|
| BTCUSDT | 118.257 | 74.418 | **−37,1%** |
| ETHUSDT | 3.649 | 1.735 | **−52,5%** |
| SOLUSDT | 185,55 | 72,07 | **−61,2%** |
| PAXGUSDT (ouro) | 3.720 | 4.078 | +9,6% |

PAXG foi o **melhor** ativo da carteira (+0,490 R) e é o único que subiu. O
motor emitiu ~50% de compras em todos os trimestres, sem nunca "perceber" a
queda.

**Consequência**: a assimetria BUY × SELL do item 45.9 é explicada pelo regime
sem precisar de defeito no motor. E **desqualifica a proposta de desligar as
compras**: seria calibrar um sistema só-vendido ao único regime em que se mediu,
o mesmo erro metodológico que o roadmap proíbe. Leitura desconfortável que vem
junto: mesmo vendendo num mercado que caiu 37-61% — a condição mais favorável
possível — o acerto foi 54% e a expectância +0,199 R.

**O que separa "tem vantagem" de "seguiu o mercado"** é rodar a MESMA carteira
numa janela de alta. Isso virou o Bloco 0 do `docs/roadmap.md`, e não exige
código nenhum: só outras duas datas no `workflow_dispatch`.

### 46.2 O runner perde dinheiro — medido, não hipótese

Contrafactual limpo: para toda operação que **comprovadamente** atingiu o TP1
(`tp1_hit` é fato observado, o TP1 é nível conhecido na entrada), qual seria o R
fechando 100% ali. É contrafactual de **gestão**, nunca de preço — sem
look-ahead.

| | valor |
|---|---|
| expectância BRUTA atual (com runner) | −0,031 R |
| expectância BRUTA fechando 100% no TP1 | **+0,009 R** |
| custo do runner | **−0,040 R/op · −13,9 R no total** |
| das 121 que atingiram TP1, fechar ali seria melhor em | **95** (pior em 26) |
| vendas que bateram TP1 e não chegaram ao TP2 | **59 — as 59 terminaram em stop** |

O último número é o mais forte: o bear market era a condição mais favorável
possível para um runner vendido, e nenhum dos 59 sobreviveu.

**Bruto contra bruto é a única comparação honesta.** Na primeira passada desta
análise comparei o líquido atual contra o bruto do contrafactual, o que inflou o
ganho de +0,040 para +0,061 R — o custo (~0,045 R) aparecia de um lado só. Fica
registrado porque é um erro fácil de repetir, e `analyzeOps` agora passa
`ZERO_COST` explicitamente nos dois lados para torná-lo impossível.

**O que isto NÃO resolve**: mesmo eliminando o runner por inteiro, o bruto vai a
+0,009 R e o custo medido é 0,045 R/op. A estratégia continua negativa. Isto é
remoção de um defeito medido, **não** uma correção que a torna lucrativa.

### 46.3 Implementação — `runnerEnabled`, LIGADO por padrão

`pineConfig.runnerEnabled` (3 arquivos espelhados). **Default `true` = o
comportamento de sempre.** Não virou default porque a medição é de UM regime, o
que é exatamente a crítica feita à proposta de desligar as compras — aplicá-la a
si mesmo é o mínimo.

Com `false`, o TP1 vira saída **terminal**: `status: CLOSED`,
`closed_reason: 'TP1_FULL'`, `exit_price: op.tp1`. Reusa `CLOSED` (já terminal)
em vez de criar status novo, então o `clearActiveOp` **dentro da mesma
transação** libera o ativo de graça, e `.claude/rules/trading-engine.md`
continua com dois — e só dois — caminhos de mutação.

**A decisão é congelada NA CRIAÇÃO, não lida na saída.** `buildTradeOpData`/
`buildSmcTradeOpData` gravam `partial_percent: 100` quando o flag está off, e os
dois loops decidem via `closesFullyAtTp1(op)` (`opExitRules.js`), lendo só a
operação. Três motivos: `priceCheckActiveOpsInner` não tem `pineConfig` em
escopo (carregá-lo poria uma leitura do Firestore no caminho rápido de
segurança); virar o flag não pode abandonar um runner já vivo; e a operação
passa a se autodescrever para auditoria.

`closesFullyAtTp1` lê `partial_percent` — a **mesma** fonte única que
`getWeights` (`tradeMetrics.js`) usa para pesar as pernas. Isso é load-bearing:
se o motor fechasse tudo no TP1 enquanto as métricas ainda pesassem 50% de
runner, o R reportado descreveria uma posição que nunca existiu. Há teste
varrendo os casos de fronteira contra `getWeights().runner <= 0`.

**Bug latente fechado de graça**: `tp1QtyPercent: 100` já produzia
`runner_percent: 0` e mesmo assim mandava a op para `RUNNER_ACTIVE` — ativo
bloqueado por dias segurando 0% de posição.

### 46.4 Como medir e como comparar

- **Sem rodar backtest**: `npm run analyze-backtest -- --report <arquivo>` agora
  imprime a seção "O RUNNER PAGOU?" em QUALQUER relatório, inclusive nos já
  existentes. É a mesma conta desta seção, reproduzível.
- **Comparando dois runs**: `report.runner` registra a gestão que de fato foi
  aplicada (inferida das operações, não do config) — impede comparar dois
  relatórios sem perceber que a saída mudou entre eles.
- **Para testar o flag**: `runnerEnabled: false` via `--pine-config`, mesma
  janela. A expectância líquida deve subir ~0,040 R e continuar negativa; muito
  mais que isso indica erro no gate.

### 46.5 Ativação manual pelo painel — corrigida (Codex, PR #95)

O botão "Ativar agora" (`AssetCard.jsx`) criava a operação com
`TradeOperation.create` **cru**. A revisão externa apontou o sintoma menor
(`partial_percent: 50` fixo, ignorando `runnerEnabled`); a verificação no código
mostrou dois defeitos maiores no mesmo caminho:

1. **Sem `initial_stop`, `current_stop`, `tp1`, `tp2`.** Nenhum dos dois loops de
   saída tinha o que comparar — a operação ficava em `SIGNAL_CONFIRMED` para
   sempre, sem stop e sem alvo. Corrigir só o `partial_percent` seria cosmético:
   ela nunca chegaria ao TP1 porque não tinha TP1.
2. **Sem passar por `createTradeOpIfNoneActive`**, então `assetActiveOps`
   continuava vazio e o scanner abria a operação DELE para o mesmo ativo. Duas
   ativas no mesmo ativo é exatamente o que a guarda do item 39.1 detecta — e a
   reação dela é **suspender toda a gestão de stop/TP daquele ativo** até
   resolução manual. Era um caminho para travar um ativo com dois cliques.

**Correção**: `activateSignalManually` (`scanner.js`), chamada pelo componente.
Reusa `scanAsset` para obter ATR/tier do 4h (em vez de recalcular e arriscar
divergir do scanner) e `buildTradeOpData` para o resto — a MESMA função da
cascata RF, então a operação manual nasce com a mesma forma e a mesma gestão de
uma automática, incluindo `runnerEnabled`. Cria pelo caminho transacional único.

Decisões explícitas dentro dela:

- **Entrada pelo preço ATUAL**, não pelo `price_at_signal`: um sinal pode ter
  horas de idade, e registrar o preço antigo falsificaria o R desde o começo.
- **`entry_candle_time_15m` = instante do clique**, o que faz a guarda temporal
  P0-g rejeitar toda vela já em andamento — nenhum candle anterior à entrada
  pode disparar stop/TP.
- **Gestão pela cascata RF 4h** (stop ATR×tier do 4h, trailing 4h, Time Stop em
  barras de 4h) qualquer que seja o sinal que motivou o clique. É a única gestão
  que o motor sabe aplicar a partir de um clique, e o `window.confirm` do botão
  diz isso antes de criar. `cascade` permanece `4h_15m` (o enum não ganhou valor
  novo); o que distingue a origem é `source: 'manual'`.
- **Falha fechado** sem ATR do 4h ou sem preço — nunca cria operação sem stop,
  que é o defeito que a função existe para eliminar.

Não fecha o `partial_percent` do webhook (`server/`), que não cria operação.

## 47. Filtro de origem do sinal nas notificações Telegram (2026-07-29)

Usuário relatou notificações indesejadas de MACD/RSI vindas do canal 24h (o
robô automático via GitHub Actions, não o "ao vivo" do navegador — confirmado
explicitamente antes de desenhar a correção). Não existia nenhum eixo de
filtro por **origem do sinal** (`SignalEvent.source`: `range_filter`,
`smc_structure`, `macd`, `ema_cross`, `rsi`) em lugar nenhum, e o canal 24h em
particular (`scripts/adminTelegram.js`) não tinha nenhuma forma de enxergar
preferência nenhuma do usuário — token/chat_id vêm de secret fixo do GitHub,
sem doc de config compartilhado, ao contrário do `pineConfig`.

**Verificado, não precisou de código**: o usuário também queria configurar o
RSI 70/30. Já existe — `rsi_overbought`/`rsi_oversold` são campos por-ativo
(`AssetConfigPanel.jsx:126-130`, validados em `assetConfigValidation.js`).

**Correção**: novo doc Firestore compartilhado `telegramFilters/current`,
replicando **exatamente** o padrão já usado para `strategyConfig/current`
(escrito pelo navegador, lido pelo cron) — não é mecanismo novo. Shape mínimo:
`{ sources: string[] }`. Default = todas as 5 origens (comportamento atual,
sem migração destrutiva).

- `src/lib/telegram.js`: `DEFAULT_FILTERS.sources`; `setTelegramFilters`
  passa a também escrever no Firestore (localStorage continua a fonte para o
  canal ao vivo); `shouldSend` ganha o check, **restrito ao evento
  `signal_detected`** — os demais eventos carregam uma `TradeOperation`, cujo
  `source` é um enum não relacionado (`scanner`/`scanner_smc`/
  `tradingview_webhook`/`manual`); sem esse guard o filtro colidiria e
  derrubaria silenciosamente toda notificação de entrada/TP/stop.
- `scripts/adminTelegram.js`: lê o doc via `firebase-admin/firestore` direto
  (mesmo padrão de `adminPineConfig.js`), memoizado por processo (uma leitura
  por execução do `npm run scan`, nunca desatualiza dentro de uma execução
  curta). Falha ao ler = **fail-open para todas as origens** — nunca
  silenciar o canal "não perder nada" por erro transitório.
- **Bug pego pelos próprios testes durante a implementação**: a primeira
  versão filtrava qualquer `source` fora da lista de 5 conhecidos, o que
  quebrava o fallback pré-existente de rótulo genérico para origem
  desconhecida/futura — um `source` novo (ainda sem toggle na UI) seria
  descartado silenciosamente em vez de notificado sem filtro, como sempre foi.
  Corrigido: o filtro só se aplica a origens **conhecidas**
  (`KNOWN_SOURCES`); origem fora dessa lista sempre passa.
- `TelegramSettings.jsx`: seção "🔍 ORIGEM DO SINAL", mesmo componente
  `MultiToggle` já usado para `SIGNAL_TYPES`.

**Fora de escopo, decisão explícita**: os demais filtros já existentes
(timeframe/lado/prioridade/score/eventos) continuam browser-only — o canal
24h segue "não perder nada" nesses eixos; limiar de força do cruzamento de
MACD, não pedido com clareza suficiente.

> **Atualização (2026-08-02) — deploy confirmado.** Usuário colou o
> conteúdo da aba "Regras" do console do Firebase (a versão REALMENTE
> publicada). Comparado linha a linha contra `firestore.rules` do repo:
> **idêntico, byte a byte** — inclui o bloco `telegramFilters`, sem
> nenhum `if true` sobrando. O deploy manual já tinha sido feito; nada
> pendente nesta frente.

### 47.1 Override por ativo (2026-07-29)

Depois do filtro global, o usuário esclareceu o pedido real: granularidade
**por ativo**, não só global — ex. "MACD do BTC sim, do ETH não". No mesmo
turno também pediu (e foi corrigido sobre) dois pontos factuais antes de
qualquer código:

- **MACD não tem escala 0–100.** O usuário usou "70/30" para os dois
  indicadores, mas isso só existe pro RSI (`SignalEvent.source: 'rsi'`); MACD
  neste projeto é cruzamento de linha/sinal (`macdLine`/`signalLine`/`cross`),
  sem limiar comparável. Esclarecido antes de desenhar — não construído nada
  em cima da confusão.
- **Timeframes 15m/1W/1M não existem como alvo de scan.** `TIMEFRAMES =
  ['1h','4h','1d']` em `scanner.js`; 15m/5m só existem como candle de
  *confirmação* das cascatas RF/SMC, nunca como timeframe de sinal
  independente. Estender isso é uma capacidade nova (mais chamadas à API da
  Binance, provavelmente **mais** notificação, não menos) — escopo separado,
  maior e mais arriscado, explicitamente fora desta rodada (confirmado com o
  usuário via pergunta direta antes de implementar).

**Decomposição do pedido em cima do que já existe** — via `AskUserQuestion`,
usuário confirmou "Sim, seguir assim": granularidade por **ativo**, por
**direção** (= `signal_type` BUY/SELL, campo que todo sinal já carrega — não é
conceito novo) e por **origem**, restrito aos timeframes existentes (1h/4h/1d).

**Implementação — reaproveita o mecanismo do item 47, não cria um novo**:

- `MonitoredAsset.notify_sources` / `MonitoredAsset.notify_signal_types`
  (`docs/schema-reference/MonitoredAsset.jsonc`) — arrays opcionais.
  **Semântica de substituição total, não merge/interseção** — mesma
  convenção já usada por `rsi_overbought`/`rsi_oversold`: quando presente,
  o override do ativo vale sozinho; ausente/`null` = herda 100% do filtro
  global `telegramFilters/current`. Um array vazio (`[]`) é um estado válido
  de propósito — silencia o ativo por completo ("nada do ETH agora").
- `shouldSend(event, data, asset)` (`src/lib/telegram.js` e
  `scripts/adminTelegram.js`) ganha o terceiro parâmetro opcional; o override
  do ativo tem precedência total sobre o filtro global quando presente, nos
  dois eixos, **restrito ao mesmo guard de evento do item 47**
  (`event === 'signal_detected'`) — o override nunca vaza para notificação de
  entrada/TP/stop, que carrega `TradeOperation` (vocabulário de `source`
  diferente e não relacionado).
- **Zero leitura extra no Firestore**: `scanner.js` já tem `asset`
  (`MonitoredAsset`) em escopo no loop de scan (usado ali mesmo para
  `alert_cooldown_minutes`) — passar o mesmo objeto pro
  `notifyNewSignal(signal, asset)` não custa nada. Em
  `scripts/adminTelegram.js`, quando o override do ativo sozinho já decide o
  resultado, `loadTelegramSources()` (a leitura memoizada do Firestore) nem
  chega a ser chamada.
- UI: nova seção "Notificações deste ativo" em `AssetConfigPanel.jsx`, reusa o
  `MultiToggle` (agora extraído para `src/components/ui/multi-toggle.jsx`,
  compartilhado com `TelegramSettings.jsx` em vez de duplicado).

**Testes**: `src/lib/telegram.test.js` e `scripts/adminTelegram.test.js`
(novo arquivo) cobrem, em espelho: override substitui (não combina) o filtro
global nos dois eixos; override pode LIBERAR uma origem/lado que o global
bloqueia (não só restringir); array vazio silencia por completo; sem `asset`
(ou sem os campos) continua herdando 100% do global — regressão; override não
vaza para eventos de operação; e no lado admin, que o override sozinho evita
a leitura do Firestore. `scannerStateMachine.test.js` ganhou uma asserção
(`toHaveBeenCalledWith`) confirmando que `persistScanResults` de fato repassa
o `asset` para `notifyNewSignal`.

**Fora de escopo, mesma decisão do item 47**: os demais eixos
(prioridade/score) continuam globais; 15m/1W/1M como timeframe de sinal
independente; limiar configurável de força do cruzamento MACD.

## 47.2. Avaliação de proposta externa de reforma do motor + PR-1 (2026-07-29)

O usuário colou uma proposta técnica externa de 20 seções (gestão de
TP1/runner, fonte de dados Futures, warm-up, funding, preço de execução,
resolução de stop/TP, honestidade do R:R, quarentena SMC, redundância do
score, tier vs. regime, contexto macro, `correction_warning`, MFE/MAE,
concentração de resultado, protocolo de experimentos) e pediu avaliação com
pesquisa antes de decidir. Rodei 3 agentes Explore em paralelo pra verificar
CADA afirmação contra o código real (arquivo:linha) em vez de aceitar a
proposta como fato — plano completo em
`/root/.claude/plans/veja-se-o-relat-rio-wild-hickey.md` (histórico de
sessão). Veredito condensado, e o que este PR (PR-1: telemetria e dados
limpos, **zero mudança de geração de sinal**) implementou:

### Já implementado, não refeito
`runnerEnabled`/`closesFullyAtTp1` (item 46) já resolvia a gestão do TP1; o
gate de amostra/IC95%/`conclusive` (item 44) já existia; `bySymbol` (aditivo)
já existia em `backtestAnalysis.js`; `smc_enabled`/`smc_confirm_4h15m` já são
`default: false` — a "quarentena SMC" pedida já é o comportamento estrutural
padrão. `passesRiskReward` (`opExitRules.js`) já documenta a própria
tautologia em comentário e grava `rr_gate_mode: 'CONFIGURED_MULTIPLE'` na op;
não achei nenhuma tela mostrando esse número como se fosse estrutural (o
widget "Risk/Reward" do dashboard mede outra coisa — `avgWin/avgLoss`
REALIZADO — e está correto).

### Conflita com decisão já pesquisada — não implementado sem validar a premissa
A proposta pedia trocar a fonte de dados do backtest pra Binance Futures
(candles+funding+taxa todos Futures, hoje é Spot). `CLAUDE.md` item 4 já
documenta que o bloqueio 451 da Futures API bloqueia qualquer IP de
datacenter dos EUA — a pesquisa desta rodada confirmou que isso vale
IGUALMENTE pro `backtest.yml` (mesmo `ubuntu-latest` do `scan.yml`,
`scripts/fetch-backtest-data.mjs` já hardcoda Spot,
`scripts/backtestMarketDataProvider.js` já documenta em comentário que
espelha o Spot do cron de propósito). A premissa da proposta (bastaria trocar
a fonte) está incorreta como descrita. Achado novo, NÃO testado: o endpoint
estático de histórico em lote `data.binance.vision` (diferente da API de
trading ao vivo `fapi.binance.com`) pode ou não escapar do bloqueio por IP —
ninguém verificou. Tentei um spike descartável (workflow temporário
`workflow_dispatch` fazendo um `curl -I` nesse endpoint a partir do runner do
GitHub) mas **não consegui disparar via API** — o token desta sessão não tem
permissão de `workflow_dispatch` (`403 Resource not accessible by
integration`). Removido do repo sem rodar. Se o usuário quiser testar: um
`curl -I "https://data.binance.vision/data/futures/um/monthly/klines/BTCUSDT/1h/BTCUSDT-1h-2024-01.zip"`
rodado de dentro de um job do GitHub Actions (não da sessão do Claude Code —
essa rede bloqueia Binance por completo) responde o HTTP status; 200 =
endpoint acessível (spike vira PR de verdade), 403/451/timeout = decisão do
item 4 permanece como está.

### Gaps reais, alto risco/blast radius — NÃO entram neste PR
Resolução de stop/TP no candle de SINAL (4h/1h) em vez do candle de EXECUÇÃO
(15m/5m) — toca os invariantes P0-c/P0-d/P0-g; entrada causal 15m ("Fresh RF
Flip"): o código mostra que o alinhamento simples é **decisão deliberada**
(`scanner.js`, comentário: "requiring a fresh signal would block valid
entries"), não omissão — precisa do mesmo tratamento de qualquer gate novo
(flag off + A/B de backtest); tier (volatilidade) vs. regime (permissão de
entrada) conflados na mesma tabela — redesenho de risco, não telemetria;
`correction_warning` como saída causal — exige que o motor de backtest saiba
simular "fechar no próximo preço executável", escopo de feature nova; Score
V2 — a redundância follow-through/preço-vs-RF já estava documentada
(item 2820-2824 desta mesma tabela), fica pra depois de MFE/MAE existir
(dado que faltava pro "feature ablation" que a proposta pede). Runner default
`true→false` + Shadow Runner: decisão tomada (ver abaixo), mas isso muda
comportamento de operação real — fica pra um PR-2 dedicado, não entra aqui.

### Gaps reais fechados neste PR (aditivos, zero mudança de sinal)
- **MFE/MAE por operação** (`mfe_r`/`mae_r`/`bars_to_mfe`/`bars_to_mae`,
  `docs/schema-reference/TradeOperation.jsonc`). Rastreado incrementalmente
  em `persistScanResults` (candle-based loop, `scanner.js`) a partir do
  high/low do candle de gerenciamento — recomputado a cada passada mas
  ESTÁVEL dentro do mesmo candle (só muda quando um candle NOVO chega), então
  só gera escrita no mesmo ritmo que o resto do loop já grava, não um novo
  spam por-passada. Gated pelo mesmo guard `candleUsable` do P0-c/P0-g — um
  candle pré-entrada nunca conta. **Deliberadamente NÃO** rastreado em
  `priceCheckActiveOpsInner` (o loop de preço em tempo real) — ali o preço
  muda a cada 5min de verdade, então a mesma lógica viraria fonte de escrita
  quase contínua; resolução de candle, não de tick, é a troca consciente.
  `bars_to_tp1`/`bars_to_stop` usam o mesmo proxy de tempo decorrido que o
  Time Stop já usa (`barsOpen`), reaproveitado (`barsSinceEntry`), não um
  contador novo. Simplificação deliberada da proposta original:
  `mfe_before_mae_r`/`mae_before_mfe_r` não foram implementados —
  `bars_to_mfe`/`bars_to_mae` já respondem a mesma pergunta de ordem sem
  precisar de dois campos derivados a mais.
- **Funding ponderado pela fração pós-TP1** (`tradeMetrics.js`,
  `countFundingSettlementsByLeg`). Antes, `calcTradeCost` cobrava TODA
  fronteira de 8h atravessada ao notional CHEIO de entrada, mesmo depois do
  TP1 reduzir a posição ao `runner_percent` — diferente de fee/slippage, que
  já eram ponderados por perna via `getWeights`. Agora fronteiras
  pré-TP1 cobram 100%, pós-TP1 cobram só a fração do runner. Sem TP1, o
  comportamento é idêntico ao de antes (regressão coberta em teste).
- **Warm-up do backtest** (`runBacktest`, `backtestEngine.js`): novos
  parâmetros opcionais `evaluationFromMs`/`evaluationToMs` (retrocompat total
  — omitidos, comportamento idêntico a antes). `fromMs`/`toMs` continuam
  sendo a janela de DADOS (o relógio simulado corre por ela inteira, pros
  indicadores convergirem); a janela AVALIADA passa a poder ser um
  subconjunto — operações abertas fora dela são criadas mecanicamente (o
  replay não muda) mas excluídas do relatório. CLI:
  `--evaluation-from`/`--evaluation-to` em `run-backtest.mjs`. O relatório
  ganha `dataRangeMs` (a janela de dados completa) quando os dois divergem.
- **Expiração/rejeição silenciosa de sinal** (`scanner.js`, ambas as
  cascatas). Antes, um `SignalEvent` que nunca confirmava entrada dentro da
  janela de retry (4h pra RF, 4×1h pra SMC) expirava mudo — sem
  `TradeOperation`, sem `SystemLog`, indistinguível de um sinal que nunca foi
  tentado (known-risks item 45.4 só documentava o lado SMC; o lado RF tinha
  o mesmo problema). Novo campo `SignalEvent.expired_logged` (booleano,
  `docs/schema-reference/SignalEvent.jsonc`) — gravado uma única vez, lido do
  MESMO objeto que o retry loop já busca a cada passada (zero leitura extra
  no Firestore), evitando o custo de `SystemLog.createUnique` (que exigiria
  uma leitura por passada por sinal parado, incompatível com a disciplina de
  quota de `.claude/rules/firestore-concurrency.md`).
- **Bug do contexto macro morto**: `analyzeAlignment` já calculava
  `tf_1d/4h/1h_direction` e gravava em `SignalEvent.context`, mas
  `buildTradeOpData`/`buildSmcTradeOpData` nunca copiavam isso pra
  `TradeOperation` — `TradeCard.jsx` já lê `op.tf_1d_direction` etc. e sempre
  recebia `null` numa operação ativa. Corrigido nos dois `buildXTradeOpData`;
  a cascata SMC também passou a gravar os mesmos 3 campos no `context` do seu
  próprio `SignalEvent` (antes só a cascata RF gravava).
- **Concentração de resultado** (`backtestAnalysis.js`, seção
  `concentration`): contribuição dos 5/10 melhores trades (por R, não por
  ordem cronológica) e maior contribuição por símbolo/trimestre/lado —
  mesmo padrão aditivo de `bySymbol`/`runner`. O motor não deve ser aprovado
  só porque poucas operações excepcionais compensaram o resto.
- **Reprodutibilidade do relatório** (`run-backtest.mjs`): novo bloco
  `reproducibility` — `commitSha` (`git rev-parse HEAD`, `null` se
  indisponível, nunca bloqueia o run), `configHash` (hash do `pineConfig`
  EFETIVO já mesclado com `--pine-config`, não só o caminho do arquivo),
  `runStartedAt`, `pineConfig` completo. `docs/experiments/registry.json`
  (array vazio versionado) — convenção documentada em
  `docs/claude/backtest-usage.md` pra rodadas que decidem algo virarem uma
  entrada (hipótese, baseline×teste, janela dev×holdout, critério de
  aceite, status) em vez de só prosa espalhada.

### Skill externa avaliada (`multica-ai/andrej-karpathy-skills`)
Pesquisada via `WebFetch`: guia genérico de disciplina de código pra LLMs
(pensar antes de codar, simplicidade, mudança cirúrgica), sem nenhuma relação
com trading/backtest/ML. Sobrepõe quase 1:1 com
`.claude/rules/operating-principles.md` já existente (mais específico ao
domínio). **Não instalada** — redundante.

### Verificação
`npm run lint && npm test` (692 passando, incluindo os novos testes desta
rodada) `&& npm run build && npm run build:scan && npm run build:backtest`.
Smoke test manual do CLI (`node scripts/dist/run-backtest.mjs` contra candles
sintéticos locais, sem rede): `reproducibility`/`dataRangeMs`/janela avaliada
via `--evaluation-from` todos confirmados no JSON de saída.

## 48. Bloco 0 — janela de ALTA: resultado (2026-07-30)

`docs/roadmap.md` Bloco 0 pedia um run com a mesma carteira de 20 símbolos e
mesma duração da baseline de baixa (344 operações, 12 meses,
2025-07-27→2026-07-27, expectância líquida −0,076 R, IC cruzando zero), mas
numa janela de ALTA (2024-07-27→2025-07-27), com um critério escrito **antes**
de olhar o número. O usuário rodou (`trial_label: Bull-baseline`, artifact
enviado, commit `cc0bb94`). Resultado, via `analyze-backtest.mjs` sobre o
relatório completo:

| | Baixa (baseline, item 44/46.1) | Alta (este run) |
|---|---|---|
| Operações fechadas | 344 | 288 |
| Expectância líquida | −0,076 R | **+0,294 R** |
| IC 95% | cruza zero (INCONCLUSIVO) | **[0,153; 0,435] — CONCLUSIVO** |
| BUY | −0,332 R (t=−4,32, item 45.9) | **+0,396 R** (159 ops) |
| SELL | +0,199 R (não sobrevive Bonferroni, item 45.9) | +0,169 R (129 ops) |

### Nenhum dos três desfechos escritos antes bateu exatamente

O critério prometia três baldes — (a) BUY positivo/SELL negativo = puramente
direcional, sem vantagem, encerra a linha; (b) líquido positivo nas DUAS
janelas = vantagem real, independente de regime; (c) negativo nas duas.
**O resultado real não cai em nenhum dos três**: os dois lados vieram
positivos na alta (derruba com força o cenário (a) — se fosse puramente
direcional, SELL devia ter ficado negativo numa alta forte, e não ficou), mas
a baixa continua líquida negativa (mesmo que estatisticamente indistinguível
de zero), então (b) também não se sustenta ao pé da letra.

**Leitura honesta**: existe vantagem real e estatisticamente confirmada em
regime de ALTA (a primeira janela, de qualquer regime, que fechou
CONCLUSIVA desde que o gate de amostra começou). BUY continuar mais forte que
SELL, espelhando a assimetria oposta da baixa, mostra que o resultado ainda
**acompanha o regime** — só que de forma mais suave do que "só ganha do lado
favorecido e perde do outro". A pergunta "o motor sobrevive numa queda de
verdade?" continua sem resposta — a única medição de queda que existe é
inconclusiva, não é uma prova de perda.

### Achado que se repete em regime diferente — reforça, não muda o veredito

`correction_warning` (item 45.9: inutilizável como filtro, causalidade
invertida) voltou a aparecer com desempenho muito pior que a média nesta
janela também: 46 operações, −0,414 R médio, contra +0,429 R médio das
operações sem arbitragem envolvida. Mesma contagem de 46 operações que na
baixa (provavelmente coincidência de amostra, não investigado) — o padrão
qualitativo se replica em dois regimes, o que é evidência a mais de que é um
efeito real (ainda que inútil como gate, pelo mesmo motivo já documentado).

### Decisão

**Não desbloqueei o Bloco 1 (os quatro flags dormentes) com base só nisto** —
o critério original pedia positivo nas DUAS janelas para essa conclusão, e a
baixa não bateu esse bar (mesmo inconclusiva, não é a mesma coisa que
provada positiva). Fica registrado como a melhor evidência de vantagem que o
projeto já produziu, mas com a ressalva de regime explícita — decisão de
como prosseguir (aceitar a ambiguidade e destravar o Bloco 1, esperar mais
uma janela, ou outra alternativa) fica para quando o usuário decidir, não
tomada aqui.

### Recomendação (2026-08-02, a pedido do usuário — "vou seguir sua recomendação")

**Fato**: a evidência é assimétrica, não simétrica. A janela de alta é
CONCLUSIVA positiva; a de baixa é INCONCLUSIVA (cruza zero), mas o corte por
lado dela (item 45.9) tem um resultado que NÃO é ambíguo — BUY negativo com
`t=-4,32` (estatisticamente significativo isolado, mesmo que o líquido do
portfólio inteiro não sobreviva à correção). O padrão mais nítido que emerge
comparando os dois cortes por lado **não é** "portfólio ganha/perde" — é que
**SELL ficou positivo nos DOIS regimes** (+0,199R baixa, não sobrevive
Bonferroni / +0,169R alta) enquanto **BUY inverteu de sinal com força**
(-0,332R baixa, `t=-4,32` / +0,396R alta). Isso não bateu em nenhum dos 3
desfechos escritos antes do run (a própria seção acima já registra isso) —
mas essa assimetria BUY-vs-SELL é um 4º padrão, não antecipado, que os 3
desfechos originais não cobriam.

**Hipótese**: se existe uma vantagem menos dependente de regime no motor,
ela está concentrada no lado SELL, não distribuída igualmente nos dois
lados. BUY parece ser o lado que "seguiu o regime" (perde na baixa, ganha
na alta); SELL parece mais estável através dos dois regimes testados —
embora nenhum dos dois lados isolados tenha amostra que sobreviva a correção
estatística por si só ainda.

**Recomendação**: **não desbloquear o Bloco 1 ainda** — a mesma disciplina
que este projeto já aplicou em outras decisões (candle pattern item 58,
retest item 40): uma janela conclusiva positiva contra uma inconclusiva
negativa-tendente não é o mesmo que "provado nos dois regimes", e o corte
por lado mostra que a força do resultado positivo na alta vem
desproporcionalmente do BUY — exatamente o lado que já tinha o pior
resultado significativo na baixa. Próximo passo concreto, mais barato que
esperar anos de dado ao vivo: rodar uma **3ª janela independente**, não
sobreposta às 2 já testadas (`2024-07-27→2025-07-27` e
`2025-07-27→2026-07-27` cobrem os últimos 2 anos completos) — ex.
`2023-07-27→2024-07-27`. **Ressalva que não dá pra verificar desta sessão**
(rede bloqueia a Binance): checar antes se os símbolos mais recentes da
carteira de 20 (PENDLE/ZRO, possivelmente outros) têm histórico de candles
suficiente na Binance até essa data — se não tiverem, rodar só com os 7
símbolos originais (mais antigos, história mais longa) em vez da carteira
de 20, para não truncar a janela silenciosamente. Mesmo assim, 3 janelas
seguem sendo 3 pontos, não os "~300 operações" que o próprio
`docs/roadmap.md` (Bloco 0) já registra como o padrão de confiança que
outros gates deste projeto exigem — mas cada janela independente é
evidência incremental real, e o recorte BUY-vs-SELL desta rodada é
informação nova o bastante pra valer a pena antes de comprometer a próxima
rodada de dado.

### 3ª janela independente — resultado (2026-08-03)

Usuário rodou a janela recomendada (`bloco0-janela3-2023`,
2023-07-27→2024-07-27, 7 símbolos originais, sem SMC, mesmos custos).

**Fato**: 78 operações fechadas, expectância líquida +0,062R,
**INCONCLUSIVO** (`ci_straddles_zero`). Por lado (via diagnóstico
`analyze-backtest.mjs`, sem CI/t-stat por lado nesta impressão — só
contagem e R médio): BUY 46 ops, R médio 0,003 (essencialmente zero);
SELL 32 ops, R médio 0,147 (positivo).

**As 3 janelas lado a lado, SELL vs BUY**:

| Janela | Regime | BUY (R médio) | SELL (R médio) |
|---|---|---|---|
| 2025-07→2026-07 (baseline) | baixa | -0,332 (`t=-4,32`) | +0,199 (não sobrevive Bonferroni) |
| 2024-07→2025-07 | alta | +0,396 | +0,169 |
| 2023-07→2024-07 (esta) | misto | +0,003 | +0,147 |

**SELL ficou positivo nas 3 janelas independentes, numa faixa estreita
(0,147 a 0,199)** — o padrão mais estável medido neste projeto até agora
para qualquer corte do motor. **BUY oscilou de fortemente negativo pra
fortemente positivo pra neutro**, seguindo o regime de cada janela, sem
nenhum sinal de estabilidade própria.

> **Ressalva (review externa, Codex, PR #122) — carteira NÃO controlada
> entre as 3 janelas.** A baixa e a alta (item 48, linha 3443) rodaram
> com a **carteira de 20 símbolos**; esta 3ª janela rodou de propósito só
> com os **7 símbolos originais** (recomendação desta sessão, pra não
> truncar histórico dos tokens mais novos). Trocar 13 símbolos entre as
> janelas é uma variável não controlada — a faixa estreita do SELL PODE
> vir da composição da carteira, não (só) da estabilidade de regime.
> **Não dá pra isolar isso com o dado disponível nesta sessão** (só o
> resumo impresso das 2 janelas anteriores foi colado, sem o
> `overall.curve` operação-a-operação pra recalcular um corte de 7
> símbolos sobre elas). Tratar a leitura "SELL estável" como hipótese
> ainda mais preliminar até alguém rodar a baixa/alta de novo só com os
> 7 símbolos, ou recomputar a partir do artifact completo se ele ainda
> estiver disponível.

**Outros padrões desta janela reconfirmam achados de janelas anteriores**
(review externa, Codex, PR #122: a contagem de "3 amostras" abaixo estava
inflada — só `correction_warning` tem dado das 3 janelas; os outros 3
comparam só esta janela contra a baixa original, 2 pontos, porque o
relatório da alta — item 48 — nunca imprimiu essas métricas):
- `correction_warning` (arbitragem cross-cascade, item 45.9/48): -0,394R
  médio (14 ops) contra +0,162R sem arbitragem — mesmo padrão qualitativo
  nas **3** janelas (única métrica com dado nas 3).
- Runner do TP1 (item 46): contribuição -0,024R bruto nesta janela
  (fechar 100% no TP1 teria sido melhor em 20 de 30 operações que
  bateram TP1) — mesma direção do achado original da baixa; **2**
  janelas com este dado (a alta/item 48 não reportou runner).
- Erosão de MFE positivo até o stop (item 53): 63 de 64 `STOP_HIT`
  (98,4%) chegaram a ficar positivas antes de estourar o stop — **2**
  janelas com este dado. **Ressalva adicional (Codex): não é comparável
  1:1 ao 60/61 original.** O 60/61 do item 53 filtrava só operações
  PRÉ-TP1 (nunca chegaram a bater TP1); o 63/64 desta janela vem da
  seção genérica de MFE/MAE do `analyze-backtest.mjs`
  (`backtestAnalysis.js:343`, `stoppedRows = rows.filter(status ===
  'STOP_HIT')`), que inclui QUALQUER `STOP_HIT`, inclusive runners que já
  bateram TP1 antes de estourar o stop depois — e um runner pós-TP1 tem
  MFE positivo quase por construção (só chegou a virar runner porque já
  tinha ficado positivo). A semelhança dos dois percentuais pode ser
  coincidência de populações diferentes, não replicação do mesmo
  fenômeno — não dá pra recalcular o corte pré-TP1-only desta janela sem
  o `overall.curve` completo.
- RF regime: rejeições dominadas por `adx_weak` (42/51, 82%), ADX médio
  nas rejeições 16,99 — **2** janelas com este dado (item 52 também é
  baseado na mesma rodada de diagnóstico da baixa original, não da alta).

**Hipótese reforçada, ainda não formalmente testada** (esta janela não
teve CI/t-stat por lado impresso, só R médio — não dá pra cravar
significância estatística desta janela isolada, e a ressalva de carteira
não controlada acima pesa contra tratar isso como comparação limpa entre
regimes): a vantagem menos dependente de regime deste motor está
concentrada no lado SELL. Com 3 janelas independentes, todas com SELL
positivo numa faixa estreita e BUY oscilando com o regime, o padrão
aponta nessa direção — mas continua sendo 3 pontos, não uma amostra
formal (~300 operações seria o padrão de confiança que outros gates
deste projeto exigem, `docs/roadmap.md` Bloco 0), **e** a diferença de
carteira (20 símbolos × 7 símbolos) entre esta janela e as 2 anteriores
não permite descartar composição de carteira como explicação alternativa
ainda.

**Decisão**: não tomada aqui — fica registrada a favor do usuário
decidir o próximo passo (aceitar a leitura SELL-específica como
suficiente pra alguma ação, rodar uma 4ª janela, calcular CI/t-stat por
lado sobre as 3 janelas já coletadas antes de decidir, ou outra
alternativa). Ver também a recomendação de 2026-08-02 acima.

### Confound controlado — reprocessar baixa e alta só com os 7 símbolos (2026-08-04)

A leitura "SELL estável nas 3 janelas" acima tinha um confound real
(Codex, PR #122): baixa/alta rodaram com a carteira de 20 símbolos, a
janela 3 rodou só com os 7 originais — trocar 13 símbolos entre janelas é
variável não controlada. Usuário rodou os 2 reprocessamentos recomendados
nesta sessão: MESMAS datas de baixa (`2025-07-27→2026-07-27`) e alta
(`2024-07-27→2025-07-27`), restritas aos mesmos 7 símbolos da janela 3
(`bloco0-baixa-7symbols-confound-check`, `bloco0-alta-7symbols-confound-check`).

**Fato** — os 5 pontos de dado agora comparáveis:

| Janela | Carteira | Ops | Líquido | BUY | SELL |
|---|---|---|---|---|---|
| Alta 2024-25 | 20 símbolos (original) | 288 | +0,294R (CONCLUSIVO) | +0,396R | +0,169R |
| Alta 2024-25 | 7 símbolos (controlado) | 101 | +0,250R | +0,197R | +0,321R |
| Baixa 2025-26 | 20 símbolos (original) | 344 | −0,076R (INCONCLUSIVO) | −0,332R (t=−4,32) | +0,199R (não sobrevive Bonferroni) |
| Baixa 2025-26 | 7 símbolos (controlado) | 105 | +0,141R (INCONCLUSIVO — IC cruza zero) | −0,104R | +0,401R |
| Janela 3 2023-24 | 7 símbolos | 78 | +0,062R (INCONCLUSIVO) | +0,003R | +0,147R |

**O confound era real e material, não cosmético.** Restringir a baixa aos
7 símbolos originais inverteu o sinal do portfólio inteiro nessa MESMA
janela de tempo/regime: de −0,076R (20 símbolos) para +0,141R (7
símbolos) — só a lista de ativos mudou. Parte do resultado negativo
original vinha especificamente dos 13 símbolos extras da carteira de 20
(ex. SOLUSDT, que caiu −61,2% nesse período, item 46.1), não da
estratégia em si.

**SELL positivo nas 5 medições feitas até hoje** (0,147R a 0,401R), em 3
regimes diferentes (baixa/alta/misto) e 2 composições de carteira (7/20
símbolos) — o padrão mais consistente já medido neste projeto para
qualquer corte do motor.

**BUY segue direcionalmente o regime nas 5 medições** (negativo nos 2
reads de baixa, positivo nos 2 de alta, ~zero no misto) — mas a
oscilação é bem menor controlando o confound (baixa: −0,332R→−0,104R;
alta: +0,396R→+0,197R), sugerindo que parte da oscilação extrema
original também vinha da composição da carteira, não só do regime.

**O critério original do roadmap ("positivo nas duas janelas ⇒ vantagem
independente de regime") bate, no ponto estimado, com a carteira
controlada** — baixa +0,141R e alta +0,250R, ambas positivas. **Ressalva
que pesa**: a baixa continua estatisticamente INCONCLUSIVA (IC cruza
zero) — o ponto estimado virou positivo, a confiança estatística não. O
IC exato da alta 7-símbolos não foi conferido (não veio no diagnóstico
colado) — não afirmar "CONCLUSIVO" sem visto o número.

**Ressalva de honestidade estatística**: esta é a 5ª/6ª leitura tirada
dos mesmos ~3 anos de histórico (baixa, alta, janela 3, mais estas 2
reprocessadas) — múltiplas comparações sobre dado adjacente/sobreposto
no tempo aumenta o risco de um padrão que pareça bonito por acaso. Não
invalida o achado, mas ele ainda não é prova formal — é a leitura mais
forte e mais limpa (confound controlado) que o projeto já produziu, não
uma certeza.

**Decisão**: continua não tomada aqui (mesma reserva de sempre) — mas a
leitura mudou o suficiente pra valer a pena o usuário revisitar as 3
opções (aceitar dependência de regime / esperar janela nova / viés
adaptativo) com este dado mais limpo em mãos, em vez do dado confundido
por carteira que motivou a hesitação original.

## 49. Funil de confirmação de entrada instrumentado — fecha 45.3/45.4 (2026-07-30)

O usuário reportou o problema real por trás de "fechar o processo do motor":
o painel ao vivo produziu só **3 operações** em mais de um mês rodando os
mesmos 7 símbolos, apesar de "bastante sinal" — pergunta confirmada:
"bastante sinal, mas poucas viram operação", com `minScore=75` (padrão,
descarta configuração de score como causa). Isso aponta pro **funil de
confirmação de entrada** (RF 4h→15m e SMC 1h→5m), que nunca teve
instrumentação agregável — cada gate só fazia `continue` mudo (RF) ou
colapsava 3 causas num `no_trigger` só (SMC, item 45.3). Fecha 45.3 e 45.4.

### O mecanismo

Novo campo `SignalEvent.last_rejection_reason` (ver
`docs/schema-reference/SignalEvent.jsonc`), escrito **só pelos loops de
RETRY** de `persistScanResults` (`scanner.js`) — o 1º pass de cada sinal já
loga verboso pro `SystemLog` uma vez, não precisa do campo persistido.
**Write-on-change**: um sinal preso no MESMO gate por N passadas de retry
custa zero escrita extra — só uma MUDANÇA de motivo grava (mesma convenção
de `expired_logged`/`rf_reverse_bars_count`, item 47.2/P0-e). Cada avaliação
(mude o campo ou não) também empurra pra `entryFunnelOutcomes`, um array em
memória sem custo de I/O que `persistScanResults` devolve — vira insumo pro
histograma `entryFunnel` do relatório de backtest (abaixo). O log de
expiração (RF e SMC) passou a incluir o último motivo conhecido na mensagem
e em `details.last_rejection_reason`, então mesmo um sinal que nunca
converteu deixa rastro de ONDE parou.

`check5mSmcConfirmation` (cascata SMC) teve seu `no_trigger` colapsado
dividido em três causas reais, fechando o item 45.3: `insufficient_data`
(menos de 60 candles 5m fechados), `no_trigger` (dado suficiente, gatilho
genuinamente nunca disparou), `fetch_error` (exceção no fetch). Antes,
"sem dado" e "sem sinal" eram indistinguíveis num replay longo.

Motivos possíveis (11 no total — ver enum em `SignalEvent.jsonc`):
`trend_reversed`, `regime_rejected`, `smc_confirm_zone_rejected`,
`retest_pending`, `displacement_gate_rejected`, `confirmation_15m_not_aligned`,
`insufficient_data`, `no_trigger`, `ote_zone_unfavorable`, `fetch_error`,
`rr_below_min`. `active_op_exists` também é contado em `entryFunnelOutcomes`
(pra não sumir do histograma), mas nunca grava o campo — não é uma rejeição
do próprio gate, é o asset já estar ocupado por outra operação.

### Backtest — seção `entryFunnel`

`backtestEngine.js` agrega `entryFunnelOutcomes` num histograma simples por
cascata (`{'4h_15m': {...}, '1h_5m': {...}}`), **diferente** dos Maps por
`dedup_key` que `retest`/`displacement`/`smcRegime` usam (que guardam o
motivo FINAL de cada sinal): aqui é a soma de TODAS as avaliações que
rejeitaram algo ao longo do replay inteiro — responde "qual gate barra mais
no funil", não "qual foi o motivo final de cada sinal" (um sinal que falha
3x e confirma na 4ª conta 3 rejeições reais que aconteceram). Nova seção
`report.entryFunnel` (`totalRejections` + `byReason` por cascata), impressa
por `scripts/run-backtest.mjs` e no resumo de `backtest.yml`.

### Por que backtest em vez de esperar dado ao vivo

O motor de backtest roda a MESMA `scanAsset`/`persistScanResults` do painel
ao vivo, sem modificação — instrumentar uma vez e rodar UM backtest dá a
distribuição real de motivos de rejeição sobre centenas de tentativas
históricas em minutos, em vez de esperar semanas de dado ao vivo acumular.
Essa é a Rodada 2 do plano de "fechar o processo do motor": o usuário roda
`trial_label: entry-funnel-diagnostico` com os 7 símbolos de sempre, e a
seção `entryFunnel` do relatório responde com número qual gate rejeita mais
em cada cascata — inclusive se a hipótese geométrica do item 45.2 (tensão
entre gatilho 5m e zona OTE da perna 1h) se confirma como a causa dominante
do lado SMC.

### Verificação

11 testes novos em `scannerStateMachine.test.js` (write-on-change nas duas
cascatas, `active_op_exists` sem escrita, os 3 motivos novos de
`check5mSmcConfirmation`, enriquecimento do log de expiração) e 3 em
`backtestEngine.test.js` (`entryFunnel` default zerado, agregação por
cascata/motivo, prova de wiring ponta a ponta via `runBacktest` real) — 703
testes passando no total, sem regressão.

## 50. Instrumentação granular do funil de entrada (RF regime + gatilho SMC 5m) (2026-07-31)

O backtest de 12 meses/7 símbolos do item 49 respondeu "qual gate rejeita
mais" com número: `regime_rejected` (ADX+Choppiness) é 69,4% das rejeições
da cascata RF (3.750/5.404); `no_trigger` é 70,3% das rejeições da cascata
SMC (11.969/17.024), com `ote_zone_unfavorable` (a hipótese do item 45.2)
em só 1,7% — **refutando** a hipótese de que a zona OTE geométrica é o
gargalo dominante do SMC.

Dois agentes Explore investigaram separadamente se algum threshold estava
mal calibrado antes de propor mudança — achado principal: **nenhuma das
duas cascatas tem hoje um número solto pra recalibrar**.

- **RF**: `evaluateRegime` (`scanner.js`) usa a tabela de tier
  (`src/lib/indicators/tier.js` — ADX 25/22/18, Choppiness 55/58/62 por
  T1/T2/T3) que é **cópia literal** do Pine real do usuário
  (`src/pages/PineScript.jsx:269-271,89-90`, valores idênticos). Mudar isso
  sem o usuário mudar o Pine real seria divergência deliberada de paridade,
  não uma correção.
- **SMC**: `swingLen=10` do gatilho 5m (`check5mSmcConfirmation`,
  `scanner.js`) **não** é do Pine real (que usa 50 como default) — é o
  `minval` do input, escolha do próprio Sentinel. Mais relevante ainda: o
  Pine real (`docs/reference-pine/smc-a-unified-v2.3.pine`) é um
  `indicator()`, sem NENHUM conceito de confirmação em timeframe menor — a
  cascata 1h→5m inteira (viés 1h + gatilho 5m) é desenho original do
  projeto. Não existe "valor certo do Pine" pra restaurar aqui.

O que as duas cascatas TÊM em comum é uma lacuna de **instrumentação**, não
de calibração — fechada nesta rodada, sem mudar nenhum critério de
confirmação/rejeição:

### RF — `rfRegimeOutcomes` simétrico a `smcRegimeOutcomes`

A cascata SMC já gravava `{ok, adxOk, chopOk}` por avaliação de regime
desde a Fase 3 (item 42, `smcRegimeOutcomes`); a cascata RF só gravava a
string `'regime_rejected'` em `entryFunnelOutcomes`, nunca o ADX/Choppiness/
tier reais. `rfRegimeOutcomes` fecha essa assimetria (`scanner.js`, mesmos
2 call sites de `evaluateRegime` que já existiam), e os dois arrays
(`rfRegimeOutcomes`/`smcRegimeOutcomes`) ganharam os mesmos 3 campos novos
(`adx`, `chop`, `tier`) pra simetria real. `backtestEngine.js` extraiu um
helper puro `buildRegimeSection` (Map por `dedup_key`, `attemptsByKey`,
mesmo padrão de `retest`/`displacement`) reaproveitado pelas duas novas
seções do relatório: `report.rfRegime` (nova) e `report.smcRegime` (shape
enriquecido, nome mantido — renomear quebraria comparabilidade com
relatórios/testes antigos).

Novo teste de paridade em `tier.test.js` (lê `PineScript.jsx` como texto,
mesmo padrão de `goldenParity.test.js` pros CSVs golden — não importa o
componente React) comparando os literais do Pine contra `TIER_PARAMS`
(agora exportado) — protege contra os dois arquivos divergirem em silêncio
no futuro, lacuna que não tinha teste nenhum antes desta rodada.

### SMC — `wrong_direction_trigger` e `smcTriggerOutcomes`

`check5mSmcConfirmation` já calcula sweep/estrutura para os dois lados
(bullish e bearish) — só o lado pedido pela direção do sinal era lido. Um
`no_trigger` hoje é indistinguível entre "nenhum evento ocorreu" e "um
evento ocorreu, no lado ERRADO". Novo valor de `rejectReason`,
`wrong_direction_trigger` (mesma operação que já dividiu `no_trigger` em 3
causas no item 49/45.3 — não um mecanismo novo), checando o lado oposto
só quando nenhum dos dois lados pedidos disparou (zero fetch extra).
Adicionado ao enum de `SignalEvent.last_rejection_reason`
(`docs/schema-reference/SignalEvent.jsonc`).

Também novo: `smcTriggerOutcomes` (`{dedup_key, cascade, confirmed, trigger,
rejectReason}`, empurrado nos mesmos 2 call sites de
`check5mSmcConfirmation`), com `attemptsByKey` genérico igual a
`retest`/`displacement` — nova seção `report.smcTrigger` (`total`,
`attempts.{evaluations,retried,maxAttempts}`, `confirmed`, `byTrigger`,
`byReason`). Diferente das seções acima, **sem** campo `enabled`:
`check5mSmcConfirmation` nunca é opt-in (roda sempre que `asset.smc_enabled`
está ligado, sem flag própria de `pineConfig`), então um `enabled` inferido
de array-não-vazio seria enganoso ali. Essa seção troca a inferência
aritmética agregada que sustentava "sinal esgota a janela de 4h sem
disparar" (346 sinais × ~48 avaliações/sinal ≈ 17.024, batendo com o real,
mas só por soma) por uma contagem real por-sinal
(`attempts.evaluations`/`retried`/`maxAttempts`).

### Backtest — impressão

`scripts/analyze-backtest.mjs` ganhou `renderGateSection`, chamada pra
`report.rfRegime` (novo), `report.smcRegime` (existia desde a Fase 3, nunca
tinha sido impresso em lugar nenhum) e `report.smcTrigger` (novo) — lê o
`report` bruto, não o `analysis` derivado de `analyzeReport`
(`backtestAnalysis.js` é escopo fechado sobre operações fechadas; estas
seções são sobre tentativas de entrada).

### Fora de escopo — decisão fica para depois

Esta rodada não decide se algum threshold/parâmetro deveria mudar — é
exatamente o dado que ela produz que vai informar essa decisão numa rodada
futura (ex.: threshold do gate de regime RF, calibração do `swingLen`/
lookback do gatilho 5m SMC), com o mesmo cuidado do Bloco 0 (critério
escrito antes do número).

### Verificação

9 testes novos em `scannerStateMachine.test.js` (rfRegimeOutcomes na 1ª
passada e no retry com adx/chop/tier reais, `wrong_direction_trigger`
distinto de `no_trigger` genuíno, `smcTriggerOutcomes` confirmado/rejeitado),
7 em `backtestEngine.test.js` (`rfRegime`/`smcTrigger` default zerado e
agregação, `attempts` sobrevive ao colapso por `dedup_key`, prova de wiring
via `runBacktest` real com `attempts.evaluations > 1`), 3 em `tier.test.js`
(paridade Pine) — 720 testes passando no total, sem regressão.

## 51. Hardening do item 50 — achados do Codex review pós-merge (2026-07-31)

O PR do item 50 (#103) mergeou antes da revisão automática externa
(`chatgpt-codex-connector`) terminar de comentar. Três achados chegaram
depois do merge — conferidos linha a linha contra o código, todos reais:

1. **P1 — `rfRegimeOutcomes`/`smcTriggerOutcomes` não respeitavam a janela
   avaliada.** `entryFunnelOutcomes` já era gravado só dentro de
   `if (t >= evalFromMs && t <= evalToMs)` (correção de uma revisão externa
   anterior no PR #102) — os dois arrays novos do item 50 não tinham esse
   gate. O comentário que justificava isso ("Maps guardam só o estado
   FINAL, um sinal de aquecimento é naturalmente sobrescrito") está
   **errado em geral**: um sinal avaliado só durante o aquecimento (nunca
   mais tocado depois) fica como entrada própria no Map pra sempre, e um
   retry que acontece DEPOIS de `evalToMs` pode sobrescrever o estado final
   de um sinal que era válido dentro da janela. **Corrigido** para
   `rfRegimeOutcomes`/`smcTriggerOutcomes` — movidos pra dentro do mesmo
   gate de `entryFunnelOutcomes` (`backtestEngine.js`, loop de
   `runBacktest`). **Não corrigido** (lacuna sinalizada, mais ampla e mais
   antiga — Fase 2/3, não introduzida por este round): `retestOutcomes`/
   `displacementOutcomes`/`smcRegimeOutcomes`/`arbitrationOutcomes`/
   `smcObFvgOutcomes` compartilham exatamente o mesmo problema. Consertar
   as 5 de uma vez é auditoria própria (muda comportamento de seções já em
   produção com relatórios/testes existentes) — fica para uma rodada
   futura dedicada, não misturada com este hardening pontual.
2. **P2 — `buildRegimeSection` descartava os valores numéricos.** Só lia
   `{ok, adxOk, chopOk}` — os campos `adx`/`chop`/`tier` que o item 50
   passou a coletar (o objetivo inteiro do round: "não só ok/not-ok") nunca
   chegavam no relatório agregado, o que inviabilizava a decisão futura de
   calibração ("as rejeições ficam perto do threshold ou longe?").
   **Corrigido**: nova função `numericStats` + campos `adxStats`/
   `chopStats` (`{avgRejected, minRejected, maxRejected}`, calculados só
   sobre as avaliações em que aquele sub-gate especificamente reprovou) em
   `report.rfRegime`/`report.smcRegime`. Impressos também no
   `scripts/analyze-backtest.mjs`.
3. **P2 — rótulo `avaliações` enganava em `analyze-backtest.mjs`.** A
   tabela por motivo das seções por Map (`rfRegime`/`smcRegime`/
   `smcTrigger`) conta SINAIS com aquele motivo FINAL (último-escreve-
   ganha), não quantas vezes o gate rodou — isso já estava certo na linha
   de resumo (`attempts.evaluations`), só a tabela usava o rótulo errado.
   **Corrigido**: coluna renomeada de `avaliações` pra `sinais`.

O PR deste hardening (#104) recebeu um 4º achado, também real, do mesmo
processo de revisão automática:

4. **P2 — `adxStats`/`chopStats` (item 2 acima) liam do Map last-write-wins,
   não de todas as rejeições reais.** `buildRegimeSection` calculava as
   estatísticas a partir de `outcomes` (o mesmo array deduped que já
   alimenta `byReason`/`total`/`passed`) — um sinal rejeitado com ADX 5 e
   depois 24 antes de finalmente confirmar contribuía só a 3ª avaliação
   (`ok:true`, nada) pras estatísticas; se expirasse ainda rejeitado,
   contribuía só a ÚLTIMA rejeição (24), perdendo a primeira (5). Isso
   enviesava exatamente a métrica que o item 2 foi corrigido pra fornecer.
   **Corrigido**: dois arrays novos, `rfRegimeAllOutcomes`/
   `smcRegimeAllOutcomes` — histograma tipo `entryFunnelCounts` (toda
   avaliação conta, não só o estado final por `dedup_key`), usados
   exclusivamente por `adxStats`/`chopStats`; `byReason`/`total`/`passed`/
   `rejected` continuam vindo do Map deduped, sem mudança de significado.
   `rfRegimeAllOutcomes` ganhou o mesmo gate de janela avaliada do item 1
   (adicionado desde já, não uma 2ª rodada de correção); `smcRegimeAllOutcomes`
   ficou fora do gate de propósito, espelhando a lacuna já sinalizada (e
   ainda não corrigida) de `smcRegimeOutcomes` no item 1 acima — evita criar
   uma nova inconsistência entre a tabela por motivo e as estatísticas
   numéricas dessa mesma seção.

### Verificação

Itens 1-3: 3 testes novos em `backtestEngine.test.js` (sinal avaliado só no
aquecimento fica fora de `report.rfRegime`/`report.smcTrigger` quando
`evaluationFrom`/`To` recorta a janela — um por seção — e `adxStats`/
`chopStats` calculados corretamente, incluindo o caso de `null` ignorado
em vez de virar 0) + 2 testes existentes atualizados (shape de
`report.smcRegime`/`report.rfRegime` ganhou `adxStats`/`chopStats`) — 723
testes passando no total, sem regressão.

Item 4: 2 testes novos (reproduz o cenário exato do achado — sinal
retried 3x com ADX 5/24/30-e-passa, `adxStats` vê as 2 rejeições reais
mesmo com o Map final marcando `ok:true`; chamador legado sem
`rfRegimeAllOutcomes` explícito continua funcionando via fallback) — 725
testes passando no total, sem regressão. `npm run lint && npm run build &&
npm run build:scan && npm run build:backtest` OK.

> **Atualização (2026-08-02, limpeza de achados "já conhecidos" da
> auditoria item 59):** as 5 seções deixadas de fora do item 1
> (`retestOutcomes`/`displacementOutcomes`/`smcRegimeOutcomes`/
> `arbitrationOutcomes`/`smcObFvgOutcomes`) e o histograma
> `smcRegimeAllOutcomes` foram movidos para dentro do mesmo
> `if (t >= evalFromMs && t <= evalToMs)` que já protegia
> `entryFunnelOutcomes`/`rfRegimeOutcomes`/`rfRegimeAllOutcomes`/
> `smcTriggerOutcomes`/`candlePatternOutcomes` (`backtestEngine.js`, loop
> de `runBacktest`) — código-motion mecânico, mesmo `if` existente, sem
> lógica nova. Fecha a lacuna que este item deixou aberta de propósito.
> **Sem teste e2e novo desta vez** — construir uma fixture de candle
> completa pra disparar reteste/displacement/regime SMC/arbitragem/OB-FVG
> via `runBacktest` (em vez de chamar `buildReport` direto, como os testes
> existentes dessas 5 seções já fazem) seria uma fixture nova e não
> trivial, desproporcional a uma limpeza de baixo risco; o próprio
> mecanismo do gate (`if (t >= evalFromMs && t <= evalToMs)`) já está
> provado por 3 testes (item 1 acima) contra a mesma estrutura de código
> (`recordOutcome` num Map por `dedup_key`) que as 5 seções movidas usam
> — a mudança é reposicionar chamadas já testadas pra dentro de um gate já
> testado, não lógica nova. 790 testes passando, sem regressão
> (`npm test`).

## 52. Gatilho SMC 5m: 100% das confirmações vêm de sweep, 0% de estrutura — não é bug (2026-08-01)

O usuário rodou o primeiro backtest real com a instrumentação do item 50
(`trial_label: regime-trigger-diagnostico`, 12 meses, 7 símbolos,
2025-07-31→2026-07-31). Resultado bate quase exato com o item 49 (117 ops
vs. 116, RF `netExpectancyR` +0,036 vs. +0,035, SMC -0,778 idêntico) —
confirma que a instrumentação do item 50 não mudou comportamento nenhum,
só mediu.

**RF regime**: 97% das rejeições (`rfRegime.byReason`) são `adx_weak`
genuíno — `adxStats.avgRejected = 16,52`, bem abaixo até do limiar mais
frouxo (T3 = 18). Não há sinal de rejeição "quase passando" nesta amostra;
não há indício de que o threshold esteja mal calibrado.

**Achado novo, com uma ressalva séria (Codex review, PR #105 — corrigida
aqui)**: das 10 confirmações da cascata SMC no ano inteiro,
`report.smcTrigger.byTrigger = { sweep: 10, structure: 0 }`. A leitura
inicial deste item ("100% sweep, 0% estrutura, prova que BOS/CHoCH quase
nunca contribui") **estava errada** — `check5mSmcConfirmation` grava
`trigger: sweepAligned ? 'sweep' : 'structure'` (`scanner.js:453`), ou
seja, sempre que `sweepAligned` é `true` o rótulo vira `'sweep'`
**independente de `structureAligned` também ser `true` na mesma vela**
(um candle "externo" que varre um extremo E fecha além do nível estrutural
oposto satisfaz os dois ao mesmo tempo — cenário plausível, não hipotético).
O que o dado prova de fato: as 10 confirmações tinham `sweepAligned=true`.
**Não** prova que `structureAligned` era `false` nelas — isso exigiria
instrumentar os dois booleanos brutos separadamente (não só o rótulo final
de precedência), o que não existe hoje. Primeira medição real de
`byTrigger` no projeto (nem o item 45.2 nem o item 50 tinham isso
reportado), mas a conclusão original que ela sustentava não se sustenta
sozinha.

### Mecanismo (investigado, continua válido — independente da ressalva acima)

`check5mSmcConfirmation` (`scanner.js:389`) chama
`calculateStructure(closed, {swingLen: 10})` sem sobrescrever
`filterInsignificantInternalBreaks` — fica `true` (default). A fórmula
(idêntica pro topo e pro fundo, `smcStructure.js:108-116`/`141-148`):

```
bigC = body > 2×dtl || body > ATR(3)
trendConcordant = bigC || (assimetria de pavio a favor)
```

só marca BOS/CHoCH quando `trendConcordant`. **Não depende de `swingLen`**
— usa só dados da vela do cruzamento (corpo, distância ao nível) + ATR(3);
`swingLen` só decide ONDE o nível se forma (`detectSwings`,
`smcStructure.js:37-54`), não a severidade do filtro. `calculateLiquiditySweep`
(`smcStructure.js:189-205`) é geometria pura (`low < swLow && close > swLow
&& close > open`) — **sem esse filtro em nenhum dos dois lados** (JS e
Pine). Essa assimetria de rigor entre os dois gatilhos é uma explicação
plausível e sustentada por evidência independente (paridade Pine, prática
de comunidade) pra estrutura ser mais rara que sweep **em geral** — mas,
por causa da ressalva acima, não dá pra atribuir a ela, com este dado,
a proporção exata `{sweep:10, structure:0}` observada nesta amostra
específica.

### Paridade e comunidade

O filtro é porte fiel, fórmula símbolo-por-símbolo, de `detect_pivot`
(`smc-a-unified-v2.3.pine:778-822`, bloco do filtro em `:807-817`). O Pine
real roda com `swing_length=50` por padrão (`:978`) — sem evidência de que
o usuário usa 10 de fato; é só o `minval` permitido pela UI do indicador.
A cascata 1h→5m inteira já é desenho original do Sentinel (item 50), sem
equivalente de confirmação LTF no Pine real.

Pesquisa externa (WebSearch, 2026-08-01, buscas "ICT SMC break of
structure BOS CHoCH minimum candle body size filter false break lower
timeframe" e "smart money concepts pivot swing length lower timeframe
confirmation entry trigger"): exigir fechamento de CORPO além do nível
estrutural (não só pavio) para validar BOS/CHoCH é prática padrão
documentada na comunidade ICT/SMC, especificamente para filtrar
rompimento falso — bate com o filtro já existente no projeto. Fontes:
[Day 3: SMC & ICT Market Structure Explained](https://tradingstrategyguides.com/day-3-smc-ict-market-structure-explained-bos-choch-swing-points-2026/),
[Break of Structure (BOS) Explained](https://www.fluxcharts.com/articles/break-of-structure-bos-explained),
[A Practical Guide to Smart Money Concepts](https://myfundedcapital.com/smart-money-concepts/).

### Recomendação

**Não mexer** no filtro nem em `swingLen` — isso continua de pé mesmo com
a ressalva acima, mas agora por um motivo mais simples: a amostra (11
operações) já era pequena demais pra justificar mexer em parâmetro antes
da ressalva; com ela, a única coisa que a amostra prova com segurança é
"sweep contribui" — não dá pra comparar a contribuição de estrutura contra
sweep, então não há base nenhuma pra decidir se vale a pena mexer no
filtro de estrutura especificamente.

**Instrumentação futura, não feita aqui** (esta é uma PR só de
documentação): pra responder "estrutura contribui de verdade ou é sempre
sombreada pelo sweep?" seria preciso gravar `sweepAligned`/
`structureAligned` brutos em `smcTriggerOutcomes` (`scanner.js`, os 2 call
sites de `check5mSmcConfirmation`), não só o `trigger` de precedência —
mesmo padrão já usado pra outros campos desta seção
(`docs/known-risks.md` item 50). Registrado aqui como possível próximo
passo, não decidido se vale a pena antes de mais dado de SMC em geral.

### Verificação

Nenhuma — item é só registro de investigação (2 agentes Explore
read-only + pesquisa externa), zero mudança de código/comportamento. A
revisão externa (Codex, PR #105) encontrou uma leitura errada do dado
`byTrigger` (precedência `sweep`/`structure` no rótulo confundida com
exclusividade) — corrigida no mesmo PR antes do merge, texto acima já
reflete a versão corrigida.

> **Atualização (2026-08-02) — instrumentação implementada.** A
> "instrumentação futura" descrita acima ("gravar `sweepAligned`/
> `structureAligned` brutos em `smcTriggerOutcomes`") foi feita:
> `check5mSmcConfirmation` (`scanner.js`) agora devolve os 2 booleanos
> brutos em todo retorno onde já são computados (`confirmed: true`,
> `no_trigger`/`wrong_direction_trigger`, `ote_zone_unfavorable`; ficam
> `null` nos retornos anteriores ao cálculo — `insufficient_data`/
> `fetch_error`), os 2 call sites que fazem `smcTriggerOutcomes.push`
> propagam os campos, e `report.smcTrigger.byRawAlignment` (novo,
> `backtestEngine.js`) agrega em `{sweepOnly, structureOnly, both}` —
> só sobre confirmações reais, onde os booleanos são significativos.
> `both` responde a pergunta original: quantas confirmações tinham
> `structureAligned=true` mesmo com sweep levando o rótulo por
> precedência (sombreamento); `structureOnly` mede independência real
> (estrutura confirmou sem nenhum sweep). **Confirmado por leitura de
> código**: `smcTriggerOutcomes` não é lido em nenhum lugar do caminho
> ao vivo (`scripts/run-scan.mjs` — zero match), só alimenta o relatório
> de backtest — a precedência `trigger: sweepAligned ? 'sweep' :
> 'structure'` que decide o resto do fluxo (stop estrutural, etc.)
> **não mudou**; isso é observabilidade pura, mesma categoria dos itens
> 49-51. Impresso também em `scripts/analyze-backtest.mjs`
> (`renderGateSection`, tabela nova ao lado de `byTrigger`). Testes:
> `backtestEngine.test.js` (fixture com os 3 casos —
> `sweepOnly`/`structureOnly`/`both`) e 2 testes existentes em
> `scannerStateMachine.test.js` atualizados (fixtures determinísticas de
> `bullishSweepCandles5m`/`flatCandles5m` produzem
> `structureAligned:false` em ambos os casos — nenhuma delas tem
> estrutura suficiente pra gerar BOS/CHoCH, só sweep ou nada). 790
> testes passando, sem regressão. **Resultado real de
> `byRawAlignment` ainda não medido** — depende de um novo backtest do
> usuário; quando vier, é achado separado, registrado à parte desta
> entrada.

### Resultado real de `byRawAlignment` — medido (2026-08-05)

Usuário rodou o backtest (`trial_label: byRawAlignment-diagnostico`,
2025-08-05→2026-08-05, 7 símbolos, `smc` ligado nos 7 pra gerar amostra).

**Fato**:

```
GATILHO DE ENTRADA — SMC 5m (1h_5m)
total: 256 · ok: 9 · rejeitado: 247

gatilho    confirmados
sweep      9
structure  0

alinhamento bruto  confirmados
sweepOnly          9
structureOnly      0
both               0

motivo                   sinais
no_trigger               231
wrong_direction_trigger  7
ote_zone_unfavorable     9
```

**As 3 perguntas que este item deixou em aberto, respondidas**:

1. **Taxa de confirmação real do gatilho 5m: 3,5%** (9 de 256 sinais
   avaliados) — quantifica com precisão o que o item 45.1 já descrevia
   qualitativamente como "código morto na prática".
2. **`both: 0`** — nenhuma das 9 confirmações teve `structureAligned`
   também `true` (nem por sombreamento). **`structureOnly: 0`** —
   estrutura nunca confirmou sozinha. Em 12 meses de dado real, o
   componente de estrutura (BOS/CHoCH) do gatilho 5m **não contribuiu
   nem uma vez**, isolado ou em conjunto com sweep. Todas as 9
   confirmações reais vieram exclusivamente de sweep.
3. **A hipótese do item 45.2 (tensão geométrica gatilho×zona) não é a
   explicação dominante.** `ote_zone_unfavorable` é só 9 das 247
   rejeições (3,6%); `wrong_direction_trigger` é 7 (2,8%). A esmagadora
   maioria — 231 de 247 (93,5%) — é `no_trigger` puro: nem sweep nem
   estrutura sequer dispararam na direção pedida, independente da zona.
   O funil trava porque os eventos raramente acontecem, não porque a
   zona rejeita eventos que aconteceram.

**Recomendação**: os dois achados sustentam a leitura que a rodada de
2026-08-04 já antecipava — os flags do Bloco 1 relacionados a SMC
(`displacementEnabled`, `smcTierEnabled`, `smcObFvgEnabled`) não têm
como consertar isso, porque nenhum deles ataca "os dois eventos-base
raramente disparam". Se algum dia fizer sentido investir mais nessa
cascata, o alvo certo (não implementado, não decidido) seria revisar o
gatilho de estrutura em si (`calculateStructure`/`swingLen: 10` no 5m —
talvez curto demais pra formar swing com regularidade) ou aceitar que a
independente 1h→5m não é um caminho produtivo e concentrar esforço em
`smc_confirm_4h15m` (mecanismo diferente, sem essa evidência negativa) e
na Fase 1 (RF 1h condicionado ao 4h, já em modo sombra).

**Nota lateral, fora do escopo deste item**: o resultado agregado do run
(116 operações, líquido +0,025R, INCONCLUSIVO — IC cruza zero) teve SMC
ligado nos 7 símbolos, então **não é comparável** aos runs do Bloco 0
(que rodam sem SMC) — não usar este número pra alimentar aquela
discussão. Por curiosidade, o mesmo padrão BUY-fraco/SELL-forte do
Bloco 0 apareceu de novo aqui (BUY −0,290R, SELL +0,340R), mas com
composição de amostra diferente (inclui as 9 operações SMC) — não é
evidência adicional formal para aquele item.

## 53. Stop pré-TP1 nunca avança — 61 operações erodem de MFE positivo até o stop original (2026-08-01)

Detalhamento do relatório de backtest (`trial_label:
regime-trigger-diagnostico`, 12 meses, 7 símbolos) já usado no item 52,
desta vez sobre `overall.curve` (dado por-operação, não precisou de
backtest novo). Das 117 operações, 96 terminaram em `STOP_HIT` —
recomputado nesta sessão diretamente do relatório, não só do resumo
agregado, em duas populações bem diferentes conforme já tinham (ou não)
batido o TP1:

**Pré-TP1 (stop cheio, 61 ops, 52% do total)**: resultado final médio
-1,131R; MFE médio +0,578R — **98,4% delas (60 de 61) chegaram a ficar
positivas** antes de estourar o stop; giveback médio (MFE − resultado
final) 1,709R; tempo médio até o MFE 5,9 barras vs. 18,1 barras até o
stop. Perfil: ficam positivas cedo e erodem devagar até o stop original,
que nunca se move. Assimetria por lado: BUY termina em stop cheio pré-TP1
em 75% dos seus `STOP_HIT` (39/52) vs. SELL 50% (22/44) — plausível viés
de regime do período do backtest (mesma limitação já aceita no item 46,
bear/bull), não investigada a fundo aqui.

**Pós-TP1 (giveback do runner, 35 ops, 30% do total)**: resultado final
médio ainda POSITIVO (+1,177R, porque o TP1 já foi bancado) mas devolve
parte do lucro flutuante: MFE médio 1,962R, giveback médio 0,785R — este
lado já tem proteção parcial, o trailing ATR pós-TP1.

### Mecanismo (confirmado por leitura de código)

`advanceTrailingStop` (`src/lib/opExitRules.js:55`) só é chamado em
`scanner.js:2549`, gated por `newStatus === 'RUNNER_ACTIVE'` — ou seja, só
depois do TP1. Antes disso, no branch pré-TP1 de `persistScanResults`
(`scanner.js:2392-2482`, `if (!tp1Hit)`), `newCurrentStop` nunca é
reatribuído — o stop fica travado no `initial_stop` da criação da operação
até (a) o preço bater nele (`STOP_HIT`) ou (b) o TP1 ser atingido, quando
vira breakeven NAQUELE instante (`scanner.js:2480`) e só a partir daí passa
a poder avançar. Não existe função de breakeven em `opExitRules.js` —
exports confirmados por grep: `isCandleUsableForExits`,
`getEntryReferenceTime`, `advanceTrailingStop`, `computeStructuralStop`,
`resolveCandleExit`, `closesFullyAtTp1`, `nextRfReverseCount`,
`passesRiskReward` — nenhuma mexe no stop pré-TP1. Também não existe no
Pine real (`src/pages/PineScript.jsx`, grep por "breakeven"/"BE" sem
match) — não é um conceito que o usuário já usa no TradingView.

### Comunidade (pesquisa externa, WebSearch, 2026-08-01)

Confirma armadilha bem documentada: mover o stop pro breakeven cedo demais
mata sistematicamente os vencedores de tendência via whipsaw normal de
mercado — precisa de um threshold não-trivial (múltiplo de ATR ou R
generoso), nunca um valor fixo pequeno. Estratégias de timeframe mais
longo se beneficiam mais (menos suscetíveis a whipsaw) — relevante aqui
porque a cascata RF, que concentra 104 das 117 operações, opera em
4h/15m, não em timeframe curto.

### Recomendação

Dado o giveback médio de 1,709R nas 61 operações pré-TP1 — a maior
população de perda isolada do sistema — vale desenhar e medir (não
decidir de antemão) se algum mecanismo de proteção parcial pré-TP1 ajuda,
com a mesma disciplina de todo flag deste projeto (Fases 2-4 do roadmap):
opt-in, desligado por padrão, comparação A/B via backtest antes de
considerar ativar. Desenho completo do mecanismo candidato registrado no
item 54.

### Verificação

Nenhuma nesta etapa — item é só registro de achado (recomputado e
verificado a partir de `overall.curve` do relatório já em mãos), zero
mudança de código/comportamento.

## 54. Proteção de stop pré-TP1 — mecanismo opt-in, desligado por padrão (2026-08-01)

Desenho e implementação do mecanismo candidato proposto no item 53, seguindo
a mesma disciplina de todo flag deste projeto (Fases 2-4 do roadmap):
opt-in, desligado por padrão, comparação A/B via backtest antes de
considerar ativar. Nenhum critério de confirmação/rejeição de entrada muda;
só o comportamento de saída PRÉ-TP1, e só quando o flag está ligado.

### Mecanismo

`advancePreTp1StopProtection` (`src/lib/opExitRules.js`) — função pura,
mesmo estilo de `advanceTrailingStop` (P0-d): monotônica (nunca regride),
nunca avança além do breakeven (`entry`) — um trailing pré-TP1 completo
seria um mecanismo diferente, não implementado aqui. Move o stop pra
breakeven quando o preço já se moveu a favor por `triggerAtrMult × ATR`
além da entrada (default 1.0× — múltiplo generoso de ATR, não um R fixo
pequeno, por causa da armadilha de whipsaw documentada no item 53).

Dois parâmetros novos em `pineConfig` (`src/lib/pineParser.js` +
`scripts/adminPineConfig.js`, mesmo par `DEFAULTS`/`SYNCED_STRATEGY_KEYS`
de sempre, também adicionados a `NON_PINE_SYNCED_KEYS` — não são
`input.*()` do Pine, mesma categoria de `runnerEnabled`/`retestEnabled`):
`preTp1StopProtectionEnabled` (default `false`) e
`preTp1StopProtectionAtrMult` (default `1.0`).

**Decisão congelada na CRIAÇÃO, não lida do `pineConfig` no momento da
saída** — mesmo raciocínio de `closesFullyAtTp1`/`runnerEnabled` (item 46):
`buildTradeOpData`/`buildSmcTradeOpData` gravam
`pre_tp1_stop_protection_enabled` e `pre_tp1_stop_advance_trigger_atr_mult`
na operação a partir do `pineConfig` vigente na entrada; o loop de saída
(`persistScanResults`, branch pré-TP1 de `scanner.js`) lê esses dois campos
DA OPERAÇÃO, nunca do `pineConfig` ao vivo — uma mudança de flag no meio do
caminho governa só a PRÓXIMA operação, nunca começa (ou para) de proteger
uma posição já em andamento. `pre_tp1_stop_advanced_at` (timestamp) é
gravado só na primeira vez que o gate dispara.

**Posição no loop**: dentro do `if (!tp1Hit)` de `persistScanResults`
(`scanner.js`), logo depois da cadeia stop/invalidação/chop/time-stop/TP1 —
só avança se NENHUMA saída disparou nesta passada
(`newStatus === op.status`). Mesma disciplina de look-ahead do P0-d/
`advanceTrailingStop`: o stop desta vela é testado contra o valor
ARMAZENADO primeiro; o avanço, calculado a partir do close desta vela, só
passa a proteger a partir da vela SEGUINTE. Gated por `candleUsable`
(P0-c/P0-g), igual a todo o resto do loop. **Só em `persistScanResults`**
— igual a `advanceTrailingStop` e ao rastreio de MFE/MAE (item 47.2),
deliberadamente ausente de `priceCheckActiveOpsInner` (preço muda a cada
tick, viraria fonte de escrita quase contínua se baseado em resolução de
tick em vez de candle).

### Auditoria (schema)

3 campos novos em `TradeOperation`
(`docs/schema-reference/TradeOperation.jsonc`):
`pre_tp1_stop_protection_enabled` (bool, congelado na criação),
`pre_tp1_stop_advance_trigger_atr_mult` (número, congelado na criação —
mesmo padrão de `retest_touch_mode`/`displacement_min_body_atr_mult`),
`pre_tp1_stop_advanced_at` (timestamp, ausente se o gate nunca disparou).

### Backtest

Nova seção `report.preTp1StopProtection`
(`src/lib/backtestEngine.js:buildReport`) — diferente de
`retest`/`displacement`/`smcRegime`/`smcTrigger`, não precisou de um array
de outcomes novo threaded pelo scanner: os 3 campos de auditoria acima já
ficam gravados NA PRÓPRIA operação, então a seção é inferida de `closed`
(mesmo padrão do `runner`, item 46 — "gestão realmente aplicada", não uma
inferência do `pineConfig`). Campos: `total` (operações com o flag ligado
na criação), `advanced` (quantas o gate de fato disparou),
`reachedTp1AfterAdvance` (seguiram até o TP1 mesmo depois do avanço —
contra-evidência de corte prematuro, o risco de whipsaw da pesquisa),
`stoppedAtBreakevenPreTp1` (pararam no stop já protegido — o cenário que o
mecanismo pretende evitar virar perda cheia), `otherExitAfterAdvance`
(Time Stop/Chop Exit/Invalidation depois do avanço). Impresso em
`scripts/analyze-backtest.mjs` (`renderPreTp1StopProtection`) só quando
`enabled` — comparar este bloco entre dois relatórios (`--pine-config`
com/sem o flag) é o mesmo fluxo "compare antes de ativar" de
retest/displacement/smcTier.

### Testes

`opExitRules.test.js`: função pura — não avança abaixo do threshold, para
exatamente em breakeven mesmo com preço bem além, nunca regride, espelha
BUY/SELL, dados inválidos devolvem o stop atual sem alterar.
`scannerStateMachine.test.js`: flag desligado (default) não move o stop;
flag ligado avança pra breakeven antes do TP1; uma reversão subsequente
para no breakeven em vez do stop original (o cenário-alvo); disciplina
P0-d — avanço e teste de stop no mesmo candle não causam look-ahead;
`buildTradeOpData` grava os 2 campos congelados a partir do `pineConfig`.
`backtestEngine.test.js`: seção nova inferida corretamente das operações
(desligado, ligado-mas-nunca-disparou, e as 3 categorias de resultado
depois de disparar).

### Status

**Implementado, desligado por padrão.** Nenhuma decisão de ativação foi
tomada — falta rodar 2 backtests (`--pine-config` com/sem
`preTp1StopProtectionEnabled`) e comparar `preTp1StopProtection` +
`overall.expectancyR`/IC contra o baseline, mesmo fluxo de todo flag
Fase 2-4. Fica para quando o usuário rodar essa comparação.

### Verificação

`npm run lint && npm test && npm run build && npm run build:scan && npm
run build:backtest`, `sentinel-trading-engine-review` (toca
`scanner.js`/`opExitRules.js`, invariante P0 de saída).

### Correção pós-review (Codex, PR #106, P1) — look-ahead em passes repetidos na mesma vela

O cron roda `persistScanResults` a cada ~5min enquanto uma vela de
timeframe de sinal (4h/1h) pode continuar sendo "a última fechada" por
horas — o mesmo motivo pelo qual `rf_reverse_bars_count` precisa de dedup
por vela própria. Sem proteção, um avanço do stop pré-TP1 na passagem N
(usando o close desta vela) seria testado de novo na passagem N+1 contra
o `low`/`high` da MESMA vela, agora usando o stop JÁ avançado — um
look-ahead que produz `STOP_HIT` falso usando dado já avaliado com
segurança contra o stop ANTIGO uma passagem antes.

**Reproduzido antes de corrigir** (`entry=100, initial_stop=98,
atrValue=2`, vela `low=99/high=102.5/close=102.5`): passagem 1 não bate
stop (99 > 98), avança para breakeven (100); passagem 2, mesma vela,
99 ≤ 100 → `STOP_HIT` falso.

**Correção**: novo campo `pre_tp1_stop_advanced_candle_time` (grava
`tfData.lastCandleTime` da vela que causou o avanço, só na primeira vez —
mesmo guard de `pre_tp1_stop_advanced_at`). A checagem de `stopHit`
pré-TP1 passa a excluir essa vela específica (`stopAdvancedThisCandle`,
mesmo espírito do `candleUsable` — "vela já resolvida, não relitigar").
Operações que nunca usam o mecanismo (`pre_tp1_stop_advanced_candle_time`
sempre `undefined`) ficam byte-idênticas ao comportamento anterior — a
comparação `undefined !== lastCandleTime` é sempre verdadeira. Uma vela
GENUINAMENTE nova (timestamp diferente) continua testada normalmente
contra o stop já avançado, exatamente como a política "protege a partir
da vela seguinte" já documentada pretendia.

Teste de regressão em `scannerStateMachine.test.js` reproduz o cenário
exato (2 passagens sobre a mesma vela — 2ª não bate stop; 3ª passagem com
vela genuinamente nova e `low` abaixo do breakeven bate stop
corretamente no breakeven, não no stop original). 738 testes passando.

**Nota para investigação futura, não feita aqui**: o mesmo padrão
estrutural (avançar um stop a partir do close de uma vela, sem excluir
essa vela de passagens seguintes) existe no trailing PÓS-TP1
(`advanceTrailingStop`, P0-d, já em produção) — mas o breakeven pré-TP1
fica muito mais perto do meio do range típico de uma vela (a entrada em
si) do que um trail de `trailAtrMult=2.0×ATR` abaixo do close, tornando o
gatilho exato desta rodada bem mais provável na prática. Não investigado
nem corrigido nesta PR (fora de escopo — mexeria num mecanismo já
shippado sem o mesmo tipo de reprodução concreta que motivou a correção
acima); sinalizado aqui para quando alguém retomar `advanceTrailingStop`.

## 55. A/B real do stop pré-TP1: expectância igual, drawdown pior — mantido desligado (2026-08-01)

Usuário rodou as 2 rodadas do `backtest.yml` recomendadas no item 54
(`pretp1-stop-protection-off-baseline` e `pretp1-stop-protection-on-1.0atr`,
mesmos 7 símbolos, mesma janela 2025-08-01→2026-08-01).

### Resultado

**Sem a proteção**: 116 operações, `expectancyR` -0,0452R (bruta
+0,0658R), IC 95% `[-0,269; 0,178]` (cruza zero, inconclusivo),
`profitFactor` 0,917, `maxDrawdownPct` 111,73%, `be: 0`.

**Com a proteção**: 129 operações, `expectancyR` -0,0446R (bruta
+0,0516R), IC 95% `[-0,222; 0,132]` (também inconclusivo), `profitFactor`
0,874, `maxDrawdownPct` 137,76%, `be: 39`.

`report.preTp1StopProtection` (rodada "com"): `total: 129, advanced: 81,
stoppedAtBreakevenPreTp1: 49, reachedTp1AfterAdvance: 29,
otherExitAfterAdvance: 3`. De 81 operações em que o gate disparou, 49
(60%) escaparam de virar perda cheia — mas **29 (36%) teriam chegado ao
TP1 mesmo sem a proteção**, cortadas cedo demais pela sacudida que a
pesquisa de comunidade do item 53 já tinha avisado ser o risco principal.

`totalOps` foi de 116 para 129 (+13, todas na cascata 4h_15m — a SMC
ficou idêntica, 11 nas duas rodadas). Não é erro: saídas mais cedo liberam
o slot de 1-operação-ativa-por-ativo mais rápido, permitindo mais entradas
dentro da mesma janela de 12 meses (efeito colateral esperado do
invariante `active_op_exists`, ver também item 56).

### Conclusão

Expectância ficou estatisticamente igual entre as duas rodadas (a
diferença é ruído, não sinal real), mas o drawdown piorou de forma visível
e o padrão de corte prematuro de vencedores apareceu com peso real (36%
dos disparos). **Recomendação: manter `pineConfig.
preTp1StopProtectionEnabled` desligado por padrão.** Os dados não mostram
ganho, e mostram um custo real e mensurável.

### Verificação

Nenhuma mudança de código a partir desta análise — o flag já nasceu
desligado no PR #106 e continua assim. Dado vem de 2 rodadas reais do
workflow `backtest.yml`, fornecidas pelo usuário (não um backtest novo
rodado nesta sessão).

## 56. Por que tão poucas entradas ao vivo — conselho de 5 papéis independentes (2026-08-01)

Usuário relatou frustração recorrente: painel ao vivo com pouquíssimas
entradas, zero operações ativas no momento, apesar de toda a instrumentação
já feita nas rodadas anteriores. Perguntou explicitamente se o timeframe,
a combinação de gates, ou gatilhos demais são a causa, e se um conselho de
agentes já tinha sido consultado.

### Metodologia

`sentinel-council-review` — 5 papéis independentes (Arquiteto, Trading,
Concorrência, Risco/Overfitting, Testes/Evidência), cada um com o mesmo
contexto factual e instrução de tentar refutar leituras superficiais,
citando `arquivo:linha`. Nenhum dado saiu da máquina (subagentes locais).

### Onde os 5 papéis convergiram sem ressalva

- **Não é ADX/Choppiness (RF) nem o filtro de estrutura/swingLen (SMC)
  mal calibrados.** São cópia literal do Pine real do usuário (protegida
  por golden test, `src/lib/indicators/tier.test.js:55-69`) ou desenho
  original já investigado com dado real (item 52). ADX médio das rejeições
  (16,5) está longe do limiar mais frouxo (18) — mercado genuinamente sem
  tendência na maior parte do tempo avaliado, não um limiar apertado
  demais.
- **Não há bug de concorrência ativo.** Os 3 defeitos que produziriam
  esse sintoma (operação travada, ponteiro órfão, Time Stop que nunca
  dispara) estão `[CORRIGIDO]` e confirmados por leitura direta do código
  atual (`src/api/entities.js:176-253`, `src/lib/opTransition.js:70-134`).
  Zero operações ativas num instante qualquer **não é**, por si, sinal de
  algo quebrado.
- **A causa real de `active_op_exists` (25-28% das rejeições nas duas
  cascatas) é concorrência por design, não regime de mercado.** RF e SMC
  compartilham o MESMO slot por ativo (`assetActiveOps`, sem distinção de
  `cascade`, `src/lib/scanner.js:1401-1405`), e o Time Stop mantém uma
  operação ocupando esse slot por 8 a 16 dias dependendo do tier
  (`src/lib/indicators/tier.js:13-15`).
- **Essa folga (slot por cascata, não por ativo) já está registrada como
  decisão de arquitetura deliberadamente adiada** (item 37 / roadmap
  Bloco 4) — bloqueada atrás do Bloco 0 (vantagem direcional da
  estratégia, ainda ambíguo desde 2026-07-30) por desenho, não por
  esquecimento.

### Dados novos que a síntese trouxe

- **Cálculo de Poisson** (papel Testes/Evidência): taxa histórica medida
  ≈0,32 operação/dia (7 símbolos juntos, 117 ops/365 dias). Um dia com
  zero operações tem **≈73% de probabilidade de acontecer mesmo com o
  sistema saudável**. "Hoje zero" não é evidência de nada quebrado — é o
  comportamento esperado da própria taxa já medida.
- **Comparação entre 2 backtests já existentes** (não um novo): 7 símbolos
  ≈0,0458 op/símbolo/dia vs. 20 símbolos (cesta do Bloco 0) ≈0,0471
  op/símbolo/dia — taxas por-símbolo praticamente idênticas. Mais símbolos
  aumenta volume quase linearmente, sem tocar nenhum limiar — com a
  ressalva já registrada de que altcoins são correlacionadas com BTC (a
  amostra efetiva é menor que a nominal).
- **Achado colateral do Arquiteto**: o gate de R:R (`passesRiskReward`) é
  matematicamente vestigial hoje — `tp1` é derivado como
  `entry ± riskR × tp1R`, então `rr1 == tp1R` sempre; com os defaults
  (`tp1R=1,5`/`minRR=1,2`), **o gate nunca rejeita nada** (já rotulado
  honestamente no código como `CONFIGURED_MULTIPLE`,
  `src/lib/scanner.js:79-87`). Não explica a escassez (contribui ~0% das
  rejeições), é só dívida de clareza arquitetural — parece um filtro ativo
  e não é.

### Refutação real entre papéis

O especialista de Trading propôs desligar a cascata SMC (11 ops/ano,
expectância -0,778R, nunca teve equivalente no Pine) para liberar o slot
compartilhado com a RF. Arquiteto e Risco/Overfitting alertaram que
qualquer alavanca que *aumente* volume/exposição atrelada à "vantagem
ainda não provada" (Bloco 0 ambíguo) repetiria o erro metodológico que o
próprio roadmap já nomeou noutro contexto. **Avaliação: os dois
argumentos não colidem de fato** — desligar SMC **reduz** exposição a um
componente já com expectância negativa medida (risco a menos, não a
mais), diferente de "abrir o Bloco 4" (que aumentaria exposição
simultânea por ativo, essa sim bloqueada até o Bloco 0 fechar).

### Recomendação final

Não tocar em ADX/Choppiness/estrutura SMC/swingLen; não abrir o Bloco 4
antes do Bloco 0 fechar; não ativar mais de um flag do Bloco 1 de uma vez.
Como próximo passo de baixo custo: (1) rodar 1 backtest dos últimos 60-90
dias com os mesmos 7 símbolos/flags do `regime-trigger-diagnostico` e
comparar `rfRegime.byReason`/`adxStats.avgRejected` contra o baseline de
12 meses — decide se o regime atual está excepcionalmente fraco ou é
"business as usual"; (2) checar `SystemLog` (erro/warn, 48h) por
`duplicate_active_ops_detected`/locks sobrepostos, só pra descartar bug
sem indício ativo; (3) considerar desligar a cascata SMC por padrão
(código pequeno, reversível, reduz risco); (4) considerar reabrir a
preferência de 7 símbolos fixos, dado o item de comparação acima — decisão
do usuário, não recomendação unilateral. Nenhuma dessas 4 ações foi
executada nesta sessão — ficam para quando o usuário autorizar cada uma.

### Verificação

Nenhuma mudança de código — item é só registro da síntese do conselho.

### Ação 3 executada: cascata SMC desligada por padrão em ativos novos (2026-08-02)

Usuário autorizou explicitamente ("Sim eu autorizo") a ação (3) da
recomendação acima, depois de eu comparar as 3 pendências abertas na sessão
e recomendar esta como a de maior retorno esperado: reduz exposição ao
componente com expectância negativa medida acima E libera o slot
compartilhado `assetActiveOps` (RF e SMC disputam o mesmo slot por ativo,
`src/lib/scanner.js:1401-1405`; uma operação SMC ocupa esse slot por 8-16
dias via Time Stop) — é a única alavanca das três discutidas com chance
real de aumentar o volume de operações RF ao vivo, o problema original
deste item.

**Mudança**: `src/components/assets/AddAssetForm.jsx:49` —
`smc_enabled: true` → `smc_enabled: false` para todo ativo NOVO criado a
partir de agora. `smc_confirm_4h15m` (linha seguinte, mecanismo diferente
— gate extra sobre a cascata RF, sem evidência negativa medida) não foi
tocado, fora de escopo desta ação. Schema (`MonitoredAsset.jsonc`)
atualizado para refletir o novo default.

**O que NÃO muda**: ativos criados entre 2026-07-19 (quando o default
passou a ser `true`) e 2026-08-02 mantêm o valor gravado na criação — esta
mudança não é retroativa, é só o valor pré-preenchido no formulário de
"Adicionar ativo" daqui pra frente. Para desligar num ativo já existente,
o usuário precisa ir em "Configurar ativo" → seção "Cascata SMC/ICT" →
desligar o toggle "Ativar cascata 1H → 5M" manualmente por ativo (nenhuma
escrita em Firestore de produção foi feita nesta rodada).

### Retomada (2026-08-03) — `minScore` é o gargalo? O timeframe 4h/1h é grande demais?

Usuário voltou a perguntar, com duas hipóteses novas e específicas: (1) o
timeframe 4h/1h escolhido pode estar errado — poucas operações em meses/
anos de dado significa nunca fechar um "ciclo" de validação; (2) ativos
que ficam "em observação" no Dashboard sem virar BUY/SELL podem estar
presos porque `minScore` é exigente demais. Pediu pesquisa de comunidade
real e uma resposta honesta, não concordância automática. Rodei 2 agentes
em paralelo: 1 leitura de código (fatos internos que faltavam) + 1
pesquisa externa (WebSearch — comunidade quant/algo trading).

#### Hipótese do score — refutada, de novo, com mais detalhe

Já tinha sido descartada uma vez (item 49: usuário testou com
`minScore=75`, padrão, e não resolveu). Desta vez o motivo estrutural veio
à tona: `MIN_SCORE` (`src/lib/scanner.js:1182`) é aplicado **antes** de
qualquer `SignalEvent` existir (decide se o candidato nasce,
`scanner.js:1193/1199`) — o gate de regime (ADX/Chop, `evaluateRegime`) só
roda **depois**, quando o motor já tenta converter um `SignalEvent`
existente em operação (`scanner.js:1725`/`2206` RF, `1889`/`2342` SMC). São
etapas sequenciais, não concorrentes. E bater 75 é estruturalmente fácil:
o item 45.7 já tinha medido que `followThrough` (25 pontos) e "preço vs
filtro RF" (10 pontos) em `calculateSignalStrength`
(`src/lib/indicators/confluence.js:98-156`) são **a mesma condição
booleana** que gerou o sinal — 35 dos 100 pontos vêm de uma variável só,
tautológica em relação à própria emissão. `score`/`minScore` também **não
aparece em nenhum motivo do enum `last_rejection_reason`** (confirmado por
grep) — porque o funil de rejeição só existe para sinais que já nasceram,
e nascer já exige ter passado no score.

**Ressalva real, apontada por review externa (Codex, PR #124) e
confirmada por leitura de código**: os 35 pontos garantidos não tornam 75
"fácil de bater" por si só — ainda faltam 40 dos 65 pontos restantes
(MACD 20 + EMA 20 + RSI 15 + Volume 10 + gate RF residual 10), e
`scanner.js:1193` descarta o candidato **silenciosamente** quando
`strengthResult.passed` é `false` — nenhum contador, nenhum log, nenhuma
entrada em `entryFunnelOutcomes` para esse caso (confirmado por grep, zero
ocorrência). Ou seja: **não existe hoje nenhuma medição de quantos flips
RF confirmados (`r.confirmed.confirmedSignal`) são descartados só pelo
score antes de virar `SignalEvent`.** O argumento estrutural acima (por
que bater 75 tende a ser alcançável quando o sinal já existe) e o teste
real do usuário (item 49, `minScore=75` não resolveu o volume baixo)
seguem de pé, mas **não são a mesma coisa que medir a taxa de rejeição
bruta** — essa lacuna de instrumentação é real e listada como próximo
passo abaixo, não fechada nesta rodada.

#### O que realmente prende um sinal em "Observando"

`👀 Observando BUY/SELL` no `AssetCard.jsx:198-200` significa que **já
existe um `SignalEvent` real** (já passou no `minScore`) sem
`TradeOperation` ativa ainda — não "esperando pontuação". A causa
dominante de um sinal ficar preso aí, já medida com dado real duas vezes
neste projeto (itens 50 e 52): **regime rejeitado** — `regime_rejected`
é o motivo mais citado entre as rejeições RF já registradas (69,4% delas,
item 50, 3.750/5.404 avaliações rejeitadas); e, dentro só das rejeições
de regime, 97% são especificamente `adx_weak` (item 52) — com ADX médio
das rejeições (16,5-18,26) **abaixo até do limiar mais frouxo da tabela
de tier**. Isso não é "gate apertado demais" — é mercado genuinamente sem
tendência na maior parte do tempo avaliado, e a tabela ADX/Choppiness é
cópia literal do Pine real do usuário (protegida por golden test), não um
número que o Sentinel inventou e pode simplesmente afrouxar sem divergir
do TradingView real.

**Ressalva de precisão (Codex, PR #126)**: o parágrafo acima juntava as
duas medições numa faixa única "69-97% das rejeições RF são `adx_weak`"
— impreciso, porque são dois recortes diferentes (69,4% é a fatia de
TODAS as rejeições que são regime; 97% é a fatia só DENTRO das rejeições
de regime que são `adx_weak`), e o denominador (avaliações rejeitadas,
não candidatos únicos nem conversões bem-sucedidas) não sustenta uma
leitura de "mortalidade de candidato". Corrigido acima.

**Ressalva real, apontada por review externa (Codex, PR #124) e
confirmada por leitura de código**: o que está medido acima descreve o
que acontece com um sinal **durante a janela ativa de retry** — não
necessariamente por que um card ESPECÍFICO ainda mostra "Observando"
agora. Um sinal RF que envelhece além da janela de retry (4h) só ganha
`expired_logged: true` (item 47.2); nem `Dashboard.jsx:324`
(`recentSignals.find(...)`, sem checar idade/`expired_logged`/
`is_dismissed`) nem `AssetCard.jsx:198-200` (`else if (latestSignal)`,
mesma ausência de filtro) descartam esse sinal morto — ele continua sendo
o "último sinal" exibido até outro `SignalEvent` do mesmo ativo entrar
nos 50 mais recentes (`SignalEvent.list('-created_date', 50)`,
`Dashboard.jsx:49-52`) e substituí-lo. Ou seja: um card em "Observando"
pode estar exibindo um sinal que **nenhum gate está mais avaliando** —
as porcentagens de regime acima explicam o funil enquanto o sinal está
vivo, não garantem que é a explicação para o que a tela mostra num
instante qualquer.

#### A hipótese do timeframe — parcialmente procedente, mas não como o usuário formulou

Pesquisa de comunidade (QuantPedia, Ernie Chan, AQR, guias de forward-
testing — Reddit bloqueado nesta sessão, ver ressalva na pesquisa
completa) converge sem exceção: **timeframe mais alto produzindo menos
operações é o comportamento ESPERADO de um filtro de tendência, não
sintoma de mal ajuste.** Nenhuma fonte tratou ~11-17 operações/ativo/ano
(o que o Sentinel já mede) como volume anormalmente baixo pra 4h.

A parte que É procedente: a preocupação sobre nunca fechar um "ciclo" de
validação é real e tem base na própria literatura de backtesting — os
patamares citados (≈30 = piso estatístico, ≈100 = "confiabilidade
limitada", 200-500 = "padrão institucional") batem com o que este projeto
já usa (`docs/known-risks.md` item 44, `minTrades=30`; roadmap Bloco 0,
~300 operações). No ritmo medido do Sentinel (~0,047 op/símbolo/dia,
praticamente igual em carteiras de 7 e 20 símbolos — item 56 acima).
Portfólio de 9 ativos ao vivo: ≈12-13 op/mês → ≈30 operações em 2-3 meses,
≈100 em 8-10 meses, 200-500 (o patamar "institucional") em **1,5 a 4
anos**. Isso é real e vale levar em conta — mas é uma característica
estrutural de QUALQUER estratégia de tendência em timeframe alto, medida
e documentada por múltiplas fontes independentes, não uma falha de
configuração deste projeto.

**Ressalva própria da pesquisa** (não fonte externa, extrapolação lógica
documentada como tal): operações em cripto multi-ativo tendem a ser mais
correlacionadas entre si (beta com BTC) do que trades de ativos
verdadeiramente independentes — a amostra EFETIVA do portfólio pode ser
menor que a contagem bruta sugere. Não há fonte específica pra cripto
confirmando isso, é inferência a partir do princípio geral "trades no
mesmo regime reduzem amostra efetiva".

#### Recomendação (nenhuma executada nesta rodada — decisão do usuário)

1. **Não afrouxar ADX/Choppiness/estrutura SMC** — evidência direta contra
   (ADX médio das rejeições já abaixo do limiar mais frouxo; mexer aqui
   diverge do Pine real do usuário no TradingView, não é ajuste de
   parâmetro solto).
2. **Mais símbolos escaneados é a alavanca já medida como quase-linear**
   (0,0458 vs. 0,0471 op/símbolo/dia entre 7 e 20 símbolos, item 56) —
   aumenta a amostra sem tocar em nenhum limiar. Ressalva: correlação
   entre altcoins reduz o ganho de amostra EFETIVA (ver acima).
3. **Baixar o timeframe (ex.: 1h→15m em vez de 4h→15m) aumentaria a
   frequência de verdade, mas é uma mudança de ESTRATÉGIA, não uma
   correção** — diverge do Pine real do usuário (hoje definido em 4h no
   TradingView), exigiria repensar paridade Pine
   (`.claude/rules/pine-parity.md`) e vem com o trade-off oposto e bem
   documentado: mais ruído, mais whipsaw, sinal de qualidade pior por
   operação. Decisão de produto, não bug fix — não recomendo sem o
   usuário decidir isso conscientemente, ciente do trade-off.
4. **Aceitar o horizonte de validação mais longo** é a opção de menor
   risco — é o que o próprio Bloco 0 já está fazendo (múltiplas janelas
   independentes em vez de esperar uma amostra ao vivo gigante).
5. **Fechar as 2 lacunas de instrumentação que a review externa (Codex,
   PR #124) encontrou** (não implementado nesta rodada): (a) um contador
   de flips RF confirmados descartados só pelo score, ao lado de
   `entryFunnelOutcomes` — responde de fato "quantos candidatos o score
   mata" em vez de inferir por estrutura; (b) filtrar `Dashboard.jsx`/
   `AssetCard.jsx` por `expired_logged`/idade antes de rotular
   "Observando", pra não confundir sinal morto com sinal ainda em
   avaliação ativa. Nenhuma muda decisão de entrada/saída — só
   observabilidade, mesma categoria dos itens 49-52.

**Conclusão direta**: a hipótese do score continua sem evidência a favor
(já tinha sido testada e descartada pelo usuário; a explicação estrutural
segue de pé), mas **a medição direta que fecharia essa dúvida em
definitivo não existe hoje** — ver ressalva acima. A preocupação sobre
timeframe/ciclo de validação é legítima e baseada em evidência real — mas
a causa não é um bug ou um limiar mal calibrado, é uma característica
inerente à combinação timeframe-alto + filtro de regime que este projeto
escolheu deliberadamente (e que é literalmente o Pine real do usuário).
Mudar isso é possível, mas é reabrir a estratégia em si, não consertar
algo quebrado. E o diagnóstico de "Observando" precisa da ressalva de
sinal expirado/não filtrado acima antes de ser tomado como prova completa
do que uma tela específica está mostrando num instante qualquer.

#### Verificação

Nenhuma — rodada de análise pura, sem mudança de código (convenção já
vigente, `.claude/rules/documentation-truth.md`: registrar análise
concluída não pede confirmação prévia, só mudança de comportamento pede).

### Fase 0 — contagem real de sinal bruto RF 1h vs. 4h (2026-08-03)

Usuário pediu plano e execução para as opções acima; aprovado rodar a
"Fase 0" da opção "baixar/adicionar timeframe": medir quantos `SignalEvent`
RF em 1h já existem no Firestore real antes de investir em qualquer
backtest experimental — o cálculo é barato porque `scanner.js` já computa e
persiste RF em 1h/4h/1d pra todo ativo (`scanner.js:981-988`), só o Entry
Motor bloqueia entrada fora do 4h (`scanner.js:1696`).

**Mecânica**: `scripts/count-1h-signals.mjs` (novo, read-only, PR #125) +
`.github/workflows/count-signals.yml` (disparo manual — a integração do
GitHub usada nesta sessão não tem permissão pra disparar `workflow_dispatch`
via API, o usuário rodou manualmente pela aba Actions). Conta
`SignalEvent{source: range_filter}` por timeframe via `backend.entities.
SignalEvent.filter(...)` (query de igualdade, sem índice composto novo).

**Resultado real** (rodado 2026-08-03, janela = todo o histórico existente
no Firestore, não uma janela desenhada):

| Timeframe | Total | Janela | Símbolos | Sinal/símbolo/dia |
|---|---|---|---|---|
| RF 1h | 86 | ~25,0 dias (2026-07-09→2026-08-03) | 9 (todos monitorados) | ≈0,382 |
| RF 4h | 20 | ~22,3 dias (2026-07-10→2026-08-01) | 9 (todos monitorados — só 7 produziram sinal; PENDLE e ZRO ficaram em ZERO, mas estavam sendo escaneados o período inteiro) | ≈0,100 |

Razão bruta (total/total, sem normalizar): 4,3x. Razão normalizada por
símbolo-dia (mais correta): **≈3,8x** (`20 ÷ (9 × 22,3)` vs. `86 ÷ (9 ×
25,0)`) — **correção de revisão externa (Codex, PR #126)**: a 1ª versão
deste texto dividia o total de 4h só pelos 7 símbolos que produziram
ALGUM sinal na janela, e não pelos 9 efetivamente monitorados/expostos ao
período inteiro (PENDLE/ZRO continuavam sendo escaneados, só não geraram
sinal 4h) — usar denominadores diferentes por timeframe inflava
artificialmente a taxa do 4h e subestimava a razão real (dava ≈3,0x em
vez de ≈3,8x). Por símbolo individual (só os 7 que produziram sinal nos
dois lados): de 2,25x (METIS) a 8x (DYDX) — variação grande, sem um
padrão único.

**Fato**: existe volume de sinal bruto 1h suficiente pra justificar
prosseguir pra uma Fase 1 (backtest experimental) — não é um "quase
nada a mais" que 4h.

**Ressalva importante, mesma disciplina do `minTrades=30` que este
projeto já usa em outros lugares (item 44)**: a amostra é pequena (n=20
sinais 4h, só ~3 semanas de histórico ao vivo) — é direcional, não
conclusiva. E é contagem de **sinal bruto**, não de operação.

**Correção de revisão externa (Codex, PR #126)**: a 1ª versão deste texto
dizia "69-97% dos candidatos RF morrem no gate de regime", citando os
itens 50/52 — **isso não é o que esses itens medem**. Item 50:
`regime_rejected` é 69,4% das REJEIÇÕES já registradas (3.750/5.404
avaliações rejeitadas — denominador é avaliação, não candidato único;
retry do mesmo sinal em passadas sucessivas pode contar mais de uma vez;
não inclui os candidatos que viraram operação com sucesso). Item 52: 97%
é a fatia DENTRO das rejeições de regime que são especificamente
`adx_weak` — um recorte do mesmo grupo, não uma segunda taxa de
mortalidade independente. Misturar os dois numa faixa "69-97%" e chamar
de mortalidade de candidato foi impreciso. **O que dá pra afirmar com o
que já está medido**: regime (ADX/Choppiness) é, disparadamente, o motivo
de rejeição mais citado entre as rejeições que o funil já registrou — não
dá pra converter isso num percentual exato de "candidato nasce → morre no
regime" sem contar também os candidatos que nunca foram rejeitados
(viraram operação). Como o 1h é intrinsecamente mais ruidoso que o 4h
(movimentos de preço mais curtos sustentam tendência por menos tempo), a
expectativa direcional continua a mesma — sobreviver menos ao gate de
regime, não mais —, mas o tamanho exato do efeito não está medido. Isso
é exatamente a pergunta que uma Fase 1 responderia, com o denominador
certo desde o início.

**Recomendação**: o número já é suficiente pra justificar avançar pra
Fase 1 se o usuário quiser seguir essa linha — não fechou a porta. Não
implementada nesta rodada, aguardando decisão do usuário.

#### Verificação

`node --check` no script + `npm run lint` (PR #125). Sem mudança em
`scanner.js`/gate/threshold/timeframe ao vivo — só leitura.

### Fase 1 — mecanismo "RF 1h condicionado ao 4h" (PR #128, mergeado 2026-08-03)

Registro retroativo — o mecanismo em si foi implementado e mergeado
(PR #128), mas a documentação desta subseção nunca foi escrita naquela
rodada (gap fechado agora, junto com o modo sombra abaixo). Usuário
aprovou avançar da Fase 0 pra Fase 1 ("sim pode começar a fase 1, siga as
diretrizes e os agentes... que fique perfeito e blindado") — desenho
produzido por um `sentinel-council-review` de 5 papéis (Arquiteto, Trading,
Concorrência, Testes/Evidência, Segurança), com 2 decisões do usuário via
`AskUserQuestion`:

1. **Desenho: "1h condicionado ao 4h"** (não "1h substitui o 4h") — um
   sinal RF 1h só vira candidato de entrada quando o RF 4h já está na
   MESMA direção, reusando o gate de regime (ADX/Choppiness/tier) **já
   avaliado no 4h** — nunca recalcula regime em dado de 1h, evitando abrir
   a pergunta não-validada de recalibrar esses limiares pra esse timeframe.
2. **Rigor: "sombra + retrospectivo exploratório"** (não só um backtest
   retrospectivo rápido) — as 3 janelas retrospectivas 2023-2026 já foram
   "gastas" pelo Bloco 0 (`docs/roadmap.md`), então o braço que realmente
   decide é observação prospectiva ao vivo (ver subseção "Modo sombra"
   abaixo), não mais um backtest na mesma janela.

**O que foi implementado** (`src/lib/scanner.js`): `pineConfig.
rf1hCondEnabled` (default `false`) existe **só** em
`scripts/backtestPineConfig.js` — deliberadamente **não espelhado** em
`src/lib/pineParser.js`/`scripts/adminPineConfig.js` (os 2 arquivos que
alimentam `strategyConfig/current` no Firestore, gravável por qualquer
sessão anônima, `CLAUDE.md` decisão item 1) — travado por 3 testes de
tripwire (`rf1hCondTripwire.test.js`) que leem o texto-fonte dos 3
arquivos. Cascade novo e distinto `'rf1h_cond4h_15m'` (nunca `'1h_5m'`
SMC nem `'4h_15m'` nativo — rótulo errado rodaria a lógica de saída
errada). `buildTradeOpData` ganhou um `cascadeInfo` opcional (default
`null`, byte-idêntico pros 2 call sites de produção existentes).
`signalArbitration.js`'s `CASCADE_RANK` e `backtestEngine.js`'s
`buildRegimeSection` (bucketização `byCascade`) atualizados pra não
misturar diagnóstico das 2 cascatas RF. Codex (PR #128) pegou um P1 real
no primeiro commit — `tier_time_stop_bars` (calibrado em barras de 4h)
não era convertido ao stampar `signal_timeframe:'1h'`, fazendo o Time Stop
disparar 4x cedo demais — corrigido no mesmo PR (`* 4`, mesmo precedente
já usado na promoção SMC→4h).

### Modo sombra prospectivo — braço decisório da Fase 1 (2026-08-03)

Por desenho do conselho, o mecanismo acima sozinho não decide nada — é
backtest-only por construção. O braço que decide é observação prospectiva
ao vivo, log-only, por semanas, nunca abrindo `TradeOperation` real.
Usuário pediu para começar ("pode começar o modo sombra").

**Implementação** (detalhe técnico completo no plano de sessão, resumo
aqui): novo workflow `.github/workflows/scan-shadow.yml` (cadência de
15min, `workflow_dispatch` manual disponível) roda `src/lib/scanner.js`
**sem nenhuma modificação**, com `pineConfig.rf1hCondEnabled` forçado a
`true` (`scripts/adminPineConfigShadow.js`, único lugar do projeto inteiro
que liga essa flag fora de teste/backtest) e todo write redirecionado para
coleções Firestore isoladas, prefixadas `experimentalRf1hShadow*`
(`scripts/adminEntitiesShadow.js`) — nunca a coleção real de produção.
Telegram mutado (`scripts/adminTelegramShadow.js`). `MonitoredAsset` é a
única exceção: lê a coleção REAL (`monitoredAssets`, pra observar o
universo real de ativos monitorados) mas nunca escreve nela (os 2 write
sites de bookkeeping de `scanAsset`/`scanAllAssetsInner` viram no-op) —
achado desta rodada que evitou um desenho ingênuo de "só duplicar
`adminEntities.js` com prefixo". Isolamento travado por
`adminEntitiesShadowTripwire.test.js` (lê o texto-fonte, falha se qualquer
nome de coleção real sem prefixo aparecer como argumento de
`db.collection(...)`/`createEntity(...)`), e reforçado pelo fato de
`scanner.js` ficar 100% intocado nesta rodada — um bug nos módulos sombra
só pode afetar as coleções sombra.

**Efeito colateral do desenho — corrigido (review externa, Codex, PR #130,
2026-08-03)**: a frase original aqui dizia que a cascata RF **nativa**
(`'4h_15m'`) ficava "sombreada de graça" dando um "controle direto" pra
comparar volume entre as 2 cascatas. **Isso está incompleto**: as 2
cascatas disputam o MESMO slot `assetActiveOps` por ativo
(`rf1h_cond4h_15m` tem `CASCADE_RANK` igual a `4h_15m`,
`src/lib/signalArbitration.js:46` — mesmo rank faz
`classifyCascadeRelation` devolver `tfRelation:'same'`, e
`planSignalArbitration` trata isso como reforço/no-op, nunca abre uma 2ª
operação). Ou seja: se a cascata nativa já tem uma operação ativa num
ativo, um candidato experimental na mesma direção é absorvido (não conta
pra `byCascade['rf1h_cond4h_15m']`) — e vice-versa. **O bucket nativo
sombreado NÃO é um controle limpo** (o que teria acontecido só com a
nativa, sem a experimental competindo pelo slot) — é o que sobrou depois
da disputa pelo slot compartilhado. Isso enviesa a "Comparação secundária"
abaixo na direção de UNDERSTATE a vantagem real de volume (operações
nativas que a experimental "roubou" o slot não aparecem em nenhum dos dois
buckets como um ganho líquido claro) — mas na direção OPOSTA de qualquer
alegação de que os 2 buckets são independentes. **Não implementado nesta
rodada** (exigiria uma 2ª instância do modo sombra rodando só com a
cascata nativa, infraestrutura nova): a comparação real e mais confiável
de "quantas operações a nativa produziria sozinha" continua sendo a
produção real (`tradeOperations`/`signalEvents` de verdade, sem
`rf1hCondEnabled`) — não o bucket nativo dentro do próprio scan sombra.

**Critério de decisão — registrado ANTES de qualquer leitura contar como
decisão** (`scripts/analyze-shadow-rf1h.mjs`, rodável sob demanda, nunca
decide sozinho — só formata o dado):

- **Amostra mínima**: n≥30 operações fechadas na cascata experimental
  (piso do CLT, mesmo `minTrades` usado em todo o resto do projeto, item
  44). **Amostra-alvo**: n≈100 antes de qualquer leitura contar como
  decisão-grade.
- **Correção estatística**: como esta cascata compete com a MESMA pergunta
  ainda aberta do Bloco 0 (vantagem direcional do RF, hoje 4h,
  `docs/roadmap.md`) — não é um teste independente — o IC da expectância
  usa correção de Bonferroni pra m=2 comparações: z=2.24 (alpha=0.05/2
  two-sided) em vez do z=1.96 padrão. `expectancyCIAtZ` (novo, aditivo, em
  `src/lib/tradeMetrics.js`) calcula esse IC sem tocar `summarizeOps` (que
  mantém o 1.96 fixo usado em todo o resto do projeto).
- **Comparação secundária** (o objetivo original — aumentar volume):
  operações/mês de `rf1h_cond4h_15m` vs `4h_15m`, medidas em paralelo na
  mesma janela sombra (`buildShadowComparison` calcula os 2 números e a
  razão entre eles — **sem** um multiplicador hard-coded de "meaningfully",
  de propósito: é leitura humana dos 2 números, não um limiar automático).
  **Ressalva (Codex, PR #130)**: os 2 buckets NÃO são independentes — ver
  "Efeito colateral do desenho" acima. Ler como `total combinado
  (nativa+experimental) vs o que a produção real vem gerando só com a
  nativa` (a fonte de comparação mais limpa), não como os 2 sub-buckets
  do próprio scan sombra competindo entre si.
- **Condição de sucesso**: n≥100, IC-Bonferroni não cruza zero, contagem
  de operações/mês meaningfully maior que a nativa — as DUAS partes juntas,
  nunca só a primeira. `scripts/analyze-shadow-rf1h.mjs` nunca rotula
  "decisão-grade" sozinho a partir de amostra+IC — o veredito da cascata
  experimental diz explicitamente "falta confirmar volume/mês" até esse
  segundo número ser lido junto (achado de revisão externa, Codex, PR #129,
  P2 — a 1ª versão declarava decisão-grade só com o critério estatístico).
  Só então uma conversa sobre produção (decisão do usuário, não automática).
- **Condição de parada antecipada**: achado estrutural que invalide o
  desenho (confirmação 15m nunca disponível, regime sempre reprova, bug
  real) — reportar na hora, não esperar n=30.
- **Leitura parcial (n<30) é só debug** (confirmar que o mecanismo está
  funcionando), nunca avaliação de performance.

**Correções de revisão externa (Codex, PR #129) antes do merge**:

1. **P1 — cadência horária amostrava só 1 de cada 4 fechamentos de 15m.**
   `check15mConfirmation` (`src/lib/scanner.js`) só examina o ÚLTIMO
   candle 15m fechado no instante da chamada — um alinhamento que aparece
   e reverte dentro da mesma hora ficava permanentemente invisível pro
   scan sombra, mesmo com a janela de retry de 4h (ela reavalia o SINAL,
   não os candles 15m intermediários perdidos), enviesando pra baixo tanto
   a contagem de operações/mês quanto a composição da amostra de
   expectância. Corrigido: cadência de **15min** (`*/15 * * * *`), alinhada
   1:1 com o próprio candle de confirmação — nenhum fechamento de 15m fica
   sem chance de ser visto. Ainda ~21x mais leve que a cadência real de
   ~5min (96 passadas/dia vs ~312) — compromisso deliberado com a quota
   compartilhada do Firestore (Spark gratuito, todo o projeto, real +
   sombra), reversível sem custo se os logs mostrarem aperto de quota.
2. **P1 — faltavam os índices compostos das coleções sombra.** Firestore
   indexa por nome exato de coleção; os 5 índices compostos que
   `firestore.indexes.json` já tinha pras coleções reais
   (`signalEvents`/`tradeOperations`/`assetStates`) não cobrem
   `experimentalRf1hShadow*` — sem os equivalentes, toda query composta que
   `scanner.js` faz (ex.: `TradeOperation.filter({symbol, asset_id,
   status:[...]})`, `SignalEvent.filter({asset_id, source, timeframe},
   '-created_date')`) falharia com `FAILED_PRECONDITION` assim que o
   workflow rodasse — o modo sombra nunca acumularia nada. Corrigido:
   5 entradas espelhadas em `firestore.indexes.json`. **Ação pendente do
   usuário**: rodar o deploy manual (tela "Actions" → workflow "Deploy
   Firestore rules & indexes" → botão "Run workflow") ANTES da primeira
   execução real do scan sombra — mesmo passo manual que rules já exige
   (item 5), sem o qual o workflow falha na primeira tentativa.
3. **P2 — veredito "decisão-grade" ignorava o critério de volume.** Ver
   "Condição de sucesso" acima.

**Fora de escopo desta rodada**: backtest retrospectivo exploratório
pré-2023 (braço separado, ainda não começado); UI/dashboard de progresso;
qualquer decisão sobre produção — esta rodada só COMEÇA o acúmulo.

#### Verificação

`npm run lint && npm test && npm run build && npm run build:scan-shadow`.
`sentinel-trading-engine-review` — mesmo sem tocar `scanner.js`, os
módulos sombra implementam a mesma garantia transacional (CAS/idempotência,
reusando `src/lib/opTransition.js`) que a produção. **Antes do 1º disparo**
(manual ou agendado): rodar o deploy de índices (ver item 2 acima) — sem
isso o workflow falha. Depois: disparo manual (`workflow_dispatch`) uma vez
pra confirmar que roda limpo antes de deixar o `schedule:` cuidar do resto.

#### Leitura de progresso (2026-08-07) — tempo/consumo e amostra até agora

Usuário perguntou quanto tempo/consumo o modo sombra já teve e quantos dados
já foram coletados. Fato, direto da fonte (GitHub Actions + relatório diário
`analyze-shadow.yml`, não estimado):

- **Tempo rodando**: 1º disparo de `scan-shadow.yml` em 2026-08-04T00:12Z;
  39 disparos completados até 2026-08-07T11:33Z (~3d 11h de janela).
- **Cadência real ≠ configurada**: `*/15 * * * *` previa ~336 disparos nessa
  janela; só 39 aconteceram — gap médio real de ~132min (mín. 56min, máx.
  6h07min) entre disparos, não 15min. **Mesmo fenômeno do item 18** (fila
  global de `schedule:` do GitHub Actions sem SLA), agora confirmado também
  no cron do modo sombra, não só no `scan.yml` de produção — o disparo
  externo via cron-job.org (mitigação do item 18) cobre só `scan.yml`, não
  `scan-shadow.yml`.
- **2 dos 39 disparos foram cancelados pelo próprio GitHub** (2026-08-06,
  18:11Z e 16:22Z) — mesmo padrão diagnosticado no PR #142 (`runner_id: 0`,
  sem log, cancelado após ~1h preso na fila sem runner atribuído): fila de
  runner, não bug do código do modo sombra.
- **Consumo de Actions**: irrelevante — cada disparo bem-sucedido leva
  ~50s de execução real; 37 disparos × ~50s ≈ 31min de compute total até
  agora. Repositório público = minutos de GitHub Actions gratuitos/
  ilimitados, sem custo. Cota do Firestore (Spark grátis) não é medível
  daqui (sem acesso ao console do Firebase nesta sessão) — desenhada por
  construção pra ficar dentro do plano gratuito (ver cadência 15min acima).
- **Amostra coletada até o último relatório (2026-08-06T15:18Z,
  `analyze-shadow.yml` run #3)**: **zero** operações fechadas nas duas
  cascatas — `rf1h_cond4h_15m` (experimental) `total:0, counted:0` e
  `4h_15m` (controle nativo sombreado) `total:0, counted:0`. As duas
  seguem `INCONCLUSIVO (amostra < mínimo)`; nem o piso n≥30 foi tocado,
  muito menos o alvo n≈100.

**Hipótese (não fato)**: a leitura zero bate com a seca de mercado já
registrada — item 60 (2026-08-04: 8 de 9 ativos monitorados com viés de
baixa correlacionado, 14 dias sem operação nova na produção real). Como o
modo sombra observa o mesmo mercado ao vivo, ausência de sinal na produção
tende a significar ausência de sinal também no braço experimental — não é
evidência de bug no desenho do modo sombra em si.

**Sem decisão a tomar aqui** — critério completo (n≥30 piso, n≈100 alvo,
IC-Bonferroni, comparação de volume) continua em "Critério de decisão"
acima; com amostra em zero, é cedo demais até pra leitura parcial de debug.
Registrado apenas como leitura de progresso, a pedido do usuário.

### Braço exploratório — backtest retrospectivo pré-2023 (critério registrado ANTES de rodar, 2026-08-03)

Usuário pediu para rodar o 3º braço da validação (rotulado EXPLORATÓRIO em
todo lugar, nunca decisório — o braço que decide é o modo sombra acima).
Mesma disciplina de registrar critério/desenho antes do resultado.

**Janela**: `2022-07-27 → 2023-07-27`. As 3 janelas do Bloco 0 já cobrem
`2023-07-27` até hoje (item 48: `2025-07-27→2026-07-27`,
`2024-07-27→2025-07-27`, `2023-07-27→2024-07-27` — a mais antiga,
`bloco0-janela3-2023`) — esta janela é a imediatamente anterior, sem
sobreposição nem buraco entre as duas.

**Ativos**: os mesmos 7 símbolos default do workflow
(`BTCUSDT,ETHUSDT,FETUSDT,PENDLEUSDT,ZROUSDT,DYDXUSDT,PAXGUSDT`) — "mesma
carteira da run de controle 4h", igual ao que `bloco0-janela3-2023` já usou.
**Ressalva de qualidade de dado** (verificado em `scripts/fetch-backtest-data.mjs`
antes de rodar, não assumido): a API da Binance devolve candles a partir de
quando o símbolo realmente começou a negociar quando a janela pedida começa
antes disso — não lança erro nem trava o download. Símbolos mais novos da
carteira (ZRO, possivelmente PENDLE) podem contribuir pouco ou nada no
início/toda a janela — **esperado, não bug** — a leitura por símbolo do
relatório (`analyze-backtest.mjs`) mostra isso explicitamente.

**Configuração — DOIS runs, não um** (corrigido, review externa Codex,
PR #130, 2026-08-03: a 1ª versão deste texto propunha comparar
`report.byCascade['4h_15m']` contra `['rf1h_cond4h_15m']` de um único run
com a flag ligada — **inválido**, porque as 2 cascatas disputam o MESMO
slot `assetActiveOps` por ativo — mesmo `CASCADE_RANK`, mesma classe de
"reforço absorvido sem abrir 2ª operação" que o modo sombra tem, ver
subseção "Modo sombra" acima. O bucket `4h_15m` DENTRO de um run com a
flag ligada não é o mesmo que rodar só a nativa):

1. **Run de controle** — pineConfig padrão, SEM `rf1hCondEnabled` (deixar
   "Overrides do pineConfig em JSON" em branco). Só a cascata nativa
   `4h_15m` roda; `report.overall`/`report.byCascade['4h_15m']` é a
   contagem-baseline real desta janela.
2. **Run combinado** — `pine_config: {"rf1hCondEnabled": true}`. Produz
   `report.byCascade['4h_15m']` E `['rf1h_cond4h_15m']` juntos (auto-
   vivificado por `buildReport`, `src/lib/backtestEngine.js:517-523` —
   sem mudança de código), mas os 2 sub-buckets internos deste run
   **não são um contraste limpo entre si** — só o **total combinado**
   (`report.overall`, soma das 2 cascatas) é comparável de forma válida
   contra o Run 1.

**Comparação válida**: Run 2 `report.overall.total`/`expectancyR` vs Run 1
`report.overall.total`/`expectancyR` — responde "ligar isso aumenta o
volume/muda a expectância combinada desta janela?". A composição interna
do Run 2 (quanto veio de cada cascata) é informativa mas secundária —
não é o número que decide.

Mesmos ativos nos dois runs
(`BTCUSDT,ETHUSDT,FETUSDT,PENDLEUSDT,ZROUSDT,DYDXUSDT,PAXGUSDT`, default do
workflow), mesma janela, sem SMC (`smc`/`smc_confirm` em branco), mesmos
custos (não usa `--no-costs`) — mesma configuração base de
`bloco0-janela3-2023`, exceto pelo par de runs.

**Rótulos das tentativas**: `fase1-exploratorio-pre2023-controle` (Run 1) e
`fase1-exploratorio-pre2023-combinado` (Run 2).

**Como este resultado é usado**: leitura rápida enquanto o modo sombra
acumula (semanas) — NUNCA decide sozinho, mesmo se vier positivo. Uma
única janela adicional (agora 4 no total: 3 do Bloco 0 + esta) continua
sendo evidência incremental, não os ~300 operações que o próprio
`docs/roadmap.md` já define como padrão de confiança. Resultado registrado
aqui como subseção separada quando o usuário rodar os 2 e colar os
relatórios.

#### Resultado — os 2 runs (2026-08-04)

Usuário rodou os 2 runs recomendados e colou os diagnósticos completos.

| | Run 1 controle (só nativa) | Run 2 combinado (+ experimental) |
|---|---|---|
| Operações fechadas | 75 | 157 |
| Expectância líquida | **+0,215 R** | **−0,028 R** |
| Veredito | INCONCLUSIVO (`ci_straddles_zero`) | INCONCLUSIVO (`ci_straddles_zero`) |
| STOP_HIT | 76,0% (22W/35L) | 83,4% (42W/89L) |
| TP2_HIT | 16,0% (12/12 win) | 10,2% (16/16 win) |
| SELL (contrib/média) | +0,092R / +0,230R | **−0,075R / −0,159R** |
| BUY (contrib/média) | +0,123R / +0,205R | +0,047R / +0,090R |
| Tier T3 (contrib/média) | +0,178R / +0,284R | **−0,057R / −0,087R** |
| `correction_warning` (contrib/média) | −0,107R / −0,619R (13 ops) | −0,105R / −0,782R (21 ops) |

**Fato**: ligar `rf1hCondEnabled` **mais que dobrou** o volume de
operações na mesma janela/ativos (75→157, 2,09x) — confirma
direcionalmente o achado de Fase 0 (RF 1h gera ~3,8x mais sinal bruto).
Mas a expectância combinada **inverteu de sinal**, positiva pra negativa.

**Correção de leitura (review externa, Codex, PR #131, 2026-08-04)** — a
1ª versão deste texto dizia "decompondo os +82 operações incrementais,
74 delas (90%) caíram em STOP_HIT", tratando a subtração simples dos
totais (131−57=74) como se fosse a contagem de quantas das operações
"novas" pararam no stop. **Inválido pelo mesmo motivo já registrado
acima**: como as 2 cascatas disputam o mesmo slot `assetActiveOps`, o
Run 2 não é "o Run 1 + 82 operações extras" — um candidato experimental
pode ocupar o slot de um ativo ANTES de um sinal nativo que teria
disparado no Run 1, trocando qual operação existe ali (e com que
entrada/duração), não só adicionando uma a mais. A subtração de totais
por balde não decompõe "quais operações são as incrementais" — só mostra
a variação agregada de cada balde entre 2 simulações independentes.

**O que os números REALMENTE sustentam** (proporção dentro de cada run,
não decomposição entre runs): a fatia de `STOP_HIT` subiu de 76,0% pra
83,4% dos fechamentos (+7,4pp); a fatia de `TP2_HIT` (o desfecho de
maior qualidade) caiu de 16,0% pra 10,2% (−5,8pp) — e cresceu bem mais
devagar em contagem bruta (12→16, 1,33x) que o volume total (75→157,
2,09x). SELL, que no Run 1 tinha a melhor média (+0,230R), tem a pior
média no Run 2 (−0,159R); T3 (tier dominante em volume nos dois runs)
segue o mesmo padrão. Essas são comparações agregadas válidas (média/
proporção de cada run, cada um medido de forma independente) — não uma
alegação sobre quais operações específicas mudaram de resultado.
`correction_warning` (já documentado, item 45.9, como cohort negativo e
inútil como gate) se manteve consistentemente negativo nos dois runs,
sem virar achado novo.

**Hipótese**: a cascata experimental está entregando exatamente o padrão
que a Fase 0 já antecipava por texto ("o 1h é intrinsecamente mais
ruidoso... sobreviver menos ao gate de regime, não mais") — mais volume,
mas de qualidade sistematicamente pior, concentrado em stop. Não é
"volume que se soma de graça" — é volume que, nesta janela específica,
comeu a vantagem que a cascata nativa sozinha tinha (mesmo essa vantagem
nativa sendo ela mesma INCONCLUSIVA, `ci_straddles_zero`).

**Ressalva de honestidade estatística — por que isto NÃO decide nada**:
(1) os DOIS runs são individualmente inconclusivos — a leitura acima é
sobre a DIREÇÃO da mudança (positiva→negativa), não um resultado provado
em nenhum dos dois lados; (2) é uma única janela exploratória (a 4ª
independente do projeto, mas ainda longe das ~300 operações que o padrão
de confiança do projeto exige); (3) mesmo problema de múltiplas
comparações já registrado — testar esta cascata numa janela histórica
compete com a mesma pergunta do Bloco 0. **Não muda a decisão de manter
`rf1hCondEnabled` desligado em produção** (já era o caso) — mas é o
primeiro dado concreto (embora não conclusivo) que aponta na direção
OPOSTA à esperança original de "mais volume sem custo de qualidade", e
deveria pesar contra otimismo precipitado quando o modo sombra (o braço
que realmente decide) começar a produzir leitura.

**Achado colateral, não decisório — ressalva de leitura em `bars_to_tp1`/
`bars_to_stop`**: no Run 2, essas colunas saltam de ~23/32 (Run 1) para
~82/79 barras — parece "operações demoram 4x mais", mas **não é real**:
o "tempo em posição" em dias reais (a métrica confiável) foi
praticamente igual nos dois runs (5,9d → 5,3d, Run 2 até um pouco mais
rápido). `barsOpen` (a métrica por trás de `bars_to_tp1`/`bars_to_stop`)
usa `SIGNAL_TF_MS[op.signal_timeframe]` como unidade — 4h pra cascata
nativa, 1h pra experimental — então uma "barra" da experimental vale 1/4
de uma barra nativa. Misturar as duas num único cálculo de média (Run 2
combina as 2 cascatas) produz um número sem significado direto — não é
bug de trading (o Time Stop em si já está corretamente convertido por
cascata, ver correção anterior desta rodada), é só um artefato de
exibição do diagnóstico quando 2 cascatas com timeframes diferentes são
somadas na mesma métrica de "barras". Não corrigido nesta rodada — fica
registrado pra não interpretar mal esse par de colunas numa leitura
futura; correção (normalizar pra horas reais, ou separar por cascata em
`backtestAnalysis.js`) fica pra quando/se o usuário pedir.

## 57. Causa raiz do volume baixo ao vivo: busca de candle sem retry (2026-08-01)

O item 56 explicava o volume baixo de operações por Poisson/regime — dado
consistente, mas insuficiente: o usuário reportou só **3 operações desde
que o painel existe (1 delas ativada manualmente)**, um número
concretamente baixo demais mesmo pra explicação estatística. Investigação
completa nesta sessão, cada hipótese testada com dado real antes da
próxima:

1. **`scan.yml` parado/quebrado?** Não — GitHub Actions API: 4.787
   execuções desde 2026-07-10 (~22 dias), 100% sucesso em toda amostra
   conferida (recente, intermediária, próxima do início).
2. **RF período/multiplicador customizado por ativo, divergindo do
   backtest?** Não — usuário confirmou todos os ativos no padrão de
   fábrica (20/3,5).
3. **Configuração da estratégia mudou no meio do período?** Não — usuário
   confirmou que não mexeu em nada na tela "Pine Script".
4. **Lista de ativos instável?** Revelou um fato novo: o painel real roda
   com **9 ativos** (BTCUSDT, ETHUSDT, FETUSDT, PENDLEUSDT, ZROUSDT,
   DYDXUSDT, PAXGUSDT, SOLUSDT, METISUSDT), não os 7 que todo backtest
   deste projeto testava até agora — SOL e METIS nunca tinham sido
   incluídos em nenhuma rodada. Backtest repetido com os 9 reais
   (`trial_label: verificacao-9-ativos-reais-10jul-01ago`, mesma janela
   2026-07-10→2026-08-01): ainda previa **9 operações** (RF confirmou 7
   sinais, SMC 2 — SOL/METIS foram avaliados mas nenhum sinal deles passou
   o gate de regime). `rfRegime.adxStats.avgRejected` = 18,26 — **normal**
   frente ao baseline histórico de 12 meses (16,5), descartando regime
   anormalmente fraco no período.
5. Com cron saudável, config idêntica ao backtest e regime normal, o
   número ainda não batia: 9 operações previstas pelo backtest contra ~2
   automáticas reais. Checagem da tela **"Logs"** do painel (filtro
   ERR/WARN, recomendação 2 do item 56) revelou o problema real.

### Mecanismo confirmado

Os logs mostraram `"Failed to fetch"` recorrente nos timeframes `1h`/`4h`
(os que RF e SMC precisam pra gerar sinal) para vários ativos — ZROUSDT,
FETUSDT, ETHUSDT, PAXGUSDT, BTCUSDT, DYDXUSDT. Em alguns casos (ZRO, FET,
DYDX) **nenhum timeframe necessário** foi buscado com sucesso naquela
passada (`"timeframes_scanned": ["1d"]` só) — a avaliação do sinal nem
rodou naquele ciclo. Um log do módulo `monitor` ("DYDXUSDT em estado de
erro") indicou falha sustentada em pelo menos um ativo, não só um blip
isolado.

Confirmado no código: `src/lib/marketDataProvider.js` (browser, Binance
Futures) e `scripts/adminMarketDataProvider.js` (cron, Binance Spot) faziam
**um único `fetch(url)` sem nenhum retry** em todas as suas funções
(`fetchCandles`, `fetchCurrentPrice`, `validateSymbol`, `fetch24hStats`,
mais `fetchMarkPrice` no browser). Uma falha de rede transitória — a mesma
classe de erro vista nos logs — derrubava a busca daquele timeframe na
hora, sem segunda tentativa; a próxima chance só vinha no próximo scan
(~5min depois via `scan.yml`, ou no próximo ciclo do `useAutoScan.js` no
browser).

Isso contrasta com o próprio downloader do motor de backtest
(`scripts/fetch-backtest-data.mjs`, tarefa concluída no item 90 desta
sessão), que **já tinha** retry com backoff exponencial + respeito ao
header `Retry-After`, até 3 tentativas, só em erro transitório
(429/5xx/falha de rede — um 4xx real como símbolo inválido falha na hora,
como deve). **O backtest nunca via esse problema porque baixa os dados uma
vez com retry; o painel ao vivo tentava uma vez só, toda vez, pra sempre.**
Sinais que o próprio motor confirma (mesmos dados, mesmo código, via
backtest) que deveriam ter virado operação estavam sendo perdidos porque o
dado necessário simplesmente não chegava naquela janela de 5 minutos.

### Correção

Extraído o padrão de retry já provado em `fetch-backtest-data.mjs` para um
módulo novo e compartilhado, `src/lib/httpRetry.js` — JS puro (`fetch`/
`setTimeout`, nativos no browser e no Node 20), sem precisar de
redirecionamento novo em `scripts/build-scan.mjs`. `fetchWithRetry(url,
{ context, maxRetries=3, retryStatuses={429,500,502,503,504},
baseDelayMs=250, maxRetryAfterMs=120000 })`: retenta erro de rede puro e
status transitório, honra `Retry-After` do servidor (segundos ou data
HTTP) com precedência sobre o backoff exponencial, nunca retenta um 4xx
que não seja 429. Ao esgotar as tentativas, devolve a `Response` não-ok
(deixando o chamador formatar sua própria mensagem de erro, igual antes) —
só falha de rede pura (todas as tentativas lançando exceção) propaga o
erro lançado, preservando o contrato que `scanner.js` já tratava por
try/catch antes desta mudança. Todos os `fetch()` de
`src/lib/marketDataProvider.js` e `scripts/adminMarketDataProvider.js`
passaram a usar esse wrapper — zero mudança em qualquer gate, threshold ou
transição de estado, só na confiabilidade da busca do dado que alimenta
todos eles.

### Divergência de documentação encontrada (efeito colateral)

`docs/claude/backtest-usage.md`, o comentário do `.github/workflows/
backtest.yml` ("preferência PERMANENTE do usuário... só estes 7 pares,
sempre") e referências à carteira "de sempre" em itens anteriores deste
arquivo descreviam 7 símbolos — o painel real roda com 9 desde antes desta
sessão (SOL e METIS ficam fora dos backtests padrão de 7 símbolos que a
maioria dos itens deste arquivo usa; foram incluídos numa única rodada de
verificação ad-hoc, ver passo 4 acima, `verificacao-9-ativos-reais-10jul-01ago`
— avaliados, mas nenhum sinal deles passou o gate de regime).

**Corrigido em 2026-08-02**: `docs/claude/backtest-usage.md` (nota logo
após o parágrafo "Preferência permanente") e o comentário do campo
`symbols` em `.github/workflows/backtest.yml` agora deixam explícito que
os 7 símbolos são só o default deliberado deste workflow, não a carteira
completa monitorada (9 ativos) — sem mudar o default em si, que continua
sendo decisão separada do usuário (pendência 5 do plano de sessão, não
pedida). Referências históricas a "7 símbolos" em `docs/roadmap.md`
(descrevendo backtests já rodados) não foram tocadas — são factualmente
corretas sobre o que aquele run específico cobriu, não afirmam ser a
carteira real.

### Testes

`src/lib/httpRetry.test.js` — sucesso na 1ª tentativa (zero delay); sucesso
após falha transitória (500) via backoff exponencial; desiste após
`maxRetries` numa falha persistente e devolve a resposta não-ok sem lançar;
NÃO retenta 404; retenta falha de rede lançada (`TypeError: Failed to
fetch`) e sucede depois; esgota tentativas numa falha de rede persistente e
relança o erro; honra `Retry-After` em segundos; honra `Retry-After` como
data HTTP. Timers falsos (`vi.useFakeTimers`/`advanceTimersByTimeAsync`,
mesmo padrão de `scannerStateMachine.test.js`) para não esperar o backoff
de verdade.

### Verificação

`npm run lint && npm test && npm run build && npm run build:scan && npm run
build:backtest` — todos passando, incluindo a resolução do novo import em
`src/lib/httpRetry.js` pelos dois bundles (Vite e esbuild).
`sentinel-trading-engine-review` rodado (não toca gate/threshold/máquina de
estados, só confiabilidade de I/O que o motor inteiro depende). Não foi
possível validar contra a Binance real nesta sessão (rede da sessão
bloqueia, `.claude/rules/pine-parity.md`) — a prova real vem depois,
olhando a tela "Logs" em produção pra confirmar queda de `"Failed to
fetch"` e comparando o volume de operações do próximo período.

## 58. Gate de padrão de vela na cascata RF — mecanismo opt-in, desligado por padrão (2026-08-02)

Pedido explícito do usuário, na sequência da conversa sobre volume/qualidade
de entrada: "tem como usar o padrão de Price Action? [...] se fez uma vela
de engolfo nos 4h daí reduz pra fazer a entrada em 15m ou 5m". Confirmado
com o usuário que o papel do padrão é **adicionar** uma exigência a mais em
cima do sinal Range Filter já existente — não virar um gatilho alternativo
de entrada (isso seria uma estratégia paralela nova, categoria da cascata
SMC, que não tem equivalente no Pine real do usuário — fora de escopo aqui).

### Pesquisa de comunidade (WebSearch, 2026-08-02)

- **Engolfo tem edge real medido em backtest**, mas contexto-dependente —
  funciona melhor combinado com tendência/estrutura do que sozinho, e o
  nome do padrão nem sempre bate com o comportamento estatístico (alguns
  backtests mostram "engolfo de baixa" performando melhor como sinal de
  alta do que a leitura tradicional sugere). Fontes:
  [quantifiedstrategies.com](https://www.quantifiedstrategies.com/engulfing-trading-candlestick-pattern-backtest/),
  [LedgerMind](https://theledgermind.com/candlestick-patterns-reddit/).
- **A técnica "indicador no timeframe maior pro viés, price action no menor
  pro timing de entrada" é padrão reconhecido**, não uma ideia isolada —
  bate exatamente com a estrutura que RF (4h→15m) e SMC (1h→5m) já usam,
  só que a confirmação de 15m/5m hoje é a mesma RF (alinhamento de
  direção), não um padrão de vela dedicado. Fontes:
  [tradingwithrayner.com](https://www.tradingwithrayner.com/multi-timeframe-analysis/),
  [acy.com](https://acy.com/en/market-news/education/power-of-multi-timeframe-analysis-in-smart-money-concepts-j-o-134004/).

**Continuação (mesmo dia)**: usuário pediu inicialmente "todos os padrões que
existem" pra poder comparar tudo num backtest só. Avaliei e **recomendei
contra** — motivo registrado aqui porque é uma decisão de escopo, não só
técnica: testar muitos padrões contra o mesmo histórico curto (~2-3 anos
reais de Binance, já limitado pela discussão de walk-forward desta sessão) é
o problema de múltiplas comparações/data-mining que a própria pesquisa de
comunidade alerta — "estabeleça a hipótese ANTES de rodar o backtest, não
desenhe a estratégia depois de ver o que funcionou" — e vários padrões
clássicos (estrela da manhã/tarde, três soldados/corvos, doji-gravestone)
dependem de contexto de tendência ou do conceito de "gap" entre candles, que
não existe do mesmo jeito em candles de cripto 24/7. Fonte adicional:
[quantifiedstrategies.com — ranking de 75 padrões](https://www.quantifiedstrategies.com/candlestick-patterns-ranked-by-backtest/)
(top performers: Inverted Hammer 60%, Bearish Marubozu 56,1%, Gravestone
Doji 57%, Bearish Engulfing 57%).

Acordo final com o usuário: **3 padrões, não "todos"** — engolfo (já
implementado) + martelo/estrela cadente (pin bar) + marubozu. Inverted
Hammer do ranking foi deliberadamente descartado por ser a MESMA geometria
de pavio do pin bar, só lida no extremo oposto — testar separado seria medir
a mesma forma duas vezes sob outro nome, não uma ideia genuinamente nova.

### Mecanismo

`src/lib/indicators/candlePatterns.js` (função pura, 3 detectores):
- `detectEngulfing(currentCandle, previousCandle, direction)`: engolfo de
  alta/baixa, corpo-a-corpo (open/close, não o range high/low completo),
  exige o candle anterior na cor OPOSTA (contexto de reversão) e o candle
  atual alinhado com a direção do sinal (doji reprova nos dois lados, mesma
  guarda que `displacement.js` já usa).
- `detectPinBar(candle, direction, {wickToBodyRatio=2})`: martelo (BUY)/
  estrela cadente (SELL) — pavio dominante (do lado da direção pedida) >=
  2× o corpo, pavio oposto <= o corpo. Deliberadamente NÃO exige que o
  candle feche na direção do sinal (a definição canônica é sobre rejeição
  de preço pelo pavio, não pela cor do fechamento — muitos martelos reais
  fecham levemente vermelhos e continuam válidos).
- `detectMarubozu(candle, direction, {minBodyToRangeRatio=0.9})`: corpo
  domina quase todo o range (pavios quase nulos), ESSE exige fechamento
  alinhado com a direção (marubozu é definido pela cor). `0.9` é limiar
  convencional da literatura — decisão de julgamento sem dado próprio pra
  calibrar, mesma categoria do `bodyAtrMult` do `displacement.js`.

Nenhum tem equivalente no Pine real (`docs/reference-pine/`, grep por nomes
de padrão sem match) — mecanismo original do Sentinel, sem obrigação de
golden test (`.claude/rules/pine-parity.md`).

`pineConfig.candlePatternEnabled` (`false` por padrão, mesma convenção de
todo flag Fase 2+). `evaluateCandlePatternGate` (`scanner.js`, ao lado de
`evaluateRegime`) compara os **dois últimos candles 4h fechados** —
`results['4h'].last2Candles`, campo novo (bounded slice de 2 candles, não a
série inteira) alimentado no loop principal de `scanAsset`. Os 3 padrões
são checados em ordem de prioridade — **engolfo → pin bar → marubozu**,
primeiro que validar ganha (um candle pode tecnicamente satisfazer mais de
um) — e combinados por OU: qualquer um dos três confirma. Rodando nos **2
pontos** da cascata RF (1ª passada e retry) — **não** na cascata SMC nesta
rodada, escopo explicitamente pedido pelo usuário como só 4h→15m. Novo
motivo `candle_pattern_rejected` no funil de rejeição já existente
(`entryFunnelOutcomes`/`last_rejection_reason`-style log); quando nenhum dos
3 valida, o `reason` do funil reporta o motivo do engolfo (o mais
informativo dos três) e o `SystemLog` da 1ª passada grava os 3 motivos
completos (`details.allReasons`) para debug.

Auditoria: `TradeOperation.entry_candle_pattern` (`'bullish_engulfing'` |
`'bearish_engulfing'` | `'hammer'` | `'shooting_star'` |
`'bullish_marubozu'` | `'bearish_marubozu'` | `null`) — recomputado dentro
de `buildTradeOpData` chamando a mesma `evaluateCandlePatternGate` (barato,
comparação pura de candles, sem I/O) em vez de threadear o resultado do
gate por todos os call sites só por esse campo.

Backtest: nova seção `report.candlePattern` (`enabled`, `total`, `attempts`,
`passed`, `rejected`, `byPattern`, `byReason`) — ao contrário de
`smcTrigger` (sempre ligado), aqui `enabled` É informativo: `total: 0` pode
genuinamente significar "flag desligado neste run". `byPattern` já separa
os 6 rótulos automaticamente, então UM backtest com o flag ligado já dá a
comparação entre os 3 padrões que o usuário queria, sem precisar rodar 3
vezes. Impressão em `scripts/analyze-backtest.mjs` via `renderGateSection`
(estendido com um branch `byPattern`, mesmo formato de `byTrigger`).

### Testes

`candlePatterns.test.js` (20 casos — função pura, os 3 detectores: válido
dos dois lados, direção errada, doji, candle anterior não-oposto, corpo que
não engolfa/não domina o range, pavio curto/longo demais, parâmetros
inválidos). `scannerStateMachine.test.js` (6 casos) — flag desligado:
comportamento idêntico ao anterior (`entry_candle_pattern` null, sem log);
confirma via engolfo, via pin bar (sem engolfo), via marubozu (sem engolfo
nem pin bar); flag ligado sem padrão nenhum válido: nenhuma operação, log
com o motivo certo; confirma pelo loop de retry, não só na 1ª passada.
`backtestEngine.test.js` — seção nova default desligada/zerada quando nada
é passado (compat de chamada legada); conta confirmados por padrão e
rejeitados por motivo corretamente.

### Primeiro backtest exploratório (2026-08-02) — A/B sem × com o filtro

Usuário rodou os dois backtests recomendados pelo GitHub Actions
(`sem-padrao-vela` × `com-padrao-vela`, mesmo período fev-dez/2025, mesmos 7
símbolos) e colou os dois diagnósticos completos.

| | sem-padrao-vela | com-padrao-vela |
|---|---|---|
| Operações fechadas | 87 | 22 |
| Expectância líquida | 0,223R | 0,452R |
| Veredito do gate estatístico | **INCONCLUSIVO** (`ci_straddles_zero`) | **INCONCLUSIVO** (`sample_too_small`) |
| STOP_HIT (W/L) | 37/35 (quase 50/50) | 10/6 (62,5%) |

O gate avaliou 105 sinais e confirmou só 26 (24,8%) — a queda de 87 para 22
operações bate com essa taxa de aprovação. `byPattern` saiu equilibrado (3 a
6 confirmações por rótulo, nenhum padrão isolado domina a amostra pequena).
Sinal de alerta extra: as 10 melhores operações do run com filtro somam
**130% do resultado total** (as outras 12 operações são líquidas negativas)
— concentração mais extrema que o baseline (top10 = 88,4%), assinatura
típica de resultado pequeno carregado por poucos trades de sorte.

**Leitura**: direcionalmente positivo (expectância ~2x maior, win rate
melhor nos dois lados) mas **nenhum dos dois relatórios é conclusivo** — o
baseline tem amostra grande mas estatisticamente indistinguível de zero; o
filtro tem resultado melhor mas amostra pequena demais pra confiar, com a
concentração de topo que costuma diluir numa amostra maior. Confirma
exatamente a cautela já registrada abaixo (`byPattern` é hipótese, não
decisão). **Flag não ativado a partir deste resultado.**

Trade-off para virar conclusivo: o filtro corta ~75% da amostra, então só
para cruzar o piso de 30 operações (o mínimo que o próprio gate estatístico
deste projeto exige, item 44) seria preciso ~14 meses de janela (30 ÷ 2,2
op/mês observado nesta amostra); para o padrão de confiança que este
projeto já usa em outros gates (ordem de centenas de operações,
`docs/roadmap.md` Bloco 0), precisaria de vários anos de histórico com o
filtro ligado — vale checar antes se os símbolos mais novos da carteira
(FET/PENDLE/ZRO) têm dado suficiente na Binance pra uma janela tão longa.
Não decidido se vale rodar de novo com janela maior ou aceitar a leitura
direcional atual como insuficiente por ora — decisão do usuário, não
antecipada.

### Status

**Implementado, desligado por padrão.** Não ativar sem comparar relatórios
de backtest com/sem o flag primeiro — mesma disciplina de todo flag deste
projeto (nenhum dos flags Fase 2+ foi ativado por default sem essa etapa).
O `byPattern` do primeiro backtest exploratório deve ser tratado como
**hipótese**, não decisão — qual padrão "ganha" numa amostra pequena e
única não é motivo suficiente pra ativar só aquele, mesma disciplina que
motivou recusar "todos os padrões" acima. Primeiro A/B real rodado (ver
subseção acima): direcionalmente positivo, mas ambos os lados
INCONCLUSIVOS — segue desligado.

### Verificação

`npm run lint && npm test && npm run build && npm run build:scan && npm run
build:backtest` — 786 testes passando. `sentinel-trading-engine-review`
rodado antes de considerar pronto (toca os 2 pontos de entrada da cascata
RF) — sem achado: não introduz look-ahead (compara candles JÁ fechados, o
mesmo par em toda a janela de retry de um sinal), erro propagado idêntico
ao anterior para os chamadores, sem novo risco de concorrência (comparação
pura, sem I/O extra).

## 59. Auditoria pedida pelo usuário: bug P0 real no trailing pós-TP1 + 2 bugs de UI (2026-08-02)

Usuário pediu uma auditoria ampla ("tudo já foi feito? tem bug em outras
telas?") — 2 Explore agents em paralelo (páginas/componentes fora do motor;
varredura de `known-risks.md`/`roadmap.md` por pendências sem correção) mais
investigação própria depois que um dos agentes sinalizou uma possibilidade
sem confirmar. Achados abaixo, todos corrigidos e testados nesta rodada.

### P0 real: trailing stop pós-TP1 tinha o mesmo look-ahead multi-passagem já corrigido no pré-TP1

Item 54 (PR #106, P1) corrigiu um bug real: o cron roda `persistScanResults`
a cada ~5min enquanto uma vela de 4h/1h pode continuar "a última fechada"
por horas — múltiplas passagens sobre a MESMA vela. Sem proteção, a
proteção de stop pré-TP1 podia avançar o stop na passagem N (usando o close
desta vela) e a passagem N+1 testava a MESMA vela contra o stop JÁ
avançado — `STOP_HIT` falso usando dado já avaliado com segurança contra o
stop ANTIGO uma passagem antes. Corrigido lá com
`pre_tp1_stop_advanced_candle_time`, que exclui essa vela específica de
recheck.

O item 54 registrou uma "nota para investigação futura" apontando que o
trailing PÓS-TP1 (`advanceTrailingStop`, P0-d, já em produção desde antes
desta sessão) tinha a mesma estrutura de código, mas nunca foi confirmado
nem corrigido. **Confirmado por leitura direta do código nesta rodada**:
`runnerStopHit` (`scanner.js`) testava `stopCheckPrice` contra
`op.current_stop` só gated por `candleUsable`, sem nenhum guard de "vela já
usada pra avançar antes" — exatamente a mesma classe de bug, só que no
mecanismo que já roda ao vivo para toda operação com `exit_mode`
`HYBRID_RF_ATR`/`ATR_TRAILING` depois do TP1.

**Cenário reproduzido** (mesmo padrão do item 54): operação RUNNER_ACTIVE,
vela ainda não fechou uma nova. Passagem N: preço não bate o stop antigo,
`advanceTrailingStop` avança o stop a partir do close desta vela, grava em
`current_stop`. Passagem N+1 (mesma vela, cron rodou de novo): sem a
correção, `runnerStopHit` testaria o `low`/`high` dessa MESMA vela contra o
stop JÁ avançado — podendo fechar a operação com `STOP_HIT` falso, cortando
um runner que na realidade nunca tocou aquele nível.

**Correção** (espelha exatamente `pre_tp1_stop_advanced_candle_time`): novo
campo `TradeOperation.runner_stop_advanced_candle_time` (schema em
`docs/schema-reference/TradeOperation.jsonc`) — grava
`tfData.lastCandleTime` toda vez que `advanceTrailingStop` muda o stop
nesta vela (diferente do campo pré-TP1, que dispara uma vez só e fica
parado no breakeven, este sobrescreve a cada avanço genuíno, porque o
trailing pode apertar repetidamente ao longo da vida da operação —
`advanceTrailingStop` é idempotente contra o mesmo close, então uma
passagem repetida sobre a mesma vela nunca dispara o branch com valor
mudado, então o campo nunca é reescrito à toa). `runnerStopHit` passa a
excluir essa vela específica, mesmo padrão de `stopAdvancedThisCandle`.

Teste de regressão novo em `scannerStateMachine.test.js` (mesma forma do
teste do item 54): passagem 1 avança o trail e não para; passagem 2 sobre a
MESMA vela não re-testa (seria o `STOP_HIT` falso); uma vela genuinamente
nova volta a testar normalmente e para no stop avançado, não no original.

### Bug real, alcançável pela UI: editar operação com campo vazio falhava silenciosamente

`src/pages/Trades.jsx` (modal "Editar"): limpar o campo Stop/TP1/TP2 e
salvar mandava `undefined` pro Firestore (`updateDoc` via
`backend.entities.TradeOperation.update`) — o SDK do Firestore rejeita
valor `undefined` e lança exceção. `editMutation` não tinha `onError`,
chamado via `.mutate()` sem tratamento — a falha era engolida, o modal não
fechava, o botão "Salvar Alterações" parecia travado, sem mensagem de erro
nenhuma.

**Corrigido**: campo vazio agora simplesmente não entra no payload (em vez
de entrar como `undefined`) — mesmo padrão que o campo `exitPrice` já
usava no mesmo componente. `editMutation` ganhou `onError` (`logError` +
alerta ao usuário), mesmo padrão já usado em `AssetCard.jsx`. Escopo: só o
call site em `Trades.jsx` — o adaptador genérico `backend.entities.*.update`
(`src/api/entities.js:110-114`) é usado por muitos outros callers; endurecer
ali (ex.: filtrar `undefined` do payload por padrão) resolveria a classe
inteira do bug de uma vez, mas é mudança de escopo maior no adaptador
compartilhado — não feito nesta rodada, registrado como possível
hardening futuro se aparecer em outro call site.

### Bug menor, repetido em 3 componentes: RSI = 0 aparecia como "sem dado"

`src/components/dashboard/AssetCard.jsx`,
`src/components/assets/AssetDetailPanel.jsx`,
`src/components/dashboard/ComparePanel.jsx` usavam
`state.rsi_value ? state.rsi_value.toFixed(0) : '—'`. RSI genuinamente pode
computar `0` (sobrevendido extremo) — nesse caso a tela mostrava "—" (sem
dado) em vez de "0", escondendo um valor real do indicador. **Corrigido**:
`Number.isFinite(state.rsi_value)` nos 3 lugares.

### Outros achados da auditoria — já conhecidos, sem ação nesta rodada

- Toggle "Runner ativado" no Telegram (`TelegramSettings.jsx`) sem função
  `notify*` correspondente — já registrado (nunca implementado), baixa
  prioridade.
- Item 51: bug de janela de avaliação corrigido só em
  `rfRegimeOutcomes`/`smcTriggerOutcomes`, deixado sem correção nas outras 5
  seções (retest/displacement/smcRegime/arbitration/smcObFvg) — reconhecido
  no próprio item, não urgente (afeta só precisão de diagnóstico de
  backtest).
- Possível gap não verificável daqui: `firestore.rules` da coleção
  `telegramFilters` (item 47) marcado "pendente fora da sessão" sem
  confirmação posterior de deploy — usuário precisa confirmar se já rodou
  `firebase deploy --only firestore:rules`.
- `docs/roadmap.md` ainda descreve a proteção pré-TP1 como "falta rodar o
  A/B", mas o item 55 já rodou e fechou isso — só desatualização de texto,
  não corrigido nesta rodada.

### Addendum (review externa, Codex, PR #116, P1): o marcador da vela também precisava de proteção transacional

O PR original escrevia `runner_stop_advanced_candle_time` fora da proteção
de `clampMonotonicStop` — só `current_stop` era protegido contra regressão
entre workers concorrentes (browser/cron), o marcador não. Cenário real:
Worker A (candle T2, mais recente) commita stop 105 com marcador T2; Worker
B (stale — leu o estado ANTES do commit de A, ainda enxergando a vela T1
mais antiga) propõe stop 102 com marcador T1. `clampMonotonicStop` corrige
o `current_stop` (fica 105, não regride) — mas sem a correção, o marcador
de B (T1) sobrescreveria o de A (T2) mesmo assim, porque só o campo
`current_stop` passava pelo clamp. Resultado: `current_stop=105` (correto)
com `runner_stop_advanced_candle_time=T1` (errado) — a próxima passagem
sobre a vela T2 (que continua sendo "a última fechada") não reconheceria
T2 como a vela que produziu o stop armazenado, e o guard de
`runnerStopHit` deixaria de excluí-la — reabrindo exatamente o `STOP_HIT`
falso que este item existe pra fechar.

**Correção**: nova função pura `stopAdvanceCandidateWon`
(`src/lib/opTransition.js`) — só true quando o `candidateStop` deste worker
é o valor que `clampMonotonicStop` de fato manteve. `transitionTradeOp`
(nos 3 backends — `entities.js`, `adminEntities.js`, `fakeBackend.js`)
ganhou um parâmetro `stopAdvanceMarkerField`: quando o candidato deste
worker PERDE o clamp, o campo do marcador é removido do patch antes do
`tx.update` (nunca sobrescreve o marcador de quem realmente venceu).
`scanner.js` passa a computar `stopAdvanceMarkerField` localmente (só
quando o avanço realmente aconteceu nesta passada) em vez de gravar o
marcador direto em `updatePayload`.

Teste de regressão novo em `scannerStateMachine.test.js` reproduz o
cenário exato de Codex (Worker A commita 105/T2, Worker B tenta 102/T1
depois) e confirma `current_stop=105` **e** `runner_stop_advanced_candle_time=T2`
— não T1. `opTransition.test.js` cobre `stopAdvanceCandidateWon`
isoladamente (função pura).

### Status

**Corrigido e testado** (trailing pós-TP1 — incluindo o addendum de
concorrência acima —, edição de operação, exibição de RSI). Os "outros
achados" ficam registrados, sem ação — nenhum afeta dinheiro real hoje.

### Verificação

`npm run lint && npm test && npm run build && npm run build:scan && npm run
build:backtest`, `sentinel-trading-engine-review` (toca `scanner.js`,
máquina de estados, P0). Teste de regressão dedicado pro achado do
trailing e pro addendum de concorrência (reproduz cada cenário exato antes
de corrigir, como manda `.claude/rules/operating-principles.md`).

## 60. Investigação ao vivo: 14 dias sem operação + causa raiz do "lock ocupado" (2026-08-04)

### Contexto

Usuário notou 0 operações ativas e pediu confirmação se o mercado estava
"parado" (BTC e os demais ativos cadastrados). Durante a investigação
apareceu um achado colateral — proporção alta de `"Scan completo
ignorado — outra execução já está em andamento (lock ocupado)"` nos logs
recentes — e o usuário pediu para ir a fundo nisso também e corrigir o
que fosse necessário.

### Capacidade nova desta sessão — leitura direta do Firestore de produção

Confirmado por teste real: a rede desta sessão alcança os servidores do
Firebase (`firestore.googleapis.com`/`identitytoolkit.googleapis.com`),
ao contrário da Binance (que segue bloqueada). A config pública do app
(`VITE_FIREBASE_API_KEY`/etc., já commitada em `render.yaml` — não é
secret, é a mesma coisa que qualquer visitante do site vê) +
`signInAnonymously()` (mesmo mecanismo que o app real usa, decisão
intencional "sem tela de login") dá acesso de LEITURA (e, pelas mesmas
`firestore.rules`, também escrita) às coleções de negócio, sem precisar
da chave de admin do GitHub Actions (`FIREBASE_SERVICE_ACCOUNT_JSON`) —
essa chave, mais poderosa (ignora `firestore.rules` **e** o código de
proteção de concorrência de `opTransition.js`), continua reservada só
aos scripts já revisados por PR (`scripts/adminEntities.js`), não usada
nesta sessão — só leitura foi feita aqui, nenhuma escrita.

### Achado 1 — só 3 operações desde sempre, 14 dias sem nenhuma nova

Confirmado por leitura direta: 3 `TradeOperation` fechadas ao todo (2
STOP_HIT — ETHUSDT 2026-07-17, FETUSDT 2026-07-21 —, 1
CLOSED/TIME_STOP — METISUSDT 2026-07-10), nenhuma ativa. 14 dias sem
nenhuma operação nova até a data desta investigação. O scan em si está
saudável — `last_scan_at` dos 9 ativos com poucos minutos de atraso,
`scan_status: success`, zero `scan_error` — **não** é o bug do item 57
(fetch sem retry) se repetindo.

### Achado 2 — viés de baixa correlacionado, não "sem tendência" no sentido ADX/Chop

`AssetState` (4h e 1D) mostra `trend_ema: bearish` em 8 dos 9 ativos
monitorados, nos DOIS timeframes (só ETHUSDT em alta no 1D) — viés de
baixa correlacionado no portfólio inteiro. **Ressalva importante**:
ADX/Choppiness (as métricas que o gate de regime realmente usa) não
ficam persistidas em produção — só o backtest grava esse número — então
não dá pra confirmar "ADX fraco" a partir do Firestore ao vivo, só
inferir indiretamente pela tendência EMA.

### Achado 3 — os bloqueios reais observados nas últimas ~9h não foram regime

`SystemLog`/`SignalEvent` recentes mostram: (a) sinal 1h bloqueado por
desenho (cascata "RF 1h condicionado ao 4h" ainda desligada em produção
— não é sintoma de mercado, é o flag `rf1hCondEnabled` mesmo); (b)
gatilho SMC 5m não disparando (padrão antigo já conhecido, item
45.1/45.2 — não é novidade); (c) 1 candidato real da cascata principal
(METISUSDT, RF 4h) bloqueado por `smc_confirm_zone_rejected` (gate extra
que esse ativo tem ligado), não por regime fraco. Nenhum
`regime_rejected` apareceu na amostra observada.

### Achado 4 — causa raiz do "lock ocupado": comportamento por desenho, NÃO é bug

- `scannerLocks/full-scan` tem TTL de 10 min (`FULL_SCAN_LOCK_TTL_MS`,
  `scanner.js`) — só o teto de segurança contra crash; em operação
  normal o lock é liberado no `finally` assim que o scan termina
  (segundos, não minutos).
- Histórico real do workflow `scan.yml` (GitHub Actions API, 20 runs
  mais recentes): dispara precisamente a cada 5 min, cada execução leva
  30-90s — **as execuções do cron nunca se sobrepõem entre si** (folga de
  ~4 min entre o fim de uma e o início da próxima).
- A causa real: `src/hooks/useAutoScan.js` roda um full scan pelo
  NAVEGADOR a cada 60 min quando o painel está aberto — usando o MESMO
  lock (comentário no próprio arquivo: "so they never overlap with each
  other or with the GitHub Actions cron scan"). Mas o contador
  (`lastFullScan.current`) começa zerado a cada MONTAGEM do componente —
  então qualquer reload/nova aba do painel dispara um full-scan do
  navegador 90s depois, independente de quanto tempo fazia desde o
  último. Esse full-scan do navegador ocasionalmente cai no mesmo
  instante do disparo do cron (a cada 5 min) e um dos dois perde a
  corrida pelo lock — daí o "lock ocupado".
- **Por que isso não é bug**: o lock existe EXATAMENTE pra tornar essa
  corrida segura (`entities.js:145-146`: "Prevents two concurrent scan
  runs (browser auto-scan + GitHub Actions cron) from processing the
  same batch at once"). Mais importante — **quem vence a corrida faz o
  MESMO trabalho completo** (`scanAllAssetsInner` avalia os 9 ativos
  igual, venha do navegador ou do cron) — o "perdedor" só deixa de
  duplicar o trabalho; nenhum ativo fica de fora de avaliação naquele
  ciclo. **Não reduz a frequência efetiva de detecção de sinal** — a
  preocupação original que motivou a investigação.

### Conclusão

**Nada para corrigir** — nem o "lock ocupado" (comportamento seguro e
por desenho) nem o volume atual de operações (motor saudável, portfólio
com viés de baixa correlacionado, sem evidência de bug). Efeito
colateral menor, não urgente: o full-scan do navegador reseta a cada
reload em vez de lembrar quando foi a última passada real — gasta
alguma leitura/escrita extra de Firestore em alguns casos, mas não causa
erro nem perda de sinal. Fica registrado como nota, não como pendência —
não alterado sem necessidade demonstrada (`CLAUDE.md`).

### Verificação

Investigação foi só leitura (Firestore de produção via cliente anônimo,
API do GitHub Actions, leitura de código) — zero mudança de código,
zero escrita em produção.

---

## 61. Auditoria de uma lista de "melhorias" — texto descrevia código que não existe (2026-08-05)

### Contexto

Usuário colou uma lista longa de features (RFHistoryChart enriquecido,
trava de segurança `check15mConfirmation` de 4h→15m, WeeklySummary,
GlobalSearch com histórico, backtest com página e "Aplicar ao Scanner",
página `/settings` de ajuste fino, marcadores vibrantes, widget de
correlação BTC/ETH/SOL, checklist no `AssetDrawer`), redigida em boa
parte como se já estivesse implementada ("já busca", "já mostra", "já
existe"), e pediu opinião sobre valor e o que falta. Auditoria de código
(sem alterar nada) confirmou divergência real entre o texto e o repo.

### Achado 1 — `check15mConfirmation` já existe, mas faz o oposto do descrito

`scanner.js:417-460` já roda em produção (não atrás de flag) nos 4
pontos da cascata nativa 4h→15m. Mas ele **confirma um sinal 4h
checando o RF de 15m** — não "bloqueia entrada 15m por desalinhamento
de tendência macro 4h" como o texto descrevia. Os reason codes citados
(`4h_trend_mismatch`, `4h_trend_neutral`) não existem em lugar nenhum
do repo; os reais são `regime_rejected`, `confirmation_15m_not_aligned`,
`trend_reversed`, `active_op_exists`. O mecanismo que de fato condiciona
4h→1h com validação estatística própria é `rf1hCondEnabled` (Fase 1 do
roadmap), **corretamente ainda restrito a backtest + shadow mode**,
nunca em produção — é uma peça separada que reusa `check15mConfirmation`
internamente, não a mesma coisa. Risco identificado: implementar "a
trava de 4h" como se fosse pedido novo, tomando a descrição do usuário
como verdade, teria criado um segundo mecanismo de bloqueio duplicando
lógica já existente e colidindo com o gate estatístico do Bloco 1
(nenhum flag novo entra em produção sem A/B declarado antes).

### Achado 2 — o resto da lista: só 1 de 10 itens existe como descrito

| Item | Estado real |
|---|---|
| Expansão ChevronDown em Assets.jsx | EXISTE |
| `RFHistoryChart` | PARCIAL — sparkline só do RF, sem preço combinado/bandas/filtro de timeframe |
| `GlobalSearch` | PARCIAL — busca Ativos+Alertas, sem seção "Histórico"/`TradeOperation` |
| Backtest | PARCIAL — motor roda via CI/CLI (`backtestEngine.js`), sem rota `/backtest`, sem "Aplicar ao Scanner" |
| `WeeklySummary` | NÃO EXISTE |
| Página `/settings` dedicada | NÃO EXISTE — só modal de Telegram e textarea de Pine Script |
| Marcadores vibrantes / `signal-zone-pulse` | NÃO EXISTE |
| Widget de correlação BTC/ETH/SOL | NÃO EXISTE |
| Checklist de veredito no `AssetDrawer` | NÃO EXISTE |

### Conclusão

Nada corrigido — achado é de documentação/percepção, não de código.
Fica registrado porque o texto original (se reaproveitado numa sessão
futura) levaria a assumir trabalho já feito que não foi, e a implementar
`check15mConfirmation` "do zero" duplicando o que já roda em produção.
Antes de qualquer uma dessas features virar tarefa de implementação,
tratar como pedido novo com escopo verificado no código atual — não como
enriquecimento de algo pronto.

### Conselho (5 papéis independentes, 2026-08-05): trava de 4h→15m nova — NÃO recomendada

Rodado via `sentinel-council-review` sobre a pergunta "faz sentido uma trava
de 4h→15m nova e distinta de `rf1hCondEnabled`?". Veredito unânime, sem
divergência real entre papéis:

- **Arquiteto**: a cascata nativa (`scanner.js:1784-1859`) já bloqueia sinal
  não-4h incondicionalmente e já rejeita por `trend_reversed`/
  `confirmation_15m_not_aligned` — é duplicação literal criar mecanismo novo.
- **Trading**: os três gates existentes (`trend_reversed`, `regime_rejected`,
  `confirmation_15m_not_aligned`) já cobrem a superfície de risco que o
  usuário quer proteger; medir o quanto cada um já filtra (`entry-funnel-
  diagnostico`, roadmap.md) vem antes de qualquer trava nova.
- **Concorrência**: seguro **só se** reusar `results['4h']` já computado no
  mesmo passe (`scanner.js:1014-1020`); um mecanismo separado com leitura
  própria introduziria risco real de inconsistência entre ticks de cron.
- **Segurança/governança**: `rf1hCondEnabled` já foi medido em A/B real e
  **piorou** a expectância (+0,215R → −0,028R, item 58/60 nesta faixa de
  linhas do arquivo) — motivo real, não burocrático, para não generalizar
  o padrão sem o mesmo rigor.
- **Testes**: `4h_trend_neutral` não é representável no modelo atual
  (`rf.direction` só tem `1`/`-1`, sem terceiro estado) — seria feature nova,
  não bug de reason code faltando; staleness de fetch 4h↔15m não tem teste
  dedicado hoje.

**Recomendação final**: não construir nada agora. Se uma operação real
específica motivou o pedido (entrada ruim numa reversão), investigar essa
operação via `last_rejection_reason`/`entryFunnelOutcomes` (item 49) para
achar qual gate deveria ter disparado, em vez de abrir mecanismo novo.

---

## 62. Backtest: desempenho real por período + disparo do backtest.yml pelo painel (2026-08-05)

### Contexto

Depois do PR #139 (visualizador de relatório JSON), o usuário pediu duas
funções adicionais na página `/backtest`, as duas juntas: (1) ver o
desempenho REAL por período (sem simular nada) e (2) disparar o workflow
`backtest.yml` do GitHub Actions direto pelo painel, sem precisar abrir o
GitHub manualmente.

### O que foi feito

- **Aba "Desempenho Real"**: filtra `TradeOperation` reais do Firestore por
  preset de período (Hoje/Semana/Mês/Mês Passado/Trimestre/Ano/Tudo, mesmo
  padrão de `Trades.jsx`), agregando com `summarizeOps()` — a MESMA função
  que `backtestEngine.js` usa para o relatório de simulação, então o corpo
  de visualização (`ReportBody`, extraído do que antes era só o JSON viewer)
  é 100% compartilhado entre os dois modos, sem duplicar conta nenhuma. Zero
  risco novo — não toca `scanner.js`, só lê Firestore via o adaptador
  `backend` de sempre.
- **Disparo do `backtest.yml` pelo painel**: 3 rotas novas em `server/index.js`
  (`POST /api/backtest/trigger`, `GET /api/backtest/status/:runId`,
  `GET /api/backtest/artifact/:runId`) usando um novo secret
  `GITHUB_ACTIONS_TOKEN` (PAT fine-grained, permissão "Actions: Read and
  write", escopado só a este repositório) para disparar o `workflow_dispatch`
  do `backtest.yml`, consultar status e baixar+extrair (`adm-zip`, nova
  dependência de `server/`) o artifact `backtest-report.json`. Frontend:
  `TriggerBacktestPanel.jsx` (formulário + polling automático) e
  `apiBackend.js` ganhou suporte a GET (antes só POST). `render.yaml` ganhou
  `VITE_BACKEND_URL` (público, aponta para `sentinel-signals-api.onrender.com`
  — sem essa variável o cliente do backend nunca funcionou em produção,
  lacuna pré-existente desde que `apiBackend.js` foi criado) e o secret
  `GITHUB_ACTIONS_TOKEN` (`sync: false`).

### Revisão de segurança (rodada antes de finalizar, per `.claude/rules/security.md`)

- **Confirmado por leitura de código**: nenhuma das 3 rotas toca
  `scanner.js`, Firestore de produção ou Telegram real — só chamam a API do
  GitHub e devolvem o resultado ao cliente.
- **Repo confirmado público** (`visibility: public` via API do GitHub) — sem
  risco de custo de minutos do Actions por abuso, só ruído/fila, que o
  cooldown de 60s em memória (`server/index.js`) já cobre razoavelmente.
- **302 do artifact tratado corretamente**: o download redireciona para uma
  URL assinada (Azure Blob) e o header `Authorization` NÃO é reenviado nesse
  2º request — padrão correto (a URL já carrega autenticação própria via
  query string).
- **Achado real, corrigido**: `pine_config`/`from`/`to` só eram validados no
  cliente (`TriggerBacktestPanel.jsx`), contornável chamando a API direto —
  adicionada validação server-side (JSON.parse de `pine_config`, `Date`
  parseável de `from`/`to`) antes de repassar ao GitHub.
- **Limitação aceita e documentada** (não é falha de desenho): o GitHub não
  permite escopar um PAT fine-grained a um único workflow — "Actions: Read
  and write" vale para todos os workflows do repo. Um vazamento do token
  permite disparar/ler qualquer workflow (backtest, scan, backup,
  deploy-firestore), mas não lê secrets nem altera código (exigiria
  "Contents: write", não concedido). Documentado em `render.yaml`/
  `.env.example`.

### Verificação

`npm run lint`, `npm test` (828 testes) e `npm run build` limpos. Sem
verificação visual no navegador (mesma limitação de ambiente já registrada
no item 61 — sem credenciais reais de Firebase nesta sessão).

---

## 63. Backtest — 2ª rodada: bug do polling perdido + aba instantânea "Ajuste Fino (What-If)" (2026-08-05)

### Contexto

Usuário disparou um backtest pelo painel (item 62) e relatou que "terminou e
não apareceu lá" — o relatório nunca carregou no painel mesmo o run tendo
concluído no GitHub. Na mesma leva, mostrou prints de outra implementação
(Base44 — plataforma de origem deste projeto, nunca reconectada como
infraestrutura, ver `CLAUDE.md`) com um fluxo de backtest **instantâneo,
single-asset/single-timeframe**, e pediu para replicar esse design aqui
(inspiração de layout/UX, não reintrodução da plataforma).

### Achado 1 — bug real: polling do backtest não sobrevivia a reload/navegação

`TriggerBacktestPanel.jsx` guardava `runId`/status **só em memória**
(`useState`). Runs de backtest podem levar de minutos a horas — se o usuário
saísse da página ou atualizasse o navegador antes do job terminar, o
`setInterval` de polling era destruído (cleanup do componente) e nunca mais
retomado; o relatório ficava pronto no GitHub, mas o painel voltava a mostrar
"Disparar backtest" como se nada tivesse acontecido. **Corrigido**:
`runId`/`htmlUrl`/`trialLabel` agora persistem em `localStorage`
(`sentinel_backtest_trigger_v1`); ao montar, o componente faz uma checagem
imediata de status e retoma o polling se o run ainda estiver em andamento.
Adicionado botão "Cancelar acompanhamento" para o usuário abandonar um run
travado/obsoleto sem precisar limpar o `localStorage` manualmente.

### Achado 2 — nova aba "Ajuste Fino (What-If)": simulação client-side, NÃO é o motor real

Novo módulo `src/lib/quickBacktest.js` — simulação single-asset/
single-timeframe, 100% no navegador, sem GitHub Actions, sem gravar nada.
Reaproveita as MESMAS funções puras de indicador que o motor real usa
(`calculateRangeFilter`, `calculateATRSeries`, `calculateRSI`, `calculateMACD`,
`calculateEMAs`) e — o mais importante — o **score real de 0-100**
(`calculateSignalStrength`, `src/lib/indicators/confluence.js`) que o motor
usa pra filtrar sinais ao vivo, não um score inventado pro sandbox.
**Deliberadamente uma aproximação, não paridade de motor** (ver
`.claude/rules/pine-parity.md`): decide entrada num único timeframe, sem
alinhamento multi-TF, sem arbitragem entre cascatas, sem SMC — documentado
como tal no topo do arquivo. Ops simuladas são montadas no MESMO formato que
`tradeMetrics.js` espera de uma `TradeOperation` real (entry_price,
initial_stop, tp1/tp2, tp1_hit, partial_percent, exit_price, status
STOP_HIT/TP2_HIT), o que permite reusar `summarizeOps()`/`ReportBody` sem
duplicar nenhuma conta de P&L/R/drawdown. Testado (`quickBacktest.test.js`):
rejeita candles insuficientes, produz operações não-vazias num fixture
determinístico, e confirma que score mínimo mais alto nunca abre mais
operações que um mais baixo.

`/settings` reorganizado no layout de 3 colunas (Range Filter / Gestão de
Risco / Confirmação) com barra "Configuração Ativa" — mesma lógica/campos já
existentes, só reorganização visual.

### Verificação

`npm run lint`, `npm test` (831 testes, +3 novos) e `npm run build` limpos.
Sem verificação visual no navegador (mesma limitação de ambiente dos itens
61/62).

---

## 64. Revisão de harmonia visual do painel (2026-08-06)

### Contexto

Usuário pediu uma revisão do painel focada em harmonia visual e utilidade da
informação, usando agentes especialistas, com explicação em linguagem
simples. Dois agentes `Explore` varreram todas as páginas
(`src/pages/*.jsx`) e os componentes de `src/components/dashboard/` +
`src/components/assets/`; achados relevantes foram verificados manualmente
lendo os arquivos apontados antes de qualquer mudança. Escopo 100% visual —
nenhuma lógica de trading/scanner/Firestore foi tocada
(`.claude/rules/frontend-ui.md`).

### Achado 1 (bug real) — badge "Breakeven" com cor de perda

`TradeHistory.jsx`'s `HistoryCard` trocava o LABEL do badge de status pra
"🔄 Breakeven" quando `classifyOutcome(op) === 'BE'`, mas mantinha a COR
vinda de `STATUS_MAP[op.status]` (`STOP_HIT` → rosa `#ff1478`, cor de
perda) — o número de P&L no mesmo card já usava a cor certa (amarelo
`#ffd166`, neutro), criando um badge rosa (parece perda) ao lado de um P&L
amarelo (neutro) pro mesmo trade. `Trades.jsx:226` já resolvia o caso
equivalente trocando cor e label juntos. **Corrigido**: `badgeColor`
condicionado a `isBE` no mesmo padrão.

### Achado 2 — "Alta Prioridade" com 3 cores diferentes

Mesmo conceito com 3 cores diferentes: `Dashboard.jsx` StatsCard usava rosa
`#ff1478`, o chip de filtro do Dashboard usava amarelo `#ffd166`, e
`Alerts.jsx` (página dedicada ao assunto, 3 ocorrências internas
consistentes) usava laranja `#ff9f43`. **Corrigido**: as duas ocorrências do
Dashboard alinhadas para `#ff9f43`, usando `Alerts.jsx` como referência.

### Achado 3 — card duplicado no Dashboard (`PerformanceBar`)

`PerformanceBar.jsx`, `PerformanceMetricsBar.jsx` e a grade de `StatsCard`
do próprio `Dashboard.jsx` mostravam, todos, os mesmos números empilhados na
mesma tela: Win Rate (idêntico ao de `PerformanceMetricsBar`, mesmo
`summarizeOps(tradeOps)`), "Ops Ativas" (duplicava a StatsCard "Operações
Ativas") e "Monitorados" (duplicava a StatsCard "Monitorados"). Só "Sinais
24h" era informação exclusiva, e de valor secundário. **Corrigido**:
`PerformanceBar` removido do Dashboard (import + render); o arquivo do
componente foi deixado no repo, sem uso, por segurança de rollback. Efeito
colateral positivo: o ícone `Target` tinha dois significados na mesma tela
("Ops Ativas" no `PerformanceBar` vs "Win Rate" nos demais) — resolvido de
graça. `PerformanceOverview` (gráfico de equity curve) e
`PerformanceMetricsBar` (drawdown + risk/reward) continuam os dois — cada um
traz algo exclusivo que o outro não tem, então a sobreposição residual de
win rate/P&L entre eles ficou registrada como observação, não como ação.

### Achado 4 — "Score" sem explicação nos pop-ups de sinal novo

`AssetCard`/`AssetDrawer`/`TradeCard` já explicam via tooltip que o Score
"não é uma probabilidade de acerto do trade" — só os dois avisos mais
chamativos (`SignalToast.jsx`, toast flutuante; `SignalAlertBanner.jsx`,
banner do topo do Dashboard) mostravam "Score X/100" cru, exatamente onde um
usuário tem mais chance de ler errado (achar que é % de chance de ganhar).
**Corrigido**: mesmo texto de disclaimer adicionado como `title` (tooltip
nativo) nos dois.

### Achado 5 (polimento menor) — laranja "quase certo" em `Logs.jsx`

Nível "WARN" usava `rgba(255,180,0,0.9)`, tom de laranja ligeiramente
diferente do `#ff9f43` usado como "aviso/atenção" em todo o resto do app.
**Corrigido**: alinhado ao hex padrão, mesma opacidade de `bg`/`border`.

### Fora de escopo (registrado, não implementado)

Duplicação de código do componente `SummaryCard` entre `Backtest.jsx` e
`MonthlyReport.jsx` (mesmo visual, dois lugares no código — manutenção, não
bug visível); `AlignmentBanner.jsx`/`DirectionIndicator.jsx` usam paleta
Tailwind (`emerald`/`rose`) fora do padrão hex do resto do app, mas nenhum
dos dois é importado em lugar nenhum hoje (código morto, sem efeito
visível); sobreposição residual `PerformanceOverview` × `PerformanceMetricsBar`
(ver achado 3).

### Verificação

`npm run lint`, `npm test` (831 testes, sem novos — mudança é só cor/prop,
nenhum comportamento novo a testar) e `npm run build` limpos. Sem
verificação visual no navegador (mesma limitação de ambiente dos itens
61-63).

---

## 65. Auditoria "existe dado fake/mock escondido?" (2026-08-06)

### Contexto

Usuário perguntou diretamente se havia dado falso/mockado em algum lugar do
app que pudesse confundir. Auditoria por grep em todo `src/`, `server/` e
`scripts/` por `mock`/`fake`/`dummy`/`hardcoded`/`Math.random()` +
verificação manual de cada ocorrência em código de produção (não-teste).

### Achado — nenhum dado falso disfarçado de real

Todas as ocorrências são benignas: geração de ID de lock (`Math.random()` em
`tryAcquireScanLock`), relógio simulado usado só dentro dos testes
(`installSimClock`), e o backend em memória do `backtest.yml` (GitHub
Actions) — que é **deliberadamente** isolado (nunca escreve no Firestore
real nem manda Telegram real) e já aparece rotulado como simulação na aba
"Simulação (GitHub)" do Backtest. Nenhum script de seed/demo popula dado
fictício nas coleções reais.

### Achado — 2 lacunas de transparência (não são dado falso, mas confundem)

1. **Divergência de fonte de preço não avisada na tela.** `marketDataProvider.js`
   (painel, browser) usa Binance **Futures** (`fapi.binance.com`);
   `adminMarketDataProvider.js` (cron, que decide as operações de verdade)
   usa Binance **Spot** (`data-api.binance.vision`) — limitação de rede já
   aceita formalmente (item 4 do `CLAUDE.md`), mas até agora só documentada
   internamente. `market_source` é gravado em `SignalEvent`/`TradeOperation`
   mas nunca lido/exibido em nenhum componente. **Corrigido**: tooltip no
   badge "Dados em tempo real" do `Dashboard.jsx` explicando a divergência.
2. **"Ajuste Fino (What-If)" não avisava ser uma aproximação simplificada.**
   O texto na tela só dizia "sem afetar o scanner" (deixa claro que é
   seguro), mas não que é uma simulação single-asset/single-timeframe sem a
   cascata completa (multi-timeframe + SMC) do motor real — só o comentário
   no código (`quickBacktest.js`) explicava isso, não a UI.
   **Corrigido**: nota abaixo do cabeçalho da seção em `Backtest.jsx`.

### Verificação

`npm run lint`, `npm test` (831, sem novos) e `npm run build` limpos. Sem
verificação visual no navegador (mesma limitação de ambiente).

### Correção pós-review (Codex, PR #143)

O texto original do achado 1 estava impreciso: dizia que "o painel vem da
Binance Futures", mas o que `AssetCard.jsx` renderiza é o `AssetState`
**persistido** no Firestore por `persistScanResults` — não uma leitura ao
vivo no navegador. Como o cron roda a cada ~5min via Spot e o full-scan do
próprio navegador (`useAutoScan.js`) só roda a cada 60min via Futures, o
valor exibido é quase sempre Spot, só ocasionalmente Futures (se a aba
ficar aberta por mais de 1h). Tooltip reescrito pra descrever o mecanismo
real. Também trocado o `title` (só hover, invisível a teclado/touch) pelo
componente `Tooltip` do shadcn/Radix já existente no projeto (nunca usado
até então) — abre no foco também, não só no hover; `TooltipProvider`
adicionado em `App.jsx`.

---

## 66. Auditoria geral pedida pelo usuário: 1H ativo? dados reais? bugs? "posso confiar?" (2026-08-07)

### Contexto

Usuário pediu uma auditoria ampla e direta do motor: confirmar se operações
em 1H estão ativas, procurar bugs/erros/lacunas, e confirmar se os dados são
reais e o sistema é confiável. Rodei 3 agentes Explore em paralelo (motor/
`scanner.js`, `docs/known-risks.md`/roadmap, dados reais vs. mock) e cruzei
com leitura direta de `scanner.js`, `pineParser.js`, `AddAssetForm.jsx`,
`scan-shadow.yml`.

### Achado 1 — 1H está ativo como dado/contexto, mas travado como gatilho de entrada RF

1H é sempre buscado/calculado por padrão (`timeframes_enabled` default
`{'1h':true,'4h':true,'1d':true}`, `AddAssetForm.jsx:48`) e alimenta a
confluência multi-timeframe de todo sinal. Mas como gatilho de ENTRADA: a
cascata RF nativa só abre operação a partir de 4h (`scanner.js:1784`, sinal
1h vira só alerta); o mecanismo dedicado `pineConfig.rf1hCondEnabled`
**nunca existe** em `pineParser.js`/`adminPineConfig.js` (só em
`backtestPineConfig.js`, travado por `rf1hCondTripwire.test.js`) — em
produção real é sempre falsy. Único caminho real de operação 1H é a cascata
SMC 1h→5m (`asset.smc_enabled`, opt-in, default `false` para ativos novos
desde 2026-08-02). O modo sombra (item 56, ativo desde 2026-08-04) testa o
`rf1hCondEnabled` ao vivo mas só em coleções isoladas — nunca abre operação
real; leitura mais recente do próprio item 56 (2026-08-07) mostra zero
operações fechadas em ambas as cascatas do modo sombra até agora. Nenhum
achado novo — confirmação independente do que já estava registrado nos
itens 56/60/61.

### Achado 2 — nenhum dado fake/mockado encontrado (segunda confirmação independente do item 65)

Grep completo por `mock`/`fake`/`dummy`/`hardcoded`/`Math.random`/`TODO`/
`FIXME`/`placeholder` em `src/lib/` e `scripts/` (produção): todas as
ocorrências são benignas (nonce de lock, comentários de changelog de bugs
já corrigidos, ou o motor de backtest — ferramenta separada e rotulada).
`marketDataProvider.js`/`adminMarketDataProvider.js` batem em endpoints
reais da Binance (Futures/Spot), sem fallback sintético; `adminEntities.js`
grava em Firestore real via `firebase-admin`. Mesmo veredito do item 65, sem
achado novo.

**Correção (Codex review, PR #145)**: a frase original aqui dizia que
"`run-scan.mjs` nunca esconde falha real do cron" — isso é impreciso.
`main()` (`run-scan.mjs:84-88`) só marca `exitCode=1` + ping `/fail` quando
o processo INTEIRO rejeita (ex.: `priceCheckActiveOps()` lançar). Uma falha
de UM ativo dentro de `scanAllAssetsInner` é capturada e **registrada como
erro do ativo** — `MonitoredAsset.scan_status/scan_error/scan_error_since` +
um `SystemLog` (`scanner.js:3310-3329`), não só `console.error` — mas **não
é propagada** para tornar a execução inteira malsucedida: o scan continua e
o ping normal de sucesso do Healthchecks.io ainda é enviado (correção de
review, Codex, PR #146 — a 1ª versão deste parágrafo dizia "só logada",
subestimando a observabilidade real). Isso não é um achado novo desta
auditoria: é o próprio comportamento já documentado no item 12 ("o ping
abaixo só reporta a passada INTEIRA como falha/sucesso — um ativo falhando
toda passada, ou saindo silenciosamente, nunca aparece"), mitigado ali pelo
healthcheck por-ativo (`checkAssetHealthchecks`, que lê exatamente esses
campos persistidos e dispara alerta Telegram de ativo "stale"),
não pelo ping de processo. O texto original desta seção conflitava com o
item 12 em vez de referenciá-lo — corrigido.

### Achado 3 — nenhum bug novo no motor

Todos os P0 de concorrência (`opTransition.js`/CAS transacional) seguem
`[CORRIGIDO]` com teste de regressão, confirmado por leitura do código
atual. Nenhuma regressão encontrada em `scanner.js`, `entities.js`/
`adminEntities.js`, `run-scan.mjs`. Itens residuais (locks separados,
ambiguidade stop/TP no mesmo candle, precedência stop>TP entre loops) são
aceitos por desenho, já documentados em `.claude/rules/trading-engine.md`,
não bugs.

### Limitações desta rodada

Sem acesso ao Firestore de produção nesta sessão — não confirmei ao vivo
quantos ativos têm `smc_enabled: true` hoje nem se há alguma
`TradeOperation` 1H aberta no momento (conferir no painel). Sem
`node_modules` instalado nesta sessão — não rodei `npm run lint && npm
test && npm run build` para confirmar que a suíte (831 testes na última
rodada, item 65) segue verde; recomendo rodar numa sessão normal.

### Verificação

Leitura completa/dirigida de `scanner.js`, `marketDataProvider.js`,
`adminMarketDataProvider.js`, `adminEntities.js`, `run-scan.mjs`,
`build-scan.mjs`, `pineParser.js`, `AddAssetForm.jsx`, `scan.yml`,
`scan-shadow.yml`, `docs/known-risks.md` (integral), `docs/roadmap.md`
(integral), `.claude/rules/trading-engine.md`, `.claude/rules/pine-parity.md`.
3 agentes Explore independentes + leitura direta própria, achados
cruzados e consistentes entre si. Nenhuma mudança de código/comportamento
nesta rodada — só documentação da análise.

---

## 67. Sinal 4h real do FETUSDT no TradingView não virava operação no Sentinel — hipótese investigada: confirmação de 15m que o Pine real não tem (2026-08-07)

### Contexto

Usuário relatou: FETUSDT deu sinal de compra 4h às 17h de 05/08 no
TradingView (rodando bem, perto do take) e outro de venda 27/07 09h que
bateu take em 28/07 21h — mas o Sentinel não mostrava essas entradas.
Confirmado por ele: o painel VIA o ativo (aba 1h mostrava "aguardando", aba
4h mostrava "próximo"), só nunca convertia em operação de verdade. Usuário
colou o Pine real completo (v13.2, o mesmo guardado em `src/pages/
PineScript.jsx`) e autorizou tentativa de leitura direta do Firestore de
produção — bloqueada pelo classificador de segurança do ambiente desta
sessão, mesmo com autorização explícita; não foi contornada.

### Achado — hipótese forte por leitura de código, NÃO confirmada por dado (ver correção abaixo)

O Pine real do usuário entra IMEDIATAMENTE no fechamento do candle de 4h que
gera o sinal — `finalBuy`/`finalSell` dependem só de `candleConfirmed` (o
próprio candle do sinal ter fechado), `freshBuy`/`freshSell`,
`buyFollowThrough`, `score >= minScore`, filtros de regime e do filtro MTF
(auto-referente quando aplicado direto no gráfico de 4h). Não existe
timeframe de confirmação separado em lugar nenhum do Pine real. Esse fato
sobre o Pine é 100% confirmado (leitura direta do script colado pelo
usuário).

O Sentinel, por desenho deliberado (não bug, já registrado no roadmap —
"entrada causal 15m 'Fresh RF Flip'"), exige uma confirmação ADICIONAL no
candle de 15m antes de abrir a operação (`check15mConfirmation`,
`src/lib/scanner.js`). Na prática isso faz o Sentinel entrar depois do
TradingView, ou às vezes nunca entrar (se o 15m não realinhar dentro da
janela de retry de 4h) — bate com o sintoma relatado. **Essa era a leitura
inicial de causa raiz, mas o A/B real (subseção mais abaixo) NÃO confirma
que essa é a explicação do caso do FETUSDT especificamente** — a contagem
de operações do FETUSDT ficou idêntica com o flag ligado e desligado.
Continua sendo uma hipótese plausível para o comportamento GERAL do motor
(atraso sistemático vs. TradingView), só não está provada como a causa do
episódio relatado no Contexto. Ver a subseção do A/B para o detalhe e o que
ainda falta investigar.

Parâmetros comparados byte-a-byte com o Pine colado e confirmados OK (não
eram a causa): `rf_period`/`rf_multiplier` (20/3,5), pesos do score
(25/20/20/15/10/10), limiares por tier (T3 Altcoin — ADX min 18, Chop max
62, ATR stop 3.0x, Time Stop 96 candles). `src/pages/PineScript.jsx` já
guardava a v13.2, mesma versão colada pelo usuário — não era cópia
desatualizada.

### Decisão e implementação

Usuário escolheu testar remover/afrouxar a confirmação de 15m para bater
1:1 com o TradingView, ciente do trade-off (perde a proteção contra
reversão rápida que o 15m dava). Implementado como mecanismo **opt-in**
(`pineConfig.skip15mConfirmationEnabled`, default `false` — preserva o
comportamento de hoje), seguindo o mesmo padrão dos 6 mecanismos
experimentais anteriores do projeto — nunca virou o comportamento padrão
direto:

- Bypassa `check15mConfirmation` nos 5 pontos de chamada (`src/lib/
  scanner.js`) via novo helper `resolveEntryConfirmation15m` — quando
  ligado, monta a confirmação a partir do que o `SignalEvent` já gravou no
  nascimento do sinal (`price_at_signal`/`candle_time`), nunca de
  `results['4h']` relido na passada atual (que no loop de retry pode já
  apontar para um candle 4h mais novo que o do sinal original — RF só emite
  sinal em MUDANÇA de direção). Zero fetch de candle 15m quando ligado.
- Novo campo `entry_candle_time_4h` (em vez de reaproveitar
  `entry_candle_time_15m` com semântica trocada) — `getEntryReferenceTime`
  (`src/lib/opExitRules.js`) ganhou um terceiro fallback, então as duas
  proteções P0 que dependem dela (guarda temporal contra candle pré-entrada
  e Time Stop) continuam corretas. Novo campo de auditoria
  `skip_15m_confirmation` na operação, congelado na criação.
- Flag sincronizado nos 3 arquivos de config (`src/lib/pineParser.js`,
  `scripts/adminPineConfig.js`, `scripts/backtestPineConfig.js`) — categoria
  "produção futura" (como `retestEnabled`/`smcTierEnabled`/etc.), não
  backtest-only como `rf1hCondEnabled`: aqui o objetivo é bater com uma
  estratégia real já operada pelo usuário, então depois de validado é
  esperado ir a produção.
- 7 testes novos (`opExitRules.test.js`, `scannerStateMachine.test.js`):
  fallback de `getEntryReferenceTime`, `buildTradeOpData` grava os campos
  certos conforme `bypassed15m`, flag desligado é byte-idêntico ao
  comportamento anterior, flag ligado abre sem nenhum fetch de 15m
  (1ª passada E retry — ver correção abaixo sobre a fonte do preço no
  retry), e as duas proteções P0 (guarda temporal, Time Stop) continuam
  corretas lendo `entry_candle_time_4h`.

### Verificação

`npm run lint && npm test && npm run build` limpos (838 testes, 7 novos, 0
regressão). `npm run build:scan`/`build:scan-shadow`/`build:backtest`
(os 3 alvos que empacotam `scanner.js` via esbuild) também compilam limpos.
Documentado o A/B recomendado via `backtest.yml` em
`docs/claude/backtest-usage.md` (comparar `report.entryFunnel` — deve zerar
`confirmation_15m_not_aligned` com o flag ligado — e `report.byCascade
['4h_15m']`/`overall` antes de qualquer decisão de ligar em produção). A/B
real ainda não rodado nesta sessão — próximo passo, sob decisão do usuário.

### Correção pós-review (Codex, PR #147) — 2 achados reais

1. **P2 — `getOpenedAt` (`src/lib/tradeMetrics.js`) não reconhecia
   `entry_candle_time_4h`.** Só olhava `entry_candle_time_15m`/`_5m` antes de
   cair para `candle_close_time` — contagem de settlement de funding,
   duração em posição e o filtro de warm-up/janela de avaliação do backtest
   (`backtestEngine.js`/`backtestAnalysis.js`, ambos reusam `getOpenedAt`)
   ficavam usando a referência errada (o candle de sinal, potencialmente
   obsoleto) para toda operação criada com `skip15mConfirmationEnabled`.
   Corrigido: mesmo terceiro fallback já adicionado em
   `opExitRules.getEntryReferenceTime`. Teste novo em `tradeMetrics.test.js`.
2. **P1 — o loop de retry podia reabrir um sinal de até 4h atrás usando o
   preço OBSOLETO do sinal original.** Os 2 pontos de retry (cascata nativa
   `4h_15m` e a experimental `rf1h_cond4h_15m`) usavam
   `sig.price_at_signal`/`sig.candle_time` na confirmação sintética — correto
   na 1ª passada (mesmo candle do sinal, sem obsolescência), mas errado no
   retry: um sinal bloqueado antes por outro gate (`active_op_exists`,
   regime, reteste) e só liberado horas depois abriria a operação num preço
   que já não é executável, misturando uma entrada antiga com o ATR/stop/tp
   calculados na passada ATUAL. Corrigido: os dois pontos de retry agora usam
   `tfData4h.lastClose`/`tfData4h.lastCandleTime` (o candle 4h da passada
   ATUAL, já revalidado como mesma direção pelo guard `trend_reversed`
   pré-existente) — mesmo padrão que o ponto de confirmação de promoção
   SMC→4h já usava corretamente desde o início. 2 testes reescritos/novos em
   `scannerStateMachine.test.js` provando o preço causal no retry e a
   rejeição por `trend_reversed` continuando a barrar entrada com preço
   obsoleto quando o 4h já reverteu. `npm run lint && npm test && npm run
   build` (+ os 3 alvos esbuild) limpos de novo após a correção (840 testes).

### A/B real via `backtest.yml` — resultado (2026-08-07)

Usuário rodou os 2 backtests recomendados (7 símbolos padrão, 12 meses,
2025-08-07→2026-08-07 — janela que cobre as duas datas relatadas no
Contexto, 27/07 e 05/08) e colou os dois diagnósticos
(`scripts/analyze-backtest.mjs`).

**Volume — o objetivo original — subiu pouco, e não como a hipótese
esperava**: 103 → 108 operações fechadas (+5, +4,9%). O funil de regime
(ADX/Choppiness) é quase idêntico nos dois runs (~128 vs ~127 candidatos
aprovados em regime, de 207 sinais totais) — a confirmação de 15m raramente
rejeitava de fato (15m tende a concordar com o 4h logo após o sinal), ela
principalmente ATRASAVA a entrada, não a impedia.

**Expectância**: 0,053R (desligado) → 0,118R (ligado), +0,065R — os dois
relatórios continuam **INCONCLUSIVOS** individualmente (IC 95% de cada
expectância cruza zero). **Correção (Codex review, PR #148)**: a versão
original desta seção comparava esse +0,065R contra o limiar de ~0,10R do
roadmap.md — errado, esse limiar é a correção pra testar 4 ablações
(múltiplas comparações), não pra um único A/B pré-registrado como este. E
"cada run é inconclusivo isoladamente" não é o mesmo teste que "a
DIFERENÇA entre os dois runs é real" — nenhum teste formal da diferença
(IC pareado/bootstrap) foi feito aqui. Honesto: não dá pra afirmar que
+0,065R é ruído nem que é sinal real — só temos os dois números brutos,
sem teste estatístico da diferença entre eles.

### Comparação operação-a-operação do FETUSDT — resultado (2026-08-08)

Usuário conseguiu baixar e anexar os 2 `backtest-report.json` completos
(a mesma coisa que eu tinha pedido, mas via upload direto — o download do
artifact continuava bloqueado pra esta sessão). Comparei as 18 operações
de `overall.curve` do FETUSDT nos dois runs, uma a uma (`side`,
`candle_close_time`, `entry_price`, `closed_reason`, `closed_at`, `r`).

**Confirma o que o Codex apontou (achado 2 do PR #148): contagem igual NÃO
era "zero diferença".** 16 das 18 operações são byte-idênticas (mesmo
sinal, mesmo preço de entrada, mesmo resultado) — nesses casos o RF do
15m já estava alinhado no exato instante do fechamento do candle de 4h,
então a confirmação não atrasou nada. Mas **2 operações divergem de
verdade**: no sinal de 2025-12-11, a confirmação de 15m atrasou a entrada
em 15min e mudou o preço (0,2378 vs 0,2356) o suficiente pra mudar o
desfecho — `STOP_HIT` com **+1,22R** (desligado) vs `TIME_STOP` com
**+0,64R** (ligado), mesma direção, resultado bem menor. A outra (sinal de
2026-07-21) teve diferença de preço mínima (0,1602 vs 0,1599), resultado
praticamente igual. **Veredito**: o flag tem efeito real no FETUSDT, só que
pequeno e raro (2 de 18) — não é "zero impacto" como a 1ª leitura sugeria,
mas também está longe de "resolve o problema relatado".

**Por que o efeito é tão raro — mecanismo (observação do usuário,
confirmada lendo o código)**: `check15mConfirmation` (`src/lib/
scanner.js:424-467`) busca "a vela de 15m mais recente que já fechou" no
momento em que o scan roda. Todo fechamento de vela de 4h **também é**,
por construção, um fechamento de vela de 15m (4h = 16 × 15m) — então,
quando o scan avalia o sinal de 4h na MESMA passada em que ele nasceu, a
"vela de 15m mais recente" já é a que fechou junto com a de 4h, não uma
vela nova 15 minutos depois. **Medido nos dados**: 16 das 18 operações do
FETUSDT entraram no MESMO instante exato do fechamento do candle de 4h
(`entry_candle_time_15m === candle_close_time`) — zero espera real. Só 2
de 18 esperaram uma vela de 15m a mais (exatamente 15min, quando a 1ª
checagem pegou o 15m ainda não realinhado). Ou seja: na prática, a
"confirmação de 15m" quase nunca é uma espera de verdade — é um cheque
quase-instantâneo que só ocasionalmente pega o mercado no meio de uma
reversão. Isso é consistente com o funil agregado dos 7 símbolos
(`entryFunnel['4h_15m'].byReason.confirmation_15m_not_aligned = 109` de
1986 rejeições totais, ~5,5%) — a confirmação raramente é o gate que
decide.

**As duas datas do Contexto, verificadas contra os dados**:
- **27/07 (venda)**: aparece IDÊNTICA nos dois runs — candle de sinal abre
  12:00 UTC = 09:00 Brasília (bate com o relatado). Mas o backtest fecha
  essa operação em **30/07 20:00 UTC** (via `STOP_HIT` favorável, +1,25R —
  o trailing do runner pós-TP1), não 28/07 21h como o usuário viu ao vivo —
  ~2 dias de diferença no fechamento, IGUAL nos dois runs (não tem nada a
  ver com a confirmação de 15m). **Correção (Codex review, PR #149): não dá
  pra atribuir isso só à divergência de preço Spot×TradingView** —
  `src/lib/backtestEngine.js:13-18` documenta que o replay histórico
  NUNCA roda `priceCheckActiveOpsInner` (o loop de preço ao vivo, tick a
  tick); ele só aproxima saídas via candle fechado
  (`persistScanResults`), que é estruturalmente mais grosseiro que o
  price-check contínuo que a produção usa de verdade. Ou seja: mesmo com
  dado de preço IDÊNTICO ao vivo, o backtest já fecharia essa operação
  mais tarde só pela granularidade candle-a-candle vs. tick-a-tick — uma
  explicação alternativa que não tinha sido considerada, e que não dá pra
  descartar sem comparar contra dado equivalente. Duas hipóteses em
  aberto (não excludentes), nenhuma confirmada: divergência de fonte de
  preço, e/ou a aproximação por candle do próprio motor de backtest.
- **05/08 (compra)**: **não aparece em NENHUM dos dois runs.** A operação
  mais recente do FETUSDT na janela inteira de 12 meses é a de 27/07 — nada
  depois disso, com ou sem a confirmação de 15m. Isso **descarta
  definitivamente** a confirmação de 15m como causa desse caso específico
  (removê-la não trouxe o sinal de volta). **Correção (Codex review, PR
  #149)**: isso mostra só que o replay sobre dado Spot não gerou/confirmou
  esse candidato — não prova QUE gate rejeitou nem que a causa seja
  divergência de fonte de dado; sem o funil de rejeição desagregado por
  símbolo (`report.rfRegime`/`entryFunnel` deste relatório são agregados
  dos 7 símbolos juntos, não dá pra isolar o FETUSDT), continua sendo
  hipótese, não fato confirmado.

**Recomendação final**: não ligar `skip15mConfirmationEnabled` em
produção — efeito pequeno, não resolve o caso que motivou a investigação.
A causa do episódio relatado **não está confirmada** — as hipóteses mais
plausíveis com o dado atual são divergência de fonte de preço
(Spot×TradingView, item 4, limitação já aceita) e/ou a aproximação por
candle fechado do motor de backtest (`backtestEngine.js`) vs. o
price-check contínuo da produção real — nenhuma delas verificada contra
dado equivalente. Não há ação de código adicional proposta aqui; investigar
mais a fundo exigiria rodar o SCAN REAL (não o backtest) sobre esse
período, ou comparar candles Spot vs. a fonte que o TradingView usa
diretamente — nenhum dos dois foi feito nesta rodada.

Verificação: leitura direta dos 2 `backtest-report.json` completos
(103/104 e 108/109 operações totais, `overall.curve` filtrado por
`symbol === 'FETUSDT'`), comparação campo a campo das 18 operações de cada
run. Nenhuma mudança de código nesta rodada — só registro do resultado.

## 68. RF 1h TOTALMENTE independente do 4h — A/B real: expectância negativa e conclusiva, mantido desligado (2026-08-08)

### Contexto

Usuário perguntou se o mecanismo de entrada em 1h é igual ao de 4h, e se já
existia um "1h puro" testado — sem SMC, sem exigir concordância do 4h. Já
havia 2 mecanismos de 1h medidos: **RF 1h condicionado ao 4h**
(`rf1hCondEnabled`, item 56 "Fase 1" — exige que o RF do 4h concorde com a
direção do sinal de 1h antes de considerar entrada; medido: volume 75→157
operações mas expectância +0,215R→−0,028R, piorou) e **SMC 1h→5m**
(indicador de estrutura de mercado, não Range Filter; expectância −0,778R,
item 56). Faltava testar RF de 1h **sem** o gate de concordância com o
4h — mesmo indicador, mesmo regime, só sem essa exigência direcional.
Usuário confirmou que queria testar.

### Mecanismo implementado

Nova flag `pineConfig.rf1hUncondEnabled` (default `false`) e nova cascata
`'rf1h_uncond_15m'` (`RF_1H_UNCOND_CASCADE`, `src/lib/scanner.js`) — mesma
mecânica do `rf1hCondEnabled` (ATR/tier/regime continuam vindo de
`results['4h']`, mesma `check15mConfirmation`, mesma janela de retry de 4
barras de 1h) com a ÚNICA diferença: **não** existe o gate
`tf4hDir !== sigDir` que o `_cond` tem — um sinal RF de 1h pode abrir
operação mesmo com o 4h discordando ou sem posição definida. Duas decisões
de design validadas antes de implementar:

1. **ATR/tier/regime continuam vindo de `results['4h']`**, não recalcula
   nada em dado de 1h — isola exatamente 1 variável em relação ao
   `rf1hCondEnabled` já testado (mesma metodologia, resultado comparável) e
   evita reabrir a calibração ADX/Choppiness em 1h (nunca validada, item 42).
2. **`CASCADE_RANK` da nova cascata = 2** (`src/lib/signalArbitration.js`),
   igual a `4h_15m`/`rf1h_cond4h_15m`, não 1 (como SMC) — rank 1 dispararia
   promoção em dois estágios contra a RF nativa (hoje só existe entre SMC e
   RF), uma 2ª variável indesejada no experimento.

**Isolamento backtest-only** (mesmo padrão do `rf1hCondEnabled`): a flag
existe SÓ em `scripts/backtestPineConfig.js` — deliberadamente NUNCA
espelhada em `src/lib/pineParser.js`/`scripts/adminPineConfig.js` (os dois
arquivos que alimentam `strategyConfig/current` no Firestore, gravável por
qualquer sessão anônima, CLAUDE.md decisão item 1 — uma chave viva ali
seria toggle de produção sem gate de revisão de código). Reforçado por
tripwire test (`src/lib/rf1hUncondTripwire.test.js`, mesmo padrão do
`rf1hCondTripwire.test.js`) que falha se a chave aparecer como entrada de
objeto em qualquer um dos 2 arquivos de produção. **Convenção, não validada
em runtime**: nunca ligar `rf1hCondEnabled` e `rf1hUncondEnabled` juntos no
mesmo run — se ambos vierem `true`, o `if/else-if` do bloco de 1ª passada
processa o sinal só pelo `_cond` (vem primeiro na cadeia); coberto por
teste em `scannerStateMachine.test.js` (describe do item 68) que documenta
esse comportamento em vez de bloquear no código.

### Verificação (feita nesta rodada, sem A/B real ainda)

`npm test` (851 testes, +11 desde antes: 3 do tripwire novo + 8 do describe
novo em `scannerStateMachine.test.js` cobrindo flag desligada, 4h
desalinhado ainda assim cria operação — prova de que o gate saiu —, 4h
alinhado também cria, regime reprovado bloqueia, expiração/retry em 4
barras, concorrência com a RF nativa pelo mesmo slot, e os dois flags
`cond`+`uncond` juntos processando o sinal só 1x) + `npm run lint` limpo +
`npm run build` + os 3 alvos esbuild que empacotam `scanner.js`
(`build:scan`, `build:scan-shadow`, `build:backtest`) compilando sem erro +
grep de isolamento confirmando a chave ausente nos 2 arquivos de produção e
presente só em `backtestPineConfig.js` + 1 backtest de fumaça local (sem
dado de candle disponível nesta sessão — sem acesso à Binance — mas
confirmou que o código compila e roda sem crashar).

### A/B real (2026-08-08) — 3 disparos do `backtest.yml`, mesma janela/símbolos

3 rodadas disparadas manualmente pelo usuário (`workflow_dispatch`, 12 meses,
7 símbolos: BTCUSDT/ETHUSDT/FETUSDT/PENDLEUSDT/ZROUSDT/DYDXUSDT/PAXGUSDT,
2025-08-08→2026-08-08): `{}` (`rf1h-ab-baseline-4h`), `{"rf1hCondEnabled":
true}` (`rf1h-ab-cond`), `{"rf1hUncondEnabled": true}` (`rf1h-ab-uncond`).
Análise pelos 3 `backtest-report.json` brutos (não só o texto do
`analyze-backtest.mjs`, que agrega TODAS as cascatas juntas e teria
escondido o achado principal abaixo).

**Achado 1 — o número "geral" (todas as cascatas somadas) é inconclusivo
nos 3 runs, mas esconde um resultado real dentro de uma cascata
específica.** `report.costs` (agregado): baseline 0,053R (n=103,
CI95 [-0,180; 0,286]), cond 0,085R (n=221, CI95 [-0,077; 0,248]), uncond
−0,073R (n=281, CI95 [-0,213; 0,068]) — os 3 com `conclusive: false`
(`ci_straddles_zero`). Olhar só esse número (o que `analyze-backtest.mjs`
imprime) sugeriria "tudo inconclusivo, nada a concluir". `report.byCascade`
conta uma história diferente.

**Achado 2 — a leitura "conclusiva" da cascata `rf1h_uncond_15m` isolada NÃO
se sustenta (correção, Codex review PR #153).** A 1ª versão deste registro
citava `report.byCascade['rf1h_uncond_15m']` (228 operações, `expectancyR:
-0,159`, `expectancyRStdErr: 0,078`) como resultado "conclusivo" usando o
IC95 padrão (z=1,96 → [-0,313; -0,006], não cruza zero,
`report.byCascade.*.conclusive: true` cru). Dois problemas, ambos já
documentados em precedente no próprio arquivo:

1. **Falta a correção de comparações múltiplas.** Esta cascata compete com
   a mesma pergunta em aberto do `rf1hCondEnabled` sobre dado histórico
   sobreposto — o mesmo raciocínio que já levou o modo sombra (item 56) a
   exigir Bonferroni m=2 (z=2,24) em vez do z=1,96 padrão (ver linhas
   4917-4923 acima). Recalculando com z=2,24: CI95 ≈ [-0,334; +0,016] —
   **cruza zero**. Sob o próprio critério que este projeto já usa nesse
   exato contexto, o resultado NÃO é decisão-grade.
2. **Comparar sub-buckets de `byCascade` entre si (ou entre runs) não é um
   contraste limpo.** Já registrado como achado do Codex no PR #130 (ver
   linhas 5061-5086 acima): `4h_15m` e a cascata experimental disputam o
   MESMO slot `assetActiveOps` por ativo — qual operação histórica cai em
   qual bucket depende de quem "venceu a corrida" pelo slot, não de uma
   divisão limpa condicional/incondicional. Comparar -0,159R (bucket
   uncond) contra +0,074R (bucket `rf1h_cond4h_15m` do run `cond`) como se
   fosse teste isolado de qualidade de cascata reabre o mesmo erro já
   corrigido ali — os buckets ficam como leitura **descritiva**, não como
   prova de diferença.

A leitura válida que sobra é a do Achado 1: os 3 `report.overall`
continuam todos inconclusivos, sem teste formal da diferença entre eles —
o run `uncond` tem o único ponto estimado negativo (-0,073R) dos 3, mas
isso é direção, não prova.

**Achado 3 — efeito colateral não previsto pelas 2 decisões de design:
a cascata nova DESLOCA operações da cascata nativa 4h, via o slot
compartilhado `assetActiveOps`.** A contagem de operações da cascata
nativa `4h_15m` caiu conforme mais cascatas de 1h competem pelo mesmo
slot por ativo: 103 (baseline, sem nenhuma cascata de 1h) → 82 (cond) →
53 (uncond). `report.entryFunnel['4h_15m'].byReason.active_op_exists`
confirma a causa: 441 (baseline) → 964 (cond) → 1.786 (uncond) — como o
sinal de 1h dispara com muito mais frequência que o de 4h, ele
frequentemente já ocupa o slot do ativo quando o sinal 4h nativo chega,
empurrando o candidato 4h para arbitragem em vez de abrir sua própria
operação. Isso **não invalida** a Decisão de design 1 (ATR/tier/regime
seguem vindo de `results['4h']` sem recalcular nada em 1h — confirmado:
`report.rfRegime.byCascade['4h_15m'].total` é 208 nos 3 runs, idêntico,
zero divergência de regime introduzida pelas flags novas), mas explica
por que a expectância da cascata NATIVA parece subir nos runs com mais
cascatas ligadas (0,053R n=103 → 0,105R n=82 → 0,300R n=53, todas
inconclusivas por CI) — é mais provável ser efeito de seleção/amostra
menor (só os sinais 4h que "furam" a concorrência pelo slot abrem
operação) do que uma melhora real de qualidade; nenhuma dessas 3 é
conclusiva, então nenhuma conclusão de causalidade é sustentada por elas.

**Achado 4 — confirmação do desenho.**
`report.entryFunnel['rf1h_uncond_15m'].byReason` não tem `trend_reversed`
(zero, ausente da lista) — confirma que o gate de concordância com o 4h
realmente saiu, como pretendido; a mesma chave aparece com 4.387 rejeições
(35% do funil) em `rf1h_cond4h_15m` no run `cond`, mostrando o quanto
aquele gate filtra quando está ligado.

### Recomendação final

**Não ligar `rf1hUncondEnabled` em produção** — mas por **ausência de
evidência de benefício + custo arquitetural real**, não por "prova
estatística de que piora" (correção acima: essa prova não se sustenta).
Os 3 `report.overall` seguem todos inconclusivos, então não há suporte
estatístico para afirmar que qualquer uma das 3 variantes é melhor ou
pior que as outras. O que É um achado sólido (não depende de IC — é
contagem/funil, Achado 3 acima): a cascata desloca operações reais da
cascata nativa 4h via contenção do slot `assetActiveOps`
(`active_op_exists`: 441→964→1.786), um efeito colateral de arquitetura
que já teria custo mesmo que a cascata nova fosse neutra em qualidade.
Sem ganho demonstrado que justifique esse custo, a flag continua
desligada. `rf1hCondEnabled` também segue sem evidência de melhora — mantém
a recomendação já registrada no item 56 de não ativar. Nenhuma mudança de
comportamento em produção nesta rodada: as duas flags já eram
backtest-only por isolamento deliberado (tripwire tests), sem caminho de
chegar a `strategyConfig/current`.

Verificação: leitura direta dos 3 `backtest-report.json` brutos
(`report.byCascade`, `report.entryFunnel`, `report.rfRegime.byCascade`,
`report.costs`, `report.arbitration`). Nenhuma mudança de código nesta
rodada — só registro do resultado (corrigido após review do Codex no
PR #153 apontar 2 achados procedentes sobre correção de comparações
múltiplas e contaminação de sub-buckets — ambos já tinham precedente
documentado neste mesmo arquivo, itens 56/PR#130, que eu não tinha
reaplicado aqui).

## 69. Simulador de operação-fantasma para atribuição de contribuição por indicador — Fase 1, backtest-only (2026-08-08)

### Contexto

Depois da revisão de um documento externo de "veredito técnico" sobre o
Sentinel (proposta de "Feature/Edge Attribution Engine" — medir a
contribuição marginal de cada indicador do score em vez de só olhar
operações que já passaram em todos os filtros de hoje), o usuário pediu
para começar, com uma condição explícita: manter os dados de CADA
indicador sempre em campo separado, nunca agregados num blob, para
permitir análise posterior sem precisar rodar o backtest de novo.

Dividido em 2 fases. **Fase 2 (funding real histórico) foi avaliada e
descartada por ora**: já estava registrado (linhas acima, item 4/seção "Fora
de escopo por colisão com restrição permanente") que funding/open
interest/basis são bloqueados pela mesma restrição 451/datacenter-US que
afeta o resto de dados de Futures — não é viável sem trocar de exchange ou
pagar infraestrutura fora dos EUA, nenhuma decisão que se tome sem pedido
explícito. Este item cobre só a **Fase 1**.

### Mecanismo

**Captura do sinal bruto** (`src/lib/scanner.js`, dentro de `scanAsset`,
ANTES do gate de score de `calculateSignalStrength`): novo array
`rawSignalSnapshots`, devolvido junto com `newSignals` no retorno de
`scanAsset`. Para todo flip de RF confirmado em 4h (aprovado ou não pelo
score/regime de hoje — a cascata nativa é a única que abre operação real a
partir de RF, ver itens 66/68), grava o estado de CADA indicador em campo
separado (`follow_through`, `macd_bullish`/`macd_bearish`, `ema_bull`/
`ema_bear`, `rsi_crossed_bull50`/`crossed_bear50`, `volume_above_ma`,
`adx_value`, `chop_value`, `tier`, mais `score_real`/`passed_real` para
cross-check contra o comportamento atual). Duplica as MESMAS condições que
`calculateSignalStrength` (`confluence.js`) já usa internamente, em vez de
mudar a assinatura dela — zero risco de regressão no caminho ao vivo, que
nunca lê este campo (confirmado por grep no bundle: `rawSignalSnapshots`
aparece no `run-scan.mjs`, mas `buildShadowOp`/`simulateShadowOutcome`
aparecem ZERO vezes nele — só em `run-backtest.mjs`).

**Simulador puro** (`src/lib/indicatorAttribution.js`, novo arquivo):
`buildShadowOp` replica a fórmula de entry/stop/TP1/TP2 de
`buildTradeOpData` (duplicada deliberadamente, não importada — os formatos
de input divergem e a fórmula é curta); `simulateShadowOutcome` anda
candle a candle reaproveitando a MESMA ordem de decisão de
`persistScanResults` (stop tem prioridade sobre TP no mesmo candle, Time
Stop por tempo decorrido, TP1 move pro breakeven + runner, trailing ATR
pós-TP1 nunca regride) e a mesma fórmula de MFE/MAE (extraída, não
reinventada). Simplificações deliberadas, documentadas no próprio arquivo:
ATR fica constante durante a simulação (não recalcula a série pra cada
candle futuro); gates opt-in desligados por padrão no motor real (Chop
Exit, Invalidação RF, proteção pré-TP1) ficam de fora — omiti-los reproduz
o comportamento DEFAULT, não diverge dele; sem confirmação de 15m (entrada
= fechamento do candle de sinal) — deliberado, o objetivo é isolar o
indicador, não retestar a confirmação 15m (já medida à parte, item 67).

**Wiring no backtest** (`src/lib/backtestEngine.js`): `runBacktest` ganha 2
parâmetros OPCIONAIS — `pineConfig` (passado pelo caller, NÃO importado
direto de `./pineParser` aqui dentro; achado durante a implementação:
`scripts/build-backtest.mjs` só redireciona `./pineParser`→
`backtestPineConfig.js` quando o IMPORTER é `scanner.js` — um import direto
em `backtestEngine.js` bundlaria o `pineParser.js` REAL do browser, com
Firebase, por engano) e `getFutureCandles(symbol, timeframe, afterMs)`
(callback que devolve candles cronológicos depois do instante do sinal,
sem o corte de `simNow()` — única exceção deliberada à janela causal do
resto do motor, segura porque só roda dentro do replay histórico). Ausente
= simulador desligado, sem quebrar nenhum caller existente
(`backtestEngine.test.js`). `scripts/run-backtest.mjs` fornece a
implementação real via `loadSeries` (exportado de
`scripts/backtestMarketDataProvider.js`, Node-only, nunca alcançado pelo
bundle ao vivo).

**Novo relatório** `report.indicatorAttribution`: array bruto `records`
(snapshot + outcome de cada sinal, TODOS os campos de indicador
preservados separados — atende o pedido explícito do usuário) mais um
resumo `by.{macd,ema,rsi,volume_above_ma}` agrupado pela concordância
DIRECIONAL do indicador com o lado do sinal (a mesma pergunta que
`calculateSignalStrength` já faz para pontuar — não um corte absoluto
bullish/bearish, que misturaria BUY e SELL sem sentido). Cada bucket usa
`summarizeRList` (novo, local — `n`/`expectancyR`/`stdErr`/`ci95`/
`conclusive`, z=1,96 fixo, mesmo `minTrades` do resto do projeto);
**deliberadamente NÃO** aplica a correção Bonferroni de comparações
múltiplas por padrão — comparar os buckets entre si exige a mesma
disciplina manual já registrada nos itens 56/68 (2ª correção do Codex no
PR #153), não fica automática aqui. ADX/Chop (contínuos, não booleanos)
ficam só no array bruto por enquanto — bucketing por faixa é extensão
futura, não construída nesta rodada (evitar escopo além do pedido).

**Correções do Codex review (PR #154, todas aplicadas)**:
1. **P1 — perna do TP1 não ponderada.** A 1ª versão reportava só o R da
   perna final (runner) em operações que passaram por TP1 — um TP1→TP2
   saía como 3R em vez do resultado REAL da posição (50%@1,5R + 50%@3R =
   2,25R). Corrigido reaplicando a MESMA ponderação de
   `tradeMetrics.calcRealizedDelta`/`getWeights` (`partial_percent`/
   `tp1QtyPercent`) — viesava TODO bucket que contivesse uma operação com
   TP1 batido.
2. **P1 — candles do sinal-fantasma vazavam a janela do replay.**
   `getFutureCandles` não clampava em `toMs` — um diretório de dados mais
   amplo que a janela pedida (prática recomendada por
   `docs/claude/backtest-usage.md`, baixar uma vez e reusar) contaminava a
   simulação com candles de FORA do replay declarado. Corrigido: o único
   limite agora é `toMs`, nunca uma contagem arbitrária.
3. **P2 — limite de 200 candles cortava runners vivos há mais de ~33
   dias**, marcando-os `STILL_OPEN_AT_CUTOFF` mesmo com o candle de saída
   real já carregado logo depois. Removido junto com a correção #2 acima —
   o limite natural já é `toMs`.
4. **P2 — `useTimeStop: false` não era respeitado.** O simulador aplicava
   o Time Stop incondicionalmente; `scanner.js` só aplica quando
   `pineConfig.useTimeStop !== false`. Corrigido — o simulador agora mede
   a MESMA estratégia configurada no replay, não outra.
5. **P2 — bucket `follow_through` sempre com `disagrees` vazio.**
   `calculateConfirmedSignal` só produz `confirmedSignal` quando o
   follow-through correspondente já é `true` — todo snapshot capturado
   (que só existe quando `confirmedSignal` é BUY/SELL) tinha
   `follow_through: true` por construção, tornando o bucket incapaz de
   medir esse componente. Removido do resumo `by` (o campo `follow_through`
   continua no snapshot bruto, `records`, para uma futura captura ANTES do
   gate de follow-through).
6. **P2 — `records` filtrava sinais não resolvidos.** A 1ª versão só
   guardava sinais com resultado calculado, escondendo `insufficient_data`/
   `STILL_OPEN_AT_CUTOFF` do consumidor — contradizia o próprio objetivo
   ("array bruto completo"). Corrigido: `records` agora tem TODOS os
   sinais capturados; só os buckets de `by` filtram para os resolvidos.

### Verificação

`npm test`: 867 passando (+16 desde antes desta feature: 14 em
`indicatorAttribution.test.js` — STOP_HIT pré/pós-TP1 com e sem
ponderação do TP1, TP1→TP2 ponderado, TP1_FULL sem runner, ambiguidade no
mesmo candle, Time Stop e o bypass via `useTimeStop:false`, trailing
monotônico nunca regride, dados insuficientes, still-open-at-cutoff,
MFE/MAE — mais 2 em `backtestEngine.test.js`, integração fim a fim: o
sinal-fantasma resolve sem look-ahead quando `getFutureCandles` é
injetado, e `report.indicatorAttribution` vem vazio sem quebrar o replay
quando o parâmetro está ausente). `npm run lint` limpo. `npm run build` +
os 3 alvos esbuild (`build:scan` 190,8kb, `build:scan-shadow` 181,2kb,
`build:backtest` 221,0kb) compilando sem erro. Grep de isolamento no
bundle: `buildShadowOp`/`simulateShadowOutcome`/`indicatorAttribution`
ausentes em `run-scan.mjs`/`run-scan-shadow.mjs`, presentes só em
`run-backtest.mjs`. Backtest de fumaça local (sem candle real disponível
nesta sessão — sem acesso à Binance) confirmou que o código compila e roda
sem crashar, com `report.indicatorAttribution` no formato esperado
(`totalRawSignals: 0` no estado vazio).

### Resultado real — run 1 (7 símbolos, 12 meses, 2026-08-09)

Usuário disparou o `backtest.yml` padrão (7 símbolos, 12 meses). 356 sinais
brutos capturados, 351 resolvidos, 5 ainda em aberto no fim da janela.
Nenhum dos 4 buckets (`by.macd/ema/rsi/volume_above_ma`) foi conclusivo
(IC95 cruza zero em todos — amostra pequena por bucket, 23-328 conforme o
indicador). Leituras pontuais (não prova): EMA concordando +0,194R (n=121)
vs. discordando +0,024R (n=230); Volume concordando +0,118R (n=260) vs.
discordando −0,017R (n=91); RSI concordando +0,017R (n=130) vs. discordando
+0,121R (n=221, direção contraintuitiva); MACD quase sem diferença
(+0,084R n=328 vs. +0,061R n=23, bucket "discorda" bem abaixo do mínimo).
Cruzamento extra (fora do `by`, feito lendo `records` direto): sinais que
JÁ passam no score real (≥75) tiveram expectância +0,154R (n=203) vs.
−0,015R (n=148) nos rejeitados — inconclusivo, mas direção plausível.

### Incidente de performance — run com 20 símbolos × 18 meses travou (2026-08-09)

Tentativa de ampliar a amostra para 20 símbolos × 18 meses
(`indicator-attribution-primeiro-run`, [run 31308336248](https://github.com/mateusraony/Sentinel-Signals/actions/runs/31308336248))
rodou quase 6h e foi **cancelada sem gerar relatório** — travou no step
"Rodar o replay" (11:07 → 16:16). **Causa, não é bug**: erro de
recomendação minha. O motor já tem uma limitação documentada e deliberada
(`docs/roadmap.md`, "Limite de performance conhecido"): o backend fake em
memória usado no backtest reordena a coleção inteira de `SignalEvent` a
cada consulta, custo que cresce de forma superlinear com o tamanho do
store — e o próprio roadmap já registrava que **"12 meses × 20 símbolos
cabe no timeout"**, mas não janelas maiores. Recomendei 18 meses em vez de
manter a janela nos 12 meses já validados como seguros — empurrei
justamente a variável (duração) que esse gargalo mais penaliza. Corrigido
recomendando voltar a janela para 12 meses (ver run 2 abaixo, que
completou normalmente) — não há indício de que o simulador de
operação-fantasma (item 69) em si tenha contribuído para o travamento: ele
não toca o backend fake (`fakeBackend.filter`), só processa candles já em
memória.

### Resultado real — run 2 (20 símbolos, 12 meses, 2026-08-09)

`indicator-attribution-20symbols-12m` completou normalmente. 1.020 sinais
brutos, 1.007 resolvidos, 13 em aberto. Amostras por bucket bem maiores
que o run 1 — os 8 valores reais: MACD 962/45, EMA 339/668, RSI 385/622,
Volume 752/255 (**correção, Codex review PR #155**: a versão anterior
citava "339-962" como faixa, mas os 8 buckets não formam uma faixa única —
cada par concorda/discorda soma o total de 1.007; o menor bucket real é 45
(MACD discorda), não 339) — mas **ainda nenhum conclusivo**, IC95 continua
cruzando zero nos 8. Comparação com o run 1 (mesma tabela, ver histórico
git para os números completos):

- **EMA e Volume mantiveram a mesma DIREÇÃO** com 3x mais dado (concordar
  continua melhor que discordar nos dois), embora o tamanho do efeito
  medido tenha encolhido (EMA: +0,194R→+0,101R "concorda"; Volume:
  +0,118R→+0,023R "concorda") — sobreviveu ao teste de mais amostra, o que
  é mais informativo que o número absoluto isolado.
- **RSI e MACD não sobreviveram.** A diferença "contraintuitiva" do RSI
  (concordar +0,017R vs. discordar +0,121R no run 1) encolheu para quase
  nada (−0,008R vs. +0,010R no run 2) — exemplo concreto, dentro do
  próprio projeto, de achado de amostra pequena que era ruído, não sinal.
  MACD seguiu o mesmo padrão (+0,084R/+0,061R → +0,002R/+0,012R).
- Cruzamento score real passa/rejeita também sobreviveu na direção
  (+0,040R n=588 vs. −0,049R n=419) mas encolheu bastante (era
  +0,154R/−0,015R no run 1).
- `report.costs` do run 2 (portfólio de 20 símbolos inteiro): bruto
  +0,020R, líquido **−0,030R**, INCONCLUSIVO — mais fraco que o run de 7
  símbolos, consistente com a ressalva já registrada no roadmap.md ("20
  símbolos não são 20 amostras independentes — correlação com BTC").

**Recomendação**: pausar a busca de mais amostra aqui — o efeito que
sobrou (EMA/Volume) encolheu com mais dado, então a amostra necessária pra
prová-lo é maior do que o cálculo inicial (baseado no run 1) sugeria, e o
custo de cada rodada é real (ver incidente de performance acima). Leitura
honesta com o dado disponível: **RSI e MACD isolados não parecem agregar
nada ao score; EMA e Volume têm um sinal fraco mas consistente, não
provado**. Não editar os pesos do score com este resultado.

## 70. Filtro MTF do Pine real — matematicamente inerte na configuração do usuário, hipótese fechada sem precisar de backtest (2026-08-09)

### Contexto

Ao desenhar o próximo teste depois do item 69 (medir a contribuição de
cada indicador do score), a hipótese cogitada era: o Sentinel usa
`analyzeAlignment` (`src/lib/indicators/confluence.js`) comparando o RF
real de 1h/4h/1d como um suposto equivalente ao "filtro MTF" do Pine real
mencionado no item 67 — e que esse seria mais um ponto de divergência
entre o painel e o TradingView, candidato a virar um novo flag
experimental A/B.

### Achado — a hipótese estava errada em dois pontos, ambos confirmados por leitura de código

1. **Na cascata RF NATIVA — a única comparável ao Pine real, já que SMC é
   desenho original do Sentinel sem equivalente no Pine — `analyzeAlignment`/
   `strengthResult.alignment` nunca gateia nada em `scanner.js`**
   (confirmado por grep — só aparece como metadado
   (`alignment: strengthResult.alignment`) gravado no `SignalEvent`/
   descrição do sinal, via `calculateSignalStrength`). Não é o port do
   filtro MTF do Pine — é um campo informativo do Sentinel sem
   equivalente funcional no Pine real. **Correção (Codex review, PR
   #155)**: essa afirmação NÃO vale para a cascata SMC 1h→5m —
   `calculateSmcSignalStrength` (`src/lib/indicators/smcConfluence.js:
   119-128`) SOMA pontos reais de `alignmentResult.alignment` no score
   SMC (crédito cheio ou parcial), que alimenta `signalArbitration.js`
   (limiares de promoção/redução de confiança entre cascatas,
   `scanner.js:1425`). Isso não reabre a hipótese fechada abaixo — o
   filtro MTF do Pine só tem correspondência conceitual com a cascata
   RF nativa (a que o Pine real implementa); a SMC nunca teve
   equivalente no Pine pra comparar em primeiro lugar.
2. **O filtro MTF real do Pine (`src/pages/PineScript.jsx`, grupo "04.
   Filtro Timeframe Superior") não compara contra 1D/1H** — `mtfTF`
   default é `"240"` (**o próprio 4h**). Quando `mtfTF` é igual ou menor
   que o timeframe do gráfico onde a estratégia roda (`mtfSameOrLowerTF`,
   verdadeiro quando aplicado direto no gráfico de 4h, como o usuário
   faz), `mtfDir = mtfDirLocal = getMtfDir(mtfRngQty, mtfRngPer)` — uma
   SEGUNDA instância do MESMO `rng_filt` que calcula o RF principal
   (`rng_filt(x, r)` com `var float rf`, mesma fórmula, mesma recorrência
   `fdir := filt > filt[1] ? 1 : filt < filt[1] ? -1 : nz(fdir[1], 0)`),
   rodando sobre a MESMA série de preço. Com `mtfRngQty`/`mtfRngPer`
   iguais a `rng_qty`/`rng_per` (ambos 20/3,5 por padrão — **confirmado
   que é a configuração real do usuário em todos os ativos**, item 57), as
   duas instâncias produzem o **mesmo valor, barra a barra, por
   construção matemática** (mesma recorrência, mesma entrada, mesma
   condição inicial). `mtfLongOk`/`mtfShortOk` (que gateiam `finalBuy`/
   `finalSell` no Pine) nunca podem discordar da direção que o sinal
   principal já exige — o filtro é um no-op certificado nesta
   configuração, não uma fonte de divergência.

### Por que registrar sem rodar backtest nenhum

Diferente dos outros itens deste arquivo, esta conclusão não depende de
dado empírico — é uma prova matemática direta da leitura do Pine real
(mesma função, mesmos parâmetros, mesma série ⇒ mesmo resultado sempre).
Rodar um A/B custaria uma rodada inteira (e o item 69 acabou de mostrar
que cada rodada não é barata) para confirmar algo que já está decidido
pelo próprio código-fonte. Pesquisa antes de planejar (princípio do
projeto) evitou esse gasto.

### Conclusão

Hipótese fechada, **não vira flag experimental**. O filtro MTF nunca foi e
não é uma fonte real de divergência entre o painel e o TradingView para
este usuário — nem pra melhor nem pra pior. Se algum dia o usuário mudar
`rf_period`/`rf_multiplier` de um ativo pra um valor diferente do padrão
de fábrica (20/3,5) SEM também mudar os parâmetros do grupo MTF no
próprio Pine (algo que só ele controla, fora do Sentinel), aí sim o
filtro deixaria de ser no-op no TradingView — mas isso não é algo que o
Sentinel precisa ou consegue replicar (o Sentinel não tem esse grupo de
parâmetros MTF separado hoje, e não há evidência de que devesse ter).

## 71. Filtro de lado na cascata RF nativa — `allowedSide`, backtest-only, achado real de BUY/SELL (2026-08-09)

### Contexto

Ao analisar os dados brutos do item 69 (run de 20 símbolos/12 meses),
separei os resultados por lado (BUY vs. SELL) — tanto nos sinais-fantasma
quanto nas operações REAIS já fechadas nesse mesmo run. O padrão já tinha
aparecido antes com amostra bem menor (item 48: SELL positivo em 5
medições, BUY seguindo o regime), mas agora com a maior amostra já medida
neste projeto para esse corte específico:

- **Sinais-fantasma** (`indicatorAttribution`, R bruto sem custo): BUY
  n=507, expectância −0,157R (IC95 [-0,258; -0,057], CONCLUSIVO); SELL
  n=500, expectância +0,165R (IC95 [0,057; 0,273], CONCLUSIVO).
- **Operações REAIS fechadas** (`report.overall.curve`, com custo
  aplicado, gates reais): BUY n=163, expectância **−0,324R** (IC95
  [-0,493; -0,155], CONCLUSIVO); SELL n=159, expectância **+0,271R** (IC95
  [0,082; 0,461], CONCLUSIVO) — todas as 322 operações desse run vieram da
  cascata nativa `4h_15m`.
- **Achado mecânico adicional**: 74 das 322 operações reais (23%) foram
  atingidas por arbitragem de sinal oposto (`arbitration_reason:
  'same_cascade_opposite_direction'`, `signalArbitration.js`) — um sinal
  do lado contrário chegou enquanto uma operação já estava ativa no MESMO
  ativo (o slot `assetActiveOps` é compartilhado entre BUY/SELL da mesma
  cascata) e, em vez de abrir sua própria operação, só reduziu a
  confiança da operação ativa em 15 pontos. Ou seja: hoje BUY e SELL
  competem pelo mesmo slot por ativo — um sinal SELL bom pode nunca virar
  operação porque um BUY (mesmo que ruim) já estava ocupando o ativo, e
  vice-versa.

### Mecanismo implementado

Novo parâmetro `pineConfig.allowedSide` (`'SELL'`, `'BUY'` ou ausente —
default, ambos os lados, comportamento de sempre). **Um parâmetro só, não
2 flags booleanas independentes** — decisão deliberada (usuário pediu
explicitamente uma forma que "um não atrapalhe a análise do outro"): evita
o estado ambíguo de os dois lados desligados/ligados ao mesmo tempo sem
precisar validar mutex, e permite testar SELL-only e BUY-only pela MESMA
mecânica, cada um num run de backtest separado — nunca no mesmo run, então
as duas amostras nunca se misturam.

Bloqueio aplicado só na cascata RF nativa (`4h_15m`, `src/lib/scanner.js`)
— a que gerou 100% das operações reais medidas acima — em 2 pontos: 1ª
passada (logo após confirmar que `results['4h']` existe, ANTES até do
gate de tendência — mais barato, sem I/O, e mais fundamental que os
outros gates) e no loop de retry (mesma posição relativa). Sinal do lado
bloqueado gera `entryFunnelOutcomes` com `reason: 'side_filter_blocked'`
(mesmo padrão de instrumentação dos outros gates, item 45.3/49) — nunca
silencioso.

**Isolamento backtest-only** (mesmo padrão dos outros mecanismos
experimentais): `allowedSide` existe só em `scripts/backtestPineConfig.js`
— deliberadamente NUNCA espelhado em `src/lib/pineParser.js`/
`scripts/adminPineConfig.js` (os dois arquivos que alimentam
`strategyConfig/current` no Firestore, gravável por qualquer sessão
anônima, CLAUDE.md decisão item 1). Reforçado por tripwire test
(`src/lib/allowedSideTripwire.test.js`, mesmo padrão dos outros). Esta é
uma mudança de ESTRATÉGIA (não um detalhe de mecanismo como confirmação
15m ou trailing) — exige A/B real e decisão explícita do usuário antes de
qualquer cogitação de produção, mais ainda que os outros flags.

### Verificação

`npm test`: 874 passando (+7: 3 do tripwire novo + 4 do describe novo em
`scannerStateMachine.test.js` — ambos os lados abrem normalmente com o
parâmetro ausente; `allowedSide: 'SELL'` bloqueia BUY mas deixa SELL
passar; `allowedSide: 'BUY'` bloqueia SELL mas deixa BUY passar, mesma
mecânica espelhada; retry loop respeita o mesmo gate). `npm run lint`
limpo. `npm run build` + os 3 alvos esbuild (`build:scan` 191,3kb,
`build:scan-shadow` 181,6kb, `build:backtest` 222,5kb) compilando sem
erro. Grep de isolamento: `allowedSide` ausente em `pineParser.js`/
`adminPineConfig.js`, presente só em `backtestPineConfig.js`. Backtest de
fumaça local confirmou que o código roda sem crashar.

### Pendente

A/B real (usuário, via `backtest.yml`, 3 disparos): baseline (`{}`),
`{"allowedSide":"SELL"}`, `{"allowedSide":"BUY"}` — mesma janela/símbolos
já usados (20 símbolos/12 meses). Critério pré-registrado: se
`report.overall`/`report.costs` do run SELL-only vier conclusivo e
positivo, é a primeira vantagem realmente comprovada (com custo, gates
reais) que este projeto mediu — não só "segue o mercado". Comparar
também `report.entryFunnel['4h_15m'].byReason.side_filter_blocked` (deve
bater aproximadamente com a contagem de sinais do lado bloqueado) e
observar se o volume de operações do lado permitido AUMENTA em relação
ao baseline (evidência do mecanismo de liberação de slot descrito acima)
ou fica igual (evidência de que a contenção de slot não era relevante na
prática).
