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
>
> **Atualização (2026-08-14, item 86)**: essa decisão vale só pra dado AO
> VIVO (`fapi.binance.com`, bloqueado por IP). O arquivo histórico em lote
> (`data.binance.vision`, serviço DIFERENTE) foi testado e está acessível
> pra Futures também — abre uma opção real (não implementada) de trocar a
> fonte do BACKTEST de Spot pra Futures. Não muda o scan ao vivo. Ver item
> 86 para o resultado completo e as ressalvas.

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

### Volume real conferido — Bloco 5, item residual (2026-08-12)

O critério de "só investir na reconstrução se `exit_ambiguous` mostrar
volume real" nunca tinha sido checado contra dado de verdade. Agreguei
`op.exit_ambiguous` de 17 relatórios de backtest reais já gerados nesta
sessão (configs/janelas/símbolos diferentes — itens 67, 68, 69, 71,
Bloco 4 Fase 1, o walk-forward do item 74 e o diagnóstico do item 75):
**19 de 2.417 operações, 0,79%**. Taxa por run varia de 0% a no máximo
~3,4% (Bloco 4 Fase 1, n pequeno) — nunca alta em nenhum run.

**Ressalva honesta**: os 2.417 não são uma amostra limpa e independente —
vários desses runs compartilham a mesma janela/carteira de 20 símbolos sob
configs de `pineConfig` diferentes (ex. os 3 runs `allowedside-ab-*` e
`indicator-attribution-20symbols-12m` provavelmente reusam candles
sobrepostos), então há dupla-contagem real de operações parecidas. Isso não
muda a leitura qualitativa: em nenhuma configuração testada até hoje a
ambiguidade passou de ~3-4%.

**Conclusão**: volume real é baixo, consistente e nunca alto — o critério
de gate para reconstrução via timeframe menor **não foi atingido**. Mantido
`exit_ambiguous` como campo observável sem reconstrução, sem reabrir a
questão até (se algum dia) o volume real ao vivo (não de backtest) mostrar
algo diferente.

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

### Destravado explicitamente pelo usuário (2026-08-10)

Depois do conselho do item 73 recomendar não abrir o Bloco 1 e apresentar
o Bloco 4 como alternativa de maior valor, expliquei ao usuário os 3 riscos
concretos desta seção (guard de corrupção virando o problema, ausência de
bucket de risco agregado, cascata 1D inexistente) e o escopo real (maior
que qualquer coisa testada até agora). **Usuário decidiu explicitamente
destravar e seguir com o Bloco 4**, ciente do risco de métricas
subestimarem risco agregado por ora. Isso satisfaz a condição que este item
e o item 56 (Ação 3) já exigiam ("não iniciar sem pedido explícito do
usuário"). Próximo passo: pesquisa de comunidade adicional (foco no bucket
de risco agregado, que é a lacuna central) + `sentinel-council-review`
dedicada ao desenho técnico (não mais "se fazer", já decidido — "como
fazer"), antes de qualquer código, conforme já determinado acima.

**Separado, não confundir**: o pedido imediato do usuário (rodar o
backtest de novo e olhar `smcDiagnostics`, item 35) é sobre a cascata
1h→5m **que já existe** — independente desta proposta de arquitetura nova.

### Pesquisa adicional (2026-08-10) — o padrão real resolve a lacuna de risco agregado

Buscando especificamente a lacuna central (bucket de risco agregado que
não existe hoje): a prática de pyramiding real não calcula um número de
risco agregado separado — ela **move o stop das pernas já abertas para
breakeven (ou melhor) quando uma nova perna abre**, mantendo o risco total
aberto aproximadamente CONSTANTE por construção, em vez de crescente. Isso
é potencialmente mais simples de implementar que inventar um subsistema de
risco agregado novo — o Sentinel já tem o precedente mecânico
(`advancePreTp1StopProtection`, item 53/54: mover stop pra breakeven
condicionado a um gatilho, nunca regredir, via `clampMonotonicStop`).

### Conselho técnico — "como fazer" (2026-08-10)

Com o "se fazer" já decidido pelo usuário, rodei `sentinel-council-review`
de novo (3 papéis independentes, subagentes locais) focado no desenho
técnico. **Refutação real entre papéis** (não convergência automática —
exatamente o que a skill pede):

- **Arquiteto**: propôs migrar `assetActiveOps/{assetId}.active_trade_op_id`
  (hoje 1 ID escalar, `src/api/entities.js:172-208`) para um MAPA
  `{cascade: opId}` no MESMO documento — preserva o padrão "1 leitura + 1
  escrita, mesma transação" do CAS atual. Arbitragem cross-cascade
  (`signalArbitration.js`) continuaria intocada para as 4 cascatas que já
  competem hoje pelo mesmo slot; as pernas novas de timeframe (Bloco 4)
  virariam chaves NOVAS e distintas no mapa, sem arbitrar entre si.
- **Especialista em concorrência REFUTOU o desenho do Arquiteto**: um doc-mapa
  único cria uma janela de corrupção pior que a de hoje durante deploy —
  uma aba do browser com bundle ANTIGO (schema escalar, Render Static Site
  sem invalidação de versão) continuaria escrevendo `active_trade_op_id`
  enquanto o código novo (cron, sempre fresco) já ignora esse campo e lê o
  mapa. Resultado: uma 2ª operação pode nascer sem ser detectada como
  duplicata — pior que a corrupção atual, que pelo menos é pega e suspende
  o ativo. **Recomendação vencedora**: doc SEPARADO por `(assetId,
  cascade)` (ex.: `assetActiveOps/{assetId}__{cascade}`), nunca reescrever
  o doc escalar existente — elimina a contenção/ambiguidade de schema por
  construção, ao custo de mais documentos no Firestore (irrelevante no
  plano Spark gratuito nesta escala).
- **Especialista em trading refutou o enquadramento como "pyramiding
  clássico"**: as 3 cascatas propostas (1h/4h/1D) têm sinal/indicador/
  entrada PRÓPRIOS — não são a mesma posição escalando, são 3 estratégias
  tecnicamente independentes que só coincidem no ativo. Aplicar regras de
  pyramiding "de livro" (perna maior primeiro) seria a categoria errada; o
  que importa é o risco correlacionado (item já coberto pela pesquisa
  acima), não a mecânica de escalonamento por si. Apontou um risco
  concreto adicional: usar o sinal do 1h como PRÉ-CONDIÇÃO pra abrir uma
  operação 4h inverteria a hierarquia de confiabilidade já medida —
  `rf1hCondEnabled` (exigir concordância do 4h com o 1h, mecanismo
  inverso mas correlato) já foi testado e **piorou** a expectância
  (STOP_HIT 76%→83,4%, TP2_HIT 16%→10,2%, ver seção RF 1h condicionado
  acima). Recomendação: o gatilho de promoção deve ser o 4h ter seu
  próprio sinal nativo válido de forma independente — "1h indo bem" no
  máximo aumenta confiança/tamanho de uma operação 4h que já abriria
  sozinha, nunca deveria ser o gatilho que a cria.
- **Convergência dos 3 papéis**: manter o mecanismo **desligado por
  padrão/backtest-only** até (a) pelo menos uma cascata isolada confirmar
  edge fora da amostra (nenhuma confirmou até hoje — item 71 encerrado sem
  confirmação, Bloco 0 ainda ambíguo) e (b) o padrão de
  stop-para-breakeven-ao-escalar estar implementado e testado — mesmo
  padrão de todo mecanismo experimental já construído neste projeto
  (nunca espelhar em `pineParser.js`/`adminPineConfig.js` até promoção
  explícita com A/B + holdout).

### Plano formal aprovado + Fase 1 infraestrutura implementada (2026-08-10)

Plano escrito e aprovado pelo usuário (modo plano) com o escopo reduzido já
recomendado pelo conselho técnico: só as 2 cascatas que já existem (`4h_15m`,
`1h_5m`) rodando como operações independentes no mesmo ativo — sem cascata
1D, sem gatilho de "continuidade" cross-timeframe (fora de escopo, ver
conselho técnico acima). Master flag `pineConfig.hierarchicalCascadesEnabled`
(backtest-only, `scripts/backtestPineConfig.js`, DEFAULT `false`).

**Camada de infraestrutura implementada e testada** (ainda **não** ligada em
lugar nenhum do `scanner.js` — zero mudança de comportamento com o flag
ausente, que é o estado de todo caller hoje):

- `buildActiveOpsAnchorId(assetId, cascade)` (`src/lib/opTransition.js`) —
  doc-âncora `assetActiveOps/{assetId}` sem mudança quando `cascade` é
  omitido (todo caller existente); `assetActiveOps/{assetId}__{cascade}`
  quando fornecido. Espelhado nos 3 backends
  (`src/api/entities.js`/`scripts/adminEntities.js`/
  `src/lib/__fixtures__/fakeBackend.js`) via um 4º parâmetro opcional
  `cascade` em `createTradeOpIfNoneActive`/`clearActiveOp` e uma chave
  `cascade` na options de `transitionTradeOp` — reusa as MESMAS 3 funções
  já testadas em vez de criar um caminho de mutação novo.
- `groupActiveOpsByAsset(ops)` — 2 passadas: agrupa por ativo (igual
  sempre); só quando TODOS os ops vivos daquele ativo carregam
  `op.hierarchical_cascade === true`, subdivide por `(ativo, cascade)`.
  **Redesenhado durante a própria implementação** (ver subseção "Wiring no
  `scanner.js`" abaixo): a 1ª versão usava um allowlist de nome de cascata
  (`coexistingCascades`) passado incondicionalmente pelos dois call sites —
  um teste pré-existente (`scannerStateMachine.test.js`, suíte "operações
  ativas duplicadas") pegou que isso relaxava a proteção também para 2 ops
  de cascatas `4h_15m`/`1h_5m` criadas fora do esquema novo (cenário de
  corrupção legada que o detector existe para pegar) — corrigido para um
  marcador por-OPERAÇÃO, gravado só no instante da criação quando
  `pineConfig.hierarchicalCascadesEnabled` estava genuinamente ligado,
  nunca inferido do nome da cascata.
- `advanceToBreakevenOnSiblingOpen({isBuy, currentStop, entry})`
  (`src/lib/opExitRules.js`) — mesma forma de `advancePreTp1StopProtection`
  (item 53/54), sem o gate de movimento de preço: avança o stop da perna JÁ
  ativa pra breakeven quando a cascata irmã abre a própria operação no
  mesmo ativo. `clampMonotonicStop` (já usado por `transitionTradeOp`)
  garante que nunca regride.
- Tripwire (`src/lib/hierarchicalCascadeTripwire.test.js`, mesmo padrão dos
  outros) + 904 testes passando (suíte inteira) + lint limpo + `npm run
  build` + os 3 alvos esbuild.
- **Achado incidental, não relacionado ao Bloco 4**: `npm run build:backtest`
  estava quebrado em `main` (export `notifyVerificationTask` ausente em
  `scripts/backtestTelegram.js`, deixado pela feature de VerificationTask/
  item 72) — confirmado via `git stash` que o bug já existia antes desta
  sessão. Corrigido (no-op, mesmo padrão dos outros exports do arquivo) pra
  poder verificar este trabalho.

### Wiring no `scanner.js` implementado e testado (2026-08-11)

Ligado o mecanismo nos dois pontos de criação de operação (`4h_15m` nativa e
`1h_5m` SMC), 1ª passada + os dois loops de retry, seguindo o desenho já
reconciliado pelo conselho:

- **Gate de entrada por cascata**: com o flag ligado, cada cascata checa sua
  própria flag derivada (`hasActiveOp4h15m`/`hasActiveOp1h5m`, filtradas de
  `activeOpsAtStart` por `.cascade`) em vez da `hasActiveOp` compartilhada —
  as duas passam a poder estar ativas simultaneamente no mesmo ativo. Com o
  flag desligado, `hasActiveOp`/`activeOp` (compartilhados) continuam
  intocados — zero mudança de comportamento, confirmado por teste.
- **Criação**: `opData.hierarchical_cascade = true` gravado só quando o
  flag está ligado; `cascade` passado como 4º argumento de
  `createTradeOpIfNoneActive` (destrava o doc-âncora `assetId__cascade`).
  Ao abrir com sucesso, se a cascata irmã já tinha operação ativa, chama
  `coupleSiblingRiskOnOpen` (nova função em `scanner.js`, ao lado de
  `recordRejection`) — uma 2ª chamada SEQUENCIAL a `transitionTradeOp`
  (reusa o CAS existente, não inventa um 3º caminho de mutação, per
  `.claude/rules/trading-engine.md`) que aplica
  `advanceToBreakevenOnSiblingOpen` ao `current_stop` da perna já ativa. Se
  essa 2ª transação falhar (CAS perdido para outro worker), loga via
  `SystemLog` e não bloqueia a 1ª operação — mesmo padrão observável de
  "transição descartada pelo CAS" já usado em outros pontos do motor.
- **Arbitragem**: com o flag ligado, `4h_15m` e `1h_5m` **nunca** arbitram
  uma contra a outra (`handleActiveOpArbitration` inteiro pulado para essas
  2 cascatas nesse modo) — cada uma só arbitra dentro de si mesma, se
  aplicável. As 4 cascatas que já disputam o slot único hoje
  (`4h_15m`/`1h_5m`/`rf1h_cond4h_15m`/`rf1h_uncond_15m`) continuam mutuamente
  exclusivas quando o flag está desligado, sem mudança.
- **Fora do escopo desta fase, deixado intocado de propósito**: os blocos
  `RF_1H_COND_CASCADE`/`RF_1H_UNCOND_CASCADE` (1ª passada e retry) continuam
  lendo `hasActiveOp`/`activeOp` compartilhados mesmo com o flag ligado —
  limitação aceita e documentada, não um bug, caso as duas famílias de
  mecanismo sejam combinadas no mesmo run futuramente.
- Os loops de cauda que já processam TODOS os ops ativos de um ativo
  (`persistScanResults`'s `allActiveOps`, `priceCheckActiveOpsInner`) **já
  suportavam N ops por ativo via `for` loop** — nenhuma mudança necessária
  ali, reduziu o escopo real do wiring.

**Testes novos** (`scannerStateMachine.test.js`, describe "Bloco 4 Fase 1"):
flag desligado → SMC não abre operação independente (slot compartilhado,
igual hoje); flag ligado → as 2 cascatas abrem operações independentes na
MESMA passada, ambas `hierarchical_cascade: true`; flag ligado → abrir a 2ª
perna avança o stop da perna JÁ ativa para breakeven (nunca além); flag
ligado → 2 ops da MESMA cascata (ambas marcadas) continuam sendo pegas como
duplicata real (proteção preservada).

**Verificação completa**: `npm test` (908/908) + `npm run lint` (limpo) +
`npm run build` + os 3 alvos esbuild (`build:scan`/`build:scan-shadow`/
`build:backtest`) + grep de isolamento (`hierarchicalCascadesEnabled`
ausente como entrada de objeto em `pineParser.js`/`adminPineConfig.js`,
presente só em `backtestPineConfig.js` — o identificador em si aparece nos
bundles ao vivo porque `scanner.js` é código compartilhado, mesmo padrão já
existente para `retestEnabled`/outros flags backtest-only; o que importa é
o valor nunca ser setado por padrão fora do backtest).

Fase 1 (escopo reduzido: só as 2 cascatas existentes, sem cascata 1D, sem
gatilho de continuidade cross-timeframe) está **completa e mergeável**. A/B
real (rodar com o flag ligado e medir) fica para depois do merge, mesmo
padrão de todo mecanismo experimental anterior — decisão do usuário sobre
quando rodar.

### Resultado do A/B real (2026-08-12)

Usuário rodou os 2 disparos recomendados (`backtest.yml`, mesma janela 12
meses, mesmos 7 símbolos, SMC 1h→5m ligado nos 2 — necessário para a cascata
`1h_5m` sequer existir no baseline) e colou os 2 relatórios completos.

**Combinado (`report.overall`, o número que decide)**: baseline
(`bloco4-fase1-baseline`, n=116) expectância líquida −0,016R, IC95
[−0,247; +0,215]; hierárquico (`bloco4-fase1-hierarquico`, n=118) −0,076R,
IC95 [−0,307; +0,154]. **Os dois individualmente INCONCLUSIVOS** (IC cruza
zero nos dois) — comparação de 2 pontos estimados, sem teste formal da
diferença entre os runs (mesma ressalva já registrada no item 68 para não
repetir o erro corrigido lá): não dá para afirmar que o flag piora nem que
melhora a expectância combinada com este dado.

**Por cascata**: `4h_15m` foi de +0,060R (n=104) para +0,027R (n=104,
mesmo n) — queda pequena, dentro do ruído desta amostra, possivelmente
(hipótese não verificada, não tracei operação a operação) efeito do
acoplamento de risco (`coupleSiblingRiskOnOpen`) puxando o stop de alguma
RF já favorável para breakeven quando a perna SMC irmã abriu — 2 vitórias
viraram derrota (50→48) com o mesmo total. `1h_5m` foi de −0,676R (n=12)
para −0,845R (n=14) — os dois `sample_too_small` (n<30), mas a direção
negativa é consistente com o achado já registrado no item 56 (−0,778R) de
que a cascata SMC 1h→5m tem expectância historicamente ruim, independente
deste mecanismo.

**Achado mais relevante — o funil de `1h_5m` prova que o slot nunca foi o
gargalo real desta cascata**: `active_op_exists` (rejeição por slot
ocupado pela RF nativa) caiu de **4.704 → 30** — confirma mecanicamente que
a coexistência de slots funciona exatamente como desenhado. Mas o volume
de operações cresceu pouco (12→14, apenas +2): quase todas as ~4.674
avaliações liberadas caíram no gargalo de verdade, `no_trigger`
(12.058→16.502, já dominante nos dois runs). Resolver a disputa de slot não
resolve o problema de volume da cascata SMC — o próprio gatilho 5m é o
limitante, não a arbitragem entre cascatas.

**Recomendação**: não ligar `hierarchicalCascadesEnabled` em produção com
este dado — zero evidência de ganho na expectância combinada. Se a cascata
SMC 1h→5m for revisitada no futuro, o alvo certo é o gatilho 5m
(`no_trigger`), não o mecanismo de slot que esta fase construiu.

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

### Desfecho real e diagnóstico — RETRATADO por erro de ano (2026-08-18)

O sinal de 05/08 (item acima) fechou no TradingView com **lucro em 15/08 às
13h** — usuário trouxe o desfecho 10 dias depois. Rodado um disparo pra
investigar: backtest só do FETUSDT, config padrão (sem nenhum flag, igual
ao que roda ao vivo).

**Erro real, pego por review externa (Codex, PR #211), confirmado**: o
disparo rodou a janela `2025-02-04→2025-08-20` — **ano errado**. O sinal
relatado é de 2026 (o item 67 original é datado 2026-08-07; "hoje" nesta
sessão é 2026-08-18). A operação "mais próxima" encontrada (BUY, candle de
sinal 07/08, fechada 14/08, `r=+1,17`) é do **FETUSDT em agosto de 2025**,
um ano inteiro antes do episódio real — não tem relação nenhuma com o
sinal investigado. **A conclusão "causa identificada: divergência
Spot×Futures" que estava aqui foi retirada — não tem base**: o diagnóstico
correto (rodar a mesma janela sobre 2026) ainda não foi feito.

Erro meu (Claude), não do usuário — as instruções de disparo que dei
pediam `2025-02-04`/`2025-08-20` sem checar contra a data corrente da
sessão. **Item 67 permanece EM ABERTO** quanto à causa do episódio de
05/08/2026 — nenhuma hipótese (confirmação de 15m, divergência
Spot×Futures, outra) está confirmada ou descartada por este disparo.
Próximo passo: re-rodar `fetusdt-live-signal-diagnostic-0805` com janela
em 2026 (ex.: `2026-02-04→2026-08-18`) antes de tirar qualquer conclusão
nova.

### Resolvido — o sinal de 05/08 EXISTIA e passava nos gates do Sentinel; causa provável é operacional (2026-08-19)

Usuário exportou 3 CSVs de candle 4h reais do FETUSDT (mai-jul/2026, via
TradingView/Binance) e um print da lista de negociações real do TradingView
("NE RF v13.2", 31/dez/2021-18/ago/2026) mostrando 4 execuções reais que
nunca apareceram no Sentinel: long 21/07→23/07 (-5,03%), short 27/07→28/07
e 27/07→30/07 (TP1+runner, +8,20%/+6,27%), e short **05/08→15/08**
(+9,56%) — o episódio original deste item, agora confirmado como **SELL**,
não BUY como a investigação original vinha assumindo.

**Achado 1 — TradingView mostra horário de Brasília (UTC-3), não UTC.**
Confirmado batendo os preços de entrada reais contra os candles Spot reais
(`open`/`close` exatos): "21 jul 01:00" = candle 4h que abre 04:00 UTC
(close 0,1599 ≈ entrada real 0,1600); "27 jul 09:00" = candle que abre
12:00 UTC (close 0,1507 ≈ entrada real 0,1506). Confirma o que a análise
anterior já tinha estabelecido para 27/07 ("12:00 UTC = 09:00 Brasília"),
agora generalizado e verificado por preço, não só por hora.

**Achado 2 — a comparação anterior (28/07 21h vs. 30/07 20:00 UTC, "~2
dias de diferença") comparava a referência ERRADA.** A operação real de
27/07 tinha DOIS fechamentos reais (TP1 parcial em 28/07 12:00 UTC +8,20%,
runner final em 30/07 12:00 UTC +6,27%) — um padrão TP1+runner idêntico ao
que o próprio Sentinel implementa (item 46). O backtest fecha essa mesma
operação em **30/07 20:00 UTC** via `STOP_HIT` do runner (+1,247R). Contra
a referência CERTA (o fechamento final real, 30/07 12:00 UTC, não o TP1
parcial), a diferença é de **8 horas no mesmo dia**, não ~2 dias — muito
mais consistente com a aproximação candle-a-candle do motor de backtest
(já documentada acima) do que com qualquer divergência grave de dado.

**Achado 3 — o sinal de 05/08 EXISTE no backtest, no candle exato, no
preço exato, e passou no gate de confluência.** Lido diretamente de
`indicatorAttribution.records` do relatório corrigido
(`fetusdt-live-signal-diagnostic-0805-2026`, janela 2026-02-04→2026-08-18):
registro com `direction: "SELL"`, `candle_time:
"2026-08-05T23:59:59.999Z"` (candle que abre 20:00 UTC = 17:00 Brasília,
bate exatamente com o horário real), `entry_price_ref: 0.1419` (real:
0,1418), `score_real: 80`, **`passed_real: true`** — ou seja, pela própria
lógica do Sentinel (mesmo código do scan real, rodado no backtest sem
modificação), esse sinal deveria ter virado uma `TradeOperation`. O
outcome registrado é `STILL_OPEN_AT_CUTOFF` (não fechou dentro da janela
do backtest, apesar de `mfeR: 2.48` — ficou favorável e nunca foi
contabilizado como fechado até o corte de 18/08), consistente com a
aproximação por candle do motor de backtest, não com o sinal em si.

**Leitura (fato × hipótese)**: **Fato** — o sinal SELL de 05/08 é real,
válido, e passaria pelos gates de confluência/regime do Sentinel; a
lógica/paridade do indicador NÃO é a causa da ausência no painel ao vivo.
**Hipótese, mais provável com o dado disponível**: a causa é operacional
— o mesmo tipo de falha que o item 106 encontrou (estouro de cota do
Firestore bloqueando a escrita da `TradeOperation`) é a explicação mais
direta para "o sinal existe mas nunca vira operação no painel", muito mais
que qualquer hipótese de paridade/indicador já descartada nas rodadas
anteriores deste item. **Não confirmado**: não temos log do Sistema de
05/08 especificamente (a evidência do item 106 é de ~18-19/08) — a chance
de o estouro já estar ocorrendo em 05/08 não foi verificada.

**Recomendação**: se o usuário puder checar a tela Logs do Sistema
filtrando por volta de 05/08 20:00 UTC (17:00 Brasília) por FETUSDT, e
achar o mesmo padrão `RESOURCE_EXHAUSTED`/falha de lock do item 106, isso
fecha o item 67 definitivamente como causado pela mesma falha operacional
— sem precisar de mais nenhum backtest. Item 67 muda de "EM ABERTO, causa
desconhecida" para "quase certamente operacional (item 106), pendente
apenas de confirmação direta nos logs daquele dia".

Verificação: leitura direta e cruzamento programático (Python/pandas ad
hoc) dos 3 CSVs de candle reais contra os horários/preços do print do
TradingView, e leitura de `indicatorAttribution.records`/`overall.curve`/
`stillOpenAtCutoff` do `backtest-report.json` já anexado
(`fetusdt-live-signal-diagnostic-0805-2026`). Nenhuma mudança de código
nesta análise.

### CAUSA REAL CONFIRMADA — não é o item 106, é o gate `smc_confirm_4h15m` rejeitando o sinal (2026-08-19)

**A hipótese "provavelmente operacional (item 106)" da seção acima estava
ERRADA e é retratada aqui** — não por raciocínio, por prova direta. Usuário
perguntou se o disparo real (`scan.yml`, GitHub Actions) tinha rodado nesse
horário. Em vez de continuar hipotetizando, chequei os dois lugares que dão
resposta definitiva: os logs do próprio Actions e o Firestore de produção
(leitura anônima, mesmo padrão já usado pela Routine "Vigia de mercado" —
a rede desta sessão alcança `firestore.googleapis.com`, só não alcança a
Binance).

**Fato 1 — o scan real rodou limpo, sem nenhum erro de cota, no horário
exato.** A vela SELL do FETUSDT abre 20:00 UTC e fecha 23:59:59.999 UTC em
05/08 (17:00–21:00 Brasília) — a passada do `scan.yml` que processa esse
fechamento é a run `31058245519`, iniciada 2026-08-06T00:00:11Z. Log
completo: `[scan] scanAllAssets: 9 ativo(s), 0 falha(s)`. Zero
`RESOURCE_EXHAUSTED`, zero falha de lock. A run anterior (20:00 UTC,
05/08) também limpa. **O item 106 é real (confirmado por log noutro dia),
mas não é a causa deste episódio — descartado por evidência direta, não
por suposição.**

**Fato 2 — o `SignalEvent` foi criado, o sinal FOI confirmado, e o motivo
da rejeição está gravado no próprio documento.** Lido direto do Firestore
(`signalEvents/FETUSDT_4h_SELL_range_filter_2026-08-05T23:59:59.999Z`):
score 80, `alignment: "aligned"`, `context.rf_direction: -1`, sinal SELL
4h totalmente válido e confirmado — mas com
**`"last_rejection_reason": "smc_confirm_zone_rejected"`**. O sinal
existiu, foi pontuado, foi persistido — e foi barrado por um gate
ADICIONAL antes de virar `TradeOperation`.

**O gate**: `asset.smc_confirm_4h15m` (`scanner.js:2889-2893`, espelhado
na 1ª passada em `scanner.js:2330-2334`) — quando `true` no
`MonitoredAsset`, exige que a estrutura SMC do 1h concorde em DUAS coisas
antes de aceitar um sinal RF 4h: `trend` (tendência SMC alinhada com o
sinal) E `pdZone` (preço não pode estar na zona premium/discount errada
para o lado). Isso é **inteiramente original do Sentinel** — o Pine real
do usuário ("NEW ERA - Range Filter Strategy v13.2") não tem esse
conceito, confirmado na investigação original deste item ("não existe
timeframe de confirmação separado em lugar nenhum do Pine real").

**Achado 2, mais grave — não é só o FETUSDT.** Query em `monitoredAssets`
confirma: **os 10 ativos monitorados têm `smc_confirm_4h15m: true`**, sem
exceção. `src/components/assets/AddAssetForm.jsx:58` grava esse campo como
`true` por padrão ao cadastrar um ativo novo — é opt-OUT, não opt-in, e o
usuário nunca precisou "mexer em configuração" pra esse gate estar ligado
em tudo, exatamente como ele relatou ("nunca mexi em configuração do
sentinel nem do pine" — verdade, o padrão já vinha ligado). Esse gate
pode estar rejeitando sinais RF válidos em TODOS os ativos monitorados há
quem sabe quanto tempo — candidato muito mais direto para "por que não
sai operação" do que qualquer hipótese estatística dos itens 100-105 OU o
item 106.

**27/07 (a outra operação real perdida)**: o `SignalEvent`
correspondente (`FETUSDT_4h_SELL_range_filter_2026-07-27T15:59:59.999Z`)
NÃO tem `last_rejection_reason` gravado — mas isso é esperado mesmo se o
MESMO gate a rejeitou: o campo só é escrito pelos loops de RETRY
(`persistScanResults`), a 1ª passada só loga no `SystemLog` (não
recuperável nesta sessão, log expira). A BUY anterior do FETUSDT
(`STOP_HIT`, fechada `2026-07-24T16:23:19.913Z`, bem antes de 27/07) não
estava mais ativa — descarta `active_op_exists` como causa alternativa
pro 27/07, deixando `smc_confirm_zone_rejected` como hipótese líder
também aqui, coerente com o mesmo mecanismo do 05/08.

**Recomendação — decisão do usuário, não decidida aqui**: desligar
`smc_confirm_4h15m` (toggle "SMC confirm 4h→15m" na tela de configuração
do ativo, `AssetConfigPanel.jsx`) aproximaria o Sentinel do comportamento
real do Pine do usuário — mas é uma mudança de comportamento em produção,
afeta os 10 ativos, e o padrão do projeto (mesma régua aplicada a TODO
gate opcional deste arquivo) é comparar backtest com/sem antes de mudar
qualquer flag ativa. Próximo passo natural: rodar o A/B
(`smc_confirm_4h15m: true` vs `false`) via `backtest.yml` antes de decidir
desligar em produção — ainda não feito.

Verificação: leitura direta do Firestore de produção (script Node
temporário, leitura anônima, apagado após uso — nunca escreveu nada) e do
log completo (`get_job_logs`) das 2 runs de `scan.yml` mais próximas do
fechamento da vela (2026-08-05T20:00:11Z e 2026-08-06T00:00:11Z, ambas
`0 falha(s)`). Nenhuma mudança de código nesta rodada — só diagnóstico e
correção de uma hipótese anterior que a prova direta invalidou.

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

**Correções do Codex review (PR #156, todas aplicadas)**:
1. **P1 — valor inválido de `allowedSide` bloqueava os DOIS lados em
   silêncio.** `setPineConfigOverrides` só espalhava `next` sem validar —
   um typo, caixa errada (`'sell'`) ou valor não-string truthy (`true`)
   chegava incólume até `scanner.js`, onde `signal_type !== allowedSide`
   rejeitaria BUY e SELL igualmente sem erro nenhum. Um backtest caro
   (12 meses/20 símbolos) terminaria com zero operações da cascata nativa,
   parecendo um resultado real ("SELL-only não gera nada") em vez de
   config quebrada. Corrigido: `setPineConfigOverrides` agora lança
   `Error` se `allowedSide` não for exatamente `'BUY'`, `'SELL'` ou
   ausente/`null` — falha cedo e alto, antes do replay começar. Novo
   `scripts/backtestPineConfig.test.js` cobre os 3 casos (ausente/null
   aceito, `'BUY'`/`'SELL'` aceitos, typo/caixa errada/não-string
   rejeitados).
2. **P2 — loop de retry recontava `side_filter_blocked` a cada passada.**
   Diferente de `trend_reversed`/`regime_rejected` (que podem genuinely
   mudar de passada pra passada), o LADO de um sinal é decidido no
   nascimento e nunca muda dentro do run. A 1ª versão usava
   `recordRejection` (o mesmo helper dos outros gates do retry) — que
   empurra pra `entryFunnelOutcomes` em TODA avaliação, mudando o motivo
   ou não. Isso inflava `report.entryFunnel['4h_15m'].byReason.
   side_filter_blocked` em até ~48× por sinal bloqueado (retry a cada
   ~5min numa janela de expiração de 4h), tornando essa contagem
   incomparável com as dos outros motivos do funil. Corrigido: lógica
   manual write-on-change no retry (grava/conta só quando
   `sig.last_rejection_reason` ainda não é `'side_filter_blocked'`),
   igual ao padrão já usado por `expired_logged`/`rf_reverse_bars_count`.
3. **P2 — exemplo de CLI em `docs/claude/backtest-usage.md` usava JSON
   inline inválido** onde o parser só aceita caminho de arquivo
   (`--pine-config`). Corrigido para `echo '{"allowedSide":"SELL"}' >
   /tmp/sell-only.json` seguido de `--pine-config /tmp/sell-only.json`,
   com nota de que o campo da UI do GitHub Actions aceita JSON inline
   diretamente (só a flag de linha de comando exige arquivo).

Verificação desta rodada de correções: `npm test` 877 passando (+3 do
`backtestPineConfig.test.js` novo), `npm run lint` limpo, `npm run build`
+ os 3 alvos esbuild sem erro, grep de isolamento confirmado de novo
(`allowedSide` ausente em `pineParser.js`/`adminPineConfig.js`; presente
nos bundles `run-scan.mjs`/`run-scan-shadow.mjs` só como o texto da
CONDIÇÃO `pineConfig.allowedSide` dentro do `scanner.js` compartilhado —
mesmo padrão inofensivo de `rf1hCondEnabled`/`rf1hUncondEnabled`, sempre
`undefined`/falsy em produção porque os configs admin nunca setam a
chave).

**Tentativas de A/B falharam por JSON inválido no campo do GitHub Actions
(2026-08-10), corrigido.** As 4 primeiras tentativas de disparo (runs
31360283059, 31360450236, 31363651347, 31363820483) falharam com
`SyntaxError: Expected property name or '}' in JSON at position 1` — não é
bug no motor: o campo "Overrides do pineConfig em JSON" foi digitado (não
colado) com aspas tipográficas/curvas (`" "`) em vez de retas (`"`), ex.
`{"allowedSide "​:"BUY"}` em vez de `{"allowedSide":"BUY"}` (confirmado lendo
o log real do job, variável `PINE_CONFIG`). `JSON.parse` rejeita aspas
curvas. Duas correções aplicadas:
1. **Falha cedo.** A etapa "Escrever overrides do pineConfig" rodava
   DEPOIS do download de candles da Binance (~20min pra 20 símbolos) — um
   JSON quebrado só era detectado depois de gastar esse tempo à toa (foi o
   que aconteceu nas 4 tentativas). Movida para ANTES do download, com
   validação (`JSON.parse` explícito) que falha em segundos.
2. **Mensagem acionável.** Tanto o workflow (`.github/workflows/
   backtest.yml`) quanto o CLI local (`scripts/run-backtest.mjs`) agora
   capturam o erro de parse e apontam a causa mais provável (aspas
   curvas/espaço sobrando no nome do campo) em vez de só repassar o
   `SyntaxError` cru do V8. Reproduzido localmente com o mesmo JSON quebrado
   do log real — mensagem nova confirmada. `npm test` (877 passando, sem
   regressão), `npm run lint`, `npm run build` + `build:backtest` limpos.

### A/B real — resultado (2026-08-10, 20 símbolos/12 meses, mesma janela dos 3 runs)

3 disparos concluídos (`trial_label`: `allowedside-ab-baseline`,
`allowedside-ab-sell-only`, `allowedside-ab-buy-only`), mesmos 20 símbolos e
janela `2025-08-10T00:00:00Z → 2026-08-10T00:00:00Z` do run de referência
(item 69). `report.costs`/`report.byCascade['4h_15m']` de cada run (idênticos
entre si aqui — só a cascata nativa estava ativa):

| Run | n (fechadas) | Expectância líquida | IC95 (z=1,96) | `conclusive` | Win rate | Profit factor |
|---|---|---|---|---|---|---|
| Baseline | 322 | −0,030R | [-0,161; 0,101] | **não** (cruza zero) | 41,6% | 0,85 |
| SELL-only | 175 | **+0,202R** | [0,023; 0,381] | **sim** | 52,6% | 1,37 |
| BUY-only | 181 | **−0,344R** | [-0,501; -0,188] | **sim** | 28,7% | 0,44 |

Lido cru (z=1,96 padrão), SELL-only bateria o critério "conclusivo e
positivo" descrito acima — mas 2 problemas mais sérios que esse critério
sozinho precisam ser corrigidos antes de aceitar isso como confirmação.
Ambos apontados pelo Codex review (PR #158) e verificados aqui contra os
dados reais — os dois são procedentes.

**Problema mais grave: esta NÃO é uma confirmação fora da amostra — é
quase a mesma janela que gerou a hipótese.** A hipótese BUY-negativo/
SELL-positivo nasceu (achado acima nesta mesma seção) separando por lado os
resultados do run de referência do item 69 — mesmos 20 símbolos, janela
`2025-08-09T00:00:00Z → 2026-08-09T00:00:00Z`. Os 3 disparos deste A/B usam
`2025-08-10T00:00:00Z → 2026-08-10T00:00:00Z` — deslocada só 1 dia, ~99,7%
de sobreposição com a janela que originou o achado. Chamar isso de "critério
pré-registrado" e "1ª vantagem real comprovada" superestima a evidência: é
essencialmente a mesma massa de dados que gerou o padrão sendo usada de
novo para "confirmá-lo" — o oposto do desenho que o item 48 deste projeto já
usou corretamente (janela de ALTA **inédita**, nunca vista antes, pra testar
se o motor tem vantagem real ou só segue o regime). SELL-only aqui é, na
melhor leitura, uma re-medição em amostra correlacionada — não confirmação
independente.

**Correção de Bonferroni (aplicada por cima do problema acima, não no lugar
dele).** Mesmo ignorando a circularidade de amostra, este run testa 2
afirmações direcionais da MESMA pergunta (SELL-only positivo, BUY-only
negativo) — mesma situação que os itens 56/68 já definiram como exigindo
correção pra m=2 comparações (z=2,24 em vez de 1,96, `docs/known-risks.md`
linhas ~4917-4923/6541-6542). Este projeto já tem, inclusive, um precedente
específico de achado SELL positivo que **não sobreviveu** a essa mesma
correção (item 45.9/48, "+0,199R não sobrevive Bonferroni"). Recalculando
com z=2,24:

- **SELL-only**: IC95-Bonferroni ≈ **[-0,003; 0,407] — cruza zero.** Não
  sobrevive à correção, mesmo padrão do precedente acima.
- **BUY-only**: IC95-Bonferroni ≈ [-0,523; -0,165] — **continua sem cruzar
  zero.** Esse lado sobrevive à correção com folga.

**Leitura honesta, com os dois problemas descontados**: a evidência contra
BUY é a única parte sólida — conclusiva mesmo com Bonferroni, reforçada por
win rate 28,7%/PF 0,44 (pior que o baseline em toda métrica) — mas ainda
assim medida na MESMA janela da descoberta, então também carece de
confirmação fora da amostra antes de virar decisão de produto. A "evidência"
a favor de SELL isoladamente não é evidência real ainda: nem sobrevive à
correção de múltiplas comparações, nem é medição independente da hipótese
que a gerou. **Não é seguro afirmar "SELL não é pior que o mercado"** a
partir de um IC que cruza zero — isso testaria só se a expectância de SELL
difere de zero, não se SELL é não-inferior ao baseline (exigiria margem de
não-inferioridade e um teste de contraste SELL-vs-baseline definidos à
parte, que este run não fez).

**Achado mecânico secundário (contagem, não IC — não precisa de correção
estatística)**: `side_filter_blocked` ficou em 561 (SELL-only) e 569
(BUY-only) — próximos entre si, como esperado (mesmo universo de sinais,
split BUY/SELL parecido nos dois runs; também confirma que o fix write-once
do PR #156 está funcionando, sem inflar por retry). `active_op_exists` caiu
de 1.457 (baseline) para 879 (SELL-only) e 808 (BUY-only) — mas isso sozinho
não isola o mecanismo de liberação de slot, já que rodar só um lado
naturalmente reduz o número de candidatos disputando pela metade. Mais
sugestivo: a SOMA de operações fechadas dos dois runs isolados (175+181=356)
supera o total do baseline (322) — 34 operações a mais no total quando os
lados não competem pelo mesmo slot do ativo, consistente com (mas não prova
formal de) o mecanismo de arbitragem cross-side descrito acima.

### Confirmação fora da amostra (holdout) — resultado (2026-08-10): hipótese NÃO se sustenta

Disparo pré-especificado (`trial_label: allowedside-holdout-sell-only`),
`{"allowedSide":"SELL"}`, mesmos 20 símbolos, janela
`2024-08-10T00:00:00Z → 2025-08-10T00:00:00Z` — os 12 meses IMEDIATAMENTE
ANTERIORES ao já usado, sem nenhuma sobreposição com a janela que originou a
hipótese (item 69) nem com o A/B anterior (acima). O critério já estava
definido antes de rodar: conclusivo e positivo = confirma; inconclusivo ou
negativo = encerra a linha.

`report.costs`: n=150 fechadas, expectância líquida **+0,078R**, IC95
**[-0,115; 0,270] — cruza zero. INCONCLUSIVO** (`ci_straddles_zero`), mesmo
com z=1,96 padrão, sem precisar nem chegar a aplicar Bonferroni — já não
sobrevive ao teste mais fraco possível. Win rate 46,7%/PF 1,27 (positivo em
direção, igual às vezes anteriores) mas a amostra dessa janela específica
(150 operações, menos que as 175 do run anterior) não separa o sinal do
ruído. `side_filter_blocked` = 555 (mesma ordem de grandeza dos runs
anteriores — funil se comportando como esperado).

**Conclusão, pelo próprio critério pré-registrado**: a hipótese SELL-only
**não se sustenta** em dado que ela nunca influenciou. A direção continua
sempre positiva nas 3 medições de SELL isolado já feitas (item 69 shadow,
A/B mesma janela, holdout) — nunca inverteu de sinal — mas nenhuma delas
prova o efeito com rigor (a primeira é sinal-fantasma sem gates reais, a
segunda é a mesma amostra da descoberta, a terceira é a confirmação de
verdade e saiu inconclusiva). Consistente com um padrão mais fraco:
"mercado historicamente mais favorável a SELL nesse conjunto de ativos", não
necessariamente uma vantagem do MOTOR sobre esse viés. **Não ligar
`allowedSide` em produção.** Esta linha de investigação (item 71) está
encerrada — reabrir exigiria evidência nova (ex. mais anos de holdout,
símbolos adicionais), não mais reanálise dos mesmos dados.

## 72. Tarefas de verificação automáticas + Análise Preditiva no Dashboard — feature nova, dois PRs de achado externo corrigidos (2026-08-10)

### Contexto

Pedido do usuário: nunca perder a revisão de um sinal de alta prioridade
(registro que sobrevive a fechar o navegador, sincronizado em três
lugares — widget, página dedicada, Telegram) e, ao lado disso, uma aba de
análise preditiva que compara o sinal atual com padrões históricos
similares. Entidade nova `VerificationTask` (`docs/schema-reference/
VerificationTask.jsonc`), criada em `persistScanResults` (`scanner.js`)
para todo sinal `priority === 'high'` — mesmo loop que já roda idêntico
no browser e no cron, sem hook client-side (que só funcionaria com o
navegador aberto). PR #159.

### Achados da revisão externa (Codex) + investigação própria — PR #160

O Codex revisou o merge commit do #159 e encontrou 5 problemas reais,
todos corrigidos no #160:

1. **Build do modo sombra quebrado (confirmado reproduzindo antes de
   corrigir).** `scripts/adminTelegramShadow.js`/`adminEntitiesShadow.js`
   não tinham `notifyVerificationTask`/`VerificationTask` espelhados —
   `npm run build:scan-shadow` falhava (`No matching export`) e o scan
   sombra crasharia em runtime no primeiro sinal de alta prioridade.
2. **Falha na 2ª escrita podia abortar o ativo inteiro na passada** — achado
   por investigação própria, não estava no relatório do Codex: confirmado
   em `scanAllAssetsInner` que o `try/catch` que envolve `persistScanResults`
   é POR-ATIVO, não por-sinal — uma exceção não capturada no bloco da
   `VerificationTask` abortaria também o motor de entrada de outros sinais
   do mesmo ativo na mesma passada. Corrigido com `try/catch` dedicado
   (`logWarn`, nunca propaga).
3. **`telegram_notified` gravado antes do envio real acontecer** —
   `send()` (`src/lib/telegram.js`) não retornava nada; passou a retornar
   boolean de entrega real (2xx), mesmo contrato que `scripts/
   adminTelegram.js` já tinha. Mantido fire-and-forget (não bloqueia os
   gates de confirmação de entrada que rodam logo depois no mesmo loop) —
   o `.then()` grava `telegram_notified` só quando a entrega é confirmada.
4. **Página `/verification` podia esconder pendências antigas** acima de
   200 documentos — filtro de status/prioridade passou a rodar no
   servidor.
5. **Análise Preditiva enviesada** pelo `tradeOps` do Dashboard (capado em
   100, misturando ativas+fechadas) — passou a buscar seu próprio
   histórico de operações fechadas (até 500).

Uma 2ª rodada do Codex sobre o próprio #160 encontrou mais 2 achados reais
— faltavam os índices compostos Firestore para as duas novas formas de
query dos itens 4 e 5 (`tradeOperations` `status+created_date`;
`verificationTasks` `priority+created_date` sozinho, sem `status`). Sem
eles a query é rejeitada pelo Firestore e o erro fica engolido pelo
default de array vazio do `useQuery` — a lista simplesmente aparece vazia
em vez de mostrar o erro real. Corrigido no mesmo PR; deploy manual
(`firebase deploy --only firestore:rules,firestore:indexes`, workflow
`deploy-firestore.yml`) confirmado com sucesso (run 31406451055).

### Estado atual — o que ficou pendente, de propósito

Escopo combinado explicitamente com o usuário antes de implementar
(ver PR #159): botão "Executar Trade" (em qualquer versão) e feedback
automático de outcome (win/loss) na própria tarefa ficaram de fora —
hoje nenhuma tela cria `TradeOperation` manualmente, só o scanner após os
gates de confirmação; um botão manual precisaria fabricar esses campos
sem os gates, escopo maior e mais arriscado do que o pedido original.
Também adiados: ações em lote, auto-expiração de tarefas antigas, filtro
de símbolo por lista (em vez de texto livre), estatísticas de conversão
sinal→trade. Nenhum desses campos/fluxos foi construído especulativamente.

Teste manual no navegador (forçar um sinal de alta prioridade e conferir
widget/página/Telegram/aba preditiva com dado real) não foi feito nesta
sessão — fora do alcance de um ambiente sem acesso à Binance/Firestore de
produção.

## 73. Conselho de revisão — o que fazer depois do item 71 não confirmar (2026-08-10)

### Contexto

Usuário perguntou diretamente, depois de muitas rodadas de teste sem
resultado satisfatório: "o que será que precisamos fazer?", sugerindo
pesquisa de comunidade (Reddit/X). Rodei `sentinel-council-review` (3 papéis
independentes — Arquiteto, Especialista em trading, Especialista em
testes/estatística — via subagentes locais, nada enviado a provedor
externo) com a pergunta: dado o histórico completo (Bloco 0 ambíguo, item 71
encerrado sem confirmação, Bloco 1 com 4 flags nunca medidos), qual o
caminho recomendado agora?

Antes de rodar o conselho, fiz uma pesquisa rápida de comunidade (WebSearch)
sobre por que estratégias técnicas de indicador único costumam falhar em
produzir edge real e o que a literatura de algotrading recomenda. Achado:
overfitting via múltiplos testes ablation-by-ablation é a armadilha mais
citada, e o antídoto padrão (holdout/walk-forward) é exatamente o que este
projeto já pratica (Bloco 0 alta/baixa, item 71 holdout) — não havia uma
"receita" óbvia sendo ignorada. A lista de "o que funciona" (filtro de
regime via ADX, stop por ATR, confluência multi-indicador) já é a
arquitetura do Sentinel.

### Achados do conselho (3 papéis convergiram, com 1 refutação real)

- **Arquiteto**: continuar o Bloco 1 sem fechar o Bloco 0 é dívida se
  acumulando, não coerência arquitetural (`roadmap.md:58,223` já reconhece
  isso ao recusar desbloquear). O Bloco 4 (cascata hierárquica por
  timeframe, nunca implementada) é a mudança estrutural real ainda não
  tentada. Como painel sem execução real, a urgência é operacional, não de
  segurança financeira — a decisão pode ser deliberada, não forçada.
- **Especialista em trading** (refutou a leitura inicial mais branda):
  "**Não testar os 4 flags do Bloco 1 agora**" — a base (cascata RF nativa)
  não tem edge demonstrado, e testar filtros em cima de ruído é exatamente
  o padrão que o item 71 acabou de reproduzir e refutar (achado forte
  in-sample → não sobrevive holdout). "SELL positivo" (item 48/71) é
  evidência de **regime** (mercado do período testado), não de vantagem do
  motor — o próprio holdout do item 71 já chegou a essa conclusão.
  Recomenda realocar esforço para o Bloco 2 (geometria de saída, já com
  achados negativos mensuráveis, ex. runner do TP1) ou o Bloco 4, não mais
  ablação de entrada.
- **Especialista em testes/estatística** (achado novo, não previsto):
  o projeto aplica Bonferroni corretamente **dentro** de cada rodada, mas
  nunca contabilizou um orçamento-alfa **acumulado** ao longo dos ~10-15
  testes de hipótese já feitos desde o item 44 — risco de mascarar tanto
  falsos positivos quanto um efeito real pequeno mas consistente. Propõe,
  em vez de 4 ablações fragmentadas de baixo poder, **um teste pooled
  único**: walk-forward com múltiplas janelas não sobrepostas e
  estimativa de efeito combinada (meta-análise ponderada por erro-padrão)
  contra a pergunta única "o motor tem vantagem independente de regime?" —
  mais poder estatístico que N testes fragmentados, sem inflar o número de
  comparações.

**Correção (Codex review, PR #163)**: a proposta acima, como escrita
originalmente, sugeria "2-3 anos" sem exigir que fossem períodos **nunca
vistos** — procedente. Os ~3 anos de histórico disponíveis (2023-2026) já
foram lidos **5-6 vezes** nas janelas do Bloco 0 (`known-risks.md`
linhas ~3682-3687, "ressalva de honestidade estatística" já registrada
naquele momento) e mais 2 vezes no item 71 (A/B + holdout). Um "pooled"
que combine esses mesmos anos não restaura validade fora da amostra — é
mais uma (7ª/8ª) releitura do mesmo dado, só com aparência mais decisiva
por juntar tudo num IC só. Pra esse teste valer como confirmação de
verdade, precisa de dado **genuinamente não examinado**: símbolos
adicionais nunca usados em nenhum backtest deste projeto, e/ou esperar
acumular janela nova prospectivamente (dado que ainda não existe). Sem
isso, um "pooled" com o dado já disponível deve ser rotulado
**exploratório**, nunca usado para decidir se o motor tem vantagem.

### Recomendação final (avaliador)

**Não abrir o Bloco 1 agora.** As duas opções de maior valor, na ordem que
o usuário priorizar: (a) desenho estrutural diferente (Bloco 4 — cascata
hierárquica por timeframe, exige `sentinel-council-review` própria antes de
código, conforme o roadmap já determina) ou (b) um teste estatístico único
e bem desenhado, mas só se usar dado genuinamente não examinado (símbolos
novos e/ou janela prospectiva futura — não os mesmos ~3 anos já lidos
5-8 vezes) — em vez de mais ablação 1-a-1. Decisão de qual seguir — ou de
pausar otimização de estratégia e aceitar o painel como ferramenta de
sinalização, seu propósito declarado
desde sempre (`CLAUDE.md`) — fica com o usuário, não decidida
unilateralmente aqui (mesmo padrão do Bloco 0 desde 2026-08-04).

## 74. Walk-forward com dado genuinamente novo (LTCUSDT/DOGEUSDT) — teste pooled do Bloco 0, ainda inconclusivo (2026-08-12)

### Contexto

Seguindo a recomendação do item 73 (opção b — "um teste estatístico único
e bem desenhado, mas só se usar dado genuinamente não examinado"), rodei 3
disparos de `backtest.yml` com **LTCUSDT/DOGEUSDT** — os únicos 2 símbolos
confirmados fora da carteira de 20 já lida 5-8 vezes (lista completa
recuperada e registrada em `docs/roadmap.md`, Bloco 0) — nas mesmas 3
janelas não sobrepostas já caracterizadas no Bloco 0 (2023-07→2024-07,
alta 2024-07→2025-07, baixa 2025-07→2026-07), sem SMC (cascata `1h_5m`
desligada, mesma metodologia dos runs originais de 20 símbolos —
confirmado via `byCascade` só ter `4h_15m`), sem overrides de pineConfig.

### Resultado — 3 janelas individuais

| Janela | n (ops) | Expectância líquida | IC95 | Conclusiva? |
|---|---|---|---|---|
| 2023-07→2024-07 | 29 | +0,129R | [-0,272; +0,530] | NÃO (amostra pequena) |
| Alta 2024-07→2025-07 | 26 | +0,317R | [-0,216; +0,850] | NÃO (amostra pequena) |
| Baixa 2025-07→2026-07 | 38 | −0,196R | [-0,559; +0,166] | NÃO (IC cruza zero) |

Amostra pequena em todas — 2 símbolos rendem ~26-38 operações por janela de
12 meses, bem abaixo das 288-344 dos runs de 20 símbolos.

### Meta-análise combinada (o teste pooled que o item 73 pediu)

Estimativa ponderada pelo inverso da variância (peso = 1/erro-padrão²) das
3 janelas: **expectância combinada +0,024R, IC95 [-0,216; +0,265]** (erro-padrão
combinado 0,123, n total = 93). **Ainda cruza zero — INCONCLUSIVO**, mesmo
depois de agrupar as 3 janelas num único teste (que é justamente o que
deveria dar mais poder estatístico que 3 testes fragmentados). Sem
correção de Bonferroni adicional aqui: é 1 teste pooled pré-desenhado, não
N comparações.

### BUY vs. SELL por janela — nenhuma confirmação nova, sem evidência de que o padrão anterior "quebrou"

Computado direto de `overall.curve` (por operação, filtrado por `op.side`):

| Janela | BUY | SELL |
|---|---|---|
| 2023-07→2024-07 | +0,335R (n=13, IC cruza zero) | −0,039R (n=16, IC cruza zero) |
| Alta 2024-07→2025-07 | +0,456R (n=16, IC cruza zero) | +0,094R (n=10, IC cruza zero) |
| Baixa 2025-07→2026-07 | **−0,552R (n=21, IC95 [-0,965; -0,139] — não cruza zero)** | +0,243R (n=17, IC cruza zero) |

Nenhum dos 3 desfechos pré-registrados do Bloco 0 bate integralmente (não é
puramente direcional — a janela "alta" tem os dois lados positivos; não é
positivo nas 3 janelas — a "baixa" é líquida negativa; não é negativo nas
3 — duas das três são líquidas positivas).

**Correção (achado do Codex, PR #169)**: a versão original desta seção
tratava o SELL de 2023-07→2024-07 (−0,039R) como prova de que o padrão
"SELL sempre positivo" (5 medições anteriores, item 48/71) "não se
repete"/"quebrou". **Isso superclama o dado.** Com n=16 e IC95 cruzando
zero, −0,039R é compatível tanto com um efeito SELL real positivo (que
esta amostra pequena não teve poder pra detectar) quanto com ausência de
efeito — o sinal do ponto estimado sozinho não estabelece não-replicação.
A leitura correta: **esta fatia é inconclusiva**, ponto — não é evidência
a favor do padrão anterior, mas também não é evidência contra. A janela
"baixa" tem um sinal mais forte no lado BUY (IC não cruza zero), mas com
n=17-21 por lado nas 3 janelas, nenhum corte aqui tem poder suficiente
para confirmar ou refutar o padrão SELL sozinho.

### Leitura (fato × hipótese × recomendação)

**Fato**: com dado genuinamente novo, nem o teste pooled combinado nem
nenhuma das 3 janelas isoladas confirma vantagem do motor — todas
inconclusivas (IC cruza zero ou amostra pequena demais).

**Hipótese (não confirmada — nem por este teste, nem pelo teste original)**:
o padrão SELL-favorável medido anteriormente pode ser mais específico à
cesta original de ativos (DeFi/L2/AI, forte correlação com BTC/altcoin
beta) do que uma propriedade geral do motor. Este walk-forward não
confirma essa hipótese nem a descarta — só não a reforça: nenhuma das 3
janelas novas produziu uma 6ª medição SELL positiva e conclusiva. Seria
preciso um walk-forward com mais pares novos (poder estatístico real, não
2 símbolos) para decidir isso de qualquer jeito.

**Recomendação**: Bloco 0 continua **em aberto**. Este teste não fecha a
pergunta central — nem confirma, nem refuta "o motor tem vantagem" — mas
também não dá suporte novo para reabrir o Bloco 1 nem para tratar o achado
SELL do item 71 como coisa estabelecida fora da cesta onde foi medido. Path
adiante (sem decidir aqui, mesmo padrão do Bloco 0 desde 2026-08-04):
ampliar o walk-forward com mais símbolos novos para ganhar poder
estatístico real, ou aceitar a ambiguidade e tratar o painel como
ferramenta de sinalização (opção que o próprio item 73 já registrou como
legítima).

### Verificação

Só análise de relatórios de backtest já gerados (sem mudança de
código/comportamento) — não precisa rodar lint/test/build.

## 75. Diagnóstico do funil da cascata SMC (`entry-funnel-diagnostico`) — hipótese do item 45.2 refutada como causa principal (2026-08-12)

### Contexto

Bloco 0.1, item residual (`docs/roadmap.md`): o funil de confirmação já
estava instrumentado (itens 49/50), faltava rodar 1 backtest
(`trial_label: entry-funnel-diagnostico`) pra ler a distribuição real de
motivos de rejeição da cascata SMC 1h→5m e confirmar ou descartar a
hipótese do item 45.2 (tensão geométrica entre gatilho e zona). Rodei
**BTCUSDT sozinho**, 2025-01-01→2026-08-12 (~19,5 meses) — mesmo símbolo e
início de janela do run original do item 45.1 (que mediu "75 eventos de
estrutura → 0 operações"), agora com o código atual (já com as correções
de instrumentação dos itens 49/50, que na época do 45.1 não existiam).

### Resultado

`smcDiagnostics`: 78 eventos de estrutura, 78 sinais confirmados no viés
1h, 0 rejeitados por zona no viés, **0 operações criadas** — o "código
morto" do item 45.1 se confirma de novo (janela um pouco maior, 78 vs 75).

Com a instrumentação corrigida, dá pra abrir a distribuição real de
rejeição — `smcTrigger` (por sinal, dedupado, n=57) e `entryFunnel['1h_5m']`
(por avaliação, agregado sobre toda a janela de retry, excluindo
`active_op_exists`, que é ocupação de slot, não rejeição do gatilho):

| Motivo | `smcTrigger` (por sinal, n=57) | `entryFunnel` (por avaliação, n=2.701) |
|---|---|---|
| `no_trigger` | 53 (93,0%) | 2.519 (93,3%) |
| `ote_zone_unfavorable` | 3 (5,3%) | 87 (3,2%) |
| `wrong_direction_trigger` | 1 (1,8%) | 95 (3,5%) |

`smcTrigger.confirmed: 0`, `rejected: 57` — nenhum dos 57 sinais avaliados
confirmou operação nesta janela, nas duas granularidades de contagem.

### Leitura

**Fato**: o motivo dominante de rejeição, por larga margem (93% nas duas
contagens independentes), é `no_trigger` — o gatilho de 5m
(`check5mSmcConfirmation`, sweep ou BOS/CHoCH com `swingLen=10`, precisa
disparar exatamente na última barra fechada daquela passada) **nunca
dispara** dentro da janela de retry de 4h (48 candles de 5m) para 93% dos
sinais. `ote_zone_unfavorable` — a hipótese do item 45.2 — responde por
só 3-5% das rejeições.

**Conclusão sobre a hipótese do item 45.2**: **refutada como causa
principal.** Não é mecanismo inexistente (as 3-5% de rejeições por zona são
reais, item 45.2 estava certo sobre o mecanismo existir), mas não é a causa
dominante do "código morto". A causa dominante é outra e mais simples: o
próprio gatilho de 5m — evento pontual, limiar local (`swingLen=10`,
~50min), avaliado só na última barra fechada de cada passada — é raro
demais para disparar dentro da janela de retry na grande maioria dos
casos. Não é "dispara mas a zona rejeita"; é "quase nunca dispara".

**Fora de escopo aqui** (diagnóstico, não mudança de código — Bloco 0
continua sendo o gate pra calibrar/redesenhar qualquer mecanismo): ajustar
o gatilho 5m (relaxar `swingLen`, ampliar a janela de avaliação, trocar de
evento pontual pra estado, etc.) seria mudança de comportamento real na
cascata SMC — que já tem expectância negativa medida (item 56, −0,778R).
Mexer nela sem o Bloco 0 fechado repetiria a mesma armadilha do Bloco 1
(calibrar sobre base sem edge demonstrado).

### Verificação

Só leitura de relatório de backtest já gerado — sem mudança de
código/comportamento.

## 76. VerificationTask pendente ficava "presa" indefinidamente quando um sinal mais novo do mesmo ativo chegava — corrigido

### Contexto

Usuário reportou incoerência real na produção: o widget "Análise Preditiva"/
aba Verificação mostrava o FETUSDT como **SELL, "Entrada Liberada", 2 dias
atrás**, enquanto a aba Trades ("Em Monitoramento") mostrava o MESMO ativo
como **BUY, 16h atrás**. Duas telas do mesmo painel, mesmo ativo,
contradizendo uma à outra.

### Achado (lendo o código, antes de qualquer mudança)

- **`Trades.jsx` ("Em Monitoramento") está correto por desenho**:
  `monitoringMap` (linhas 325-333) sempre mantém só o `SignalEvent` mais
  recente por `symbol_timeframe` — reflete o estado ATUAL do RF.
- **`VerificationTask` (Análise Preditiva) nunca teve auto-expiração** — cada
  sinal de prioridade alta cria UMA tarefa (`persistScanResults`, `scanner.js`),
  que fica `pending` até o usuário clicar manualmente em revisar/pular. Não
  existe nenhum código que marque uma tarefa antiga como superada quando um
  sinal novo (e oposto) chega para o mesmo ativo. Isso já era um gap
  **conhecido e deliberadamente adiado** na hora de construir a feature
  (`docs/known-risks.md` item 72: *"Também adiados: ações em lote,
  auto-expiração de tarefas antigas..."*) — o usuário é quem encontrou a
  primeira confirmação real disso em produção (o teste manual com dado real
  nunca tinha sido feito, também já registrado no item 72).
- **Não é bug do motor de trading**: `VerificationTask` é só um lembrete
  informativo (`"Informativo — replica as travas do scanner só para
  conferência manual, não substitui nem altera a decisão real do motor"`),
  nunca gateia entrada/saída real. O card antigo, mesmo com "ENTRADA
  LIBERADA", nunca criou uma `TradeOperation` — só ficou visualmente
  contraditório com a tela que reflete o estado real.

### Correção

`persistScanResults` (`scanner.js`), logo após criar uma `VerificationTask`
nova com sucesso: busca outras tarefas `pending` do MESMO `asset_id` +
`timeframe` (mesma chave que `Trades.jsx` já usa para "qual é o sinal atual
deste ativo") e marca cada uma como `status: 'superseded'`. Filtro só com
`==` (asset_id/timeframe/status), sem `orderBy` — mas, seguindo o mesmo
padrão defensivo já usado no resto do `firestore.indexes.json` deste projeto
(que já define índice composto até para combinações só-de-igualdade, ex.
`assetStates(asset_id, timeframe)`), adicionado o índice composto
`verificationTasks(asset_id, timeframe, status)` — **requer deploy manual**
(`firebase deploy --only firestore:rules,firestore:indexes`, workflow
`deploy-firestore.yml`, mesmo procedimento do item 72) antes do mecanismo
funcionar em produção.

**Novo valor de status**: `superseded` (`VerificationTask.status`, também
`docs/schema-reference/VerificationTask.jsonc`) — distinto de
`reviewed`/`skipped` (ações do usuário) porque é uma ação do SISTEMA. UI
(`Verification.jsx`) ganhou aba de filtro "Superadas" e badge própria (cor
diferente de "Revisada", pra não parecer uma revisão manual que nunca
aconteceu). O widget do Dashboard (`VerificationWidget.jsx`) não precisou de
mudança — já filtra só `status === 'pending'`, então uma tarefa superada
simplesmente para de aparecer como pendência, sem nenhuma mudança de código.

Escopo mantido mínimo, seguindo o mesmo raciocínio já registrado no item 72:
não apaga a tarefa antiga (mantém histórico), não altera nada da lógica de
entrada/confirmação, roda no mesmo `try/catch` dedicado que já protege a
criação da `VerificationTask` (uma falha aqui não pode abortar o motor de
entrada de outros sinais do mesmo ativo na mesma passada).

### Verificação

908→910 testes (2 novos: uma tarefa antiga do MESMO ativo+timeframe vira
`superseded` quando a nova chega; tarefas de ativos/timeframes DIFERENTES
ficam intocadas) + `npm run lint` limpo + `npm run build` + os 3 alvos
esbuild (`build:scan`/`build:scan-shadow`/`build:backtest`) — todos passando.

**Pendente após o merge**: deploy manual do índice Firestore novo
(`firebase deploy --only firestore:rules,firestore:indexes` ou disparo do
workflow `deploy-firestore.yml`) — sem isso, a query de superseding falha
silenciosamente (mesma classe de erro já vista no item 72: `useQuery`
engole o erro e devolve array vazio) e as tarefas antigas continuam presas,
mas SEM regredir o comportamento anterior — o try/catch garante que uma
falha aqui não trava mais nada.

## 77. SMC deixa de ser cascata independente, vira score observacional sobre a RF nativa — implementado, backtest-only

### Contexto

Depois do item 75 confirmar que a cascata SMC 1h→5m é código morto na
prática (93% das rejeições nunca chegam nem a avaliar o gatilho), o usuário
perguntou diretamente se SMC "não adianta de nada" e propôs uma mudança de
arquitetura: parar de tratar SMC como gerador independente de operação e
usá-lo só para identificar "zona de interesse" — a RF nativa continua sendo
a única a abrir operação de verdade.

### Achado que sustenta a proposta

Relendo o Pine real do SMC (`docs/reference-pine/smc-a-unified-v2.3.pine`,
já salvo no repositório desde 05/08 — não precisava ter sido reenviado,
conferido linha a linha contra o que o usuário colou de novo, bate 100%):
é um `indicator()`, **não** um `strategy()` — não existe
`strategy.entry()`/`strategy.exit()` em lugar nenhum do arquivo. O script
real só calcula estrutura/OB/FVG/zona/sweep e junta tudo num **score de
confluência (0-7)**, nunca dispara operação sozinho. A cascata `1h_5m` que
o Sentinel construiu (`check5mSmcConfirmation`) é uma invenção própria, sem
correspondência no Pine — reforça a proposta do usuário: SMC como
score/contexto é mais fiel ao que o script real É do que SMC como cascata
independente.

### Achado adicional: já existia uma versão quebrada disso

`asset.smc_confirm_4h15m` — um flag por-ativo já existente — já usa
estrutura SMC (tendência + zona) pra "confirmar" sinais da RF nativa em 4h.
Mas (1) é um **gate obrigatório** (rejeita a operação, não só marca) e
(2) usa a zona Premium/Discount **genérica de 20 velas** (`calculatePdZone`)
— a mesma tautologia geométrica que os itens 35/38 já corrigiram na
cascata SMC (o candle que acabou de romper estrutura cai perto da borda da
janela por construção). Esse defeito já estava registrado (item 45.5),
nunca corrigido. Não mexi nesse gate existente — só construí a versão nova
ao lado, sem tocar no que já está em produção.

### Implementado

- **Novo flag** `pineConfig.smcAlignmentScoreEnabled` (backtest-only,
  default `false` — mesmo isolamento dos outros mecanismos experimentais,
  tripwire em `src/lib/smcAlignmentScoreTripwire.test.js`).
- **Nova função pura** `computeSmcAlignmentAtEntry` (`src/lib/scanner.js`,
  ao lado de `recordRejection`) — classifica `'aligned'`/`'against'`/
  `'unavailable'` reusando `buildOteLeg`+`classifyZone` (mesmo fix do item
  38) contra a perna do PRÓPRIO rompimento 4h, nunca a janela genérica.
- **Correção de um bug real encontrado ao implementar**: a 1ª versão media
  a zona contra o MESMO close que também define a borda da perna
  (`legBreakClose`) — reproduzindo a exata tautologia dos itens 35/38 (pra
  BUY, `legHigh = legBreakClose`, então classificar `legBreakClose` contra
  um range cujo próprio topo É `legBreakClose` cai em "premium" por
  construção, sempre, incondicionalmente). Corrigido antes de rodar
  qualquer teste: a perna fica ancorada no candle de 4h que gerou o sinal
  (`tf4hData.lastClose`), mas a zona é medida contra o **preço real de
  entrada** (`opData.entry_price` — a confirmação de 15m, um valor
  independente e posterior) — exatamente o mesmo desenho causal que o item
  38 já usa (perna fixada no rompimento 1h, zona medida no gatilho 5m
  posterior).
- **Nunca bloqueia**: `entry_score` e a decisão de abrir a operação não
  mudam em nada. Só grava `TradeOperation.smc_alignment_at_entry`
  (`docs/schema-reference/TradeOperation.jsonc`) para análise posterior.
- **Nos 2 pontos de criação da RF nativa** (1ª passada e retry) — os
  mesmos onde `asset.smc_confirm_4h15m` já roda hoje, sem tocar nele.
- **Cascata SMC 1h→5m independente**: não precisou apagar nada — já é
  opt-in por ativo (`smc_enabled`), default `false` desde 02/08. Fica
  inerte simplesmente por nunca ser ligada.

### Verificação

919/919 testes (6 novos: flag desligado = campo ausente; alinhado
[tendência+zona a favor] = `aligned`, sem mudar `entry_score`; tendência
contra = `against`, sem bloquear a criação; zona contra [perna estreita] =
`against`; pivôs de estrutura ainda não formados = `unavailable`,
fail-open; confirma pelo loop de retry) + `npm run lint` limpo + `npm run
build` + os 3 alvos esbuild (`build:scan`/`build:scan-shadow`/
`build:backtest`) + grep de isolamento confirmado.

### Correção pós-merge: perna congelada no instante do sinal, não recalculada no retry (achado do Codex, PR #173)

O Codex revisou o PR **depois de mergeado** e apontou um achado procedente
(P2, `scanner.js:2791`): a função e os comentários ao redor dela prometiam
que a perna SMC ficava "ancorada no candle 4h que gerou o sinal" — mas os
dois pontos de chamada (1ª passada e retry) na verdade reconstruíam a perna
a partir de `tf4hData.smc`/`tfData4h.smc` e `.lastClose` **ao vivo**, da
passada ATUAL do scan. Como a janela de retry admite o sinal por até (mas
não incluindo) 4h, um candle 4h novo pode fechar entre a criação do sinal e
a confirmação por retry sem o RF ter revertido — nesse caso a passada de
retry via um candle 4h diferente do que gerou o sinal, reconstruindo uma
perna diferente e contaminando os grupos `aligned`/`against` do backtest.
O mesmo problema já tinha sido evitado corretamente pela cascata SMC
1h→5m (item 38) — perna computada uma vez, persistida em
`SignalEvent.context.ote_leg_high/low`, nunca recalculada depois — só não
tinha sido replicado aqui na primeira versão deste mecanismo.

**Importante, para não confundir com outro comportamento do mesmo trecho de
código**: o retry já usa `tfData4h.lastClose`/`lastCandleTime` como preço de
ENTRADA de propósito (item 67/PR#147) — um `sig.price_at_signal` velho de
horas poderia não ser mais executável. Isso continua certo e não mudou. O
bug era especificamente sobre a PERNA (o range Premium/Discount), um
conceito diferente que precisa ficar fixo no candle 4h original mesmo
quando o preço de entrada legitimamente usa dado mais recente.

**Correção**: `scanAsset` agora computa a perna uma única vez, no
nascimento do sinal RF nativo (`buildOteLeg(r.confirmed.confirmedSignal,
r.lastClose, r.smc)`, mesmo padrão de `buildOteLeg(signalType, r.lastClose,
r.smc)` já usado para a cascata SMC), e grava em
`SignalEvent.context.smc_align_leg_high/low`. `computeSmcAlignmentAtEntry`
não recebe mais `legBreakClose`+`smc` para reconstruir a perna — recebe
`legHigh`/`legLow` já prontos, lidos de `signal.context?.smc_align_leg_high/low`
(1ª passada) ou `sig.context?.smc_align_leg_high/low` (retry). `smc.trend`
continua sendo lido AO VIVO nos dois call sites, de propósito — só a
IDENTIDADE da perna foi prometida como congelada; o gate irmão
`asset.smc_confirm_4h15m` (item 45.5) já reavalia trend/zona a cada retry
por design, e essa parte não muda.

Novo teste de regressão (`scannerStateMachine.test.js`, describe
`smcAlignmentScoreEnabled`): 1ª passada cria o sinal com uma perna
`[50, 300]` (`aligned`); retry roda com `results['4h'].smc` DIFERENTE
(perna `[90, 100]`, que sozinha classificaria a entrada como `against`) —
o resultado esperado, e verificado, continua `aligned`, provando que o
retry usa a perna persistida no `context` e não a recalcula ao vivo.
Suíte inteira: 920/920 (7 no describe do item, era 6) + `npm run lint` +
`npm run build` + os 3 alvos esbuild + grep de isolamento — todos
confirmados de novo depois da correção.

### Achado do primeiro A/B real: 0 "aligned" em 104 operações — viés geométrico na âncora da perna, corrigido

Usuário disparou o primeiro A/B real (`backtest.yml`, 7 símbolos/12 meses,
`pine_config: {"smcAlignmentScoreEnabled": true}`, `trial_label:
smc-alignment-score-ab`). Resultado bruto (104 operações fechadas,
`costs.conclusive: false`, IC cruza zero — a estratégia em si segue
inconclusiva, nada novo aí): **0 `aligned`, 65 `against` (63%), 39
`unavailable` (37%)** — distribuídos de forma equilibrada entre os 7
símbolos e os dois lados (BUY/SELL), não é artefato de 1 ativo.

**Investigação (fato, verificado contra os próprios números do
relatório, não é só hipótese)**: cruzando `entry_price` com
`origin_4h_price` (= `price_at_signal`, o fechamento da vela 4h que gerou
o sinal — e também o mesmo valor que `legBreakClose` usava como uma das
bordas da perna na 1ª versão deste mecanismo): em **91% dos BUYs e 94%
dos SELLs**, o preço de entrada já tinha ultrapassado esse fechamento
antes da operação abrir. Faz sentido mecanicamente — a RF nativa só entra
depois que o 15m **confirma continuação**, então o preço quase sempre já
andou mais na mesma direção. O problema: a perna da 1ª versão usava
exatamente esse mesmo fechamento como uma de suas bordas
(`buildOteLeg(signalType, r.lastClose, r.smc)`, `legHigh = legBreakClose`
pra BUY) — então, quase sempre, o preço de entrada já estava além da
própria borda que definia "premium" pra compra (ou "discount" pra venda).
Resultado: `against` (ou `unavailable`, se os pivôs de estrutura nem
existiam) praticamente garantido, **independente de qualquer estrutura
SMC real** — um viés geométrico, não sinal de mercado. Não é o mesmo bug
de tautologia dos itens 35/38 (não é literalmente "comparar o valor com
ele mesmo": `entryPrice` ≠ `legBreakClose`), mas é primo dele — a régua de
medição estava ancorada exatamente no ponto que uma entrada validada por
continuação vai, quase sempre, ultrapassar.

**Correção**: a perna deixou de usar `buildOteLeg` (que ancora uma borda
no fechamento do candle que gerou o sinal — desenho correto pra cascata
SMC 1h→5m, onde esse candle É o evento SMC, mas sem sentido aqui, onde o
"rompimento" é um evento da RF, não da SMC) e passou a usar a **perna
natural da própria estrutura SMC**: `smc.lastSwingHigh`/`lastSwingLow` —
os pivôs protegidos e confirmados que `calculateStructure` já rastreia,
independentes de qualquer candle da RF (mesmos campos que sustentam o
stop estrutural da cascata SMC nativa, item 24). É também a definição
mais fiel ao ICT/SMC real de Premium/Discount (medido sobre o último
swing significativo), mais correta que o hack anterior. `context.
smc_align_leg_high/low` agora grava `smc.lastSwingHigh`/`lastSwingLow`
diretamente, no mesmo instante do sinal (mesma disciplina "congelado no
sinal" da correção anterior, intocada). `smc.trend` continua lido ao
vivo, sem mudança.

Testes existentes (describe `smcAlignmentScoreEnabled`,
`scannerStateMachine.test.js`) não mudaram — já recebiam a perna via
`context` explícito, desacoplados de como `scanAsset` a calcula, então
continuam cobrindo a lógica de classificação (`aligned`/`against`/
`unavailable`) sem alteração. A produção da perna em si (`scanAsset`)
segue no mesmo padrão de cobertura que o `ote_leg_high/low` da cascata
SMC nativa já tinha (nunca testado no nível de `scanAsset` diretamente —
só os consumidores, via `context` sintético). Suíte inteira: 920/920 +
lint + build + os 3 alvos esbuild + grep de isolamento, todos
confirmados de novo.

### Segundo A/B real (perna corrigida): `aligned` aparece, mas amostra longe do suficiente

Usuário rodou o A/B de novo (`trial_label: smc-alignment-score-ab-v2`,
mesmos 7 símbolos/12 meses) já com a perna ancorada em `smc.lastSwingHigh/
lastSwingLow`. Distribuição: **2 `aligned`**, 51 `against`, 51
`unavailable` (n=104 — `unavailable` subiu de 39 para 51 porque agora as
DUAS bordas da perna dependem de pivôs SMC formados, contra só uma
antes). Confirma que a correção funciona (`aligned` deixou de ser
estruturalmente impossível), mas 2 casos não sustentam nenhuma conclusão
sobre se `aligned` performa diferente de `against` — essa amostra pode
levar muito tempo pra crescer, já que `aligned` parece ser raro mesmo
(~2%). `costs`/`overall` bateram byte-a-byte com a 1ª rodada (mesmo
volume/expectância/IC) — confirma, de novo, que o campo é puramente
observacional e nunca influenciou nenhuma entrada/saída real.

### Próximo passo (fora deste registro)

Sem novidade — segue esperando amostra crescer (nenhum novo A/B
programado só pra isso; o campo já é gravado em toda operação com o flag
ligado, então acumula sozinho em qualquer run futuro que tenha a flag
ativa). Quando houver volume de `aligned` suficiente, quebrar por
`aligned`/`against`/`unavailable` de verdade responde se SMC realmente
ajuda ou é só mais filtro no caminho. Decisão do usuário sobre quando
achar que já tem dado suficiente.

---

## 78. RF nativa (4h_15m) suprimida sob demanda para medir 1h isolado sem disputa de vaga

### Contexto

Usuário pediu uma comparação entre "RF nativa direto" no 4h e no 1h (sem
confirmação de timeframe menor, batendo com o Pine real). O 4h já tinha
peça pronta (`skip15mConfirmationEnabled`, item 67); o 1h também, juntando
`rf1hUncondEnabled` (item 68) com o mesmo `skip15mConfirmationEnabled`
(a função que ele desvia, `resolveEntryConfirmation15m`, já é genérica —
usada pelos dois). Perguntado se preferia rodar rápido aceitando uma
ressalva conhecida (as duas cascatas competem pela mesma vaga por ativo)
ou esperar uma correção pequena antes — usuário escolheu rodar rápido
primeiro.

### Achado real — a ressalva se confirmou, e forte

Resultado do A/B (`trial_label: rf-1h-direto`, `{"rf1hUncondEnabled":
true, "skip15mConfirmationEnabled": true}`, mesmos 7 símbolos/12 meses):

| Cascata | Operações | Expectância | Situação |
|---|---|---|---|
| `4h_15m` (competindo) | 59 | +0,363R | conclusiva |
| `rf1h_uncond_15m` (competindo) | 224 | −0,115R | inconclusiva |
| Total combinado | 283 | −0,015R | inconclusiva |

O sinal de 1h dispara ~4× mais que o de 4h. Das rejeições de
`rf1h_uncond_15m`, **67% foram `active_op_exists`** (vaga ocupada, não
sinal ruim), e a amostra do `4h_15m` **caiu pela metade** (de 109, no run
"4h direto" isolado, pra 59 aqui) só por causa da disputa. Os dois números
da tabela acima são sub-buckets contaminados — mesma classe de erro já
corrigida nos itens 51/68 (comparar sub-bucket de runs/cascatas diferentes
sem isolar a variável não é um teste limpo). Não dá pra usar nenhum dos
dois isoladamente como "quanto vale o 4h" ou "quanto vale o 1h". O que
sobrevive: o total combinado, praticamente plano (levemente negativo,
inconclusivo) — empilhar 1h direto sobre o que já existe não pareceu
ajudar nesta janela.

### Implementado — `pineConfig.rf1hExclusiveEnabled` (backtest-only)

Suprime a criação de operação da cascata NATIVA (`4h_15m`) por completo —
1ª passada e retry — dando a vaga inteira pra `rf1hCondEnabled`/
`rf1hUncondEnabled` (o que estiver ligado) medir sem disputa. Sinais RF de
4h continuam sendo emitidos e logados normalmente (funil/expiração
visíveis no relatório); só a CRIAÇÃO de `TradeOperation` é suprimida.

- **`src/lib/scanner.js`**: 1ª passada — o `else` final da cadeia
  `if/else-if` que decide o que fazer com um sinal `source: 'range_filter'`
  (cond 1h → uncond 1h → "não é 4h, ignorado" → nativo 4h) virou
  `else if (!pineConfig.rf1hExclusiveEnabled)`; com a flag ligada, nenhum
  ramo bate para um sinal de 4h — ele é ignorado silenciosamente (mesmo
  comportamento do ramo "não é 4h" logo acima, sem gerar rejeição de
  funil, porque não é um gate rejeitando, é a cascata inteira fora do
  run). Retry — um `if (pineConfig.rf1hExclusiveEnabled) continue;` logo
  no topo do loop que itera `recent4hSignals`, antes de qualquer outra
  checagem.
- **`scripts/backtestPineConfig.js`**: `rf1hExclusiveEnabled: false` nos
  `DEFAULTS`, mesmo isolamento backtest-only dos demais (tripwire em
  `src/lib/rf1hExclusiveTripwire.test.js`).
- **`src/lib/scannerStateMachine.test.js`**: novo describe (4 casos) —
  flag desligada não regride nada; flag ligada sozinha suprime o sinal 4h
  sem crash e sem contar como rejeição; flag ligada + `rf1hUncondEnabled`
  ligada, sinal 4h e sinal 1h no MESMO scan → só o 1h cria operação;
  mesma prova no caminho de retry (sinal 4h pendente nunca confirma,
  sinal 1h pendente confirma normalmente).

### Verificação

927/927 testes (4 novos) + `npm run lint` limpo + `npm run build` + os 3
alvos esbuild (`build:scan`/`build:scan-shadow`/`build:backtest`) + grep
de isolamento confirmado.

### A/B limpo real: `rf1hExclusiveEnabled` funcionou, resultado não favorece o 1h

Usuário rodou de novo (`trial_label: rf-1h-direto-isolado`,
`{"rf1hUncondEnabled": true, "skip15mConfirmationEnabled": true,
"rf1hExclusiveEnabled": true}`, mesmos 7 símbolos/12 meses). Confirmado
que a trava funcionou: `report.byCascade` só tem `rf1h_uncond_15m`
(`4h_15m` não aparece — zero tentativas, nenhuma linha no funil).

| | Operações | Expectância líquida | Situação |
|---|---|---|---|
| `rf1h_uncond_15m` competindo (run anterior) | 224 | −0,115R | inconclusiva |
| `rf1h_uncond_15m` isolado (este run) | 255 | −0,042R | inconclusiva |
| `4h_15m` isolado (item 67/roadmap) | 109 | +0,108R | inconclusiva |

Volume subiu (255 vs 224, sem mais perder vaga pro 4h) e a expectância
melhorou (menos negativa), mas segue inconclusiva (IC95 cruza zero). Na
comparação limpa lado a lado: o 1h dispara ~2,3× mais vezes que o 4h, mas
com viés levemente NEGATIVO, oposto ao viés levemente positivo do 4h.
Nenhum dos dois é conclusivo isoladamente (amostra pequena pros dois),
mas **não há evidência de que RF direto em 1h ajude** — o sinal fraco
disponível aponta na direção errada. Consistente com o resultado já
registrado do RF 1h condicionado ao 4h (itens 56/68): mais uma leitura
que não favorece dar peso ao 1h nesta estratégia.

### Próximo passo (fora deste registro)

Nenhum programado — linha de investigação (RF direto em 1h, com ou sem
condição do 4h) não parece promissora com o dado acumulado até aqui.
Reabrir só se surgir hipótese nova ou dado genuinamente não examinado
(mesma disciplina do item 73).

---

## 79. Score e margem de regime — sem evidência de relação com R nesta amostra, análise post-hoc (2026-08-13)

### Contexto

Usuário perguntou (frustrado com a sequência de resultados inconclusivos)
se havia alguma forma diferente de melhorar o resultado — não mais um
filtro de entrada, mas algo estruturalmente distinto. Três linhas
propostas: (1) dado genuinamente novo/futuro, (2) usar o painel como
apoio à decisão humana em vez de piloto automático, (3) dimensionar
risco pelo tanto que o sinal é confiável, em vez de mexer em quando
entrar. As linhas 2 e 3 têm uma pergunta comum, testável AGORA com dado
já coletado (sem precisar de novo backtest): **o `entry_score`/margem de
regime da RF nativa prediz o resultado real da operação?** Se sim, tanto
dimensionar posição pelo score (linha 3) quanto um humano hesitar em
sinais "no limite" (linha 2, proxy: margem pro limiar de ADX/Chop) teriam
sustento. Se não, as duas ideias não têm base nos dados que já existem.

### Achado (fato — análise post-hoc sobre `rf-4h-direto`, item 67, n=109, cascata nativa isolada, sem contaminação de outra cascata)

Correlação de Pearson entre cada variável e o R realizado, com IC95%
(transformação de Fisher — a correção que faltava na 1ª versão deste
registro, apontada pelo Codex review no PR #178):

| Variável | Correlação com R | IC95% | Cruza zero? |
|---|---|---|---|
| `entry_score` (0-100) | −0,032 | [−0,219; 0,157] | sim |
| margem ADX (`adx_at_entry` − mínimo do tier) | 0,024 | [−0,165; 0,211] | sim |
| margem Chop (máximo do tier − `chop_at_entry`) | 0,122 | [−0,068; 0,303] | sim |
| as duas margens somadas | 0,101 | [−0,089; 0,284] | sim |

**Nenhum dos quatro IC exclui zero** — com n=109, o erro-padrão da
correlação é grande o bastante pra não distinguir "sem relação" de uma
correlação moderada real em qualquer uma das quatro variáveis (o IC do
score, por exemplo, é compatível com uma correlação negativa moderada
[-0,22] OU positiva moderada [+0,16] — a estimativa pontual −0,032 não
prova que a associação verdadeira é zero, só que esta amostra não tem
poder pra detectá-la).

Terços por `entry_score`: baixo avgR=+0,273, médio avgR=−0,156, alto
avgR=+0,214 — padrão em U, não monotônico. Terços por margem de Chop:
baixo avgR=−0,184, médio avgR=+0,076, alto avgR=+0,432 — o único com
gradiente na direção esperada, mas com IC cruzando zero igual aos
outros. **Ressalva adicional**: Pearson só captura relação LINEAR — o
padrão em U do score não seria bem descrito por nenhuma correlação
linear, positiva ou negativa; os terços mostram isso diretamente
(mais informativo aqui do que o coeficiente sozinho), mas também não
sugerem nenhuma regra de dimensionamento simples (nem "aposte mais no
score alto", já que o score baixo empatou com o alto).

### Conclusão (recalibrada — a 1ª versão deste item superclaimava)

**Não há evidência de relação entre `entry_score`/margem de regime e o R
realizado NESTA amostra — não é o mesmo que provar que a relação não
existe.** Com n=109 e essa magnitude de erro-padrão, um efeito real
moderado (a diferença que separaria uma regra de dimensionamento útil de
uma inútil) simplesmente não seria detectável. A formulação correta é
"sem sustento pra agir agora", não "score não prediz resultado" (a
primeira versão deste registro dizia isso, e o Codex review corretamente
apontou que a análise não sustenta uma afirmação tão forte). Nenhuma
decisão de produto tomada a partir disso — nem a favor, nem contra.

**O que resolveria isso de verdade** (sugestão do próprio Codex review,
registrada como pendência, não implementada): testar uma regra de
dimensionamento CONCRETA (ex.: tamanho de posição proporcional ao score)
direto em dado de holdout — diferente desta análise de correlação, que só
usa os R-múltiplos já normalizados por risco (por construção,
independentes do tamanho da posição). Simular uma regra de
dimensionamento de verdade exigiria um motor de backtest novo, com PnL em
dólar variável por operação — não existe hoje, é escopo novo, não
implementado sem pedido explícito.

### Próximo passo (fora deste registro)

Linha 1 (dado genuinamente novo/futuro) segue em aberto — não é
simulável, só observável com o tempo. Agendado check-in pra ~90 dias
(2026-11-11) pra revisitar com dado real de produção acumulado desde
então — amostra maior estreita o IC de qualquer uma dessas correlações e
pode finalmente separar sinal de ruído. Se o usuário quiser ir além da
correlação, o desenho de um backtest com dimensionamento variável
(sugestão do Codex acima) fica disponível, mas não é gatilho automático.

---

## 80. Varredura completa do sistema — falhas/erros/bugs, do CSS ao motor (2026-08-13)

### Contexto

Usuário pediu uma varredura criteriosa e cuidadosa de TODO o projeto —
"desde o css ate o mais complicado do sistema" — pra identificar falhas,
erros e bugs, terminando num relatório. Diferente de `sentinel-bug-audit`
(que exige reprodução de um bug relatado), esta foi uma auditoria ampla e
exploratória. Rodei 5 agentes independentes em paralelo, cada um cobrindo
um domínio (UI/acessibilidade, motor de trading, indicadores/paridade
Pine, segurança/dados, build/CI), todos read-only, cada um com o índice
dos 79 itens já registrados aqui + um bloco de decisões intencionais
pra evitar redescobrir/re-reportar como "novo" algo já investigado e
aceito. Um achado do motor (B-1) atingiu o critério de
`sentinel-council-review` (concorrência real em máquina de estados) e
recebeu 4 papéis independentes de revisão antes de entrar aqui.
Relatório completo, navegável e com evidência expandível por achado,
publicado como Artifact (link entregue ao usuário na conversa).

### Achado — 25 itens novos, 13 riscos já conhecidos reconfirmados, 9 decisões intencionais revisadas e descartadas

**P1 (8, requerem atenção — a maioria já ativa em produção hoje, só B-1
está atrás de uma flag desligada; ver ressalva por item abaixo):**

- **A-1/A-2 (UI)** — `AddAssetForm.jsx:30-54` e `AssetConfigPanel.jsx:79-93`
  chamam Firestore/API sem try/catch — uma falha de rede trava o spinner
  de "Salvando..."/"Validando..." pra sempre, sem mensagem de erro.
- **A-4 (UI)** — `AssetDrawer.jsx` é um modal caseiro (dois `<div>` fixos)
  sem foco/Esc/`aria-modal`, apesar do componente `ui/sheet.jsx` (Radix
  Sheet, próprio pra esse padrão) já existir no repo e não ser usado por
  ninguém.
- **A-5 (UI)** — vários `<input>`/`<select>` nativos usam `outline-none`
  sem nenhum substituto de foco visível (Dashboard.jsx, Assets.jsx,
  Logs.jsx, PineScript.jsx) — falha WCAG 2.4.7, ao contrário do
  componente `Button` do design system, que já trata isso certo.
- **B-1 (Motor)** — `scanner.js:3458-3486` (branch pré-TP1) nunca passa
  `stopAdvanceMarkerField` pra `transitionTradeOp`, ao contrário do
  branch runner pós-TP1 (`scanner.js:3584-3587`, hardening do item 59) —
  o marcador `pre_tp1_stop_advanced_candle_time` pode ser sobrescrito por
  um worker desatualizado numa corrida entre browser e cron, reabrindo a
  classe de bug "falso STOP_HIT por look-ahead" que os itens 54/59 já
  fecharam uma vez (agora no mecanismo pré-TP1). **Confirmado por conselho
  de 4 papéis** (Concorrência, Arquiteto, Trading, Testes) — ver subseção
  dedicada abaixo, incluindo uma refutação real que melhora a correção
  proposta originalmente.
- **C-1 (Indicadores)** — `tier.js:22-30`
  (`calculateAtrPctSmooth`) mistura zeros-placeholder de warm-up do ATR
  na média quando `atrPeriod` é grande o bastante pra invadir a janela de
  suavização — reproduzido rodando o algoritmo real: `atrLen=135` dilui
  o ATR% em ~26% (cruza o limiar T2→T1), `atrLen≥148` zera. Tier errado
  propaga silenciosamente pra stop mult/ADX/Chop/Time Stop de uma
  operação real, sem log nem exceção. `atrLen` é sincronizado
  globalmente sem `maxval` no Pine real.
- **C-2 (Indicadores)** — `rsi.js:29-66` (`calculateRSI`) inicializa a
  série com placeholder `50` e `prevRSI`/`prev2RSI` podem ler esse
  placeholder (não um RSI real) perto do warm-up mínimo — reproduzido:
  com `n = period+1`, `crossedBull50` dispara a partir do PRIMEIRO valor
  computável, não de um cruzamento real. Blindado hoje por guardas
  externas (`closedCandles.length < 50`), mas `rsi_period` por-ativo sem
  clamp na UI reproduz isso em produção com um ativo recém-listado
  configurado em ~48-49 — +15 pontos indevidos no score de confluência.
- **D-1 (Segurança)** — `server/index.js:62-92` +
  `telegramConfig/{uid}` (escrita liberada ao próprio dono do doc):
  qualquer visitante anônimo pode escrever um `chat_id` arbitrário no
  próprio doc e usar `POST /api/telegram-notify` (endpoint hoje não usado
  pelo frontend, confirmado) como relay de spam com o token real do canal
  24h, sem rate limit.

**P2 (12, vale corrigir sem urgência):** A-3 (linha do histórico não
ativável por teclado), A-6 (contraste ~2:1 nos eixos dos gráficos,
3 componentes), A-7 (busca global escondida abaixo de 640px sem
fallback), A-8 (abas do editor Pine sem ARIA, ao contrário do padrão
correto já usado em Dashboard.jsx), A-9 (sliders de Settings.jsx sem
`aria-label`), B-2 (fechamento de operação hierárquica não passa
`cascade` pra `transitionTradeOp` — âncora `assetActiveOps/{id}__{cascade}`
fica com ponteiro fantasma, mascarado pelo auto-reparo P0-f;
`hierarchicalCascadesEnabled` já está desligado por recomendação do
próprio A/B do item 37), D-2 (`requireAuth` do server checa só
autenticação, não autorização — qualquer anônimo dispara
`/api/backtest/trigger`), D-3 (comparação do webhook secret não é
constant-time), D-4 (`server/index.js:119` persiste o `secret` do
webhook em texto puro dentro de `tradingviewWebhookEvents`), E-1 (3
flags de produção — `preTp1StopProtectionEnabled`/`AtrMult`,
`candlePatternEnabled` — ausentes do espelho `backtestPineConfig.js`,
inofensivo hoje mas quebra a convenção documentada no próprio arquivo),
E-2 (`ci.yml`, o gate de merge, sem `timeout-minutes`/`concurrency`,
diferente de todos os outros workflows), E-3 (`deploy-firestore.yml` sem
`timeout-minutes`).

**Info (5, sem risco real hoje):** A-10 (`Sidebar.jsx` usa
`console.error` em vez de `logError`, sem feedback ao usuário em falha),
C-3 (função `ema()` triplicada byte-idêntica em `rangeFilter.js`/
`macd.js`/`movingAverages.js`, risco de manutenção não de cálculo), D-5
(comentário de `firestore.rules` descreve uma Cloud Function que nunca
existiu — a regra em si já é segura), D-6 (CORS abre pra `'*'`
silenciosamente se `ALLOWED_ORIGIN` faltar — hoje `render.yaml` define
certo), E-4 (comentário aponta pro arquivo de tripwire errado —
`rf1hCondTripwire.test.js` é o real, o comentário cita
`scannerStateMachine.test.js`).

### Achado B-1 em detalhe — conselho de revisão (4 papéis independentes)

O achado do motor de trading (corrida no marcador pré-TP1) bateu o
critério de `sentinel-council-review` (máquina de estados + concorrência
em produção). Rodei 4 papéis independentes, cada um lendo o código real
e tentando refutar a reconstrução antes de aceitar:

- **Concorrência**: **CONFIRMADO** — a causa raiz é ainda mais ampla que
  o achado original descrevia: `stopAdvanceMarkerField` nunca chega no
  branch pré-TP1, então o marcador é sobrescrito incondicionalmente,
  vencendo ou perdendo o clamp do `current_stop` (não só no caso de
  empate de valor citado originalmente). Recomendou P2 (mecanismo
  desligado por padrão hoje).
- **Arquiteto**: confirmou a assimetria (cronologia bate com omissão —
  item 54 já sinalizava o gêmeo estrutural um dia antes do item 59
  corrigir só o runner) e **discordou parcialmente da correção
  proposta**: como `advancePreTp1StopProtection` salta pra breakeven uma
  única vez (valor fixo), dois workers concorrentes costumam calcular o
  MESMO valor candidato — `stopAdvanceCandidateWon` (que compara só
  valor, `clampedStop === candidateStop`) não discrimina quem venceu
  nesse empate. Copiar literalmente o padrão do runner não fecha esse
  caso.
- **Trading**: **CONFIRMADO**, chegou **independentemente** à mesma
  ressalva do Arquiteto sobre o empate de valor (convergência real entre
  papéis que não se comunicaram). Recomendou manter **P1**: severidade
  deve refletir o impacto SE o mecanismo for religado, não a
  probabilidade disso acontecer — o flag é opt-in e documentado, não
  hipotético.
- **Testes**: achado **testável de forma conclusiva** — desenhou um
  teste determinístico (nível `transitionTradeOp` direto, sem
  `Promise.all`, sem depender de timing) que falha HOJE sem a correção,
  no mesmo padrão do teste já existente pro runner
  (`scannerStateMachine.test.js:4170-4191`).

**Veredito**: severidade mantida **P1** — a flag
`preTp1StopProtectionEnabled` está desligada por padrão em produção hoje
(não é P0 ativo), mas é um bug real e documentado esperando pra
acontecer se a flag for religada (o item 55 já decidiu mantê-la
desligada por resultado de A/B, o que reduz a urgência mas não muda o
que aconteceria se alguém a religasse). **A correção correta não é só
espelhar o padrão do runner** — precisa também desempatar por horário de
vela candidata quando os valores empatam, refinamento que só apareceu
por causa da refutação do conselho.

### Verificado e confirmado íntegro (não são achados, são checagens positivas)

Todos os P0 de `.claude/rules/trading-engine.md` (CAS transacional,
candle retroativo, trailing look-ahead, contagem RF por candle, retry
re-apontando operação terminal, stop regredindo) seguem corretos —
regressão checada linha a linha, sem achado novo. Paridade
`pineParser.js`×`adminPineConfig.js` confirmada por diff programático
(63 chaves DEFAULTS, 59 SYNCED_STRATEGY_KEYS, zero divergência — item 27
persiste). Política "stop vence" na ambiguidade stop/TP idêntica nos
branches pré/pós-TP1 (item 36). 7 arquivos de tripwire de isolamento
rodados (`npx vitest run`) — 24/24 verdes, nenhum flag experimental
vazando pra produção. Os 4 flags dormentes (`retestEnabled`,
`displacementEnabled`, `smcTierEnabled`, `smcObFvgEnabled`) revisados por
bug de código mesmo desligados — nenhum encontrado.

### Conclusão

Nenhuma correção foi aplicada nesta tarefa — foi deliberadamente
só leitura/análise, por pedido do usuário ("me faça um relatório").
Distribuição de severidade (8 P1 / 12 P2 / 5 Info) reflete um sistema já
maduro e auditado — nenhum P0 novo, nenhum vazamento catastrófico de
flag experimental (a hipótese de maior risco da própria varredura,
investigada a fundo pelo Agente E e confirmada como não-lacuna). Os 2
achados de maior valor prático são C-1/C-2 (indicadores) — silenciosos,
sem log, afetam a qualidade do sinal diretamente, não só UI — e merecem
prioridade mesmo sendo "só" P1.

### Próximo passo (fora deste registro)

Decisão do usuário sobre o que corrigir e em que ordem. Sugestão não
vinculante: A-1/A-2 primeiro (menor risco, mudança isolada); C-1/C-2 em
seguida (afetam sinal, não só UI); B-1 pode esperar mas com o
refinamento do conselho quando for feito; D-1 vale decidir logo
(desativar endpoint não usado ou protegê-lo); P2/Info numa rodada
dedicada futura, no espírito do Bloco 5 já fechado nesta sessão.

---

## 81. Correção dos 4 achados P1 mais acionáveis do item 80 — A-1/A-2, C-1/C-2, B-1, D-1 (2026-08-13)

### Contexto

Usuário pediu pra seguir com a ordem de próximos passos sugerida no item
80. Perguntei especificamente como resolver D-1 (desativar vs. proteger o
endpoint) — escolheu **proteger**. Escopo desta rodada: só estes 4
achados (A-4/A-5 de acessibilidade e todo P2/Info ficam pra uma rodada
dedicada futura, como já registrado no item 80). B-1 (motor de trading)
teve o desenho validado por um agente Plan antes da implementação, que
achou 2 problemas reais no desenho original — ver "Achado" abaixo.

### Achado (correções aplicadas)

**A-1/A-2 (UI)** — `AddAssetForm.jsx` (`handleValidate`/`handleSave`) e
`AssetConfigPanel.jsx` (`handleSave`) agora envolvem as chamadas
assíncronas em try/catch, resetam `validating`/`saving` num `finally`,
reusam o estado de erro que cada componente já tinha
(`error`/`errors` — array, não string solta) e chamam
`logError(ComponentName, mensagem, { error: err.message })`, mesmo padrão
já usado em `AssetCard.jsx`/`Trades.jsx`.

**C-1 (indicador)** — `tier.js:calculateAtrPctSmooth` cortava a série
ANTES de calcular o `atrPctSeries`, no índice `atrPeriod - 1` (o primeiro
valor real de `calculateATRSeries`), em vez de filtrar por valor (o
filtro antigo `v > 0 || v === 0` era um no-op, não distinguia placeholder
de warm-up de ATR real zero). Teste de regressão novo em `tier.test.js`
com candles de volatilidade constante (TR=2 todo candle, ATR% real
sempre exatamente 2) provando que `atrLen=135`/`atrLen=148` em 149
candles não dilui/zera mais o resultado (antes: 1.5 e 0.1
respectivamente; depois: 2 nos dois casos).

**C-2 (indicador)** — `rsi.js:calculateRSI` agora gateia
`crossedBull50`/`crossedBear50` (e `prevRSI`/`prev2RSI`) por índice
válido (`>= period`), não lendo mais o placeholder `fill(50)` como se
fosse um RSI anterior real. Teste de regressão novo em `rsi.test.js`
exatamente em `n = period+1` (o mínimo aceito) com closes estritamente
crescentes, provando que `crossedBull50` não dispara mais a partir do
placeholder.

**B-1 (motor de trading, maior risco)** — `scanner.js` agora seta
`stopAdvanceMarkerField = 'pre_tp1_stop_advanced_candle_time'` no branch
pré-TP1 (linha ~3485), espelhando o que o branch runner já fazia (item
59 addendum). `opTransition.js:stopAdvanceCandidateWon` ganhou um
desempate por horário de vela (comparação de STRING, não `Date` — ISO
8601 é lexicamente ordenável, e usar `Date` quebraria com os placeholders
`'T1'`/`'T2'` que os próprios testes já usam pra representar horário de
vela, virando `NaN`) pra resolver o caso de EMPATE de valor: diferente do
runner (trail continuamente variável), `advancePreTp1StopProtection`
satura num alvo fixo (breakeven), então dois workers concorrentes que
cruzam o gatilho computam o MESMO valor candidato — um empate estrutural,
não uma exceção rara. Um agente Plan validou o desenho antes da
implementação e achou 2 problemas reais: (1) faltava um 4º backend
espelhado, `scripts/adminEntitiesShadow.js` (modo sombra, item 56), que
teria herdado o mesmo bug sem a correção; (2) o desenho original usava
`new Date(...).getTime()` pro desempate, que quebraria silenciosamente
com os placeholders de teste do próprio arquivo (`new Date('T1').getTime()
=== NaN`) — trocado por comparação de string direta. Os 4 backends
(`entities.js`, `adminEntities.js`, `fakeBackend.js`,
`adminEntitiesShadow.js`) foram atualizados juntos. Teste de regressão
novo em `scannerStateMachine.test.js` (mesmo estilo do teste do item 59
addendum, mas com valores EMPATADOS nos dois workers, não diferentes —
confirmado manualmente que o teste falha sem a correção de
`opTransition.js` e passa com ela).

**D-1 (segurança)** — `server/index.js:/api/telegram-notify` não lê mais
`chatId` de `telegramConfig/{uid}` (documento que qualquer visitante
anônimo podia escrever livremente) — converge pro único canal legítimo
do app, a mesma env var `TELEGRAM_CHAT_ID` que o handler do webhook logo
abaixo já usa e confia (o próprio comentário do arquivo já dizia "this
app is single-tenant"). Adicionado rate limit por uid (10s, mesmo padrão
"freio de cortesia" do disparo de backtest) e limite de tamanho do texto
(4000 caracteres). Sem suíte de teste nova pro `server/` — não existe
nenhuma hoje (lacuna já registrada no item 80), fora do escopo desta
rodada.

### Conclusão

`npm run lint && npm test && npm run build && npm run typecheck` — todos
limpos (932/932 testes, incluindo os 5 novos de regressão; lint e
typecheck sem erro; build sem regressão de tamanho). A-4/A-5
(acessibilidade) e todo P2/Info do item 80 seguem pendentes, por decisão
de escopo desta rodada, não por esquecimento.

### Próximo passo (fora deste registro)

Decisão do usuário sobre quando tocar A-4/A-5 e a rodada de P2/Info.

---

## 82. Correção dos 12 P2 + 5 Info do item 80 (2026-08-13)

### Contexto

Usuário pediu pra seguir com a rodada de P2/Info do item 80, deixada
pendente no item 81. Para o D-2 (autorização do disparo de backtest),
perguntei diretamente porque a correção mais completa (`role==='admin'`)
tem um efeito colateral real de produto — usuário escolheu a opção mais
segura mesmo sabendo disso. Validei os 5 fixes de maior risco
(D-2/D-3/D-4/D-6 em `server/index.js`, B-2 em `scanner.js`) com um agente
Plan antes de implementar, que confirmou todos os desenhos corretos
contra o código real.

### ⚠️ AÇÃO NECESSÁRIA — D-2 quebra o botão "Disparar Backtest" até promoção manual

`POST /api/backtest/trigger` agora exige `users/{uid}.role === 'admin'`
(nova middleware `requireAdmin`, `server/index.js`), além de estar
autenticado. Como todo usuário recebe `role: 'user'` na criação e
promoção a admin é sempre manual (`firestore.rules` já impede
auto-promoção), **o botão "Disparar Backtest" do painel para de funcionar
pro próprio usuário até ele promover seu uid pra `role: 'admin'` no
console do Firebase** (Firestore Database → coleção `users` → documento
do seu uid → campo `role` → `admin`). `/api/backtest/status`/`/artifact`
não mudaram (continuam só `requireAuth`).

### Achado (correções aplicadas)

**UI (6):** A-3 (`TradeHistory.jsx`) — linha do card ganha
`role="button" tabIndex={0}` + `onKeyDown` Enter/Espaço. A-6 (`PnLChart.jsx`,
`TradeEntryMarkers.jsx`, `PerformanceOverview.jsx`) — contraste dos eixos
Recharts, `fill` 0.2/0.25→0.45, `fontSize` 8→9. A-7 (`GlobalSearch.jsx`) —
busca visível em mobile (removido `hidden sm:flex`), larguras responsivas.
A-8 (`PineScript.jsx`) — ARIA retrofit nas abas customizadas
(`role="tablist"/"tab"/"tabpanel"` + `aria-selected`/`aria-controls`/
`aria-labelledby`), sem migrar pro componente Tabs do Dashboard (reescrita
maior, mais risco). A-9 (`Settings.jsx`) — `aria-label={field.label}` nos
sliders. A-10 (`Sidebar.jsx`) — `ClearLogsButton` troca `console.error`
por `logError` + `toast` de erro.

**Indicador (1):** C-3 — função `ema()` triplicada em `rangeFilter.js`/
`macd.js`/`movingAverages.js` consolidada: `movingAverages.js` exporta a
única cópia, os outros dois importam.

**Motor (1):** B-2 (`scanner.js`) — os 2 call sites de `transitionTradeOp`
que fecham uma operação agora passam `cascade: op.hierarchical_cascade
=== true ? op.cascade : undefined`, corrigindo a âncora
`assetActiveOps/{assetId}__{cascade}` que nunca era limpa numa operação
hierárquica (mascarado até aqui pelo auto-reparo de ponteiro órfão, P0-f).
Confirmado sem risco pra operações não-hierárquicas
(`buildActiveOpsAnchorId` já trata `cascade` falsy como hoje).

**Segurança (5):** D-2 (ver aviso acima). D-3 — comparação do webhook
secret trocada por `crypto.timingSafeEqual` (constant-time). D-4 —
`secret` descartado antes de persistir o evento do webhook (não fica
mais em texto puro em `tradingviewWebhookEvents`). D-5 — comentário de
`firestore.rules` corrigido (não descreve mais uma Cloud Function
inexistente). D-6 — `ALLOWED_ORIGIN` ausente em produção agora derruba o
boot (`process.exit(1)`) em vez de só avisar e seguir com CORS `'*'`,
mesmo padrão já usado pros outros secrets obrigatórios do arquivo.

**Build/CI (4):** E-1 — 3 flags (`preTp1StopProtectionEnabled`/
`AtrMult`, `candlePatternEnabled`) que faltavam em
`scripts/backtestPineConfig.js` DEFAULTS, quebrando a convenção "mantenha
espelhado à mão" do próprio arquivo — adicionadas, puramente aditivo.
E-2 — `ci.yml` ganha `timeout-minutes: 15` + `concurrency` com
`cancel-in-progress: true` (cancela run obsoleto do mesmo PR/branch,
diferente dos workflows agendados que enfileiram). E-3 —
`deploy-firestore.yml` ganha `timeout-minutes: 5`. E-4 — comentário sobre
`rf1hCondEnabled` em `pineParser.js`/`adminPineConfig.js` corrigido (apontava
pro tripwire errado, `scannerStateMachine.test.js` em vez de
`rf1hCondTripwire.test.js`).

### Conclusão

`npm run lint && npm test && npm run build && npm run typecheck` — todos
limpos (932/932 testes, sem regressão de nenhum dos 40 arquivos de teste;
lint e typecheck sem erro; build sem regressão de tamanho). Nenhum teste
novo de regressão nesta rodada — os 17 fixes são todos correções
estruturais/de contrato sem lógica nova complexa o bastante pra justificar
um teste dedicado (confirmado pelo agente Plan: nenhum teste existente
quebra, incluindo o único mock de `transitionTradeOp` em
`scannerStateMachine.test.js`, que stuba a função inteira sem checar
argumentos). Os 25 achados do item 80 estão todos corrigidos, exceto A-4/A-5
(acessibilidade — modal do AssetDrawer sem foco/Esc/aria, inputs sem foco
visível), que não estavam no escopo desta rodada nem da anterior.

### Próximo passo (fora deste registro)

Usuário promover seu uid pra `role: 'admin'` no console do Firebase (ver
aviso acima) pra continuar usando o botão de backtest. A-4/A-5 seguem sem
data definida.

---

## 83. Correção de A-4/A-5 — fecha os 25 achados do item 80 (2026-08-13)

### Contexto

Usuário confirmou que A-4/A-5 eram os únicos achados restantes da
varredura completa (item 80) e pediu pra terminar. Últimos 2 dos 25
achados originais.

### Achado (correções aplicadas)

**A-4** — `src/components/dashboard/AssetDrawer.jsx` migrado do modal
caseiro (dois `<div>` fixos, sem foco/Esc/`aria-modal`) pro componente
`Sheet` (`src/components/ui/sheet.jsx`, Radix Dialog por baixo) — já
existia no repo, importado por ninguém. Ganha foco automático, fechamento
por Esc e `aria-modal` de graça, sem reescrever o conteúdo (só a casca:
`Sheet`/`SheetContent`/`SheetHeader`/`SheetTitle` substituindo os `<div>`s
manuais; o `<button>` de fechar customizado foi removido — o `SheetContent`
já inclui um botão de fechar acessível próprio).

**Achado colateral do próprio processo de verificação**: migrar pra
`Sheet` expôs 8 erros de `typecheck` que não apareciam antes —
`src/components/ui/sheet.jsx` está em `jsconfig.json`'s `exclude`
(pasta `ui/` inteira, convenção deste projeto pros componentes
shadcn gerados), mas `exclude` só impede o arquivo de ser descoberto como
raiz — não impede o `tsc` de checá-lo quando importado por um arquivo
incluído (`AssetDrawer.jsx`). Como nada importava `sheet.jsx` antes, essa
lacuna de tipagem (faltavam as anotações JSDoc `@param
{React.ComponentPropsWithoutRef<typeof X>}` que o `dialog.jsx` gêmeo —
mesmo Radix Dialog por baixo — já tinha corretamente) nunca tinha sido
exercitada. Corrigido copiando o mesmo padrão de anotação de
`dialog.jsx` pros 6 componentes de `sheet.jsx` (`SheetOverlay`,
`SheetContent`, `SheetHeader`, `SheetFooter`, `SheetTitle`,
`SheetDescription`) — `typecheck` volta a 0 erros.

**A-5** — 7 ocorrências de `outline-none` sem substituto de foco visível
(`Dashboard.jsx` ×3, `Assets.jsx`, `Logs.jsx` ×2, `PineScript.jsx`)
ganham `focus-visible:ring-1 focus-visible:ring-ring`, mesmo padrão já
usado em `ui/button.jsx`/`ui/input.jsx`.

### Verificação

`npm run lint && npm test && npm run build && npm run typecheck` — todos
limpos (932/932 testes, build sem regressão de tamanho, typecheck 0
erros incluindo o `sheet.jsx` agora tipado corretamente).

**Limitação desta verificação, registrada com honestidade**: tentei subir
`npm run dev` e clicar de verdade num `AssetCard` pra abrir o
`AssetDrawer` (prática padrão pra mudança de UI), usando Playwright
headless contra o servidor local. A tela renderizada ficou **em branco**
— `Firebase: Error (auth/invalid-api-key)` — porque este ambiente
sandboxed não tem as credenciais reais do Firebase (`VITE_FIREBASE_API_KEY`
etc. são secrets só do Render, não existem aqui). Isso acontece em
QUALQUER página do app neste ambiente, não é específico desta mudança —
não consigo testar clique-a-clique aqui. A confiança nesta correção vem
de: build/typecheck/lint limpos (confirmam que os imports/tipos resolvem
de verdade), leitura cuidadosa da API do Radix Dialog/`cn`+`twMerge`
(confirmando que as classes Tailwind do `Sheet` sobrescrevem
corretamente as do componente original sem conflito), e o padrão já
comprovado em produção no `dialog.jsx` gêmeo. Recomendo ao usuário
conferir visualmente (clicar num ativo no Dashboard) na primeira
oportunidade depois do deploy.

### Conclusão

Os 25 achados do item 80 (varredura completa de 2026-08-13) estão todos
corrigidos: 8 P1 (item 81), 12 P2 + 5 Info (item 82), A-4/A-5 (este
item). Nenhum achado da varredura original segue pendente.

### Próximo passo (fora deste registro)

Nenhum — varredura do item 80 encerrada. Usuário ainda precisa promover
seu uid pra `role: 'admin'` (item 82, D-2) e conferir visualmente o
`AssetDrawer` no primeiro uso pós-deploy (ver limitação de verificação
acima).

## 84. Curva de equity real (conta virtual, capital+drawdown compostos) (2026-08-14)

### Contexto

Uma análise externa (outra IA, com acesso de leitura ao repo) apontou que
a "curva de equity" exibida hoje no relatório de Backtest
(`overall.cumulativePct`, `src/lib/tradeMetrics.js` `summarizeOps`) é uma
soma percentual ingênua — `cumulativePct += pnlPct` por operação fechada,
sem dimensionamento de posição por risco nem composição de capital.
Verifiquei lendo o código real: é fato, não exagero — o `maxDrawdownPct`
reportado também deriva dessa mesma soma, então nunca foi um drawdown de
conta genuíno. O usuário pediu para implementar isso com "a importância
que deve ter pra que fique perfeito", junto com o teste do endpoint de
arquivo histórico Futures (item 47.2, PR separado). Perguntado via
`AskUserQuestion`, escolheu: capital inicial **$1.000**, risco **1% do
capital corrente por operação**, escopo **Backtest + painel ao vivo**.

### Achado-chave (simplifica o desenho)

`calcRealizedR(op, costModel)` (já exportada, `tradeMetrics.js:259-264`)
já desconta custo (via `calcRealizedDelta`, chokepoint único, item 44) e
já pondera TP1+runner (via `getWeights`) — devolve o resultado em R
(risco = `|entry_price - initial_stop|`). Com dimensionamento de posição
por risco fixo, o PnL em dólar de qualquer operação fechada é, por
construção algébrica:

```
pnlDollars = R × (capitalCorrente × risco%)
```

Vale mesmo com custo aplicado (R já é líquido). A curva de capital real
não precisa recalcular preço de TP1, pesos nem custo — só chama
`calcRealizedR` (já pública) e faz duas multiplicações por operação.

### Implementação

**Novo módulo `src/lib/equityCurve.js`** — separado de `tradeMetrics.js`
(mesmo padrão de `backtestAnalysis.js`: importa só API pública, zero
linha mudada no módulo mais crítico/mais testado do projeto).
`simulateEquityCurve(ops, { initialCapital=1000, riskPct=1, costModel,
epsilonR, epsilonPct, sortBy })` — ordena por `closed_at` (mesma
convenção de `summarizeOps`), compõe capital sequencialmente sobre um
único pool. Operação sem `initial_stop` válido (R null) fica
`sized:false, reason:'unsized_no_r'`, capital inalterado — nunca inventa
dimensionamento. Se o capital cai a `<= 0`, trava em 0
(`accountBlown:true`) e as operações seguintes ficam
`sized:false, reason:'account_blown'` — comportamento de conta
liquidada. Devolve também `maxDrawdownAbs`/`maxDrawdownPct` (reais, sobre
o pico de capital), `totalReturnPct`, `cagrPct` (com
`cagrUnavailableReason` — `window_too_short`/`no_time_range`/
`account_blown`/`non_positive_final_capital` — nunca extrapola CAGR de
amostra inutilizável) e o array `curve` por operação.

**Limitação documentada no cabeçalho do módulo, não escondida**: o laço
assume um único pool de capital disputado sequencialmente por ordem de
fechamento — não modela posições concorrentes (o sistema real roda
vários ativos monitorados ao mesmo tempo, com operações sobrepostas no
tempo). Mesma simplificação que `summarizeOps.cumulativePct` já fazia.
Alocação de capital para posições sobrepostas ficou fora de escopo.

**`src/pages/Backtest.jsx`**: título da curva ingênua existente
(`ReportBody`, `overall.curve`) trocado para "Curva ingênua (soma %
simples, NÃO composta — ver curva de capital real abaixo)" — zero mudança
de cálculo, só deixa a natureza dela explícita (antes enganava por
omissão). Nova seção "Curva de capital real (composta, position sizing
por risco)" com inputs de capital inicial/risco por operação (o mesmo
`Slider` já usado em `QuickBacktestTab`), 4 cards (Capital Final, Drawdown
Real, CAGR, Operações Dimensionadas), badge "CONTA ZERADA" quando
aplicável, e um `LineChart` do capital em USD. Reusa o mesmo `costModel`
que o relatório já usou (`report.costs?.model`) — não diverge do
`expectancyR` já exibido — e o aviso "RESULTADO INCONCLUSIVO" existente
(amostra pequena/IC cruza zero, mesmo gate do item 44) agora também cobre
a curva real, sem construir uma segunda máquina de IC95%.
`PortfolioVsMarket.jsx` ficou **fora** desta rodada — problema correlato
(soma % vs benchmark que compõe) mas de modelagem diferente (capital
todo alocado por trade, não risco por trade) — decisão separada, não
implementada. **Atualização (2026-08-14, item 87)**: implementado numa
rodada seguinte, a pedido do usuário.

**Painel ao vivo**: novo componente `src/components/dashboard/
VirtualAccountCard.jsx` (mesmo padrão visual de `MetricCard` que
`PerformanceMetricsBar.jsx` já usa), com query PRÓPRIA
(`['trade-operations-closed-all']`, `list('-created_date', 500)` — mesmo
padrão de limite maior já usado por `MonthlyReport.jsx:71`) em vez de
reaproveitar a query de 100 operações que `PerformanceMetricsBar`/
`PerformanceOverview` já usam — para não mudar o comportamento desses
widgets existentes. Mostra Capital Atual, Retorno Total % e Drawdown
Real %, com os defaults do usuário ($1.000/1%). Posicionado em
`Dashboard.jsx` entre `PerformanceOverview` e `CorrelationWidget` (mesma
"zona de performance" já existente na página).

### Testes

`src/lib/equityCurve.test.js` (15 testes novos, convenção de
`tradeMetrics.test.js` — fixture `makeOp()`, `ZERO_COST` explícito,
conta manual em cada assert): dimensionamento simples, composição
passo a passo ao longo de várias operações, drawdown real divergindo do
ingênuo num cenário construído a propósito (ganho grande cedo infla o
pico — medido: ingênuo 15% vs real ≈2,97%), conta zerada (gap through do
stop com risco 100%), TP1+runner (reusa os mesmos cenários de
`tradeMetrics.test.js`), operação sem `initial_stop`, CAGR indisponível
(janela curta) vs disponível (~1 ano), validação de entrada
(`initialCapital`/`riskPct` fora de faixa lançam), custo aplicado por
padrão, lista vazia/só operações abertas.

### Verificação

`npm run lint && npm test && npm run build && npm run typecheck` — todos
limpos (947/947 testes = 932 anteriores + 15 novos, 0 erros de
typecheck, build sem regressão). Confirmado por grep que
`equityCurve.js`/`VirtualAccountCard.jsx` não vazam para o bundle do scan
(`scripts/dist/run-scan.mjs`, isolamento esbuild) — são consumidos só por
páginas/componentes React, nunca por `scanner.js`.

**Não verificado nesta rodada** (mesma limitação de sempre neste
ambiente sandboxed, sem credenciais reais do Firebase): teste visual no
browser do novo card no Dashboard e da nova seção no Backtest. Recomendo
ao usuário conferir visualmente após o deploy — especialmente o slider de
risco no Backtest (1%→5%) e o comportamento do card "Conta Virtual" com
o histórico real de operações fechadas.

### Conclusão

Os dois passos concretos pedidos pelo usuário (teste do endpoint de
arquivo histórico Futures — item 47.2 — e esta curva de equity real)
estão implementados. A curva real fica lado a lado com a ingênua
(aditivo, não substitui), reusa o chokepoint de custo/TP1-runner já
existente sem duplicar lógica, e aparece tanto no Backtest quanto no
painel ao vivo, conforme decisão explícita do usuário. O teste do
endpoint Futures em si ficou bloqueado — ver item 85.

## 85. Teste do endpoint de arquivo histórico Futures — bloqueado por permissão (2026-08-14)

### Contexto

Depois do merge do PR #185 (`spike-futures-archive-check.yml`, item 47.2),
tentei disparar o workflow via `mcp__github__actions_run_trigger`
(`method: run_workflow`) contra `main`, tanto pelo nome do arquivo
(`spike-futures-archive-check.yml`) quanto pelo ID numérico
(`334249404`, confirmado existente e `state: active` via
`actions_list.list_workflows`).

### Achado

As duas tentativas retornaram o mesmo erro:

```
403 Resource not accessible by integration []
```

Mesmo bloqueio que a sessão original do item 47.2 já tinha documentado —
o token/integração do GitHub usado por esta sessão não tem o escopo
necessário pra disparar `workflow_dispatch` via API, independente do
workflow ter (ou não) `state: active`, e independente de eu estar
chamando pelo nome do arquivo ou pelo ID numérico. Não é um problema do
workflow em si (o YAML está correto, ativo, visível na listagem) — é uma
restrição de permissão da integração GitHub App conectada a esta sessão,
fora do meu controle.

### Conclusão

**Não corrigível de dentro de uma sessão do Claude Code com esse mesmo
nível de acesso.** O erro "Resource not accessible by integration"
confirma que a conexão é via **GitHub App**, não um token OAuth pessoal —
GitHub Apps não têm "escopo" no sentido OAuth; o que falta é a
**permissão de repositório "Actions: write"** na instalação do App
(distinta de "Contents"/"Pull requests", que já funcionam — só
`workflows` dispatch exige `write` em Actions, ver [docs REST do
GitHub](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)).
O workflow `spike-futures-archive-check.yml` continua no repositório,
pronto pra disparar — só falta alguém com permissão disparar manualmente
pela interface do GitHub (aba **Actions** → "Spike — Futures historical
archive reachability (temporary)" → botão **Run workflow**) ou o
administrador da instalação do GitHub App habilitar "Actions: write" nas
permissões do repositório para sessões futuras conseguirem disparar via
API.

### Próximo passo

**[SUPERADO — ver item 86]** O usuário disparou manualmente pela UI do
GitHub no mesmo dia e colou o resultado; o workflow já foi removido do
repositório (cumpriu seu propósito) e o resultado real está registrado
no item 86, não aqui. Esta seção fica só como registro histórico do que
era o plano no momento em que este item foi escrito — não reflete mais o
estado atual do repositório (o arquivo `spike-futures-archive-check.yml`
não existe mais).

## 86. Arquivo histórico Futures da Binance — ACESSÍVEL, não bloqueado (2026-08-14)

### Contexto

Usuário disparou manualmente `spike-futures-archive-check.yml` pela UI do
GitHub (Actions → Run workflow) — o passo que ficou bloqueado no item 85
por falta de permissão da integração desta sessão. Colou o log completo
do job.

### Achado (FATO, log real do runner `ubuntu-24.04`, região `eastus` — mesma
rede dos runners de `scan.yml`/`backtest.yml`)

Os dois `curl -I` retornaram **HTTP/2 200**:

```
--- BTCUSDT 1h Jan/2024 (Futures USD-M monthly klines) ---
HTTP/2 200
content-type: binary/octet-stream
content-length: 38890
last-modified: Sun, 18 Feb 2024 13:55:42 GMT
server: AmazonS3 (via CloudFront)

--- Same host, Spot equivalent (control) ---
HTTP/2 200
content-type: application/zip
content-length: 43482
last-modified: Mon, 05 Feb 2024 12:06:34 GMT
server: AmazonS3 (via CloudFront)
```

`data.binance.vision` (CDN estático via CloudFront/S3, arquivo em lote
histórico) **não está sujeito ao mesmo bloqueio 451 por IP de datacenter
dos EUA** que afeta `fapi.binance.com` (API de trading Futures AO VIVO,
item 4) — confirma a hipótese do item 47.2: são dois serviços distintos
da Binance, com políticas de bloqueio independentes.

### Ressalvas importantes (não deixar o achado "vender mais do que é")

1. **Não afeta o scan ao vivo.** O arquivo é histórico/em lote —
   `last-modified` de fevereiro de 2024 pro arquivo de janeiro/2024,
   típico de arquivo mensal fechado (atualizado uma vez, dias depois do
   fim do mês, não em tempo real). Não serve pra substituir
   `fapi.binance.com` no scanner ao vivo, que precisa do candle mais
   recente possível. A divergência painel(Futures)/cron(Spot) ao vivo
   (item 4) **continua exatamente como estava** — este achado não a
   resolve.
2. **Só abre uma opção pro BACKTEST.** Hoje `scripts/fetch-backtest-data.mjs`
   baixa histórico de `data-api.binance.vision` (API REST Spot, formato
   JSON) — um serviço diferente deste (que serve arquivos `.zip`
   contendo CSV, formato de arquivo em lote, não API REST). Trocar a
   fonte do backtest pra usar Futures de verdade exigiria **reescrever**
   esse script pra baixar/descompactar/parsear o formato de arquivo em
   lote (ZIP→CSV) em vez de chamar uma API REST — não é troca de URL,
   é um pipeline de dado diferente.
3. **Decisão de produto, não implementada.** Faria o backtest refletir
   melhor o que o painel ao vivo veria (Futures, não Spot) — mas é
   trabalho real de engenharia, com trade-offs próprios (arquivos
   mensais/diários têm lag de disponibilização, cobertura de símbolos
   pode variar). Não implementar sem pedido explícito do usuário.

### Conclusão

Item 47.2 fechado: o arquivo histórico de Futures da Binance é
**acessível** a partir de runners do GitHub Actions (mesma rede do
`scan.yml`/`backtest.yml`). Isso NÃO muda a decisão aceita do item 4
(divergência ao vivo permanece), mas registra uma opção real e nunca
antes confirmada: um backtest futuro poderia usar dado histórico de
Futures em vez de Spot, se o usuário decidir que vale o esforço de
reescrever o pipeline de download.

### Próximo passo

Nenhum implementado agora — decisão do usuário se/quando quiser buscar
essa opção. O workflow temporário `spike-futures-archive-check.yml`
cumpriu seu propósito (responder a pergunta binária "dá pra acessar ou
não") e foi removido neste mesmo commit — o resultado fica registrado
aqui, não precisa do workflow permanecer no repositório.

## 87. `PortfolioVsMarket.jsx` — curva da carteira agora composta (2026-08-14)

### Contexto

Item 84 (curva de equity real) deixou `PortfolioVsMarket.jsx` fora de
propósito — problema correlato, modelagem diferente (aqui não é
dimensionamento por risco, é "100% do capital realocado por trade",
comparável a um benchmark de mercado). Usuário pediu explicitamente pra
fechar essa pendência.

### Achado (confirmado lendo o código antes de mudar)

`calcPortfolioCurve` (`PortfolioVsMarket.jsx`) usava
`summarizeOps(trades).curve` → `cumulativePct`, a MESMA soma percentual
ingênua do item 84 (`cumulativePct += pnlPct`, sem compor). O benchmark
de mercado ao lado (`src/lib/marketBenchmarks.js`) já é uma curva
composta por natureza — BTC usa `((close - basePrice) / basePrice) *
100` (retorno de preço, inerentemente composto ano a ano) e CDI/Selic/
IPCA usam juros compostos explícitos (`marketBenchmarks.js:53-60`,
comentário do próprio arquivo já dizia isso). Resultado: o rótulo
"Superando"/"Atrás" comparava uma soma ingênua contra uma curva
composta — o veredito podia estar errado por um artefato de composição,
não por desempenho real.

### Correção

Nova função `compoundReturnCurve` em `src/lib/equityCurve.js` (mesmo
módulo do item 84, adição pura — zero linha mudada em `tradeMetrics.js`
de novo): compõe um fator multiplicativo (`factor *= 1 + pnlPct/100`)
por operação fechada, sem dimensionamento por risco (sem
`initial_stop`, sem R, sem unidades) — só o `pnlPct` bruto de cada
trade, já líquido de custo via `calcRealizedPnlPct` (mesmo chokepoint).
Devolve o MESMO formato de `summarizeOps().curve`
(`{ op, outcome, pnlPct, cumulativePct }`), então a troca em
`PortfolioVsMarket.jsx` foi de uma linha (`summarizeOps(trades).curve` →
`compoundReturnCurve(trades)`), sem tocar o resto do componente
(merge com benchmark, tooltip, resumo). Adicionado um subtítulo no
cabeçalho do card deixando explícito que a curva compõe, mesmo padrão de
honestidade já usado no Backtest (item 84).

Limitação herdada do item 84, documentada no cabeçalho do módulo: um
único pool de capital sequencial, sem modelar posições simultâneas em
vários ativos.

### Testes

6 casos novos em `equityCurve.test.js` (total 21 no arquivo): 1
operação (cumulativePct = pnlPct dela), composição multiplicativa
divergindo da soma ingênua num cenário construído a propósito
(+11,25% então -5% → +5,6875% composto vs +6,25% soma, confirmado
contra `summarizeOps(...).totalPnlPct`), operação sem `pnlPct`
computável (cumulativePct não muda), custo aplicado por padrão, lista
vazia, e formato de saída idêntico ao de `summarizeOps().curve`.

### Verificação

`npm run lint && npm test && npm run build && npm run typecheck` —
todos limpos (953/953 testes = 947 anteriores + 6 novos, 0 erros de
typecheck, build sem regressão). Confirmado por grep que
`equityCurve.js` continua ausente do bundle do scan
(`scripts/dist/run-scan.mjs`).

**Não verificado nesta rodada** (mesma limitação do ambiente sandboxed
de sempre): teste visual do card "Carteira vs Mercado" no browser real.
Recomendo conferir depois do deploy, comparando o rótulo "Superando"/
"Atrás" antes/depois se possível.

### Conclusão

Item 6 da lista de pendências fica fechado — `PortfolioVsMarket.jsx`
agora compõe a curva da carteira, comparável de verdade com qualquer um
dos 4 benchmarks (BTC/CDI/Selic/IPCA), todos compostos por natureza.

## 88. Bloco 0 / item 48 — critério revisado: BUY e SELL como hipóteses separadas (2026-08-15)

### Contexto

O item 48 rodou o critério de decisão pré-registrado do Bloco 0
(`docs/roadmap.md`) com três desfechos possíveis, e nenhum bateu: a janela
de alta veio com BUY **e** SELL positivos (derruba o cenário "puramente
direcional"), mas a janela de baixa continua líquida negativa mesmo que
estatisticamente inconclusiva (derruba "positivo nas duas janelas"). O
`roadmap.md` registrou isso como decisão em aberto — "fica em aberto até o
usuário decidir como interpretar a ambiguidade" (Bloco 0). Esta entrada
resolve essa pendência, a pedido do usuário, depois de uma auditoria externa
de um relatório de backtest que reabriu a pergunta.

### Achado

Olhando as 5 medições já feitas até hoje (3 janelas de regime + 2
reprocessamentos controlados, ver item 48), o padrão real é **assimétrico
entre os lados**, não simétrico como o critério original assumia:

- **SELL**: positivo nas 5 de 5 medições (0,147R a 0,401R), atravessando 3
  regimes de mercado e 2 composições de carteira diferentes.
- **BUY**: acompanha o regime — positivo na janela de alta, negativo (mas
  estatisticamente inconclusivo, IC cruza zero) na janela de baixa.

O critério original tratava BUY/SELL como um par único ("direcional puro"
vs. "vantagem independente de regime nas duas pernas"), então não tinha
categoria para esse padrão assimétrico — por isso nenhum dos três desfechos
pré-registrados bateu exatamente.

### Critério revisado

- BUY e SELL passam a ser avaliados como **hipóteses separadas**, não como
  par binário.
- **BUY**: aceito formalmente como regime-dependente — mesmo tratamento já
  dado à divergência Futures×Spot (item 4): deixa de ser "risco pendente" e
  vira limitação/comportamento aceito, enquanto ninguém propuser e testar um
  filtro de regime específico à parte (ex.: condicionar compra ao alinhamento
  de tendência 1D). Não desbloqueia nada por si só.
- **SELL**: candidato a edge genuíno, mas **ainda não confirmado** — o
  teste out-of-sample do item 71 (holdout n=150) não confirmou a hipótese
  SELL-only isoladamente (IC cruzou zero), e o próprio item 71 já se encerrou
  dizendo que reabrir a linha "exigiria evidência nova (ex. mais anos de
  holdout, símbolos adicionais), não mais reanálise dos mesmos dados". Antes
  de qualquer mudança de produto (ligar `allowedSide: SELL` de verdade em
  produção), exigir que uma **próxima medição**, numa janela genuinamente
  nova — não sobreposta a nenhuma das janelas já usadas em qualquer medição
  de SELL até hoje (item 48: 2023-07→2024-07, 2024-07→2025-07,
  2025-07→2026-07; item 71: 2024-08-10→2025-08-10, 2025-08-09→2026-08-09,
  2025-08-10→2026-08-10) — se sustente sob o IC corrigido por família de
  comparações múltiplas (ver item 89).
- **Bloco 1** (os 4 flags dormentes) continua trancado — agora por esse
  motivo específico e testável, não por "ambiguidade" genérica.

### Correção (2026-08-15, review externa Codex, PR #189 e PR #190)

A primeira versão deste item estimava a família "hipótese SELL-only" em
"N≥6", mas o ledger do item 89 nasceu vazio — rodar a próxima medição sem
mais nada teria calculado N=1 (z=1,96) em vez do N real, exatamente o erro
que a correção deveria evitar. Corrigido em duas rodadas (PR #189, depois
PR #190 ao achar mais 4 medições que a 1ª varredura tinha perdido — itens
56 e 74, ver "Próximo passo" abaixo): as **12 medições de SELL** já
publicadas neste projeto foram semeadas no ledger via
`backtest-trial-registry.mjs --seed` (ver item 89) — a família
`sell-only-hypothesis` está hoje em **N=12** (z=2,8653), então a próxima
medição fará N=13. Nem todas as 12 têm IC95 publicado — essas ainda contam
para o TAMANHO da família (é mais uma vez que a hipótese foi olhada), só
não contribuem um IC corrigido próprio. Efeito prático de sair de N=8 para
N=12: até a medição mais forte já registrada (item 71, n=159, +0,271R)
deixa de sobreviver ao IC corrigido pela família inteira (`[-0,006;
0,548]` — cruza zero).

**Ressalva de honestidade que a correção acima não resolve**: várias dessas
12 medições vêm de janelas fortemente sobrepostas (ex. as 3 leituras da
mesma janela de baixa 2025-26, ou as 2 leituras quase idênticas da janela
de alta 2024-25) — Bonferroni assume comparações independentes, e
comparações sobre dado correlacionado violam essa suposição na direção
"correção conservadora demais", não "liberal demais". Preferível a
subestimar o N (que seria liberal demais na direção perigosa), mas não é
rigor estatístico formal — outra decisão de julgamento humano que o script
não resolve por você.

### Próximo passo — PAUSADO (2026-08-15, decisão do usuário)

Checagem antes de rodar o trial de SELL-only revelou que **não existe hoje
uma janela de 12 meses genuinamente livre de sobreposição** com as já
usadas em qualquer medição de SELL. **Correção (2026-08-15, review externa
Codex, PR #190): o inventário original desta seção esquecia duas linhas de
investigação inteiras** — item 56 já rodou `2022-07-27→2023-07-27` (7
símbolos, run de controle só cascata nativa) e mediu SELL (n=30, +0,230R,
ver seção "Braço exploratório — backtest retrospectivo pré-2023"); item 74
já rodou as 3 janelas do Bloco 0 de novo, mas com **LTCUSDT/DOGEUSDT** — os
únicos 2 símbolos confirmados fora da carteira já testada — e também mediu
SELL nas 3 (n=16/10/17, todas com IC cruzando zero, amostra pequena demais
pra confirmar ou refutar qualquer coisa).

**As janelas de calendário já consumidas, contíguas sem buraco**:

`2022-07-27→2023-07-27`, `2023-07-27→2024-07-27`, `2024-07-27→2025-07-27`,
`2024-08-10→2025-08-10`, `2025-07-27→2026-07-27`, `2025-08-09→2026-08-09`,
`2025-08-10→2026-08-10` — cobrem 2022-07-27 até 2026-08-10 sem lacuna.

**Mas "janela nova" não é a única forma de dado genuinamente novo** — o
item 74 já demonstrou o caminho alternativo: **símbolos nunca testados**,
mesmo em janelas de calendário já usadas, também contam como não sobrepostos
(o motor nunca viu aquele par ativo×janela antes). O problema é que os
únicos 2 símbolos confirmados fora da carteira (LTC/DOGE) já foram gastos
nessa tentativa — item 74 terminou inconclusivo por amostra pequena (só
~26-38 operações/janela com 2 símbolos, contra 288-344 com a carteira de
20) e recomendou explicitamente "ampliar o walk-forward com mais símbolos
novos" como o próximo passo real, não decidido até hoje.

Voltar a antes de 2022-07-27 (a outra alternativa) reabriria a
incompatibilidade de regime (2021-2022, ciclo de alta seguido do colapso
Luna/FTX) e o problema de ativos faltantes que o `roadmap.md` já descartou
por outro motivo.

**A próxima janela de CALENDÁRIO sem sobreposição só pode COMEÇAR em
2026-08-10 ou depois e, sendo 12 meses, só fecha por volta de 2027-08-10** —
quase um ano a
partir de hoje (2026-08-15), não "alguns meses" como a versão anterior deste
texto dizia (achado do Codex review, PR #190: essa imprecisão podia induzir
alguém a rodar cedo demais, violando o próprio critério de janela sem
sobreposição).

**Decisão do usuário**: pausar esta linha de investigação por enquanto — não
rodar em janela sobreposta, nem pré-2022, nem ampliar o walk-forward de
símbolos novos agora. Duas formas válidas de retomar, nenhuma escolhida
ainda: esperar o histórico ao vivo alcançar 2027-08-10 (janela de calendário
nova), ou encontrar/confirmar símbolos adicionais fora da carteira já
testada e repetir a metodologia do item 74 com mais poder estatístico que
2 símbolos permitem. `docs/roadmap.md` atualizado no mesmo commit para
refletir este critério e a pausa.

## 89. Registro de trials com correção Bonferroni automática (2026-08-15)

### Contexto

Motivado pela mesma auditoria externa do item 88: toda vez que este projeto
já aplicou correção de comparação múltipla (itens 45.9, 56, 68), o N da
família de hipóteses foi decidido manualmente por um humano lendo o
histórico do `known-risks.md`, e uma vez (item 68) a correção foi
simplesmente esquecida na primeira versão do relatório — só corrigida depois
por uma review externa (Codex, PR mencionado no próprio item 68). Não existia
nenhum mecanismo — contador, tabela, registro — que soubesse quantos trials
já competiam pela mesma pergunta.

### O que foi construído

`scripts/backtest-trial-registry.mjs` (CLI Node, sem dependência nova) +
`docs/backtest-trial-registry.json` (ledger append-only, versionado no
repo — não é `scripts/dist/`, não é gitignored):

- `--report <path> --family <nome>`: lê o `backtest-report.json` de um run
  do `backtest.yml` (usa os campos já existentes `trialLabel`,
  `reproducibility`, `costs.{netExpectancyR,expectancyRCI95,countedTrades,
  conclusive}` — nenhuma mudança em `backtestEngine.js`/`tradeMetrics.js` foi
  necessária, o `stdErr` é recuperado a partir do próprio IC95 publicado) e
  acrescenta um registro ao ledger. Recusa duplicar o mesmo `trialLabel` na
  mesma família.
- `--summarize-family <nome>`: para todos os trials daquela família, aplica
  correção Bonferroni (`z` calculado por inversa exata da CDF normal —
  aproximação racional de Acklam, não tabela hardcoded — para
  `alpha=0.05/N`, N=tamanho da família) e imprime uma tabela markdown com o
  IC original (z=1,96, o que cada relatório isolado já mostra) lado a lado
  com o IC corrigido pela família, pronta para colar aqui no
  `known-risks.md`.
- `familySize=1` reproduz exatamente o `z=1,96` já usado em
  `summarizeOps`/`tradeMetrics.js` — a correção é estritamente uma extensão,
  nunca muda o veredito de um trial isolado sem irmãos na família.

### Correções do Codex review (PR #189, ambas aplicadas)

1. **P1 — família nascia vazia mas o item 88 já assumia N≥6.** A 1ª versão
   só sabia registrar trials com `backtest-report.json` de origem — nenhuma
   das medições históricas de SELL (item 48/71) tinha artifact vivo (retenção
   de 30 dias). Rodar a próxima medição de SELL-only calcularia N=1 (z=1,96)
   em vez do N real, tratando um resultado como "corrigido" sem contar as
   tentativas que motivaram a correção — o oposto do propósito deste item.
   Corrigido com um segundo modo, **`--seed`**: registra uma medição já
   publicada em `known-risks.md`, sem artifact, com `source`/`seedSource`
   obrigatório (proveniência auditável até o texto que originou o número) e
   `n`/`expectancyRCI95` aceitando `null` quando o dado publicado não incluiu
   essa informação (conta para o TAMANHO da família mesmo sem contribuir um
   IC corrigido próprio). As **12 medições reais de SELL** já publicadas
   (item 45.9, item 48 ×4, item 71 ×3, item 56, item 74 ×3 — os últimos 4
   achados numa 2ª rodada de review, PR #190, depois que a 1ª varredura
   perdeu duas linhas de investigação inteiras) foram semeadas — família
   `sell-only-hypothesis` em N=12 hoje, não N=1. Detalhe em item 88.
2. **P1 — Bonferroni não devia "resgatar" amostra pequena demais.**
   `summarizeFamily` computava `correctedConclusive` só a partir do IC
   corrigido, ignorando `n`/`minTrades`/o `conclusive` original do relatório
   — um trial reprovado por `sample_too_small` no próprio `summarizeOps`
   podia aparecer como `SIM` aqui, porque alargar o IC não é o mesmo que ter
   amostra suficiente. Nova função `correctedConclusiveVerdict` (testada
   isoladamente, 5 casos incluindo o cenário exato que o Codex apontou):
   `false` assim que qualquer gate reprova, `null` quando falta dado pra
   decidir (nunca assume positivo por omissão — por isso todo registro
   semeado, que não tem `minTrades` conhecido, mostra no máximo `null`/`não`,
   nunca `SIM`), `true` só quando os dois gates passam.

28 testes agora (`backtest-trial-registry.test.mjs`): Acklam contra quantis
conhecidos, Bonferroni N=2≈2,241, seed com/sem CI, `correctedConclusiveVerdict`
isolado, e um teste de regressão específico do achado #1 (família mista
seed+trial novo reflete o N combinado).

### O que isto NÃO resolve

Decidir o que conta como "mesma família de hipótese" continua sendo
julgamento humano — o `--family` é texto livre, do mesmo jeito que
`trial_label` sempre foi. O script garante que, uma vez decidida a família,
a correção nunca fica de fora por esquecimento; não decide a família por
você — nem garante que a varredura inicial de "quais medições já existem"
foi completa (a 1ª varredura desta família perdeu 4 de 12 medições reais,
corrigido só depois de uma 2ª review externa, PR #190). E Bonferroni em si
assume comparações independentes — várias das 12 medições semeadas vêm de
janelas sobrepostas (ver ressalva de honestidade no item 88), o que torna
N=12 conservador demais, não impreciso na direção perigosa.

### Verificação

`npm run lint && npm test && npm run build` — todos limpos após cada rodada
de correção (970/970 → 981/981 com os testes da correção de Bonferroni/
seed; a rodada de PR #190 foi só documentação + dado no ledger, sem
mudança de código, então a contagem de testes não mudou de novo).

### Próximo passo

Usar o registro nos trials desta rodada (runner off, breakeven pré-TP1,
combo, minScore 60, retest) — famílias `exit-runner-fix`,
`entry-score-threshold`, `entry-retest-gate`. O follow-up de SELL-only do
item 88 está PAUSADO (sem janela/símbolo genuinamente novo disponível hoje)
— família `sell-only-hypothesis` fica em N=12 até essa linha ser retomada.

## 90. Rodada de trials pós-auditoria externa: runner/breakeven/minScore/retest (2026-08-15)

### Contexto

Depois do fact-check do relatório externo (achados B/C/E) e das correções
dos itens 88/89, usuário rodou 5 trials via `backtest.yml` — mesma janela
nova para os 5 (`2025-08-15→2026-08-15`, 7 símbolos default, custos
ligados) — cada um registrado no ledger do item 89 por família.

### Resultado — família `exit-runner-fix` (N=3, z corrigido=2,3940)

| trial_label | n | bruto | líquido | custo/op | IC95 original | IC corrigido |
|---|---|---|---|---|---|---|
| `runner-off-baseline` | 102 | +0,124R | **+0,074R** | 0,050R | [-0,156; 0,304] | [-0,207; 0,355] |
| `pretp1-breakeven-baseline` | 112 | +0,087R | +0,045R | 0,043R | [-0,134; 0,224] | [-0,174; 0,264] |
| `runner-off-plus-breakeven-baseline` (combo) | 112 | +0,080R | +0,039R | 0,041R | [-0,133; 0,210] | [-0,171; 0,248] |

Todos os 3 **INCONCLUSIVOS** (IC cruza zero, com e sem correção), mas todos
com ponto estimado positivo — direção consistente com o achado E do
relatório externo (runner devolve lucro) e com o item 46.2 já registrado.
**Achado não previsto**: o combo (runner off + breakeven) rendeu MENOS que
runner off sozinho (+0,039R contra +0,074R), não mais. Amostra pequena
demais (n~102-112) pra distinguir isso de ruído — mas vale registrar que a
soma dos dois consertos não foi simplesmente aditiva nesta janela.

### Resultado — família `entry-score-threshold` (N=1)

| trial_label | n | bruto | líquido | IC95 |
|---|---|---|---|---|
| `minscore-60-baseline` | 154 | **−0,005R** | **−0,054R** | [-0,241; 0,134] |

**INCONCLUSIVO, mas com ponto estimado NEGATIVO** — o oposto do que o
Achado C do relatório externo previa ("score alto = pior entrada, `minScore`
menor deveria capturar entradas melhores"). `minScore: 60` deixou passar
mais 52 operações (154 contra ~102-112 dos outros trials, mesma janela) mas
piorou tanto o bruto quanto o líquido. Não refuta o Achado C com rigor (IC
cruza zero, e o achado original vinha de sub-buckets pequenos por faixa de
score, que já eram um alerta de amostra insuficiente no fact-check) — mas
também não dá nenhum suporte a ele. Ponto contra baixar `minScore` sem mais
evidência.

### Resultado — família `entry-retest-gate` (N=1) — achado qualitativo, não estatístico

| trial_label | n | motivo |
|---|---|---|
| `retest-gate-baseline` | **0** | `sample_too_small` |

**Zero operações na janela inteira. Correção (2026-08-15, review externa
Codex, PR #191): a leitura original citava `entryFunnel.byReason.
retest_pending = 2.050` como se fosse 2.050 sinais distintos travados — 
errado.** `entryFunnel` conta cada AVALIAÇÃO rejeitada, somando a 1ª
passada com todo retry (`backtestEngine.js:990-1002`) — um único sinal
pendente por várias passadas do cron simulado contribui várias entradas.
O relatório tem uma seção dedicada por sinal (`report.retest`, dedupada,
last-write-wins) que é a fonte certa:

| Métrica | Valor |
|---|---|
| Sinais únicos que entraram no gate | **126** |
| Confirmados (preço retestou) | **3** (2,4%) |
| Pendentes no corte do relatório | **123** (97,6%) |
| Avaliações totais (1ª passada + retries) | 2.061 |
| Sinais que tiveram retry | 114 (máx. 18 tentativas) |

**Achado corrigido**: de 126 sinais únicos que passaram pelo gate, só 3
(2,4%) confirmaram o reteste — não é um artefato de contagem, o gate
continua extremamente restritivo na tolerância padrão. Ressalva honesta que
a correção também expõe: "pendente no corte do relatório" não é o mesmo que
"nunca teria confirmado" — alguns desses 123 podem ainda estar dentro da
janela de validade quando a janela de backtest terminou (efeito de borda),
não necessariamente expirados. Mesmo com essa ressalva, 2,4% de confirmação
é baixo o bastante pra sustentar a recomendação original: antes de testar de
novo, valeria afrouxar a tolerância (`retestToleranceAtrMult` > 0,3) — ou
aceitar que o gate fica desligado, já que testar de novo com o mesmo valor
não deve produzir resultado muito diferente.

### Leitura (fato × hipótese × recomendação)

**Fato**: nenhum dos 5 trials produziu resultado estatisticamente
conclusivo — esperado, dado que uma única janela de 12 meses/7 símbolos
(~100-150 operações) não tem poder pra detectar edge menor que ~0,3R (a
mesma matemática que `docs/roadmap.md`, "A regra que ordena tudo: amostra",
já registra).

**Hipótese**: os 3 consertos de saída (runner off, breakeven, combo) têm
ponto estimado positivo, consistente com — mas não prova de — o achado E do
relatório externo. O achado C (score baixo é melhor) não se sustenta nesta
amostra; o ponto estimado foi na direção oposta. O gate de reteste na
tolerância padrão parece impraticável, não só "não testado ainda".

**Recomendação**: nenhuma mudança de config em produção a partir só disto
— amostra insuficiente para qualquer um dos 5. Path adiante mais barato que
esperar mais dado: repetir os mesmos 3 trials de saída numa 2ª janela
(idealmente a alta 2024-25, já caracterizada no item 48) para começar a
formar uma família com correção Bonferroni que tenha chance real de ficar
conclusiva; recalibrar `retestToleranceAtrMult` antes de testar reteste de
novo; não perseguir `minScore` mais baixo sem evidência nova.

### Verificação

Nenhuma mudança de código nesta rodada — só registro dos 5 relatórios no
ledger (`docs/backtest-trial-registry.json`) e esta análise. `npm run lint
&& npm test && npm run build` continuam limpos (981/981, sem alteração de
contagem).

### 2ª janela — alta 2024-25, mesmos 3 trials de saída (2026-08-15)

Seguindo a recomendação acima: os mesmos 3 trials de `exit-runner-fix`
repetidos na janela de alta já caracterizada no item 48
(`2024-07-27→2025-07-27`), mesma carteira de 7 símbolos, só a janela
mudou.

| trial_label | n | bruto | líquido | IC95 (z=1,96) | Conclusivo (z=1,96)? |
|---|---|---|---|---|---|
| `runner-off-alta2024` | 102 | +0,291R | **+0,238R** | **[0,009; 0,467]** | **SIM** |
| `pretp1-breakeven-alta2024` | 114 | +0,164R | +0,119R | [-0,065; 0,303] | não |
| `runner-off-plus-breakeven-alta2024` (combo) | 114 | +0,181R | +0,138R | [-0,046; 0,322] | não |

**`runner-off-alta2024` é o primeiro trial desta família a fechar
CONCLUSIVO isolado** (IC não cruza zero, mesmo padrão de honestidade que o
item 48 usa: um resultado individual conclusivo, não a família toda).

**Família `exit-runner-fix` agora com N=6 (baixa ×3 + alta ×3), correção
Bonferroni z=2,6383**:

| trial_label | líquido | IC95 original | IC corrigido (N=6) | Conclusivo corrigido? |
|---|---|---|---|---|
| `runner-off-baseline` (baixa) | +0,074R | [-0,156; 0,304] | [-0,236; 0,384] | não |
| `pretp1-breakeven-baseline` (baixa) | +0,045R | [-0,134; 0,224] | [-0,196; 0,286] | não |
| `runner-off-plus-breakeven-baseline` (baixa) | +0,039R | [-0,133; 0,210] | [-0,192; 0,270] | não |
| `runner-off-alta2024` | +0,238R | **[0,009; 0,467]** | [-0,070; 0,546] | **não** |
| `pretp1-breakeven-alta2024` | +0,119R | [-0,065; 0,303] | [-0,129; 0,367] | não |
| `runner-off-plus-breakeven-alta2024` | +0,138R | [-0,046; 0,322] | [-0,110; 0,386] | não |

**A correção por família derruba o único conclusivo isolado** —
`runner-off-alta2024` deixa de sobreviver assim que contabiliza os 6 trials
que já competem pela mesma pergunta. Isto é o registro do item 89 fazendo
exatamente o que foi desenhado pra fazer: evitar que um resultado bonito
isolado vire "confirmação" sem contar as tentativas.

### Correção (2026-08-15, review externa Codex, PR #192) — faltava o controle, e existe um que derruba a leitura acima

**A leitura "combinada" original comparava cada variante contra ZERO
(`expectancyRCI95` cruza zero ou não), nunca contra o comportamento padrão
(`runnerEnabled: true`, sem breakeven) — então nenhuma das 6 medições
respondia "isto melhora a estratégia?", só "isto tem expectância diferente
de zero?". Isso por si só já seria uma falha de desenho grave o bastante
pra invalidar a conclusão anterior. Mas o Codex achou algo mais concreto:
**um controle real já existe para a janela de alta**, e ele derruba a
leitura anterior na prática, não só na teoria.

O run `bloco0-alta-7symbols-confound-check` (item 48, "Confound
controlado", 2026-08-04) é EXATAMENTE a mesma janela
(`2024-07-27→2025-07-27`) e a mesma carteira de 7 símbolos, mas com
**pineConfig padrão** (sem nenhum override de saída) — o controle que
faltava:

| Config | n | Líquido |
|---|---|---|
| **Controle (padrão, item 48, 2026-08-04)** | 101 | **+0,250R** |
| `runner-off-alta2024` | 102 | +0,238R |
| `pretp1-breakeven-alta2024` | 114 | +0,119R |
| `runner-off-plus-breakeven-alta2024` (combo) | 114 | +0,138R |

**O controle (config padrão) supera as 3 "correções" nesta janela** —
inclusive `runner-off`, a que eu tinha lido como "a que mais ajuda". Sem
IC publicado para o controle (o item 48 já registrava essa lacuna: "O IC
exato da alta 7-símbolos não foi conferido"), então não dá pra dizer que a
diferença é estatisticamente significativa — mas o ponto estimado inteiro
da narrativa anterior ("runner-off lidera, é a correção mais promissora")
não sobrevive à simples comparação com o que já estava rodando sem
nenhuma mudança.

**Ressalva adicional**: o controle é de 2026-08-04, os 6 trials de
exit-fix são do commit `fd084dc8` (2026-08-15) — se algo mudou no motor
entre essas duas datas (não verificado aqui), a comparação não é
estritamente mesmo-commit. Não invalida o achado — só significa que o
controle certo a usar daqui pra frente é um rodado no MESMO commit dos
trials de tratamento, não um reaproveitado de outra sessão.

### Leitura combinada — corrigida (fato × hipótese × recomendação)

**Fato**: nenhuma das 6 medições de exit-fix tinha um controle pareado até
agora — e o único controle disponível (alta 2024-25, mesma carteira,
2026-08-04) supera as 3 variantes testadas, inclusive a que parecia
melhor. A janela de baixa (2025-08-15→2026-08-15) não tem controle
publicado nenhum — é uma janela nova, nunca rodada com config padrão.

**Hipótese**: a leitura anterior ("runner-off é a correção mais
promissora") era um artefato de comparar contra zero em vez de comparar
contra o que já roda hoje. Não há evidência de que qualquer um dos 3
conserta algo — pode ser que o comportamento padrão já capture a maior
parte do valor nesta janela, ou que a diferença exista mas seja pequena
demais pra aparecer nos ~100-114 operações medidos.

**Recomendação — revisada, substitui a anterior**: não rodar uma 3ª janela
treatment-only (isso preservaria o mesmo confound, é exatamente o que o
Codex apontou). Antes de mais janelas, rodar um **controle pareado**
(pineConfig padrão) no MESMO commit `fd084dc8`, nas MESMAS 2 janelas já
usadas (baixa `2025-08-15→2026-08-15` e alta `2024-07-27→2025-07-27`), e
comparar cada variante contra esse controle específico (`variante −
controle`), não contra zero. Só depois disso decidir se vale uma 3ª
janela.

### Verificação (2ª janela)

Nenhuma mudança de código — 3 relatórios a mais no ledger + esta análise.
`npm run lint && npm test && npm run build` continuam limpos (981/981).

### Controle pareado nas 2 janelas — resultado desta rodada (2026-08-15)

Executada a recomendação da correção acima: 2 runs com `pineConfig` **padrão**
(sem nenhum override), mesmas 2 janelas (`default-control-baixa-new`,
`default-control-alta2024`, família `exit-runner-fix-control` no ledger).
**Correção (2026-08-15, review externa Codex, PR #193): a afirmação
"mesmo commit dos 6 trials de tratamento" era falsa** — os 2 controles são
do commit `519f21e5`, os 3 trials de baixa são do `fd084dc8`, os 3 de alta
são do `bc844e1a`, três commits distintos. Verificado agora (`git diff
--stat` entre os três pares): as diferenças entre eles tocam **só**
`docs/known-risks.md` e `docs/backtest-trial-registry.json` — nenhuma
mudança em `src/lib/`, `scripts/` nem `.github/workflows/backtest.yml`
entre nenhum dos três. Os commits são código-equivalentes pra fins de
backtest (mesmo `scanner.js`/`backtestEngine.js` nos três), mas a
afirmação certa é essa — "código equivalente, verificado" — não "mesmo
commit".

| Janela | Controle (padrão) | n |
|---|---|---|
| Baixa (2025-08-15→2026-08-15) | +0,087R (INCONCLUSIVO) | 100 |
| Alta (2024-07-27→2025-07-27) | **+0,250R (CONCLUSIVO, IC [0,013; 0,487])** | 101 |

O controle da alta bate quase exato com o número já publicado no item 48
(2026-08-04, commit diferente): +0,250R lá, +0,250R aqui, n=101 nos dois —
o achado de 11 dias atrás **replicou** no commit atual, resolvendo a
ressalva de commit da correção anterior.

**As 6 comparações variante-menos-controle, mesma janela cada uma**:

| Variante | Janela | Líquido | Controle | Delta |
|---|---|---|---|---|
| runner-off | baixa | +0,074R | +0,087R | **−0,013R** |
| breakeven | baixa | +0,045R | +0,087R | **−0,042R** |
| combo | baixa | +0,039R | +0,087R | **−0,048R** |
| runner-off | alta | +0,238R | +0,250R | **−0,012R** |
| breakeven | alta | +0,119R | +0,250R | **−0,131R** |
| combo | alta | +0,138R | +0,250R | **−0,112R** |

**As 6 de 6 comparações são negativas.** Nenhuma das 3 variantes bateu o
controle padrão em nenhuma das 2 janelas testadas, em ponto estimado.
`runner-off` é a menos pior das 3 nas duas janelas (delta mais próximo de
zero).

**Correção (2026-08-15, review externa Codex, PR #193): "6 de 6 negativos"
não são 6 confirmações independentes — a leitura original superclaimava
isso.** Três problemas reais na forma como os 6 deltas foram apresentados:
(1) os 3 deltas de cada janela reutilizam o MESMO controle — uma flutuação
de ruído nesse único run de controle move os 3 deltas daquela janela
juntos, na mesma direção, não são 3 eventos independentes; (2) as 2 janelas
não são independentes entre si (mesma lógica de mercado, séries de preço
correlacionadas); (3) o combo é mecanicamente sobreposto às outras 2
variantes (é as duas juntas), não uma 3ª observação livre. Nenhum IC do
delta em si foi calculado.

**O tamanho do delta de `runner-off` importa mais que o sinal**: o
erro-padrão do PRÓPRIO controle (derivado do IC95 publicado) é
**≈0,121R** nas duas janelas — uma ordem de grandeza MAIOR que o delta de
`runner-off` (−0,012R a −0,013R). Isso significa que a diferença entre
`runner-off` e não mexer em nada está muito dentro do ruído do próprio
controle — não dá pra distinguir "ligeiramente pior" de "estatisticamente
idêntico" com este dado. Os deltas de breakeven/combo são maiores
(−0,042R a −0,131R, mais perto da ordem de grandeza do erro-padrão do
controle) mas ainda sem IC próprio calculado.

### Leitura final desta rodada — corrigida (fato × hipótese × recomendação)

**Fato**: com o controle certo, nenhuma das 3 variantes de saída superou o
comportamento padrão em ponto estimado, nas 2 janelas testadas. Mas isso
NÃO é 6 confirmações independentes de que as variantes pioram a
estratégia — é, na melhor leitura, 2 observações de regime (correlacionadas
entre si) com 3 comparações cada (correlacionadas dentro de cada janela
pelo controle compartilhado). Para `runner-off` especificamente, o delta
(~−0,012R) é pequeno demais frente ao erro-padrão do próprio controle
(~0,121R) pra sustentar qualquer afirmação de direção.

**Hipótese**: isto ainda pesa contra o Achado E do relatório externo
("o runner devolve o lucro, tirar ele resolve") — nenhuma variante bateu o
controle em nenhuma janela, então não há evidência A FAVOR de desligar o
runner nestes dados. Mas também não há evidência forte CONTRA — o
resultado correto é "inconclusivo em ambas as direções", não "o oposto do
relatório está provado". Duas leituras possíveis pra por que o item 46.2
(runner custa −0,040R/op) apontava numa direção mais clara: (a) foi medido
diferente — contrafactual DENTRO do mesmo conjunto de operações que
realmente bateram TP1, isolando só a gestão pós-TP1 — enquanto estes 6
trials comparam POPULAÇÕES de operações fechadas diferentes entre si (a
config de saída afeta quantas operações fecham antes do corte do
backtest, não só o R de cada uma); (b) o efeito real do runner pode ser
pequeno ou específico do regime de baixa profunda em que o item 46.2 foi
medido originalmente (mesma ressalva de regime que o item 46.1 já registra
para BUY/SELL).

**Recomendação — revisada, mais cautelosa que a anterior**: não mudar
`runnerEnabled`/`preTp1StopProtectionEnabled` em produção — mas por falta
de evidência em qualquer direção, não porque os dados "provam que piora".
Se a linha for reaberta, dois caminhos tecnicamente corretos, nenhum feito
ainda: (a) recalcular o contrafactual do item 46.2 (só operações que
bateram TP1, fechar 100% ali vs. manter o runner, DENTRO do mesmo conjunto)
nestas 2 janelas novas, que evita o confound de população; ou (b) se
insistir no desenho de trial inteiro, calcular o IC do delta de verdade
(exige os R por operação de ambos os lados, não só o resumo agregado) antes
de reportar qualquer direção como leitura.

### Verificação (controle pareado)

Nenhuma mudança de código — 2 relatórios a mais no ledger
(`docs/backtest-trial-registry.json`, família `exit-runner-fix-control`) +
esta análise. `npm run lint && npm test && npm run build` continuam
limpos (981/981).

### Recálculo do contrafactual do item 46.2, mesmo método, 2 janelas novas (2026-08-15)

A correção anterior apontava dois caminhos: recalcular o contrafactual
original (população pareada, só operações que bateram TP1) ou calcular o
IC do delta dos 6 trials de config inteira. Optamos pelo primeiro — mais
barato (reusa os 2 relatórios de controle já baixados, nenhum trial novo) e
resolve o confound de população que os 6 trials de config carregavam.

`scripts/analyze-backtest.mjs` já implementa exatamente o método do item
46.2 (`src/lib/backtestAnalysis.js:analyzeOps`, usa `calcRAtTp1` de
`tradeMetrics.js` — função dedicada a este contrafactual específico,
existente desde a Fase de custos). Rodado sobre os 2 relatórios de
controle (`default-control-baixa-new`, `default-control-alta2024`, config
padrão, sem overrides):

| Janela | Real (com runner) | 100% no TP1 | Contribuição do runner | Ops c/ TP1 | Melhor fechando no TP1 |
|---|---|---|---|---|---|
| Baixa (nova) | 0,140R | 0,146R | **−0,007R/op (−0,7R total)** | 41 (9 chegaram ao TP2) | 30 de 41 (73%) |
| Alta 2024-25 | 0,305R | 0,303R | **+0,001R/op (+0,1R total)** | 46 (10 chegaram ao TP2) | 28 de 46 (61%) |

**Comparação com o item 46.2 original** (baixa 2025-07→2026-07, 20
símbolos, bear market profundo): contribuição do runner lá foi
**−0,040R/op (−13,9R total)**, com 95 de 121 (78,5%) melhores fechando no
TP1. **Nas 2 janelas novas, o efeito é quase nulo — uma ordem de grandeza
menor** (−0,007R e +0,001R contra −0,040R original).

### Leitura (fato × hipótese × recomendação)

**Fato**: com o método correto (população pareada, mesma pergunta do item
46.2), o runner não custa nada relevante nestas 2 janelas — praticamente
zero na alta, pequeno na baixa. Isto substitui a leitura anterior baseada
nos 6 deltas correlacionados (que era estatisticamente indefensável) por
uma medição limpa e diretamente comparável ao achado original.

**Hipótese, agora com evidência a favor**: a hipótese (b) da correção
anterior se confirma — o achado original de −0,040R/op foi específico do
regime de bear market profundo (BTC −37%, ETH −52%, item 46.1) em que foi
medido, não uma propriedade geral do motor. Em janelas menos extremas
(a atual, mista, e a alta), o runner não tem custo mensurável. Isto está
alinhado com o próprio texto do item 46.2, que já registrava a mesma
ressalva ("mas NUM REGIME SÓ, por isso não virou default").

**Recomendação — fecha esta linha de investigação**: `runnerEnabled:
false` **não tem justificativa nestas 2 janelas** — o efeito que motivou a
proposta (do relatório externo, Achado E) é real mas específico de regime,
não generalizável ao comportamento atual do motor. Não desligar o runner
em produção. Se o regime voltar a ficar tão extremo quanto o de 2025-26
(queda de 37%+ nos majors), vale remedir — até lá, esta linha está
encerrada por falta de efeito, não por falta de dado.

### Verificação (recálculo item 46.2)

Nenhuma mudança de código — só reuso de `scripts/analyze-backtest.mjs`
(já existente, sem alteração) sobre os 2 relatórios já no ledger, e esta
análise. `npm run lint && npm test && npm run build` continuam limpos
(981/981).

### `minScore: 60` na janela de alta (2026-08-15)

Mesma disciplina aplicada ao runner: `minScore: 60` repetido na janela de
alta 2024-25, comparado contra o controle padrão (`minScore: 75`) já
rodado na mesma janela.

| Janela | `minScore: 60` | Controle (`minScore: 75`) | Delta |
|---|---|---|---|
| Baixa (nova) | −0,054R (n=154, stdErr 0,096) | +0,087R (n=100, stdErr 0,121) | −0,141R |
| Alta 2024-25 | +0,087R (n=152, stdErr 0,099) | +0,250R (n=101, stdErr 0,121) | −0,163R |

### Correção (2026-08-16, review externa Codex, PR #195) — "fecha a linha" estava errado, mesmo erro de novo

A 1ª versão desta seção comparava o delta só contra o erro-padrão do
CONTROLE (~0,121R) e concluía que o efeito "passa no teste" — **errado
pela mesma razão que a correção do PR #193 já tinha ensinado, só que
aplicada de forma incompleta**: a VARIANTE (`minScore: 60`) também tem
erro-padrão próprio (0,096R baixa, 0,099R alta), e o teste certo pra saber
se uma DIFERENÇA entre duas amostras é real usa o erro-padrão da
DIFERENÇA — soma em quadratura dos dois lados, não um erro-padrão só:

```
SE_diff = sqrt(SE_variante² + SE_controle²)
z = delta / SE_diff
```

| Janela | Delta | SE_diff | z |
|---|---|---|---|
| Baixa | −0,141R | 0,154R | **−0,91** |
| Alta | −0,163R | 0,156R | **−1,04** |

**Os dois z ficam abaixo de 1,96 — nem no teste mais fraco possível (sem
nenhuma correção de comparação múltipla) a diferença é estatisticamente
distinguível de zero.** A conclusão "fecha esta linha, efeito real
confirmado" da versão anterior não se sustenta — é o mesmo tipo de erro que
os "6 de 6 negativos" do runner já tinham cometido (comparar contra
metade da incerteza relevante), só que desta vez eu mesmo escrevi a régua
certa na correção anterior e ainda assim apliquei ela incompleta aqui.

### Leitura — corrigida (fato × hipótese × recomendação)

**Fato**: `minScore: 60` teve ponto estimado pior que o controle nas 2
janelas (direção consistente), mas a diferença não é estatisticamente
distinguível de zero em nenhuma das duas, pelo teste de duas amostras
independentes. Mesma população não perfeitamente pareada de sempre
(`countedTrades` varia com o `minScore`), então mesmo esse teste é uma
aproximação, não um IC formal do delta real.

**Hipótese**: a direção consistentemente negativa em 2 janelas (mesmo sem
significância formal) ainda pesa levemente CONTRA a proposta do Achado C
do relatório externo ("score menor deveria ajudar") — não confirma que
baixar o score piora, mas também não dá nenhum suporte à ideia de que
ajuda. É o mesmo veredito "sem evidência forte em nenhuma direção" da
linha do runner, não uma contradição forte do relatório como a versão
anterior afirmava.

**Recomendação — revisada**: não baixar `minScore` para 60 em produção,
mas pela mesma razão de sempre (falta de evidência a favor), não porque os
dados "provam que piora". Se alguém quiser uma resposta com significância
de verdade, precisa do IC pareado por operação (mesma limitação já
registrada na correção do PR #193) — comparar médias agregadas com
amostras de tamanho diferente não chega lá, mesmo com o erro-padrão da
diferença calculado corretamente.

### Verificação (`minScore` alta)

Nenhuma mudança de código — 1 relatório a mais no ledger (família
`entry-score-threshold`, agora N=2) + esta análise. `npm run lint && npm
test && npm run build` continuam limpos (981/981).

## 91. `minScore` mais baixo aumenta a taxa de arbitragem cross-side — confound não examinado (2026-08-15)

### Contexto

Ao revisar os 11 relatórios desta sessão em busca de algo que tivesse
passado despercebido, comparei a taxa de operações atingidas por
`arbitration_reason: 'same_cascade_opposite_direction'` (mecanismo do
item 71 — BUY e SELL do mesmo ativo disputam o mesmo slot
`assetActiveOps`; um sinal do lado oposto chegando com operação ativa não
abre 2ª operação, só reduz `current_confidence_score` em 15 pontos) entre
os trials de `minScore=60` e os controles padrão, usando
`scripts/analyze-backtest.mjs` (já existente, sem alteração).

### Achado

| Trial | Ops arbitradas | Taxa | R médio arbitradas | R médio sem arbitragem |
|---|---|---|---|---|
| `minscore-60-baseline` (baixa) | 48/154 | 31% | −0,672R | +0,226R |
| `default-control-baixa-new` | 20/100 | 20% | −0,553R | +0,247R |
| `minscore-60-alta2024` | 37/152 | 24% | −0,483R | +0,271R |
| `default-control-alta2024` | 15/101 | 15% | −0,818R | +0,436R |

### Correção (2026-08-16, review externa Codex, PR #196, dois achados P1/P2)

**1. A taxa de arbitragem NÃO sobe de forma estatisticamente sustentada
nas duas janelas** — a versão original afirmava isso sem calcular
incerteza. Teste de duas proporções (pooled): baixa (48/154 vs 20/100)
`z≈1,96` — bem na fronteira, não passa com folga nem no teste mais fraco
possível; alta (37/152 vs 15/101) `z≈1,83` — **abaixo** de 1,96, não
distinguível de ruído. Rebaixado de "sobe nas duas janelas" para "diferença
observada, sem significância estabelecida em nenhuma das duas".

**2. Mais grave: não existe mecanismo causal ligando arbitragem a
resultado pior — isto era o MESMO erro de causalidade invertida que o
item 45.9 já tinha documentado, e citar o item 45.9 no texto original não
impediu cometer o erro que ele descreve.** Verificado agora, busca
completa no repo: `current_confidence_score` (o único campo que
`reduce_confidence` escreve) é lido em `scanner.js` só para ESCREVER o
próximo valor — **nenhuma lógica de saída, sizing, ou stop em
`opExitRules.js`/`backtestEngine.js`/qualquer componente lê esse campo**.
Ou seja: a arbitragem `same_cascade_opposite_direction` não muda NADA no
destino da operação — é puramente informativa/logada. O sinal oposto
também chega **depois** que a operação já estava aberta, não antes. A
leitura honesta, idêntica à do item 45.9 para o `correction_warning`
irmão: operações que já estão indo mal (preço andando contra a posição)
são **mais prováveis de atrair um sinal de reversão no mesmo timeframe
depois** — é o resultado ruim que causa a arbitragem aparecer, não a
arbitragem que causa o resultado ruim. A frase "efeito MECÂNICO de mais
sinal bruto gerando mais briga de slot" da versão anterior não tem
sustentação nenhuma — corrigida para descrever só a correlação observada.

**O que sobra, com essas duas correções**: `minScore=60` tem uma taxa de
arbitragem numericamente maior que o controle nas 2 janelas (correlação,
direção consistente), mas (a) a diferença não é estatisticamente
estabelecida em nenhuma das duas, e (b) mesmo se fosse, não há mecanismo
identificado que ligue isso ao pior resultado — é a mesma classe de
correlação-sem-causa que o item 45.9 já tinha fechado como "indicador
coincidente, não preditor, inutilizável como filtro".

### O que isto NÃO muda

A recomendação do item 90 (não baixar `minScore` em produção) continua de
pé, mas agora só pelo motivo original (falta de evidência a favor) — a
hipótese "é um efeito mecânico de slot" desta seção não se sustentou. A
investigação do mecanismo de slot (item 92) segue válida como
investigação arquitetural independente — não depende desta correlação
para justificar o pedido explícito do usuário de entender o mecanismo.

### Verificação

Nenhuma mudança de código — reuso de `scripts/analyze-backtest.mjs`
existente sobre os 4 relatórios já no ledger, busca de código para
verificar consumidores de `current_confidence_score`, e esta análise.
`npm run lint && npm test && npm run build` continuam limpos (981/981).

## 92. Investigação do mecanismo de slot — por que "slot por lado" NÃO é uma extensão do Bloco 4 Fase 1 (2026-08-16)

### Pedido

A pedido explícito do usuário, motivado pelo item 91 (taxa de arbitragem
cross-side numericamente maior sob `minScore=60` — correlação observada,
sem mecanismo causal estabelecido, ver correção no próprio item 91):
investigar com cuidado o mecanismo de slot compartilhado entre BUY e SELL
que o item 71 já tinha deixado como pendência não resolvida — a pergunta
vale por si (arquitetura do motor), independente de a correlação do
item 91 ter ou não sustentação estatística. Isto é leitura/investigação —
**nada foi implementado nesta rodada**.

### Fato 1 — já existe uma infraestrutura de slot particionado, mas ela resolve um problema DIFERENTE

O item 37 (Bloco 4 Fase 1, 2026-08-10→12) já implementou, testou e mediu em
A/B um mecanismo de slot por `(ativo, cascata)`:
`buildActiveOpsAnchorId(assetId, cascade)` (`src/lib/opTransition.js:131`)
troca o doc-âncora `assetActiveOps/{assetId}` por
`assetActiveOps/{assetId}__{cascade}` quando `pineConfig.
hierarchicalCascadesEnabled` está ligado — deixando a cascata RF nativa
(`4h_15m`) e a SMC (`1h_5m`) terem operações **simultâneas e independentes**
no mesmo ativo, sem uma bloquear a outra.

**Isto não cobre o caso do item 71/91.** A dimensão que o Bloco 4 particiona
é CASCATA (RF × SMC) — nunca LADO. Confirmado lendo
`planSignalArbitration` (`src/lib/signalArbitration.js:187-189`): mesmo com
`hierarchicalCascadesEnabled` ligado, um candidato `4h_15m` SELL chegando
com uma operação `4h_15m` BUY já ativa continua caindo no mesmo branch
`direction === 'opposite' && tfRelation === 'same'` → `same_cascade_
opposite_direction` → só reduz confiança, nunca abre 2ª operação. O texto
do próprio item 37 já registra isso: "com o flag ligado, `4h_15m` e `1h_5m`
nunca arbitram uma contra a outra... cada uma só arbitra DENTRO de si
mesma, se aplicável" — ou seja, o problema de BUY×SELL dentro da MESMA
cascata continua exatamente como estava.

### Fato 2 — o resultado do A/B do Bloco 4 é um alerta relevante, não só uma nota de rodapé

O A/B real do item 37 (2026-08-12) mediu: a coexistência de slots
funcionou mecanicamente como desenhado (`active_op_exists` na cascata SMC
caiu de 4.704 para 30 rejeições), **mas o volume de operações cresceu
pouco** (12→14, +2) porque o gargalo real da SMC nunca foi o slot — era o
próprio gatilho 5m (`no_trigger`, dominante nos dois runs). E a
expectância combinada **não melhorou** (ambos os runs inconclusivos, RF
nativa até caiu ligeiramente, possivelmente pelo acoplamento de risco
`coupleSiblingRiskOnOpen`). **Lição direta para a proposta de slot por
lado**: resolver a disputa de slot não resolve automaticamente nada — só
libera volume onde o volume já era o problema. Se o gargalo do BUY/SELL
não for a disputa de slot em si, mas outra coisa (ex.: sinais opostos
correlacionados de verdade com reversão de tendência), abrir um 2º slot
teria o mesmo resultado nulo que o Bloco 4 teve na SMC.

### Fato 3 — slot por lado não é uma extensão natural do desenho existente; é conceitualmente diferente

O Bloco 4 (RF × SMC simultâneas) é, na prática, uma forma de **pyramiding
multi-timeframe** — duas pernas na MESMA direção implícita de tendência
(a pesquisa de comunidade do próprio item 37 confirma: pyramiding é
estritamente trend-following, nunca para "promediar" posição contrária).
**Slot por lado seria outra coisa: permitir BUY e SELL simultâneos no
MESMO ativo** — não duas pernas reforçando a mesma tese, mas duas apostas
**diretamente opostas** sobre o mesmo preço. Isso é estruturalmente mais
parecido com um straddle/hedge do que com pyramiding, e a
`signalArbitration.js` já trata um candidato de lado oposto como
**informação sobre a operação já ativa** (ela pode estar errada), não como
uma 2ª oportunidade legítima e independente — é assim que o RF (Range
Filter, um indicador de tendência) e a SMC foram desenhados: sistemas
direcionais, não sistemas de hedge. Abrir um 2º slot para o lado oposto
mudaria essa premissa de raiz, e — diferente do Bloco 4, que tinha
literatura de pyramiding real como referência — não há prática de mercado
equivalente clara para "hedge automático intrabot no mesmo ativo" que
sirva de guia de desenho (pesquisa de comunidade ainda não feita para
esta variante especificamente).

### Fato 4 — existe uma alternativa mais barata e já meio-construída: fortalecer a invalidação em vez de abrir 2º slot

`planSignalArbitration` já tem um precedente de "candidato oposto forte
o bastante para agir, não só avisar": `direction === 'opposite' &&
tfRelation === 'larger'` (`critical_opposite`) tem `arbInvalidateOnOppositeMajor`
(`pineConfig`, default `false`) — quando ligado, invalida a operação ativa
em vez de só reduzir confiança. **O branch `same_cascade_opposite_
direction` (o que o item 71/91 mede) não tem equivalente nenhum** — é
sempre `reduce_confidence`, nunca invalidação, independente do score do
candidato. Estender esse MESMO padrão (`arbInvalidateOnOppositeSameTf` ou
nome similar, opt-in, default false) para o caso mesmo-timeframe seria uma
mudança **muito menor** que slot por lado: não mexe no invariante de
"1 operação por ativo/cascata", reusa a mesma infraestrutura de
`transitionTradeOp`/CAS já testada, e ataca o mesmo sintoma (BUY ruim
persistindo enquanto um SELL bom não consegue nada) por um ângulo
diferente — fechar a posição errada em vez de abrir uma 2ª.

**Ressalva que pesa contra essa alternativa também**: o item 45.9 já
mediu que o aviso de arbitragem (`correction_warning`) chega **depois**
que o preço já andou contra a posição em 82 de 82 casos medidos (mediana
64h) — é indicador **coincidente** de operação perdendo, não preditor. Se
essa mesma causalidade invertida vale para `same_cascade_opposite_
direction`, invalidar automaticamente nesse gatilho corta a perda só
depois que ela já apareceu — pode ajudar (sair antes do stop cheio) ou
piorar (sair de uma posição que se recuperaria, puro whipsaw). Não dá
para saber sem medir.

### Leitura (fato × hipótese × recomendação)

**Fato**: existem 2 caminhos de mecanismo, nenhum implementado hoje para o
caso BUY×SELL mesma cascata — (A) slot por `(ativo, cascata, lado)`,
extensão mecânica do Bloco 4 mas conceitualmente mais arriscada (posições
opostas simultâneas, sem literatura de apoio equivalente); (B) invalidação
opt-in no branch `same_cascade_opposite_direction`, mudança bem menor,
reusa infraestrutura existente, mas com o mesmo risco de causalidade
invertida já documentado no item 45.9 para o mecanismo irmão.

**Hipótese**: (B) é a aposta mais barata e menos arriscada de testar
primeiro — não mexe no invariante central da máquina de estados (que o
item 37 já classificou como mudança estrutural que exige
`sentinel-council-review`), e o A/B do Bloco 4 já deu um alerta real de
que resolver disputa de slot nem sempre resolve o problema de expectância
por trás dela.

**Recomendação — não implementar nada agora, apenas o desenho fica
registrado**: (1) qualquer uma das duas opções precisa entrar na mesma
fila de disciplina que o item 37 já definiu — pesquisa de comunidade
específica (nenhuma foi feita ainda para nenhuma das duas), desenho
explícito, e revisão de conselho se for a opção (A), dado que mexe
potencialmente no invariante de estado; (2) se o usuário quiser avançar,
(B) é o ponto de entrada mais barato e reversível — pode ser medido com
um trial de backtest simples (novo campo opt-in, sem tocar
`assetActiveOps`) antes de considerar (A); (3) Bloco 0 (vantagem
direcional da estratégia) continua sendo o bloqueio de sequenciamento
formal já registrado no item 37 para QUALQUER mudança estrutural nova no
motor — essa regra não mudou com esta investigação.

### Verificação

Nenhuma mudança de código — investigação por leitura direta de
`src/lib/signalArbitration.js`, `src/lib/opTransition.js`,
`src/api/entities.js`, `scripts/adminEntities.js`, `src/lib/scanner.js`
(pontos de wiring do `hierarchicalCascadesEnabled`) e itens 37/39/45.9/71
do `known-risks.md`. `npm run lint && npm test && npm run build`
continuam limpos (981/981, sem alteração — nada foi tocado no código).

## 93. `arbInvalidateOnOppositeSameTf` — invalidação opt-in no branch `same_cascade_opposite_direction` (2026-08-16)

### Pedido

Continuação do item 92 (opção B, a alternativa mais barata identificada na
investigação do mecanismo de slot): implementar a extensão do padrão já
existente de `arbInvalidateOnOppositeMajor` para o branch same-timeframe
(`direction === 'opposite' && tfRelation === 'same'`), que hoje é sempre
`reduce_confidence`, nunca invalidação, independente da força do candidato
oposto.

### Pesquisa de comunidade (antes do desenho)

Busca sobre estratégias trend-following "stop-and-reverse"/mitigação de
whipsaw confirma a prática consolidada: exigir um limiar de confirmação
**mais alto** do que o de simples entrada antes de inverter/fechar uma
posição por sinal oposto — inverter no primeiro sinal contrário (sem
filtro adicional) é o padrão clássico que gera excesso de whipsaw em
mercados choppy. Por isso o desenho abaixo reusa `arbPromoteMinScore`
(75, o piso já usado para PROMOVER um candidato a operação própria) como
piso de invalidação, não `arbReinforceMinScore` (50, o piso mínimo só
para reduzir confiança) — o candidato precisa ser forte o bastante para
ter aberto operação própria por conta própria, não só "forte o bastante
para ser notado".

### Desenho implementado

`src/lib/signalArbitration.js`, branch `same_cascade_opposite_direction`
(final de `planSignalArbitration`): novo flag opt-in
`pineConfig.arbInvalidateOnOppositeSameTf` (default `false`, mesmo padrão
de todo outro flag experimental do motor). Com o flag ligado E
`candidateScore >= arbPromoteMinScore`, o outcome passa de
`reduce_confidence` para `invalidate` (mesma ação genérica que
`critical_opposite` já usa) — `scanner.js:handleActiveOpArbitration` não
precisou de nenhuma mudança, porque o tratamento de `action === 'invalidate'`
já é genérico por ação, não por branch (seta `status: 'INVALIDATED'`,
`closed_reason: 'INVALIDATION'`, `closed_at`, `exit_price`, libera o slot).
Com o flag ligado mas score abaixo de `arbPromoteMinScore` (e acima de
`arbReinforceMinScore`), o comportamento continua `reduce_confidence` —
nunca invalida por um candidato fraco. Com o flag desligado (default), o
comportamento é idêntico ao de sempre.

Sincronizado nos 3 arquivos de config, mesma convenção dos outros flags
production-syncable do motor: `src/lib/pineParser.js` e
`scripts/adminPineConfig.js` (DEFAULTS + `SYNCED_STRATEGY_KEYS`, escreve/lê
`strategyConfig/current` no Firestore) e `scripts/backtestPineConfig.js`
(DEFAULTS, override só via `--pine-config`, sem Firestore).

### Ressalva (herdada do item 92, não resolvida por este código)

O mesmo risco de causalidade invertida do item 45.9/91 se aplica aqui: o
item 45.9 mediu que o aviso de arbitragem chega DEPOIS que o preço já
andou contra a posição (82/82 casos, mediana 64h) — é indicador
coincidente, não preditor. Ligar `arbInvalidateOnOppositeSameTf` pode
cortar a perda mais cedo (sair antes do stop cheio) ou pode piorar
(sair de uma posição que se recuperaria — whipsaw). **Este item só
implementa o mecanismo; não mede o efeito.** Segue a mesma regra de todo
outro flag experimental do motor (retest/displacement/tier/pré-TP1
breakeven etc.): não ativar em produção sem comparar relatórios de
backtest com/sem primeiro.

### Verificação

`npm run lint && npm test -- --run && npm run build` — 986/986 testes
passando (5 novos em `signalArbitration.test.js`, cobrindo: comportamento
default-off, flag ligado mas score abaixo de `arbPromoteMinScore` (ainda
`reduce_confidence`), flag ligado e score suficiente (`invalidate`),
fronteira exata do limiar (`>=`, não `>`), e flag ligado mas score abaixo
até de `arbReinforceMinScore` (ainda totalmente bloqueado por
`belowThreshold`) — build limpo, lint limpo. Próximo passo (não feito
ainda): rodar um trial de backtest com o flag ligado vs. desligado, no
mesmo espírito dos outros testes desta rodada.

## 94. Reteste com tolerância maior (0,6×/1,0× ATR) — ainda não produz amostra utilizável (2026-08-16)

### Contexto

Seguindo a recomendação do item 90 (o baseline `retestToleranceAtrMult:
0,3` teve só 2,4% de confirmação), usuário rodou 2 trials afrouxando a
tolerância, mesma janela/carteira do item 90
(`2025-08-15→2026-08-15`, 7 símbolos default, custos ligados):
`retest-tol-0.6-baixa2025` (`retestToleranceAtrMult: 0,6`) e
`retest-tol-1.0-baixa2025` (`retestToleranceAtrMult: 1,0` — o mesmo
múltiplo tratado como "generoso" no item 53/54 para o breakeven pré-TP1).

### Resultado

| trial_label | tolerância | sinais no gate | confirmados | taxa | operações (n) | expectancyR líquida | conclusivo? |
|---|---|---|---|---|---|---|---|
| `retest-gate-baseline` (item 90) | 0,3× | 126 | 3 | 2,4% | 0 | — | não (`sample_too_small`) |
| `retest-tol-0.6-baixa2025` | 0,6× | 125 | 4 | 3,2% | 1 | −1,025R | não (`sample_too_small`) |
| `retest-tol-1.0-baixa2025` | 1,0× | 125 | 8 | 6,4% | 4 | −0,049R (bruta −0,004R) | não (`sample_too_small`, apesar de já ter IC95 calculável: [-1,192; 1,095]) |

Família `entry-retest-gate` (ledger, `backtest-trial-registry.mjs`) agora
em N=3, z corrigido=2,3940 — irrelevante aqui porque nenhum trial da
família individualmente limpa o piso de amostra (`minTrades: 30`) para
sequer entrar na comparação de IC.

### Leitura (fato × hipótese × recomendação)

**Fato**: triplicar a tolerância (0,3×→1,0×) só levou a taxa de
confirmação de 2,4% para 6,4% — mais que dobrou proporcionalmente, mas o
volume absoluto de operações continua trivial (0→1→4, contra o piso de 30
que o próprio motor exige para qualquer veredito). `avgBarsToConfirm`
(10,8 e 9,1 barras de 15m, respectivamente) mostra que quando o reteste
CONFIRMA, é rápido (~2-3h) — o problema não é velocidade, é que a grande
maioria dos sinais nunca toca de volta o nível rompido dentro da janela
de retry do sinal.

**Hipótese**: mesmo em 1,0×ATR — já um múltiplo generoso pelo próprio
padrão deste projeto — o gate de reteste, do jeito que está desenhado
(retestar exatamente o nível que o próprio sinal candidato rompeu, não um
nível estrutural mais largo), é estruturalmente incompatível com produzir
amostra utilizável numa única janela de 12 meses/7 símbolos. Não é mais
"a tolerância padrão é baixa demais" (leitura do item 90) — é "mesmo
afrouxando bastante, o gate ainda é raro demais para medir nesta escala
de teste".

**Recomendação**: não vale continuar subindo a tolerância como próximo
passo isolado — em algum ponto (provavelmente >1,5×ATR) o gate deixa de
significar "reteste" e vira só "preço ainda por perto", esvaziando o
propósito original do item 40. Se o usuário quiser insistir nesta linha,
o gargalo real é ORÇAMENTO DE AMOSTRA (mais símbolos e/ou mais anos),
não o multiplicador — mesma lição que o item 95 abaixo mede
independentemente para a linha SELL-only. Por ora, `retestEnabled`
continua desligado por padrão e esta linha de investigação fica parada
até haver orçamento de amostra maior para testar.

### Verificação

2 relatórios reais (`backtest.yml`, mesma janela/carteira do item 90),
registrados em `docs/backtest-trial-registry.json` via
`backtest-trial-registry.mjs --report ... --family entry-retest-gate`.
Nenhuma mudança de código.

## 95. SELL-only com carteira expandida (8 símbolos) — mais perto do limiar, ainda inconclusivo (2026-08-16)

### Contexto

Item 88 pausou a linha SELL-only por falta de janela de calendário ou
símbolo genuinamente novo, mas registrou uma segunda forma válida de dado
novo: mais símbolos fora da carteira já testada (o caminho que o item 74
já tinha aberto com só LTCUSDT/DOGEUSDT, subamostrado demais — n=16-38
por janela). A pedido do usuário, retomando essa linha: rodou-se
`sell-only-expanded-symbols-baixa2025` com 8 símbolos —
`LTCUSDT,DOGEUSDT` (já usados no item 74) + 6 novos
(`TRXUSDT,ATOMUSDT,ETCUSDT,UNIUSDT,ICPUSDT,FILUSDT`) — mesma janela
recente do item 90 (`2025-08-15→2026-08-15`), `allowedSide: SELL`.

### Resultado (pooled, 8 símbolos — ver correção abaixo)

74 operações totais, 72 contadas (2 ainda abertas no corte do
relatório — efeito de borda normal, não erro), distribuídas de forma
razoavelmente equilibrada entre os 8 símbolos (7 a 11 operações cada):

| Métrica | Valor |
|---|---|
| n (contadas) | 72 |
| Win rate | 54,2% (39W/32L/1BE) |
| Expectância líquida | +0,257R |
| Expectância bruta | +0,314R |
| Profit factor | 1,354 |
| IC95 (não corrigido) | [-0,025; 0,539] — cruza zero por margem pequena |
| Motivo de inconclusivo | `ci_straddles_zero` (não mais `sample_too_small` — n=72 já limpa o piso de 30) |

### Correção (2026-08-16, review externa Codex, PR #198) — 2 achados

**P1 — LTCUSDT/DOGEUSDT não são dado genuinamente novo nesta janela.**
A leitura original tratou os 72 operações como amostra inteiramente
nova, mas LTCUSDT/DOGEUSDT já tinham sido medidos pelo item 74 na janela
`2025-07-27→2026-07-27` (`item74-walkforward-baixa-2025-26-ltcdoge-
sell-slice`) — **~95% sobreposta** com a janela deste trial
(`2025-08-15→2026-08-15`, início só 19 dias depois). O critério do item
88 define "dado novo" como par ativo×janela nunca examinado — misturar
os 22 operações de LTC/DOGE (11 cada) no n=72 pooled viola isso
diretamente: parte da "próxima medição fora da amostra" já estava,
efetivamente, dentro da amostra.

**Recomputado excluindo LTC/DOGE** (só os 6 símbolos genuinamente novos,
recalculado diretamente de `overall.curve` do mesmo relatório — mesma
fórmula mean/SE/CI95 do motor, conferida batendo com os campos originais
do relatório antes do filtro):

| Métrica | Valor (só 6 símbolos novos) |
|---|---|
| n | 50 (TRXUSDT 9, ATOMUSDT 7, ETCUSDT 8, UNIUSDT 10, ICPUSDT 7, FILUSDT 9) |
| Win/Loss | 29W/21L/0BE |
| Expectância líquida | **+0,387R** |
| IC95 (não corrigido) | **[0,049; 0,725]** — **não cruza zero** |

Curiosamente, excluir LTC/DOGE **fortalece** o resultado (o ponto
estimado sobe de +0,257R para +0,387R, e o IC deixa de tocar zero) — os
dois símbolos reaproveitados estavam, nesta amostra, com desempenho pior
que a média dos 6 novos, puxando o pooled para baixo. Registrado como
`sell-only-expanded-symbols-baixa2025-newonly` (seed) na família.

**P2 — a alegação "13/13, sem reversão de sinal" era falsa.** O ledger já
tinha `item74-walkforward-2023-24-ltcdoge-sell-slice` com expectância
**−0,039R** (n=16, inconclusiva) — um sinal negativo, não positivo — e
outros 2 valores (0,078R, 0,094R) já ficavam fora da faixa "0,147R a
0,401R" citada. O correto: **12 de 13 medições prévias são positivas, 1 é
negativa** (a mais fraca da família em amostra, n=16, ela própria
inconclusiva — não é evidência forte de reversão, mas também não é
"sem reversão").

### Resultado final (com as 2 correções aplicadas)

Família `sell-only-hypothesis` agora em **N=14** (z corrigido=2,9137),
incluindo os 2 registros deste trial (pooled contaminado, mantido no
ledger por rastreabilidade, e o corrigido `-newonly`):

| trial_label | n | expectancyR | IC95 não corrigido | IC corrigido (N=14) |
|---|---|---|---|---|
| `sell-only-expanded-symbols-baixa2025` (pooled, contaminado) | 72 | 0,257 | [-0,025; 0,539] | [-0,163; 0,676] |
| `sell-only-expanded-symbols-baixa2025-newonly` (válido) | 50 | **0,387** | **[0,049; 0,725]** | [-0,116; 0,889] |

### Leitura (fato × hipótese × recomendação)

**Fato**: a versão corrigida (só os 6 símbolos genuinamente novos) é a
**primeira medição individual da família inteira, com dado
inequivocamente novo, cujo IC95 não corrigido não cruza zero** — mais
forte que a versão pooled original. Mas depois da correção Bonferroni
por família (N=14, z=2,91 contra z=1,96 sem correção), o IC volta a
cruzar zero ([-0,116; 0,889]) — o mesmo desfecho final da leitura
original, só que chegando lá por um caminho diferente e mais correto.

**Hipótese**: 12 de 13 medições anteriores positivas (não 13/13) ainda é
um padrão direcional forte, mas "quase todas positivas, uma negativa e
pequena" é uma alegação mais fraca que "sem reversão nenhuma" — a
correção não muda a conclusão prática, mas muda quanto peso essa
consistência histórica deveria ter no julgamento.

**Recomendação — inalterada em relação à leitura original**: pelo
critério do item 88, isto **não desbloqueia o Bloco 1** — IC cruza zero
depois da correção de família, mesmo com o resultado individual mais
forte já medido. Os 2 caminhos seguem os mesmos: (a) expandir a carteira
de símbolos ainda mais (com a ressalva, reforçada por este episódio, de
CONFERIR que qualquer expansão futura não reusa símbolo×janela já
registrado antes de pooling — o erro P1 acima é exatamente o tipo de
lapso que se repete se não virar checklist); (b) esperar a janela de
calendário livre de sobreposição (~2027-08-10, item 88).

### Verificação

1 relatório real (`backtest.yml`, 8 símbolos, janela 2025-08-15→2026-08-15,
`allowedSide: SELL`) + 1 registro derivado (seed, filtrado do mesmo
relatório excluindo LTC/DOGE), ambos em `docs/backtest-trial-registry.json`
via `backtest-trial-registry.mjs`. Nenhuma mudança de código.

## 96. Correlação entre ativos — hipótese continua válida, mas a checagem original era artefato, não sinal (2026-08-16, corrigido)

### Contexto

Usuário perguntou, de forma exploratória, se havia algo estrutural sendo
deixado passar apesar do volume de medições já feito. Investigando, achei
uma ressalva já mencionada de passagem em pelo menos 2 lugares do projeto
(`roadmap.md`, "20 símbolos não são 20 amostras independentes —
correlação com BTC"; item 39/pesquisa de pyramiding sobre "portfolio
heat") mas **nunca medida nem tratada como investigação própria** — todo
IC95 calculado neste projeto (aqui e em todos os itens anteriores) trata
cada operação como uma amostra independente, mas ativos cripto
compartilham beta forte com BTC. Essa pergunta de fundo continua válida
— o que mudou nesta correção é que a checagem que eu tinha feito para
testá-la **não vale nada como evidência**, e o motivo é instrutivo.

### O que a versão original fez (e por que estava errada)

Usando o relatório de `sell-only-expanded-symbols-baixa2025` (item 95, 72
operações, 8 símbolos): de 120 pares de operações de símbolos DIFERENTES
cuja janela de tempo aberta se sobrepôs, 77,5% tiveram o mesmo sinal de
resultado — comparado contra "~51% esperado sob independência, dado o
win rate geral de 54%". Essa foi apresentada como evidência direcional
de correlação entre ativos.

### Correção (2026-08-16, review externa Codex, PR #199)

**O nulo de 51% estava errado — não isolava correlação entre ativos.**
Três problemas reais, todos confirmados com o dado do próprio relatório:

1. **Duração e resultado NÃO são independentes**: operações vencedoras
   nesta amostra duraram em média 209,7h; perdedoras, 155,9h (n=39/33).
   Faz sentido mecanicamente — o motor tem trailing/TP2 que estende a
   vida de uma operação ganhadora, enquanto um stop cedo encerra rápido
   uma perdedora.
2. **Selecionar pares por sobreposição de janela super-representa
   operações longas** (um trade mais longo tem mais chance de se
   sobrepor com outros) — como duração já está associada a resultado
   (ponto 1), isso sozinho já infla a taxa de "mesmo sinal" sem nenhuma
   correlação real de mercado.
3. **Os 120 pares não são 120 comparações independentes**: a mesma
   operação aparece em até 9 pares diferentes (5 operações não
   apareceram em nenhum) — o mesmo resultado é contado várias vezes.

**Verificação decisiva**: rodei um teste de permutação (2.000
repetições) embaralhando os RÓTULOS de símbolo entre as operações —
isso preserva exatamente a duração, o resultado e a estrutura de
sobreposição/duplicação de cada operação, mas destrói qualquer
correlação real de mercado entre ativos (já que o símbolo passa a ser
arbitrário). Resultado: a taxa "mesmo sinal" sob esse nulo embaralhado
tem média **77,5%** (IC empírico 5-95%: [75,2%; 79,8%]) — **idêntica**
ao valor real observado (também 77,5%, p-valor=0,483). Ou seja: os 3
problemas acima explicam o número inteiro, sozinhos, sem precisar de
nenhuma correlação real entre BTC e os outros ativos. **A checagem
original não tinha nenhum valor evidencial — nem fraco.**

### Leitura (fato × hipótese × recomendação)

**Fato**: a hipótese de fundo (ativos cripto correlacionados via beta
BTC, e isso potencialmente inflando a confiança de todo IC95 já
calculado no projeto) continua teoricamente plausível — é fato de
mercado bem estabelecido, independente desta checagem. Mas a checagem
específica que fiz não a confirma nem a refuta: era estatisticamente
inválida desde o desenho, comparando contra um nulo que não isolava a
variável de interesse.

**Hipótese**: nada mudou aqui — a pergunta "os IC95 deste projeto
assumem independência que talvez não exista" segue em aberto, sem
evidência a favor ou contra depois desta rodada.

**Recomendação — revisada**: não usar mais este achado como argumento
de repriorização (como cheguei a sugerir ao usuário) — ele não sustenta
isso. Se a pergunta valer a pena investigar formalmente, o desenho
precisa isolar duração corretamente: (a) o teste de permutação por
embaralhamento de rótulo de símbolo usado na correção acima é uma opção
válida e já implementada nesta rodada — dá pra reaplicar num relatório
maior; (b) a sugestão original do Codex (deslocar/reamostrar a série
inteira de cada símbolo, ou coortes por tempo de entrada fixo) é outra
via válida; (c) correlação de Pearson entre R e retorno real de BTC no
mesmo período (item 79 já usou a ferramenta para outra pergunta) evita o
problema de pareamento por sobreposição inteiramente.

### Segunda ideia, menor e já registrada no item 88 mas nunca testada: filtro de regime pro BUY

Item 88 já nomeou isto explicitamente como o único caminho formal de
reabrir a pergunta do BUY ("condicionar compra ao alinhamento de
tendência 1D") — nunca chegou a virar trial. Diferente da correlação
acima, é uma mudança de ESTRATÉGIA (um novo gate), não de método de
medição — mais cara e arriscada, mas concreta e já com justificativa
escrita. Não afetada pela correção acima.

### Verificação

Checagem exploratória original + teste de permutação de correção, ambos
via script Node ad-hoc sobre `overall.curve` do relatório do item 95 —
não é medição formal, não muda código (`npm run lint && npm test --
--run` continuam limpos, nada tocado em `src/`/`scripts/`). Registrado
aqui — incluindo o erro e a correção lado a lado — porque é achado real,
ainda que a conclusão final seja "sem evidência", seguindo a mesma regra
do resto do arquivo.

## 97. Ferramenta formal de correlação entre ativos (`backtest-correlation-check.mjs`) — piloto confirma correlação real e substancial no relatório do item 95 (2026-08-16)

### Contexto

Item 96 deixou a pergunta em aberto sem evidência (a checagem original era
artefato). A pedido do usuário, desenhei e implementei a medição formal —
pesquisa de comunidade confirmou erro-padrão em cluster (Cameron & Miller)
como a técnica padrão da literatura de econometria/finanças pra esse
problema exato, com a literatura de "overlapping returns" (Richardson &
Smith 1991, Lo & MacKinlay 1988) como o análogo direto de operações com
duração variável e sobreposta.

### Ferramenta

`scripts/backtest-correlation-check.mjs` (matemática pura à mão, sem
dependência nova, mesmo padrão do `backtest-trial-registry.mjs`) —
diagnóstico puro, não toca `backtestEngine.js`/`pineConfig`, roda em cima
de um `backtest-report.json` já existente:

1. **Erro-padrão em cluster (Cameron-Miller CR1)**, com clusters definidos
   como componentes conectados do grafo de sobreposição temporal entre
   operações de símbolos DIFERENTES (não por dia — duração variável
   fatiaria uma operação longa de forma arbitrária num balde de
   calendário). Devolve IC95 em cluster, DEFF (design effect) e N
   efetivo — reduz exatamente ao erro-padrão ingênuo quando todo cluster
   tem tamanho 1 (conferido em teste).
2. **Teste de permutação por deslocamento circular por símbolo**: desloca
   a série INTEIRA de cada símbolo por um offset aleatório, preservando
   100% do comportamento real do símbolo (duração, taxa de acerto,
   cadência) e destruindo só o alinhamento de calendário com os outros
   símbolos — exatamente o tipo de correção que a review do Codex (item
   96/PR #199) exigiu, agora formalizada e reutilizável. Serve de
   validação cruzada do método 1, que sozinho é pouco confiável com
   poucos clusters (G) — o script sempre reporta G e sinaliza quando
   baixo (<20).
3. Limitação documentada no próprio código: o IC em cluster usa z=1,96
   (não t-Student, mesma convenção do resto do projeto) — com G baixo
   pode subestimar a incerteza levemente a mais; por isso o teste de
   permutação (que não depende de G pra ser válido) é a validação
   primária nesse regime, não o IC em cluster sozinho.

Testado (`scripts/backtest-correlation-check.test.mjs`, 21 casos): grafo
de sobreposição (transitividade, componentes desconexos), fórmula CR1
contra exemplo à mão, caso degenerado G=1 (a fórmula pura daria SE=0 —
"certeza perfeita" falsa — corrigido pra devolver `null` explícito, mesma
convenção de `sample_too_small`), deslocamento circular preserva
duração/espaçamento, teste de permutação detecta corretamente correlação
construída e ausência dela.

### Piloto nos 3 relatórios do usuário

| Relatório | N | G (clusters) | DEFF | N efetivo | Permutação (p-valor) |
|---|---|---|---|---|---|
| `retest-tol-0.6-baixa2025` | 1 | 1 | — | 1,0 | — (n insuficiente p/ qualquer cálculo) |
| `retest-tol-1.0-baixa2025` | 4 | 3 | 1,64 | 2,43 | 0,0090 |
| `sell-only-expanded-symbols-baixa2025` (item 95) | **72** | **18** | **2,99** | **24,08** | **0,0005** |

### Leitura (fato × hipótese × recomendação)

**Fato**: no relatório com amostra real (item 95, 72 operações), o efeito
NÃO é artefato — o teste de permutação confirma isso diretamente (DEFF
real muito acima do que o deslocamento circular, que preserva
duração/seleção mas destrói correlação real, produz por acaso: p5=0,43,
p95=1,64, real=2,99). **O N efetivo (~24) é cerca de 1/3 do N nominal
(72)** — o IC95 em cluster ([-0,231; 0,745]) é quase o dobro da largura
do IC ingênuo publicado no item 95 ([-0,025; 0,539]).

**Hipótese**: a suspeita do item 96 se confirma, pelo menos para este
relatório — operações de símbolos diferentes que estiveram abertas ao
mesmo tempo realmente se movem junto o suficiente para inflar a confiança
aparente de forma substancial. Isto NÃO significa que todo IC95 já
publicado neste projeto tem o mesmo DEFF (~3,0 é específico desta
janela/carteira de 8 símbolos, todos altamente correlacionados com BTC em
regime de baixa) — mas é a primeira evidência real, não teórica, de que a
ressalva "20 símbolos não são 20 amostras independentes" tem magnitude
prática relevante, não só direção.

**Recomendação**: (1) não implica mudar nenhum IC95 já publicado — seria
preciso reprocessar cada relatório histórico, e a maioria dos artifacts
do `backtest.yml` já expirou (mesma limitação que o item 89 já registrou
pro ledger de trials); (2) proposta prática pra daqui pra frente: rodar
`backtest-correlation-check.mjs` junto de qualquer novo relatório
relevante (baixo custo, reusa o mesmo arquivo já baixado) e reportar
N efetivo ao lado do N nominal — não é gate, não bloqueia nada, só
informação adicional na mesma leitura; (3) o item 48/alta (único
resultado CONCLUSIVO do Bloco 0, carteira de 20 símbolos) é o candidato
mais importante pra rodar isto depois, se o artifact original ainda
existir — é a conclusão mais forte já tirada neste projeto, e a que mais
se beneficiaria de saber seu N efetivo real.

### Verificação

`npm run lint && npm test -- --run && npm run build` — 1007/1007 testes
passando (21 novos), build limpo. Piloto rodado nos 3 relatórios
(`node scripts/backtest-correlation-check.mjs --report <path>
--iterations 2000`) — não é mudança de comportamento, ferramenta
puramente diagnóstica.

## 98. O único resultado CONCLUSIVO do projeto (item 48/alta), sob correlação de cluster: continua excluindo zero, mas por uma margem muito menor (2026-08-16)

### Contexto

Seguindo a recomendação do item 97, o usuário recuperou o artifact original
do item 48 (janela de alta, `trial_label: Bull-baseline`, 2024-07-27→
2025-07-27, carteira de 20 símbolos) — não estava mais salvo, mas o artifact
do GitHub Actions (run 30505384474, 2026-07-30) ainda não tinha expirado
(validade até 2026-08-29). Sessão não alcança o domínio de Azure Blob
Storage que serve artifacts do Actions (bloqueio de política de rede,
mesma classe do bloqueio à Binance já documentado) — usuário baixou pelo
navegador e enviou o `backtest-report.json` diretamente.

### Resultado

| Métrica | Ingênuo (publicado no item 48) | Em cluster (Cameron-Miller CR1) |
|---|---|---|
| N | 288 | 288 (G=13 clusters, tamanho médio 22,15) |
| Erro-padrão | 0,0719 | 0,1357 |
| IC95 | **[0,153; 0,435]** | **[0,028; 0,560]** |

DEFF = 3,56 — **N efetivo ≈ 81** (de 288 nominal, ~28% do tamanho
nominal). Teste de permutação (deslocamento circular por símbolo, 1000
réplicas): DEFF real muito acima do nulo (média 0,39, p95 1,38) —
**p-valor=0,0003**, confirmando que o efeito não é artefato de
duração/seleção.

### Leitura (fato × hipótese × recomendação)

**Fato**: o IC em cluster **continua excluindo zero** (0,028 > 0) — o
resultado não é refutado, tecnicamente ainda "conclusivo" pela mesma
régua usada em todo o projeto. Mas a margem encolheu de forma
dramática: o limite inferior caiu de 0,153 pra 0,028 — mais de 5x mais
perto de zero. G=13 é ainda mais baixo que o do item 95 (G=18), então a
ressalva de confiabilidade do erro-padrão em cluster com poucos clusters
se aplica com força extra aqui — o valor exato do limite inferior (0,028)
merece menos confiança do que o teste de permutação (que não depende de
G pra ser válido, e confirma a DIREÇÃO do efeito com bastante força).

**Hipótese**: a "melhor evidência de vantagem que o projeto já produziu"
(texto do próprio item 48) continua sendo a melhor evidência que existe
— mas era mais forte do que devia parecer. Com tamanho médio de cluster
de 22 operações (numa carteira de 20 símbolos), a maior parte das 288
operações "independentes" na verdade se agrupa em blocos de dado
correlacionado bem grandes — praticamente o que se poderia esperar de
um mercado onde a maioria dos ativos segue o mesmo regime a maior parte
do tempo.

**Recomendação**: não implica reverter a decisão do item 48 (Bloco 1
continua trancado pelo motivo já registrado — SELL não confirmado, não
por causa disto). Mas ao comunicar este resultado pra qualquer decisão
futura, a formulação correta não é mais "resultado conclusivo com IC
[0,153; 0,435]" — é "resultado que sobrevive à correlação de cluster,
mas por margem estreita, com poucos clusters efetivos (13) pra
sustentar essa margem com confiança". Se uma nova janela de alta for
medida no futuro (não hoje, sem pedido do usuário), vale rodar esta
mesma ferramenta nela desde o início, não como correção posterior.

### Verificação

`node scripts/backtest-correlation-check.mjs --report <path>
--iterations 3000` sobre o artifact recuperado do run 30505384474.
Nenhuma mudança de código — mesma ferramenta do item 97, sem alteração.

## 99. Terceira medição de correlação (item 71/holdout) — DEFF≈3 se replica num 3º relatório independente (2026-08-16)

### Contexto

Usuário recuperou também o artifact do holdout do item 71
(`allowedside-holdout-sell-only`, run 31396915576, 2024-08-10→2025-08-10,
carteira de 20 símbolos, mesmo bloqueio de rede dos dois itens
anteriores — baixado pelo navegador, enviado direto).

### Resultado

| Métrica | Ingênuo (publicado no item 71) | Em cluster (Cameron-Miller CR1) |
|---|---|---|
| N | 150 | 150 (G=17 clusters, tamanho médio 8,82) |
| IC95 | [-0,115; 0,270] — já cruzava zero | [-0,275; 0,430] — cruza ainda mais |

DEFF=3,36, N efetivo≈45 (de 150 nominal). Teste de permutação: DEFF real
muito acima do nulo (média 0,87, p95 1,76) — **p-valor=0,0010**.

### Leitura — o achado real aqui não é sobre este relatório específico

Como o item 71 já era INCONCLUSIVO na leitura ingênua, a correção não
muda nada da decisão (continua encerrado, mesmo motivo). **O achado real
é outro**: esta é a 3ª medição independente de DEFF neste projeto —

| Relatório | Item | DEFF |
|---|---|---|
| SELL-only expandido (8 símbolos) | 95/97 | 2,99 |
| Bull-baseline (20 símbolos, alta) | 48/98 | 3,56 |
| Holdout SELL-only (20 símbolos, baixa) | 71/99 | **3,36** |

Três janelas diferentes, duas composições de carteira diferentes (8 e 20
símbolos), dois regimes de mercado diferentes (alta e baixa) — e o DEFF
caiu no mesmo intervalo estreito (2,99–3,56) nas três vezes. Isso deixa
de ser "um resultado isolado" e vira um padrão replicado: **como regra
prática de bolso, dividir qualquer N nominal deste projeto por ~3 dá uma
estimativa melhor do N efetivo real** do que assumir independência —
enquanto ninguém rodar a ferramenta relatório por relatório, esse é o
melhor número disponível pra calibrar quanta confiança depositar num
IC95 publicado.

**Ressalva de honestidade**: 3 relatórios ainda é uma amostra pequena
pra esse "DEFF≈3" virar constante confiável — todos vêm de ativos cripto
correlacionados com BTC numa faixa parecida de regime (nenhum é um
mercado extremamente anômalo tipo colapso Luna/FTX); não dá pra
extrapolar esse número pra qualquer contexto sem mais medições.

### Recomendação

Nenhuma mudança de decisão. Registrado como referência rápida pra
qualquer leitura futura de IC95 deste projeto: até que a ferramenta seja
rodada no relatório específico, tratar o N nominal com ceticismo — o
efetivo provavelmente é uns 3x menor.

### Verificação

`node scripts/backtest-correlation-check.mjs --report <path>
--iterations 3000` sobre o artifact recuperado do run 31396915576.
Nenhuma mudança de código.

## 100. `buyRegimeFilterEnabled` — filtro de regime pro BUY, a linha nova pedida pelo usuário depois de identificar o loop de trials incrementais (2026-08-16)

### Contexto

Usuário perguntou diretamente se a sessão estava produzindo resultado ou
entrando em loop. Resposta honesta: a linha SELL-only (itens 48→71→74→
88→90→95→97→98→99, hoje N=14 na família Bonferroni) e a de tolerância de
reteste (40→90→94) tinham virado incrementos de retorno decrescente —
cada trial novo só torna o próximo mais difícil de confirmar (correção
fica mais rígida), sem ganho de poder proporcional. O item 88 já tinha
nomeado uma linha genuinamente nova, nunca tentada: "condicionar compra
ao alinhamento de tendência 1D" — único caminho formal registrado pra
reabrir a pergunta do BUY (regime-dependente: positivo em alta,
negativo/inconclusivo em baixa, item 48/88). Usuário escolheu esta
opção entre 4 caminhos apresentados.

**Pesquisa de comunidade (WebSearch, 2026-08-16)** — filtro de tendência
de timeframe maior gateando entradas: técnica padrão em sistemas
trend-following ("higher-timeframe filter"/"regime filter"), Quantpedia
documenta exatamente este desenho (filtro diário + entrada 4h) num
sistema pra Bitcoin. Riscos conhecidos, documentados na literatura:
menos sinais, atraso na virada de tendência (o filtro diário só
confirma DEPOIS que parte do movimento já aconteceu), whipsaw quando
diário e 4h discordam perto de uma reversão. Van Tharp Institute
descreve o princípio geral ("operar na direção da tendência maior
identificada num timeframe mais longo"). Contexto cripto atual
(CryptoQuant, ago/2026): >84% das altcoins abaixo da MA200, funding
negativo nas large-caps — consistente com a premissa de que BUY é mais
regime-dependente que SELL neste momento de mercado.

### Mecanismo implementado

Novo `pineConfig.buyRegimeFilterEnabled` (opt-in, default `false`,
backtest-only — mesmo isolamento arquitetural do `allowedSide`, item
71: NUNCA espelhado em `src/lib/pineParser.js`/`scripts/
adminPineConfig.js`, reforçado por `src/lib/buyRegimeFilterTripwire.
test.js`). Só afeta sinais **BUY** da cascata RF nativa (`4h_15m`) — SELL
nunca é tocado por este gate, exatamente por já performar bem
independente de regime (item 88).

**Reusa dado já calculado, zero I/O novo**: `signal.context.
tf_1d_direction`/`sig.context.tf_1d_direction` já é gravado em toda
`SignalEvent` desde sempre (`scanner.js`, alimentado por
`analyzeAlignment`), até hoje só usado como metadado observacional na
pontuação (nunca como gate — confirmado no item 70, que fechou a
hipótese de que o filtro MTF do Pine real faria algo equivalente: aquele
é matematicamente inerte na configuração do usuário, comparando o 4h
contra ele mesmo — não tem relação com este mecanismo, que usa dado real
de 1D). Gate posicionado no MESMO ponto do `allowedSide` (logo após
`results['4h']` existir, antes do gate de alinhamento 4h) — mesma
justificativa (mais barato, mais fundamental que checar qualidade do
sinal).

**Bloqueia quando 1D não é inequivocamente bullish** (`tf_1d_direction
!== 1` — bloqueia tanto baixista quanto neutro/0, decisão deliberada:
sem confirmação macro clara, gate conservador por desenho, não só
filtra contra-tendência explícita).

**Diferença de desenho importante em relação ao `allowedSide` no loop de
retry**: o LADO de um sinal nunca muda depois de nascer (por isso
`allowedSide` usa escrita manual write-on-change, evitando o helper
padrão). A direção 1D é condição de mercado AO VIVO — pode genuinamente
mudar entre passadas de retry, mesma classe de `trend_reversed`/
`regime_rejected`. Por isso este gate usa o helper `recordRejection`
padrão no retry, não o inline manual do `allowedSide` — decisão
documentada no próprio código, não uma cópia cega do padrão vizinho.

Rejeição registrada como `buy_regime_filter_blocked` em
`entryFunnelOutcomes`/`SignalEvent.last_rejection_reason`, mesmo padrão
de instrumentação de todo outro gate deste motor (nunca silencioso).

### Correção (2026-08-16, review externa Codex, PR #203)

**A implementação original do retry não fazia o que o próprio comentário
dizia.** O texto acima já explicava que o gate no retry deveria
reavaliar a direção 1D AO VIVO (por isso usa `recordRejection`, não o
write-on-change manual do `allowedSide`) — mas o código lia
`sig.context?.tf_1d_direction`, o valor CONGELADO no nascimento do
sinal, que nunca muda dentro do run. Na prática: um BUY nascido com 1D
bullish continuava passando mesmo depois do 1D virar baixista de
verdade, e um BUY nascido com 1D baixista ficava bloqueado pra sempre
mesmo depois do 1D virar bullish — o oposto do comportamento "condição
ao vivo" documentado, e um viés real que contaminaria qualquer backtest
rodado com o flag ligado.

Corrigido: o gate no retry agora lê `results['1d']?.rf?.direction`
diretamente (mesmo padrão de `tfData4h.rf.direction` já usado no gate de
alinhamento 4h logo abaixo) — dado já buscado na mesma passada, sem I/O
extra. `undefined` (1D indisponível nesta passada) conta como bloqueado,
mesma filosofia conservadora do valor neutro. O gate do 1º passo não
precisou de mudança — `signal.context.tf_1d_direction` ali É o valor
recém-calculado por `analyzeAlignment` na mesma chamada de `scanAsset`,
sem staleness possível (o sinal acabou de nascer).

### Verificação

13 testes em `src/lib/scannerStateMachine.test.js` (novo describe
`Filtro de regime pro BUY`, 3 adicionados na correção): flag desligado
sem mudança de comportamento; flag ligado com 1D bullish abre
normalmente; 1D baixista bloqueia; 1D neutro TAMBÉM bloqueia (gate
conservador); SELL nunca afetado mesmo com 1D baixista; retry respeita o
1D AO VIVO (não mais o congelado); retry grava `last_rejection_reason`
via `recordRejection`; **teste específico da correção** — sinal nascido
com 1D baixista mas 1D AO VIVO já bullish deixa passar (provaria o bug
original, agora passa); 1D indisponível na passada conta como
bloqueado. +3 testes de isolamento em `buyRegimeFilterTripwire.test.js`
(mesmo padrão do `allowedSideTripwire.test.js`). `npm run lint && npm
test -- --run` — 1019/1019 passando. `npm run build` + os 3 alvos
esbuild (`build:scan`/`build:scan-shadow`/`build:backtest`) compilando
sem erro. Grep de isolamento confirmado: `buyRegimeFilterEnabled`
ausente em `pineParser.js`/`adminPineConfig.js`, presente só em
`backtestPineConfig.js`.

**Próximo passo (não feito ainda)**: rodar um trial de backtest com o
flag ligado vs. desligado — mesma regra de todo outro flag experimental
deste motor, nunca ativar sem essa comparação primeiro. Diferente da
linha SELL-only, esta é uma hipótese genuinamente nova — o primeiro
resultado real vale mais do que qualquer previsão.

## 101. `buyRegimeFilterEnabled` medido pela 1ª vez — melhora aparente é composição de carteira, não qualidade de entrada (2026-08-16)

### Contexto

Usuário rodou os 2 disparos propostos (`buy-regime-filter-off-baixa2025`/
`buy-regime-filter-on-baixa2025`), mesma janela `2025-07-27→2026-07-27`,
carteira de 20 símbolos — a janela de baixa onde BUY já tinha medido
-0,552R (item 74), escolhida de propósito por ser onde o filtro, se
funcionar, deveria aparecer.

### Resultado — número de topo

| | Desligado | Ligado |
|---|---|---|
| n | 343 | 213 |
| Expectância líquida | -0,041R | **+0,121R** |
| IC95 | [-0,167; 0,085] | [-0,039; 0,282] |
| Win rate | 41,1% | 49,8% |
| Profit factor | 0,87 | 1,19 |

Delta = +0,162R. **Não significativo**: `SE_diff = sqrt(SE_on² +
SE_off²) = 0,104`, z = 1,559 (p≈0,12, bicaudal) — os dois números
individuais já eram inconclusivos, e a diferença entre eles também não
cruza o limiar convencional.

### O achado real: decompondo por lado, quase toda a "melhora" é composição de carteira, não qualidade de entrada

Como o filtro só bloqueia BUY, decompus por lado (`op.side`):

| | BUY desligado | BUY ligado | SELL desligado | SELL ligado |
|---|---|---|---|---|
| n | 178 | **30** | 165 | **183** |
| Expectância | -0,286R | -0,174R | +0,223R | +0,170R |
| Delta (SE_diff, z) | +0,112R (z=0,49, ns) | | -0,053R (z=-0,41, ns) | |

Dois achados nesta tabela, nenhum deles "o filtro melhorou o BUY":

1. **O BUY caiu 83% em volume (178→30) e a qualidade dos que sobraram NÃO
   melhorou de forma detectável** (z=0,49, muito longe de significativo,
   amostra de 30 é pequena demais pra dizer qualquer coisa com confiança).
2. **O SELL aumentou 11% em volume (165→183) mesmo sem o gate tocar em
   SELL nenhuma vez no código.** Mecanismo: `assetActiveOps` compartilha
   1 vaga por ativo — com 148 BUY a menos disputando a vaga, mais sinais
   SELL que antes esbarravam em `active_op_exists` agora conseguem abrir.
   Mesma classe de efeito de disputa de vaga já documentada nos itens
   39.1/78 — não é bug, é o motor se comportando como desenhado, só que
   não é o mecanismo que a hipótese do item 88/100 pretendia testar.

**Decomposição aditiva** (mesma disciplina do `backtestAnalysis.js` —
separar efeito de MISTURA de carteira do efeito de QUALIDADE por lado):
com dois fatores (mistura BUY/SELL, qualidade de cada lado) e só 2 pontos
de dado, a ordem da decomposição importa (efeito de interação real) — as
duas ordens possíveis dão contribuição de mistura entre +0,130R e
+0,192R, e de qualidade entre -0,030R e +0,032R (média Shapley:
mistura ≈+0,161R, qualidade ≈+0,001R). **Nas duas ordens, o efeito de
mistura de carteira domina quase totalmente os +0,162R observados — o
efeito de qualidade fica perto de zero.**

### Ressalva adicional (ferramenta do item 97)

`backtest-correlation-check.mjs` nos dois relatórios: `on` tem
DEFF=3,30 (G=12), consistente com o padrão já replicado 3x nos itens
97-99 — o IC95 real desse lado é mais largo do que o publicado. `off`
deu DEFF=0,03 (G=7) — **não confiável**: G=7 é baixíssimo, e o teste de
permutação confirma que esse número não se distingue de ruído
(p=0,6335, dentro do intervalo esperado sob o nulo). Não dá pra refazer
o teste de delta com erro-padrão em cluster dos dois lados de forma
confiável com este par de relatórios.

### Leitura (fato × hipótese × recomendação)

**Fato**: o número de topo (+0,162R) não é evidência de que "condicionar
BUY ao 1D funciona" no sentido que a hipótese propunha — é
majoritariamente um artefato de composição (menos BUY ruim diluindo o
pool, mais SELL bom entrando pela vaga liberada), não de BUY melhor
filtrado.

**Hipótese**: se o objetivo real fosse "path pra mais SELL", o
`allowedSide: 'SELL'` já testado nos itens 71/95/97/99 é o experimento
mais direto — este mecanismo chega lá de forma indireta e cara (perde
83% do volume BUY pra ganhar 11% de SELL). Se o objetivo é
especificamente "BUY que sobra é melhor", esta medição não confirma nem
refuta — n=30 no lado BUY-ligado não tem poder nenhum pra decidir isso.

**Recomendação**: não ativar. Não é um "não funciona" definitivo — é
"não sabemos ainda, e o efeito visível não é o que a hipótese previa".
Se valer a pena insistir nesta linha especificamente (isolar qualidade
de BUY, não composição), o próximo desenho precisaria neutralizar o
efeito de vaga — ex.: medir só em `hierarchicalCascadesEnabled` (item
37) ou em janela/carteira com mais volume BUY de sobra pra dar poder ao
subconjunto BUY-ligado. Registrado como família nova
`buy-regime-filter-hypothesis` no ledger (N=2 até aqui).

### Verificação

2 relatórios reais (`backtest.yml`), registrados via
`backtest-trial-registry.mjs --family buy-regime-filter-hypothesis`.
Decomposição e testes de significância via script Python ad-hoc sobre
`overall.curve` dos dois relatórios (mesma fórmula `SE_diff` já
estabelecida nas correções dos itens 90/95 desta sessão). Nenhuma
mudança de código.

## 102. `rfStructuralStopEnabled` — stop estrutural pro RF nativo, reusando o mecanismo já testado da SMC (2026-08-17)

### Contexto

Usuário perguntou, de forma direta e honesta, qual seria a melhor forma
de obter resultado — se valeria trocar de estratégia inteira. Resposta
registrada em conversa (não em known-risks, é opinião/recomendação, não
achado de dado): os dados deste projeto não sustentam "trocar de
estratégia" como primeiro passo — o teto real é estatístico (item 97-99,
N efetivo ≈ N/3), não necessariamente a lógica de entrada, e uma
estratégia nova bateria no MESMO teto sem nenhum do hardening já
construído aqui. O lado barato e nunca testado é SAÍDA/gestão de risco,
não entrada — e o candidato mais concreto é o stop estrutural: a cascata
SMC já tem um (`computeStructuralStop`, testado, em produção), mas foi
descartado junto com o resto da SMC (que tinha problema de ENTRADA, não
de saída) — estrutural e a entrada SMC nunca foram separados e testados
independentemente.

### Mecanismo implementado

Novo `pineConfig.rfStructuralStopEnabled` (opt-in, default `false`,
backtest-only — mesmo isolamento arquitetural de todo outro flag
experimental deste motor). Reusa **sem duplicar**:

- `computeStructuralStop` (`opExitRules.js`, já testado/em produção na
  SMC) — pega o nível de swing protegido, aplica margem de 0,1×ATR além
  dele, trava a distância entre 0,5×ATR (piso) e 2,0×ATR (teto); sem
  nível válido ou do lado errado, cai pro fallback ATR puro sozinho.
- O swing de 4h que o RF nativo **já calcula pra todo sinal**
  (`tf4hData.smc.lastSwingLow`/`lastSwingHigh`, via `calculateStructure`
  dentro de `scanAsset`) — até hoje só consumido como gate informativo
  (`smc_alignment_at_entry`), nunca como stop. Nenhum indicador novo,
  nenhuma busca de dado nova pra ISSO especificamente.
- TP1/TP2 já são calculados como `entry ± riskR × tp1R/tp2R` — trocando
  o stop, os alvos se ajustam sozinhos pro MESMO múltiplo de R (1,5R/3R),
  zero código extra.

Confirmei no item 24 (já registrado): o RF ficou com o stop por
tier×ATR por disciplina de **paridade com o Pine real**, não porque
estrutural foi testado e rejeitado nessa cascata — combinação
genuinamente nova, nunca proposta nem descartada antes.

### O risco que quase inutilizaria o experimento, corrigido antes de medir

Item 34 (já registrado) mediu que `calculateStructure` é *stateless*
(recalcula do zero a cada scan) e `swingLen=50` quase silencia
BOS/CHoCH com só 150 candles de histórico — foi por isso que a SMC no
1h ganhou uma janela ampliada pra 500 candles só pra ela
(`SMC_1H_STRUCTURE_CANDLE_LIMIT`). **O RF no 4h nunca ganhou esse
ajuste.** Sem corrigir isso, o stop estrutural do RF quase sempre cairia
no fallback ATR por falta de dado, não por o mecanismo não ajudar — um
resultado "sem diferença" seria ambíguo e inútil. Corrigido: quando
`rfStructuralStopEnabled` está ligado, a busca de candles 4h TAMBÉM
amplia pra 500 (`RF_4H_STRUCTURAL_STOP_CANDLE_LIMIT`, mesmo valor/mesmo
motivo) — sem afetar a busca de 4h de ninguém que não estiver testando
este flag.

**Instrumentação decisiva**: `TradeOperation.initial_stop_basis`
(`'tier_atr'` default | `'structural'` | `'structural_floored'` |
`'structural_capped'` | `'atr_fallback'` quando o flag está ligado mas
sem swing válido) grava qual stop foi usado DE VERDADE em cada operação
— sem isso, o resultado do futuro trial seria tão ambíguo quanto teria
sido sem ampliar a janela: não daria pra distinguir "estrutural não
ajuda" de "estrutural quase nunca foi usado".

### Verificação

19 testes novos: 6 comportamentais em `scannerStateMachine.test.js`
(flag desligada sem mudança; swing válido usa estrutural com TP1/TP2 no
mesmo R; swing muito perto vira `structural_floored`; swing longe demais
vira `structural_capped`; sem swing vira `atr_fallback`; SELL usa
`lastSwingHigh`, mesma mecânica espelhada); 2 em `backtestEngine.test.js`
confirmando a ampliação real da busca de candles 4h (150 padrão, 500 com
o flag); 3 de isolamento em `rfStructuralStopTripwire.test.js` (mesmo
padrão dos outros tripwires). `npm run lint && npm test -- --run` —
1030/1030 passando. `npm run build` + os 3 alvos esbuild
(`build:scan`/`build:scan-shadow`/`build:backtest`) compilando sem erro.
Grep de isolamento confirmado: `rfStructuralStopEnabled` ausente em
`pineParser.js`/`adminPineConfig.js`, presente só em
`backtestPineConfig.js`.

**Próximo passo (não feito ainda)**: rodar um trial de backtest com o
flag ligado vs. desligado, olhando também `initial_stop_basis` na
distribuição de operações antes de interpretar qualquer diferença de
expectância — mesma regra de todo outro flag experimental deste motor.

### Correção (2026-08-18, review externa Codex, PR #209) — o teto não era por-tier

O texto acima descreve o teto de `computeStructuralStop` como fixo em
"2,0×ATR" — verdade só pro tier T1. O ramo DESLIGADO usa
`tf4hData.tier?.atrStopMult` (2,0/2,5/3,0×ATR pra T1/T2/T3,
`indicators/tier.js`), mas a chamada original de `computeStructuralStop`
no ramo ligado não passava `maxAtrMult`, então sempre caía no default
2,0 da função — pro T2/T3 (a maioria das operações reais, ver item 104),
os casos `structural_capped`/`atr_fallback` produziam um stop
SISTEMATICAMENTE mais apertado que o ramo desligado pro mesmo tier, não
o mesmo valor. Isso quebrava a premissa de isolar 1 variável só
("estrutural vs ATR") — também mudava, sem intenção, o múltiplo de
risco pra maioria das operações.

**Corrigido**: `scanner.js` agora passa `maxAtrMult: ATR_MULT` (o mesmo
`tf4hData.tier?.atrStopMult ?? 2.0` que o ramo desligado usa) pra
`computeStructuralStop`. O piso (`minAtrMult`, sem equivalente por-tier
no ramo desligado) continua fixo em 0,5×ATR de propósito — só o TETO
precisava ficar tier-aware pra reproduzir fielmente o comportamento
antigo quando cai em `capped`/`fallback`. 2 testes novos em
`scannerStateMachine.test.js` cobrindo T3 (`atrStopMult=3.0`) explicitamente.

**Consequência prática**: o trial já medido no item 104
(`rf-structural-stop-on-baixa2025`, rodado ANTES desta correção) está
confundido — não testa limpo "estrutural vs ATR" pros tiers T2/T3 (98%
da amostra). Ver item 104 para o detalhe e a recomendação de novo run.

## 103. `arbInvalidateOnOppositeSameTf` medido — sinal direcional negativo consistente com a causalidade invertida suspeitada, mas não confirmado estatisticamente (2026-08-17, corrigido 2026-08-18 ×2)

### Contexto

A/B do item 93 rodado (`arb-invalidate-sametf-off-baixa2025` reaproveitado
do item 100/101 como controle + `arb-invalidate-sametf-on-baixa2025`),
mesma janela `2025-07-27→2026-07-27`, carteira de 20 símbolos.

### Resultado — número de topo (comparação agregada, com o mesmo confundimento de composição do item 101)

| | Desligado | Ligado |
|---|---|---|
| n | 343 | 385 |
| Expectância líquida | -0,041R | -0,110R |
| IC95 | [-0,167; 0,085] | [-0,226; 0,005] |

Delta = -0,069R, `SE_diff=0,087`, **z=-0,79 — não significativo**
isoladamente. Mas, como no item 101, o n aumentou (343→385, +42) mesmo
o mecanismo só FECHANDO operações — sinal de que o mesmo efeito de vaga
liberada (`assetActiveOps`) está presente aqui também: encerrar uma
operação mais cedo libera a vaga do ativo pra um sinal novo entrar antes
do que entraria sem o flag.

### O achado real — contrafactual pareado por ID de operação

Como os dois relatórios rodam na MESMA janela/carteira, o `id` da
operação é determinístico (símbolo+timeframe+lado+candle) — dá pra
casar a MESMA operação exata nos dois relatórios, isolando o efeito
causal do resto do ruído de composição. Este é um método novo nesta
sessão, mais forte que a comparação agregada usada até aqui quando os
dois relatórios compartilham janela/carteira.

Das 95 operações fechadas pelo mecanismo no relatório "ligado"
(`arbitration_reason: 'same_cascade_opposite_direction_invalidate'`),
**81 existem também no relatório "desligado"** — a mesma operação
exata, único diferencial é a flag:

| | Com invalidação (ligado) | Sem invalidação (desligado, mesma operação) |
|---|---|---|
| R médio (n=81, pareado) | **-0,789R** | **-0,651R** |

Diferença pareada = **-0,138R**. 48 das 81 operações ficaram PIORES com
a invalidação, só 33 ficaram melhores.

### Correção (2026-08-18, review externa Codex, PR #207) — significância recalculada com a ferramenta certa

A primeira versão deste item computou o erro-padrão pareado como se as
81 diferenças fossem independentes (t=-2,19), **sem aplicar a própria
ferramenta de correlação (item 97) que esta sessão construiu
justamente pra não cometer esse erro** — mesmo tipo de dado (múltiplas
janelas de operação sobrepostas, vários símbolos) onde os itens 97-99
já mediram DEFF≈3 (N efetivo ≈ N/3). Achado do Codex, procedente.

Recomputado com `backtest-correlation-check.mjs` sobre as 81 diferenças
pareadas (clusterizando por sobreposição temporal, mesma metodologia
Cameron-Miller CR1 já usada nos itens 97-99):

| Método | Erro-padrão | t |
|---|---|---|
| Ingênuo (i.i.d., versão original) | 0,0632 | -2,186 |
| Em cluster (G=24, tamanho médio 3,38) | 0,0689 | **-2,005** |

Achado extra, não previsto: o DEFF real aqui é **1,19**, bem menor que
o ≈3 medido em R bruto (itens 97-99) — e o teste de permutação confirma
que esse DEFF pequeno não se distingue de ruído (p=0,2047, dentro do
intervalo do nulo). Leitura: a estimativa "reduziria pra t≈1,26"
(aplicando o DEFF≈3 de R bruto direto à diferença pareada)
**superestimou a correção necessária** — diferenças pareadas cancelam
boa parte do movimento de mercado COMUM aos dois lados da comparação (a
mesma operação, com e sem o flag, herda o mesmo movimento de preço até
o ponto em que divergem), que é justamente a componente que a
correlação entre ativos infla. Não inventa a correção certa por
analogia — precisa medir a série específica que está sendo testada, não
reusar automaticamente um número de outro contexto (regra prática
confirmada por este episódio: até um "efeito 10x menor" precisa ser
medido, não estimado).

### Segunda correção (2026-08-18, review externa Codex #2, PR #208) — a referência certa é t(G-1), não z, e o veredito muda

A tabela acima comparou `|t|=2,005` contra o limiar z=1,96 (a mesma
convenção documentada como limitação deliberada em
`backtest-correlation-check.mjs`) e chamou de "significativo, raspando".
**Errado**: erro-padrão em cluster com G baixo tem que ser comparado
contra uma t-Student com `df=G-1`, não contra a normal — prática padrão
da literatura (Cameron-Miller) que o próprio comentário do script já
citava como ressalva, mas que esta análise não aplicou na hora de tirar
o veredito. Com G=24, `df=23`, o crítico bicaudal a 5% é
**t(23)=2,069** — não 1,96. `|t|=2,005 < 2,069`: **não passa**.

Consequência da ferramenta (`scripts/backtest-correlation-check.mjs`,
função nova `studentTCritical95`, testada contra a tabela t padrão em
`backtest-correlation-check.test.mjs`): `analyzeReport`/`formatMarkdown`
agora reportam o IC95 em cluster também com a referência t-Student
correta, lado a lado com o z=1,96 antigo (mantido só pra comparação com
o IC ingênuo) — a "raspada" que a primeira versão deste item chamou de
significativa nunca teria passado se a ferramenta já reportasse a
coluna certa por padrão.

Achado complementar do mesmo review: a família `arb-invalidate-sametf-
hypothesis` tem N=2 registros no ledger (`docs/backtest-trial-registry.
json`) — `bonferroniZ(2)≈2,241`, também acima de `|t|=2,005`. Aplicar
essa correção especificamente a este teste é mais discutível (o N=2 aqui
é 1 controle + 1 tratamento do MESMO comparativo, não 2 hipóteses
independentes competindo — diferente do uso já estabelecido do registro,
ex. item 90 `exit-runner-fix` N=3 com 3 tratamentos distintos), mas não
precisa ser resolvido: a correção t(G-1) sozinha já derruba o veredito,
então a questão do Bonferroni fica sem efeito prático aqui.

**Veredito revisado: INCONCLUSIVO.** O ponto estimado continua negativo
(-0,138R pareado, -0,79R vs -0,65R) e consistente com a hipótese teórica
de causalidade invertida (item 45.9) e com os 91% de STOP_HIT no mundo
desligado — mas a diferença **não passa** no teste de significância
correto (t(23), nem no Bonferroni de família). G=24 é justamente o
regime que o comentário original do script já apontava como "pouco
confiável sozinho" — aqui a instabilidade decidiu o veredito na direção
oposta à que a 1ª correção (2026-08-18, PR #207) tinha concluído.

**O motivo**: no mundo "desligado", **74 das 81 operações (91%) bateram
STOP_HIT de qualquer jeito** — quase todas já estavam condenadas antes
do mecanismo interferir. Isso confirma exatamente a causalidade
invertida já suspeitada e registrada no item 45.9/91/92/93: o sinal
oposto forte que dispara a invalidação chega DEPOIS que o preço já
andou contra a posição, então não é um alerta preventivo — é um
indicador coincidente de uma operação que já ia perder de qualquer
jeito. E, em vez de deixar o stop já calibrado (nível estrutural/ATR)
fazer o trabalho dele, a saída por invalidação sai num preço pior em
média (-0,79R contra -0,65R) — plausivelmente porque dispara sobre o
preço corrente no momento em que o sinal oposto é forte o bastante
(já depois de mais movimento contrário) em vez do nível de stop
pré-calculado mais próximo da entrada.

### Leitura (fato × hipótese × recomendação)

**Fato**: para as 81 operações pareadas onde o mecanismo realmente age,
o R médio piorou (-0,79R contra -0,65R) e 74 das 81 (91%) já bateriam
STOP_HIT de qualquer jeito no mundo desligado. **Isso é medição direta,
não depende de teste de significância.** Já a alegação de que essa
piora é "estatisticamente significativa" **não sobrevive** à referência
correta pro erro-padrão em cluster (t(23)=2,069 > |t| medido=2,005) —
com G=24 clusters, não dá pra descartar que a diferença pareada seja
ruído de amostra pequena.

**Hipótese**: a suspeita de causalidade invertida do item 45.9,
carregada por 3 itens seguidos (91/92/93) como ressalva teórica não
testada, ganhou um sinal direcional consistente nesta medição — mas
**continua sendo hipótese**, não achado confirmado estatisticamente. O
argumento mais forte a favor dela aqui não é o teste-t (que falhou), é
a leitura qualitativa: 91% das operações que o mecanismo toca já
estavam condenadas (STOP_HIT) antes dele agir, o que é consistente com
"o sinal oposto chega tarde demais pra ajudar" independente do teste de
significância.

**Recomendação**: **não ativar `arbInvalidateOnOppositeSameTf` por
enquanto** — mas por ausência de evidência a favor (nenhuma medição até
hoje mostrou melhora, e o ponto estimado é negativo nas duas
comparações), não por "confirmado que piora". Diferente do item 71
(SELL-only), que tem um critério pré-registrado e um holdout genuíno
batendo inconclusivo, aqui a leitura correta é: **medição única,
inconclusiva, direção sugestiva mas não comprovada** — reabrir só faz
sentido com uma 2ª medição independente (janela/carteira nova) que
aumente G o suficiente pra um teste com poder real, não reanalisando os
mesmos 81 pares de novo.

### Nota de método (reaproveitável em trials futuros)

Quando dois relatórios compartilham janela/carteira, **casar operações
por `id` determinístico** dá um contrafactual pareado real — mais forte
que `SE_diff` sobre médias agregadas (que continua sendo o certo quando
os relatórios NÃO compartilham as mesmas operações exatas, caso mais
comum). **Correção do Codex #1 incorporada à regra**: mesmo um
contrafactual pareado precisa passar pela correção de correlação
(`backtest-correlation-check.mjs`) antes de virar veredito — não dá pra
assumir que diferenças pareadas herdam automaticamente o DEFF≈3 já
medido pra R bruto (aqui saiu bem menor, 1,19, porque a diferença
cancela a componente de mercado comum aos dois lados) nem que herdam
independência total — tem que medir a série específica. **Correção do
Codex #2 incorporada à regra**: erro-padrão em cluster com G baixo
precisa de referência t-Student (`df=G-1`), não z=1,96 — a diferença é
pequena a maior parte do tempo, mas decisiva perto do limiar (foi
decisiva aqui: `t=-2,005` "passa" contra z=1,96, mas não contra
t(23)=2,069). A ferramenta agora reporta as duas colunas
(`clusteredCI` em z, `clusteredCIStudentT` em t) — usar sempre a coluna
t-Student pra decidir significância, nunca só a z.

### Verificação

2 relatórios reais, registrados via `backtest-trial-registry.mjs
--family arb-invalidate-sametf-hypothesis` (N=2). Pareamento via script
Node ad-hoc sobre `overall.curve` dos dois relatórios, casando por
`op.id`. Significância recomputada com `backtest-correlation-check.mjs`
(erro-padrão em cluster + teste de permutação + `studentTCritical95`
novo, testado contra a tabela t padrão em
`backtest-correlation-check.test.mjs`) sobre as diferenças pareadas,
reusando/estendendo as funções já testadas do item 97 em vez de
reimplementar. Única mudança de código: a extensão do script de
diagnóstico (não toca `backtestEngine.js`/`scanner.js`/`pineConfig` —
nenhuma mudança de comportamento de produção ou de backtest).

## 104. `rfStructuralStopEnabled` medido — 1ª medição CONFUNDIDA por um teto não tier-aware (corrigido no código, item 102); re-run limpo dá sinal negativo direcional, mas G=8 baixo demais pra confirmar estatisticamente (2026-08-18, corrigido/completado 2026-08-18)

### Contexto

A/B do item 102 rodado: controle reaproveitado (`buy-regime-filter-off-
baixa2025`, item 100) + `rf-structural-stop-on-baixa2025`, mesma janela
`2025-07-27→2026-07-27`, carteira de 20 símbolos.

### Resultado — número de topo

| | Desligado | Ligado |
|---|---|---|
| n | 343 | 395 |
| Expectância líquida | -0,041R | -0,107R |
| Win rate | 41,1% | 39,7% |
| IC95 | [-0,167; 0,085] | [-0,226; 0,011] |

Delta = -0,066R, `SE_diff=0,088`, **z=-0,75 — não significativo**
isoladamente. n subiu 343→395 (+52, +15%) mesmo o mecanismo só mudando
o STOP — mesmo efeito de vaga liberada (`assetActiveOps`) já visto nos
itens 101/103: um stop diferente muda a duração média da operação, que
muda quando a vaga do ativo libera pra próxima entrada.

### Contrafactual pareado por ID de operação

336 das 395 operações do trial "ligado" existem também no "desligado"
(85% — confirma que o mecanismo realmente só muda a SAÍDA: a imensa
maioria das entradas é idêntica, a diferença de n vem do efeito de vaga
liberada sobre a minoria restante).

| | Com stop estrutural (ligado) | Com stop ATR (desligado, mesma operação) |
|---|---|---|
| R médio (n=336, pareado) | **-0,066R** | **-0,030R** |

Diferença pareada = **-0,036R**. 227 das 336 pioraram, 109 melhoraram.

| Método | Erro-padrão | t |
|---|---|---|
| Ingênuo (i.i.d.) | 0,0456 | -0,782 |
| Em cluster (G=32, tamanho médio 10,50) | 0,0554 | **-0,643** |

t crítico correto (t-Student, df=31) = **2,040** — `|t|=0,643` fica bem
abaixo. **Não significativo por nenhuma medida.** DEFF=1,48; teste de
permutação p=0,092 (perto do limiar de 10%, mas não confirma a
correlação com confiança convencional).

### Correção (2026-08-18, review externa Codex, PR #209) — a explicação original estava errada: o teto NÃO era por-tier

A leitura original deste item classificava `structural_capped`/
`atr_fallback` (95% da amostra) como "colapsa de volta pro comportamento
ATR antigo" — **errado**. `computeStructuralStop` chamado pelo ramo
ligado usava um teto FIXO de 2,0×ATR (`maxAtrMult` default), mas o ramo
DESLIGADO usa `tf4hData.tier?.atrStopMult` — 2,0/2,5/3,0×ATR pra
T1/T2/T3. Cruzando `initial_stop_basis` com o `tier` de cada operação:

| Tier | `atrStopMult` do ramo desligado | n (trial ligado) | % da amostra |
|---|---|---|---|
| T1 | 2,0×ATR (== teto fixo usado) | 8 | 2,0% |
| T2 | 2,5×ATR | 35 | 8,9% |
| T3 | 3,0×ATR | 352 | 89,1% |

**89% da amostra é T3.** Pra essas 352 operações, `structural_capped`/
`atr_fallback` (a maioria delas) usaram um stop capado em 2,0×ATR
enquanto o ramo desligado teria usado 3,0×ATR — **um terço mais
apertado**, não "o mesmo comportamento antigo". O mesmo vale, em menor
grau, pro T2 (2,0× contra 2,5×, 11% mais apertado). Só as 8 operações T1
(2%) realmente reproduziam o comportamento antigo quando capadas/em
fallback. **A afirmação "95% colapsa pro comportamento antigo" estava
errada — pra 98% da amostra (T2+T3), o trial testava, sem intenção,
"ATR mais apertado" e não "estrutural vs ATR".**

**Corrigido no código** (`scanner.js`, ver item 102): `maxAtrMult` agora
usa o mesmo `tf4hData.tier?.atrStopMult` do ramo desligado. **O trial já
medido (`rf-structural-stop-on-baixa2025`) foi rodado ANTES desta
correção e está confundido** — o -0,036R pareado abaixo mistura o
efeito real de "estrutural vs ATR" com o efeito não intencional de "ATR
mais apertado pra T2/T3". Não é possível decompor os dois a partir
deste relatório sozinho (não há como saber, sem re-rodar, quanto do
-0,036R vem de cada componente). **Recomendação: re-rodar o trial sob o
código corrigido antes de tirar qualquer conclusão sobre a hipótese
"stop estrutural" em si** — os números abaixo ficam registrados como
diagnóstico do bug, não como medição válida do mecanismo.

### O que os dados (confundidos) mostraram

`TradeOperation.initial_stop_basis` (o campo de auditoria que o item 102
adicionou de propósito) — das 395 operações do trial ligado:

| `initial_stop_basis` | n | % |
|---|---|---|
| `structural_capped` (nível real longe demais, capado no teto — 2,0×ATR fixo, o bug) | 319 | 81% |
| `atr_fallback` (sem swing válido, caiu no ATR — também 2,0×ATR fixo, o bug) | 56 | 14% |
| `structural` (nível genuíno, nem capado nem flooreado — não afetado pelo bug) | 14 | 3,5% |
| `structural_floored` (nível perto demais, elevado ao piso 0,5×ATR — não afetado pelo bug) | 6 | 1,5% |

### Leitura (fato × hipótese × recomendação)

**Fato**: o trial medido (-0,036R pareado, não significativo — t=-0,64
em cluster contra t(31)=2,040 crítico) não pode ser atribuído
limpamente à hipótese "stop estrutural" — 98% da amostra também sofreu
um aperto de stop não intencional (teto fixo 2,0×ATR em vez do
`atrStopMult` do tier). Mesmo sem essa confusão, o efeito medido já não
era significativo, então a conclusão prática (não ativar, sem evidência
de melhora) não muda — mas a EXPLICAÇÃO do porquê ("colapsa pro
comportamento antigo") estava errada, e uma medição limpa da hipótese
real continua pendente.

**Hipótese**: com o teto corrigido (tier-aware), a fração de operações
`structural_capped`/`atr_fallback` que reproduzem fielmente o
comportamento antigo deve subir bastante — o próximo trial deveria
produzir um contraste mais limpo entre "estrutural" (as poucas
operações com nível genuíno) e "ATR antigo de verdade" (agora
corretamente reproduzido nos casos capados/fallback).

**Recomendação**: **não ativar** (sem evidência de melhora, efeito não
significativo mesmo confundido) — e **não reusar os números deste
trial** como medição da hipótese "estrutural vs ATR": re-rodar
`rf-structural-stop-on-baixa2025` sob o código corrigido (commit que
inclui a correção do item 102) é o próximo passo antes de qualquer
decisão nova sobre este mecanismo.

### Re-run sob o código corrigido (2026-08-18) — sinal negativo confirma direção, mas G=8 é baixo demais pra confiar na significância

`rf-structural-stop-on-baixa2025-tierfix` rodado (mesmo controle, mesma
janela/carteira), commit `72152dc` (já com o teto tier-aware).
**Confirmação de que o fix funcionou**: spot-check de uma operação T3
`structural_capped` dá distância/ATR = 3,000 (não mais 2,000) — o teto
agora usa mesmo o `atrStopMult` do tier. `initial_stop_basis='structural'`
(nível genuíno) subiu de 3,5% (14/395, trial com bug) pra **9,9%
(34/345)** — o teto mais largo pra T2/T3 dá mais espaço pro nível real
de swing caber dentro da faixa antes de ser capado, exatamente o
esperado.

| | Desligado (controle) | Ligado (tierfix) |
|---|---|---|
| n | 343 | 345 |
| Expectância líquida | -0,041R | -0,086R |
| IC95 | [-0,167; 0,085] | [-0,211; 0,040] |

Top-line: delta=-0,044R, `SE_diff=0,091`, z=-0,49 — não significativo
isoladamente.

**Contrafactual pareado**: 334/345 (97%) casam com o controle.

| | Com stop estrutural (tierfix) | Controle (mesma operação) |
|---|---|---|
| R médio (n=334, pareado) | **-0,070R** | **-0,027R** |

Diferença pareada = **-0,043R** (176 piores, 137 melhores, 21 empate).
t ingênuo=-2,51 (passaria até no z=1,96 ingênuo). Em cluster: **G=8**,
tamanho médio de cluster 41,75 — bem abaixo do piso de confiabilidade
que a própria ferramenta já sinaliza (<20), e o G mais baixo medido
nesta sessão até agora (itens 97-105 sempre tiveram G≥21). Erro-padrão
em cluster=0,0161, t=-2,67, "passa" contra o crítico t(7)=2,365 — **mas
esse veredito não é confiável nesse G**: a literatura que fundamenta o
CR1 (Cameron-Gelbach-Miller, a mesma citada no cabeçalho do script)
recomenda bootstrap wild-cluster pra G tão baixo, que esta ferramenta
não implementava até esta rodada; com só 8 "observações" efetivas pra
estimar a variância entre clusters, o próprio erro-padrão em cluster é
instável.

### Correção (2026-08-18, review externa Codex, PR #210) — o teste de permutação errado foi usado pra julgar significância

A leitura original citou `permutationTest` (p=0,132, "estrutura de
correlação não se distingue de ruído") como se isso invalidasse a
significância do efeito — **erro de categoria apontado pelo Codex**:
`permutationTest` (item 97) testa se o **DEFF** medido excede o que um
deslocamento circular de calendário produziria por acaso; ele não tem
hipótese nula sobre a MÉDIA. Um p-valor alto ali só diz "não dá pra
confirmar que a correção por cluster está bem calibrada" — não diz nada
sobre se o efeito em si é zero. Tomados ao pé da letra, os dois testes
efetivamente reportados (ingênuo t=-2,51, cluster t=-2,67) **rejeitam
zero**, contradizendo a conclusão "não confirmado" que a leitura
original tirou de um teste que respondia outra pergunta.

**Corrigido com a ferramenta certa**: nova função `clusterSignFlipTest`
(`backtest-correlation-check.mjs`) — teste de randomização cujo nulo É
sobre a média: inverte o sinal de todos os valores de cada cluster
JUNTOS (preserva a correlação intra-cluster), sorteia um padrão de
sinais por cluster, recomputa a média, repete. Com G=8, dá pra enumerar
os 2⁸=256 padrões possíveis — **p-valor EXATO**, não aproximado, e
válido pra qualquer G (ao contrário do CR1, que degrada com G baixo).

**Resultado**: `clusterSignFlipTest` nas 334 diferenças pareadas (G=8,
enumeração exaustiva) — **p=0,156**. **Não significativo.** A conclusão
prática da leitura original ("não confirmado") sobrevive, mas agora com
o teste certo por trás — o teste de permutação de DEFF nunca deveria
ter sido citado como evidência disso.

**Checagem independente por símbolo** (não depende de nenhuma matemática
de cluster, serve de triangulação adicional): dos 20 símbolos pareados,
**11 tiveram diferença média negativa, 6 positiva, 3 ~zero** — direção
majoritariamente negativa, mas longe de unânime. A magnitude agregada é
puxada por um punhado de símbolos (XRPUSDT -0,261R, ARBUSDT -0,178R,
AAVEUSDT -0,137R, ETHUSDT -0,104R, DOTUSDT -0,078R), não um efeito
uniforme em toda a carteira — consistente com o `p=0,156` do teste
correto (efeito não confirmado, majoritário mas não universal).

### Leitura final (fato × hipótese × recomendação)

**Fato**: com o código corrigido (teste válido pra qualquer G), o ponto
estimado do contrafactual pareado é negativo (-0,043R), mas o teste de
randomização correto (`clusterSignFlipTest`, p=0,156, exaustivo sobre
G=8) **não rejeita a hipótese nula de efeito zero**. Os testes ingênuo
(t=-2,51) e em cluster CR1 (t=-2,67) formalmente "passam", mas o CR1
não é confiável nesse G e o ingênuo ignora a correlação entre símbolos
— nenhum dos dois é o teste certo aqui; o `clusterSignFlipTest` é. A
checagem por símbolo (11/20 negativos) reforça a leitura de "sinal
majoritário, não confirmado".

**Hipótese**: stops mais largos (T2/T3 agora usando 2,5×/3,0×ATR de
verdade, não mais 2,0× capado) parecem, direcionalmente, piorar o
resultado — possivelmente porque um stop mais largo dá mais espaço pro
preço reverter antes de ser interrompido, sem um ganho compensatório
equivalente (TP1/TP2 escalam no mesmo R, então o múltiplo de risco não
muda, só a distância absoluta). Mas isso é leitura qualitativa, não
achado estatístico confirmado.

**Recomendação**: **não ativar** — a direção do sinal é negativa tanto
no trial original (confundido pelo bug, descartado como medição válida)
quanto no re-run limpo (top-line E contrafactual pareado, que são DUAS
LEITURAS do MESMO re-run, não duas medições independentes — o único
dado novo aqui é o re-run em si), mas nenhuma leitura alcança confiança
estatística com o teste correto. Não é "confirmado que piora" — é
"nenhuma evidência de melhora, com sinal direcional negativo recorrente
que não chega a ser conclusivo". Reabrir exigiria uma medição
independente nova (janela/carteira diferente, idealmente com clusters de
sobreposição menos concentrados — G maior), não repetir a mesma janela.

### Verificação

3 relatórios reais (`backtest-trial-registry.mjs --family
rf-structural-stop-hypothesis`, N=3 — Bonferroni z=2,394, todos
inconclusivos isoladamente; o 1º é diagnóstico do bug, não medição
válida). Pareamento por `op.id` via script Node ad-hoc; significância
via `backtest-correlation-check.mjs` (`clusterRobustStdErr` +
`studentTCritical95` + `clusterSignFlipTest`, o teste do EFEITO, não do
DEFF), mais uma checagem independente por símbolo (média simples por
`op.symbol`, sem depender de nenhuma matemática de cluster).
`initial_stop_basis`/`tier` lidos direto do `TradeOperation` de cada
operação do relatório. Confound original identificado e código
corrigido (`scanner.js`, `maxAtrMult: ATR_MULT`) com 2 testes novos de
regressão (T3 tier-aware) em `scannerStateMachine.test.js`.
`clusterSignFlipTest` nova, testada (5 casos: valor exato calculado à
mão, sem efeito, efeito forte, G<2, exaustivo vs. Monte Carlo,
determinismo) em `backtest-correlation-check.test.mjs`. `npm run lint
&& npm test -- --run` (1042/1042) e os 4 alvos de build
(`build`/`build:scan`/`build:scan-shadow`/`build:backtest`) limpos.

## 105. `preTp1StopProtectionEnabled` medido — protege capital como desenhado, mas o efeito no subconjunto onde realmente ativa é pequeno e não significativo (2026-08-18, corrigido 2026-08-18)

### Contexto

A/B do item 53/54 finalmente rodado: mesmo controle (`buy-regime-filter-
off-baixa2025`) + `pretp1-breakeven-on-baixa2025`, mesma janela
`2025-07-27→2026-07-27`, 20 símbolos, `preTp1StopProtectionAtrMult` no
default (1,0×ATR).

### Resultado — número de topo

| | Desligado | Ligado |
|---|---|---|
| n | 343 | 404 |
| Expectância líquida | -0,041R | -0,038R |
| Win rate | 41,1% | 22,3% (ver explicação abaixo — não é piora real) |
| IC95 | [-0,167; 0,085] | [-0,128; 0,051] |

Delta = +0,003R, `SE_diff=0,079`, **z=0,04 — efetivamente zero**
isoladamente. n subiu 343→404 (+61, +18%), mesmo efeito de vaga
liberada dos itens 101/103/104.

**O win rate caindo pra 22,3% NÃO é o mecanismo piorando** — é um
artefato de como `wins`/`losses`/`be` são contados: `be` (breakeven)
saltou de **3 (controle) para 160 (ligado)**, de 404 operações. Isso é
exatamente o mecanismo funcionando como desenhado: operações que
teriam fechado com perda agora fecham em 0R (breakeven), o que não
conta como "win" — derruba o win rate nominal sem representar piora
nenhuma (breakeven é estritamente melhor que perda). `avgLossR` das
perdas que restaram caiu de 0,993R pra 0,886R (-11%) — as perdas que
ainda acontecem são um pouco menores, também consistente com o desenho.

### Contrafactual pareado por ID de operação

342 das 404 operações do trial "ligado" existem também no "desligado"
(85%). **182 dos 342 pares (53%) são EMPATE exato** (diferença = 0).

### Correção (2026-08-18, review externa Codex, PR #209) — "empate" não é a mesma coisa que "gatilho não disparou"

A leitura original assumiu que os 182 empates significavam "o gatilho
nunca ativou nesses pares" e tratou os 160 pares não-empatados como "o
subconjunto onde o mecanismo realmente agiu" — **os dois erros
apontados pelo Codex**:

1. `buildReport` expõe `preTp1StopProtection.advanced` (por relatório) e
   cada operação carrega `pre_tp1_stop_advanced_at` (não-nulo quando o
   stop realmente avançou pra breakeven) — a fonte certa pra saber se o
   mecanismo ativou, não o sinal indireto de "a diferença de R deu zero".
   Uma operação PODE avançar o stop e ainda assim fechar idêntica ao
   controle (ex.: atinge TP1 depois de avançar — o nível de stop nunca
   chega a ser testado). Recontando pelos 342 pares usando o campo real:
   **226 (66%) tiveram o stop avançado**, não 160. Desses 226: 69
   fecharam empatados mesmo assim (avançou mas TP1/TP2 saiu antes do
   stop importar), 157 tiveram diferença real. E 3 dos pares
   NÃO-empatados nem tinham `advanced` marcado — ruído pequeno, não
   investigado (n=3, irrelevante pro resultado).
2. **Erro aritmético**: o texto original relatou "+0,025R... contabilizando
   só as 160 operações não-empatadas" — mas +0,025R é a média sobre os
   **342 pares inteiros** (zeros inclusos), não sobre o subconjunto. A
   média condicional certa, recalculada com o campo `advanced` real
   (n=226, não 160): **+0,038R**.

| | Todos os 342 pares (inclui zeros) | Só pares com `advanced=true` (n=226) |
|---|---|---|
| Diferença pareada média | +0,025R | **+0,038R** |
| Erro-padrão ingênuo | 0,0399 | 0,0603 |
| G (clusters) / tamanho médio | 21 / 16,3 | 26 / 8,7 |
| Erro-padrão em cluster | 0,0269 | 0,0554 |
| t em cluster | 0,927 | **0,680** |
| t crítico (t-Student, df=G-1) | 2,086 | 2,060 |

**Não significativo em nenhum dos dois recortes.** DEFF no subconjunto
`advanced=true` = 0,844 (mais perto de 1 que o 0,455 do pool completo,
como esperado — menos zeros artificiais suprimindo a variância
compartilhada); teste de permutação p=0,439.

### Leitura (fato × hipótese × recomendação)

**Fato**: o mecanismo faz exatamente o que foi desenhado pra fazer
(operações que andaram a favor cedo e depois reverteriam pra perda
fecham em breakeven em vez de perda plena — `be` salta 3→160 de 404,
e o stop avançou de verdade em 226 das 342 operações pareadas, 66% —
taxa de ativação bem mais alta do que a 1ª leitura sugeria). O efeito
condicional a essa ativação é **+0,038R** (não os +0,025R
originalmente citados, que eram a média não-condicional) — ainda
levemente positivo, ainda não significativo.

**Hipótese**: o achado do item 53 que motivou este mecanismo (61/117
operações positivas cedo, MFE +0,578R, erodindo sem proteção) continua
válido como observação — a proteção testada aqui é conservadora o
bastante (gatilho em 1,0×ATR de movimento favorável, de propósito, ver
item 54) que ela protege capital sem necessariamente capturar ganho
extra, o que é consistente com um efeito agregado pequeno mesmo que a
lógica esteja correta.

**Recomendação**: **não ativar ainda** — mas, diferente do item 103/104
(sinal negativo), aqui não há evidência CONTRA também: é um mecanismo
que reduz risco de cauda (perdas viram breakeven) sem custo detectável
na expectância, com uma taxa de ativação real de 66% (não 47% como a
1ª leitura media indiretamente). Se a linha for retomada, testar
`preTp1StopProtectionAtrMult` menor (ex.: 0,5×, gatilho mais cedo) numa
amostra maior faz sentido — usar sempre `preTp1StopProtection.advanced`/
`pre_tp1_stop_advanced_at` como fonte de ativação, nunca inferir pelo
sinal da diferença pareada.

### Verificação

2 relatórios reais (`backtest-trial-registry.mjs --family
pretp1-breakeven-baixa2025-hypothesis`, N=2 — Bonferroni z=2,241, ambos
inconclusivos isoladamente). Pareamento por `op.id`; significância via
`backtest-correlation-check.mjs` (mesmas funções do item 104), recomputada
usando `TradeOperation.pre_tp1_stop_advanced_at` (não o sinal da
diferença pareada) pra segmentar o subconjunto onde o mecanismo
realmente ativou. `wins`/`losses`/`be`/`preTp1StopProtection.advanced`
lidos direto de `report.overall`/`report.preTp1StopProtection` dos dois
relatórios. Diferente do item 104, aqui o mecanismo em si (código) não
tinha bug — só a análise original inferiu ativação pelo sinal errado e
cometeu um erro aritmético na média condicional. Nenhuma mudança de
código de produção.

## 106. Causa real da "semana sem operação ao vivo": cota diária do Firestore (Spark grátis) estourando — não é problema de estratégia (2026-08-19)

### Contexto

Depois de uma extensa investigação estatística (itens 100-105) sem achar
nenhuma alavanca de melhora, usuário questionou se havia algum jeito de o
projeto "começar a ter resultado" — semanas sem nenhuma operação nova ao
vivo, mesmo com o motor supostamente funcionando. Investigação de um caso
específico (FETUSDT, ver item 67) levou a checar os Logs do Sistema ao
vivo — e o achado ali foi bem mais simples e mais grave que qualquer
hipótese estatística cogitada até aqui.

### Achado — cota gratuita do Firestore estourando continuamente

Usuário trouxe um print dos Logs (66 registros ERR entre 18:41 e 21:10 de
um único dia): a esmagadora maioria são `"8 RESOURCE_EXHAUSTED: Quota
exceeded."` — o formato de erro gRPC padrão do Firestore quando a cota
diária do plano Spark (gratuito: 50k leituras / 20k escritas / dia)
estoura. **Todos os ativos monitorados** aparecem no log com esse mesmo
erro, repetido a cada passada do cron (~5min): BTCUSDT, ETHUSDT, SOLUSDT,
ARBUSDT, NEARUSDT, DYDXUSDT, PAXGUSDT, PENDLEUSDT, CRVUSDT, ENAUSDT,
METISUSDT, ETHFIUSDT — não é um problema pontual de um ativo, é sistêmico.
Adicionalmente, `acquireScanLock` (`src/api/entities.js:149`) também
falha pelo mesmo motivo (`"Falha ao adquirir lock 'full-scan'"`,
repetido dezenas de vezes) — mesmo a operação MAIS barata do scan (tentar
pegar um lock) não consegue completar.

**Isso já era um risco conhecido e parcialmente mitigado (item 13)**:
uma auditoria anterior já tinha encontrado que, com **10**
ativos monitorados, a estimativa de escrita diária já passava de 90% do
limite gratuito, mesmo depois de cortar desperdício real (busca dupla de
`getPineConfig`, log incondicional de "scan completo", checagem de
operação ativa repetida 4x/ativo, queries sem corte de histórico). Um
guard de aviso foi adicionado (`scanner.js:4074-4100`) — projeta o uso da
passada atual pra um dia inteiro (312 passadas/dia: 288 do disparo
externo cron-job.org a cada 5min + 24 do fallback horário do GitHub
Actions, ver item 18) e grava um `logWarn` no Debug Log se o projetado
passar de 80% do limite (16.000 escritas/dia).

**Hoje há 14 ativos monitorados** (usuário confirmou) — 40% a mais que os
10 que já tinham motivado o item 13. Extrapolando a mesma taxa de escrita
por ativo medida naquela auditoria (~90%/10 ativos ≈ 9%/ativo do limite
de 20k, ou seja ~1.800 escritas/ativo/dia projetadas), 14 ativos
projetariam **~25.200 escritas/dia — 126% do limite gratuito**. Bate com
o observado: no dia do print, o estouro já estava acontecendo por volta
das 18h-21h e provavelmente bem antes (o log só guarda uma janela
recente, "Limpar antigos" indica rotação).

### Leitura (fato × hipótese × recomendação)

**Fato**: a cota gratuita do Firestore está estourando de forma
sistemática, todo dia, afetando TODOS os ativos monitorados — quando isso
acontece, o scan não consegue gravar `SignalEvent`/`TradeOperation`/
`AssetState` novos, então **nenhuma operação nova pode ser criada
enquanto durar o estouro**, independente de o sinal ter edge ou não. Isso
explica a "semana sem operação" de forma muito mais direta e completa do
que qualquer hipótese estatística testada nos itens 100-105.

**Hipótese**: o crescimento de 10→14 ativos monitorados (sem revisar a
capacidade do plano gratuito) é a causa mais provável do estouro — o guard
de 80% (item 13) deveria ter avisado no Debug Log antes de virar erro
franco; não confirmado aqui se o aviso apareceu e passou despercebido, ou
se o crescimento foi rápido o suficiente pra pular direto de "ok" pra
"estourando" entre duas leituras do painel.

**Recomendação**: reduzir carga sobre o Firestore antes de qualquer outra
mudança — é a alavanca de maior impacto disponível, e não exige nenhuma
mudança de código. Duas opções (ver conversa para a escolha do usuário):
(a) reduzir o número de ativos monitorados de volta pra perto de 8-10; ou
(b) reduzir a frequência do disparo externo (hoje ~5min via cron-job.org,
item 18) — as duas juntas dão mais folga. Não decidido nesta rodada.

### Verificação

Diagnóstico feito por leitura direta dos Logs do Sistema em produção
(prints do usuário) — não é possível reproduzir localmente (rede desta
sessão não alcança o Firestore de produção). Nenhuma mudança de código
nesta rodada — puro registro do achado.

### Correção (Codex, PR #212)

Duas ressalvas pegas em review, que deixam o achado acima menos completo
do que o texto original dava a entender — a causa raiz (estouro de cota)
continua de pé, mas a conta e o alcance temporal precisam de ajuste.

**1. A conta de 126% ignorou `scan-shadow.yml` — mesmo projeto Firebase,
mesma cota.** O cálculo acima (312 passadas/dia, ~1.800 escritas/
ativo/dia, 14 ativos → ~25.200 escritas/dia) só contou o disparo de
produção (`scan.yml`). Só que `scan-shadow.yml` (`.github/workflows/
scan-shadow.yml`, item 56 — Fase 1 do modo sombra) roda a cada 15min
(**96 passadas/dia**) contra o **mesmo** `FIREBASE_SERVICE_ACCOUNT_JSON`,
ou seja o mesmo projeto Firebase — só redireciona os writes pra coleções
prefixadas `experimentalRf1hShadow*` (`scripts/adminEntitiesShadow.js`),
o que isola as COLEÇÕES mas não a COTA (cota é por-projeto no Spark
grátis, não por-coleção). O comentário do próprio workflow já registrava
essa preocupação de propósito ("compromisso deliberado com a quota
compartilhada... já usada pela produção real"), mas o item 106 original
não somou esse consumo à conta. **Não tenho o custo de leitura/escrita
por-passada do scan sombra medido** (não é o mesmo código do
`scanAllAssetsInner` linha a linha — roda uma variante com
`rf1hCondEnabled` forçado), então não dá pra transformar isso num número
final único sem medir. O que dá pra afirmar com segurança: **os ~25.200/dia
calculados são um piso, não o total real** — o consumo do modo sombra
soma em cima disso, então a folga real acima de 100% da cota é maior (pior)
do que os 126% relatados, não menor. Isso reforça a recomendação de reduzir
carga (não a enfraquece), mas significa que "14 ativos causaram o estouro"
não pode ser afirmado como única causa sem medir separadamente a fatia do
modo sombra — e que **pausar/reduzir a frequência de `scan-shadow.yml`
também deveria entrar como opção de mitigação**, não só reduzir ativos ou
frequência da produção.

**2. A evidência (66 logs, janela de ~2h30 num único dia) não cobre a
semana inteira.** O texto original ("explica a 'semana sem operação' de
forma muito mais direta e completa") generaliza uma amostra de uma janela
de horas para uma afirmação sobre 7 dias. Como a cota do Firestore é
**diária** (reseta a cada dia), o estouro observado nesse dia específico
não prova, por si, que todos os outros dias da semana também estouraram
no mesmo horário ou magnitude — só prova que ESSE dia estourou. **Leitura
corrigida**: a exaustão de cota é um **contribuinte provável e
confirmado** para pelo menos parte da janela sem operação (o dia
documentado), não uma explicação verificada para a semana inteira — até
que se confirme (via Logs do Sistema de mais dias, ou via console do
Firebase → Uso, que mostra o gráfico diário de leitura/escrita) que o
padrão se repete nos outros dias.

**Recomendação atualizada**: antes de decidir só entre "reduzir ativos" e
"reduzir frequência" (pergunta ainda em aberto na seção anterior),
recomendo (a) checar o console do Firebase (Uso → Firestore) pros últimos
7 dias, pra confirmar se o estouro é diário/recorrente ou pontual daquele
dia, e (b) incluir `scan-shadow.yml` no orçamento de qualquer decisão de
redução — pausá-lo ou espaçar mais (ex.: 30min em vez de 15min) libera
cota real da produção sem tocar nos ativos monitorados nem no disparo
principal.

### Otimização de código aplicada (a pedido do usuário, antes de decidir reduzir ativos/frequência)

Antes de qualquer decisão sobre reduzir ativos/frequência, usuário pediu
para investigar se sobrava otimização de código no próprio scan. Auditoria
de `scripts/run-scan.mjs` + `src/lib/scanner.js`:

- **`last_scan_at` não pode ser otimizado** — `persistScanResults`
  (`scanner.js:3722-3735`) já tem comentário explícito: precisa atualizar
  em TODA passada (sucesso ou erro) porque é o campo que o watchdog do
  item 12 ("cron parou de rodar de vez") usa pra distinguir de "este ativo
  está falhando". Mexer aqui quebraria essa proteção — não é candidato.
- **[APLICADO] `SystemLog.create` do catch-block de `scanAllAssetsInner`
  não tinha dedup** (`scanner.js`, branch de erro dentro do loop de
  `scanAllAssetsInner`) — ao contrário do `MonitoredAsset.update` do mesmo
  catch (que só muda campos de status, sempre necessário), esse log
  gravava um documento NOVO a cada passada com erro, mesmo quando é o
  MESMO erro repetindo (exatamente o cenário deste item: 14 ativos,
  `RESOURCE_EXHAUSTED` idêntico, a cada ~5min, por horas). Convertido para
  `SystemLog.createUnique`, mesmo padrão já usado por
  `logDuplicateActiveOpsPriceCheck` (item 39.1) — chave de dedup inclui
  ativo + data (YYYY-MM-DD) + mensagem de erro exata, então: (a) o mesmo
  erro no mesmo ativo no mesmo dia grava só 1 vez (era até ~288x/dia por
  ativo no pico do cron a cada 5min), mas (b) um dia NOVO com o mesmo erro
  ainda gera um log fresco (a data faz parte da chave), preservando
  visibilidade recorrente em vez de silenciar o alerta depois da primeira
  ocorrência para sempre. `createUnique` troca 1 escrita garantida por 1
  leitura garantida + escrita só se for a primeira vez naquele dia — troca
  favorável porque leitura tem muito mais folga (50k/dia) que escrita
  (20k/dia, o gargalo real). Efeito esperado: praticamente elimina a
  amplificação de escritas causada pelo PRÓPRIO log de erro durante um
  estouro de cota prolongado (o log deixa de piorar o problema que está
  reportando).
- **[NÃO APLICADO, candidato secundário de menor valor] `scripts/
  run-scan.mjs:checkAssetHealthchecks()`** roda seu próprio `MonitoredAsset.
  filter({is_active:true})`, redundante com a query idêntica que
  `scanAllAssetsInner` já fez na MESMA passada do cron — uma leitura select
  duplicada, não desprezível mas menos urgente porque leitura tem 2,5x mais
  folga que escrita. Não corrigido nesta rodada: eliminar a redundância
  exigiria mudar o retorno de `scanAllAssets()` pra expor a lista de
  `MonitoredAsset` já buscada, e essa função é compartilhada com o browser
  (`useAutoScan.js`, `TopBar.jsx`) — mudar o contrato de retorno é risco
  desproporcional ao ganho (é leitura, não o recurso estourando). Registrado
  como opção futura, não implementado.

### Remediação aplicada — `scan-shadow.yml` espaçado de 15min para 30min (2026-08-19)

Usuário decidiu: reduzir ativos monitorados (10→já feito, ver seção
anterior) **e** espaçar o modo sombra, as duas mitigações recomendadas na
correção Codex acima. `.github/workflows/scan-shadow.yml`: `cron: "*/15 *
* * *"` → `"*/30 * * * *"` — ~96 → ~48 passadas/dia, reduzindo pela metade
a fatia deste workflow no orçamento compartilhado do Firestore.

**Correção (Codex, PR #214)**: a redação original desta seção invertia a
comparação de cobertura. A cadência de 15min original era **1:1** — o
próprio workflow já descrevia isso ("alinha 1:1 com o próprio candle de
confirmação, nenhum fechamento de 15m fica sem chance de ser visto"), não
"1 de cada 4" (esse 1/4 é a cobertura da cadência HORÁRIA, o pior caso já
descartado quando o workflow foi criado, não a cadência de 15min que
estava valendo até agora). **Leitura correta do trade-off**: ir de 15min
para 30min reduz a cobertura de **todos** os fechamentos de 15m para **1
de cada 2** — uma perda real de metade da amostra intermediária, não uma
melhora de 1/4 para 1/2 como o texto original dava a entender. Ainda assim
bem menos cego que a cadência horária (1/4), que seria a alternativa mais
barata em cota. Reversível sem custo (só o `cron:`) se a folga de cota
ainda não for suficiente. `.github/workflows/scan-shadow.yml`,
`.github/workflows/analyze-shadow.yml` e `.claude/rules/ci-deploy.md`
atualizados para refletir a nova cadência.

### Checagem pós-remediação — ainda não dá pra dizer "resolvido" (2026-08-19)

Usuário perguntou se ainda existe risco de estourar a cota depois das duas
mitigações aplicadas (10 ativos, `scan-shadow.yml` a 30min). Não tenho como
consultar o uso real do Firestore de produção nesta sessão (rede bloqueada,
mesma limitação de sempre) — resposta é extrapolação de código, não
medição direta.

**Fato, com uma ressalva real (Codex, PR #215)**: o item 13 original
registra que, com **10** ativos (o número atual, depois da redução), "a
estimativa diária de escrita já passava de 90% do limite" — mas essa
frase aparece ANTES da lista "Causas corrigidas" no texto original, não
depois. Não está documentado se o 90% foi medido antes ou depois daquelas
correções específicas (double fetch de config, log incondicional,
checagem de op ativa 4x, queries sem filtro) — a leitura mais literal do
texto é que é o número que MOTIVOU os fixes, não o resultado pós-fix. Eu
tinha tratado esse 90% como o baseline atual válido; **isso não está
sustentado** — pode ser um número pré-fix (realidade pós-fix desconhecida,
possivelmente bem menor) ou um número pós-fix só que datado, sem contar
várias otimizações de escrita feitas depois (item 45.3 write-on-change,
o próprio dedup desta rodada, etc.). Sem recomputar a partir da contagem
real de operações por-passada de hoje, não dá pra afirmar que a produção
está em ~90% agora — é hipótese fraca, não fato.

**Hipótese, revisada**: sem um número de baseline confiável para a
produção, não dá pra concluir com confiança se o total (produção + fatia
do `scan-shadow.yml`, mesma cota do projeto) está perto de 100% ou
folgado. O dedup do log de erro (seção acima) só reduz a amplificação
DURANTE um estouro/instabilidade — não muda a taxa de escrita normal, sem
erro — então não afeta essa incerteza num sentido ou noutro.

**Achado incidental (baixa prioridade, não corrigido)**: o guard de aviso
de cota em `scanAllAssetsInner` (`src/lib/scanner.js`) tem
`PASSES_PER_DAY = 312` **hardcoded** — correto pra `scan.yml`, mas
`scan-shadow.yml` roda o MESMO `scanner.js` sem modificação (via
`scanAllAssets()` em `run-scan-shadow.mjs`) a só 48 passadas/dia. O guard
superestima o projetado do modo sombra em ~6,5x, então provavelmente
dispara (falso alarme) em praticamente toda passada do modo sombra,
gravando um `SystemLog.create` extra (via `logWarn`/`bulkCreate`) nas
coleções isoladas — custo real mas pequeno (até ~48 escritas/dia a mais,
~0,24% do limite). **Correção (Codex, PR #215)**: essas escritas extras
NÃO deixam de afetar a produção — consomem a MESMA cota compartilhada do
projeto (o ponto central desta seção inteira), só não mexem em dado de
produção (coleções isoladas). A distinção certa é "não corrompe dado de
produção", não "sem efeito na produção" — sob condição de cota já
apertada, esse desperdício espúrio piora, não é neutro. Não corrigido
nesta rodada — valor baixo pro esforço de parametrizar a constante;
registrado como limpeza futura.

**Recomendação — única forma de saber com certeza**: checar o Console do
Firebase → Uso → Firestore (gráfico diário real de leitura/escrita,
últimos 7 dias) — é a única fonte de verdade que não depende de
extrapolação. **Correção (Codex, PR #215)**: a tela Logs do painel
(`src/pages/Logs.jsx`) lê `backend.entities.SystemLog`, que mapeia pra
`systemLogs` (a coleção real de produção) — os avisos do modo sombra vão
pra `experimentalRf1hShadowSystemLogs`, uma coleção DIFERENTE que o painel
nunca lê. Não existe risco de confundir os dois ali; qualquer aviso que
aparecer na tela Logs já é necessariamente da produção. Pra inspecionar os
avisos (ruidosos, pelo achado acima) do modo sombra especificamente,
seria preciso olhar a coleção isolada direto no Firestore ou a saída do
workflow no GitHub Actions, não o painel. Se o Console do Firebase
confirmar estouro ainda ocorrendo, a próxima alavanca (não aplicada
ainda) é reduzir a frequência do disparo externo do `scan.yml`
(cron-job.org, hoje ~5min, item 18) — maior impacto restante disponível
sem tocar em ativos monitorados de novo.

## 107. Horário real do evento (candle) vs. horário de detecção (scan) — alertas e histórico agora distinguem os dois (2026-08-19)

### Contexto

Pedido explícito do usuário, ao investigar o item 67/106: "precisa ter
algum mecanismo pra quando pegar o alerta ou a entrada/saída/take/loss ele
mostre o horário real que aconteceu". Confirmado por leitura de código:
TODO evento de saída (`stop_hit_at`/`tp1_hit_at`/`tp2_hit_at`/`closed_at`,
`src/lib/scanner.js`) é gravado com `new Date().toISOString()` — o
horário em que a PASSADA do scan detectou a condição, nunca o horário real
de mercado. Sob cadência normal (~5min) a diferença é pequena, mas depois
de um gap de cron (item 106, rede, etc.) o horário gravado pode estar
horas ou dias atrasado em relação ao evento real — exatamente o tipo de
confusão que motivou a investigação do item 67 (comparar "quando fechou no
Sentinel" com "quando fechou no TradingView" sem saber que o primeiro é
detecção, não o evento).

### Mecanismo implementado

**Só o caminho baseado em candle** (`persistScanResults`, os dois blocos
pré/pós-TP1) tem uma referência de horário real disponível —
`tfData.lastCandleTime`, o fechamento do candle que causou a decisão.
`priceCheckActiveOpsInner` (baseado em preço/tick) não tem candle nenhum
para referenciar — ali o `_at` de parede JÁ é a melhor aproximação
disponível, na resolução daquele loop.

- **Campos novos, aditivos, sempre ao lado do `_at` existente** (nunca o
  substituem, então nenhum consumidor existente quebra): `stop_hit_real_time`,
  `tp1_hit_real_time`, `tp2_hit_real_time`, `closed_at_real_time` — só
  gravados nos exits baseados em candle; ausentes (não `null` gravado como
  regressão silenciosa — literalmente omitidos do patch) nos exits
  baseados em tick, então a UI/Telegram sabem distinguir "sem horário real
  disponível" de "horário real igual ao de detecção".
- **`TradeHistory.jsx`**: a Linha do Tempo agora mostra `_real_time` como
  horário principal (cai para `_at` só se `_real_time` ausente) e, quando a
  diferença entre os dois passa de 20min (folga generosa acima da cadência
  normal do cron), acrescenta "(detectado Xh depois)" — o próprio atraso
  vira sinal de diagnóstico visível (gap de cron/quota fica óbvio olhando o
  histórico, sem precisar ler o Debug Log).
- **Telegram** (`src/lib/telegram.js` + espelho `scripts/adminTelegram.js`,
  mesmo padrão de sincronização manual de sempre): `notifyStopHit`/
  `notifyTP1Hit`/`notifyTP2Hit`/`notifyInvalidated`/`notifyTimeStop`/
  `notifyChopExit`/`notifyTradeCreated` ganharam uma linha "🕐 Horário
  real: DD/MM HH:mm BRT" (UTC-3, mesma convenção BRT já usada em
  `TradeHistory.jsx`), omitida quando não há horário real disponível — sem
  dependência nova (formatador de data manual, os dois arquivos já eram
  enxutos/sem `moment`). Entrada usa `getEntryReferenceTime(op)`
  (`opExitRules.js`, já existia para os campos `entry_candle_time_*`) —
  entradas já tinham essa informação, só faltava exibi-la no alerta.
- **`scanner.js`**: os dois pontos de chamada de `notify*` (candle-based e
  tick-based) agora passam o `op` MESCLADO com o `updatePayload` que
  acabou de ser escrito, não mais o `op` pré-transição — sem essa correção
  os `_real_time`/`_at` recém-gravados nunca chegariam à função de
  notificação (ela leria o valor antigo/`undefined`).

### Verificação

`npm run lint && npm test -- --run && npm run build` limpos (1042 testes,
0 regressão — nenhum teste existente fazia match exato do `updatePayload`,
só `toBeTruthy` em `closed_at`). Os 3 alvos esbuild que empacotam
`scanner.js`/`telegram.js` (`build:scan`, `build:scan-shadow`,
`build:backtest`) compilam limpos. Sem teste novo dedicado nesta rodada —
mudança é aditiva (novos campos opcionais + leitura condicional na UI/
Telegram), sem alterar nenhuma transição de estado nem campo existente;
cobertura via os testes de regressão já existentes do state machine
continua válida sem alteração.

### Correção (Codex, PR #213) — 2 achados reais

1. **P2 — `stop_hit_real_time`/`tp1_hit_real_time`/`tp2_hit_real_time` não
   são o instante exato do cruzamento, só um limite superior.** O gate de
   stop/TP1/TP2 é avaliado contra o HIGH/LOW intrabar do candle
   (`stopCheckPrice`/`tpCheckPrice`), não o close — então
   `tfData.lastCandleTime` (o fechamento do candle) só prova que o toque
   aconteceu EM ALGUM MOMENTO dentro daquele candle, podendo ser até ~1
   candle inteiro (4h na cascata RF) antes do valor gravado. A implementação
   original rotulava isso como "Horário real" sem essa ressalva. **Fix**:
   comentário explícito em `scanner.js` documentando o limite; UI
   (`TradeHistory.jsx`) e Telegram (`realTimeLine(iso, isBound)`) agora
   rotulam esses três campos como "🕐 Vela (candle)" em vez de "Horário
   real", com tooltip explicando o porquê na UI. `closed_at_real_time`
   herda a mesma ressalva quando `status === STOP_HIT` ou
   `closed_reason === TP1_FULL`/`TP2_HIT`. INVALIDATION e CHOP_EXIT
   continuam exatos (decisão é sobre o CLOSE do candle, não o range) — sem
   mudança nesses dois.
2. **P2 — `closed_at_real_time` do TIME_STOP gravava um horário sem
   relação com o gatilho real.** Time Stop dispara por IDADE EM RELÓGIO
   (`Date.now() - entryRef >= timeStopBars candles`), não por estado de
   candle — gravar `tfData.lastCandleTime` rotulava um timestamp arbitrário
   (o último candle fechado no momento do scan, que pode ser horas antes do
   prazo real) como "horário real do Time Stop". **Fix**: calculado o prazo
   exato e determinístico (`entryRef + timeStopBars × barMs`) em vez do
   candle — esse SIM é o instante exato em que a condição passou a valer,
   sem ressalva.

`npm run lint && npm test -- --run && npm run build` + os 3 alvos esbuild
limpos de novo após a correção (mesma contagem de testes, sem regressão).

## 108. `smc_confirm_4h15m` não é "filtro que barra uma operação de vez em quando" — zera a cascata RF inteira (2026-08-19)

### Contexto

Continuação direta do item 67: descoberto que o gate `asset.smc_confirm_4h15m`
(ligado por padrão em `AddAssetForm.jsx`, presente em TODOS os 10 ativos
monitorados hoje) rejeitou o sinal SELL real do FETUSDT em 05/08. Usuário
perguntou se não seria melhor simplesmente tirar o gate. Antes de decidir por
anedota, rodei o A/B real (mesmo padrão de todo o resto desta investigação —
7 símbolos padrão, 12 meses, `backtest.yml`): gate ligado (replica produção)
vs. gate desligado.

### Resultado — não é ambíguo

| | Gate LIGADO (produção hoje) | Gate DESLIGADO |
|---|---|---|
| Operações no período (7 símbolos, 12 meses) | **0** | 98 (99 com a ainda aberta) |
| Rejeições da cascata 4h/15m | 3.600 | 1.949 |
| `smc_confirm_zone_rejected` | **2.025 (56% de todas as rejeições)** | 0 (gate nem roda) |
| `regime_rejected` | 1.574 | 1.401 |
| Expectância líquida | — (zero trade, nada pra medir) | +0,064R |
| IC 95% da expectância | — | [-0,176; +0,304] — **cruza zero, inconclusivo** |
| Profit factor | — | 0,986 (~empate) |
| Max drawdown | — | 94,4% |

**Fato, escopado à amostra testada**: com o gate como está configurado em
produção HOJE, a cascata RF 4h→15m produziu **ZERO operações nesta
amostra específica** (12 meses, os 7 símbolos padrão de referência). Não
é "às vezes barra um sinal bom" — nesta amostra é a MAIOR causa de
rejeição isolada (56%, maior até que `regime_rejected`, que já era
conhecido como o principal gargalo desde o item 50), rejeitando 100% do
que sobrou depois do filtro de regime. **Isso não prova que o gate
garante zero operações em qualquer condição futura** — o código permite
passar quando a estrutura SMC concorda (ver "Leitura" abaixo) — mas
explica a ausência de operação NESSA janela de forma mais completa e
direta do que qualquer hipótese estatística dos itens 100-105 ou o item
106 (cota do Firestore) explicaram sozinhos.

**Com o gate desligado**: 98 operações reais, resultado **ainda
inconclusivo** (IC cruza zero) — não é "prova que a estratégia é boa", é
"agora existe uma amostra pra observar", o mesmo status de praticamente
todo o resto desta investigação. Profit factor de 0,986 é essencialmente
empate. Drawdown máximo de 94,4% é alto e merece atenção própria (não
investigado nesta rodada — pode ser efeito já conhecido do runner
pós-TP1, item 46, não necessariamente do gate).

### Leitura (fato × hipótese × recomendação)

**Fato, com escopo explícito (Codex, PR #216)**: NESSA amostra testada —
7 símbolos padrão, janela 2025-08-19→2026-08-19 — manter o gate ligado
produziu zero operações RF nativas. Isso **não** é uma prova de que o
gate garante zero operações sempre, em qualquer condição de mercado — o
código (`scanner.js:2889-2893`) só rejeita quando `trendAligned` E
`zoneOk` falham; existe combinação de tendência/zona SMC em que ele deixa
passar (a taxa de rejeição de 100% nesta amostra é achado empírico de UMA
janela/carteira, não uma garantia lógica do código). O que ESTÁ
sustentado pelos dados: nesta amostra de 12 meses/7 símbolos — a mesma
usada em praticamente toda a investigação anterior (itens 100-106) — o
gate rejeitou 100% dos candidatos que sobraram depois do filtro de
regime, então é um contribuinte real e mensurável pra "poucas/nenhuma
operação", não só uma hipótese. **Hipótese**: o mecanismo provavelmente
sofre do mesmo problema de tautologia geométrica já documentado para o
gate de zona PD original (item 35/38) — comparar o range 4h contra sua
própria estrutura tende a rejeitar quase tudo por construção, não por
seletividade real; não confirmado a fundo nesta rodada (o campo
`pdZone`/`trend` usado aqui é código funcionalmente irmão daquele já
corrigido, mas não é o mesmo gate). **Recomendação**: desligar
`smc_confirm_4h15m` nos 10 ativos monitorados — na amostra testada foi a
diferença entre zero e 98 operações; o resultado das 98 sem o gate não é
prova de lucro (inconclusivo), mas é infinitamente mais informativo que
zero. **Não desliguei em produção nesta rodada** — é escrita em Firestore
de produção afetando os 10 ativos reais, decisão do usuário.

### Verificação

Dois runs reais de `backtest.yml` disparados pelo usuário
(`smc-confirm-4h15m-gate-on-baseline-1yr` e
`smc-confirm-4h15m-gate-off-1yr`, mesma janela 2025-08-19→2026-08-19),
relatórios completos anexados e lidos por inteiro (`entryFunnel`,
`byCascade`, `costs`). **Correção (Codex, PR #216)**: os DOIS trials estão
registrados em `docs/backtest-trial-registry.json` (família
`smc-confirm-4h15m-gate`, N=2) — o "on" (0 operações, `expectancyR: null`)
também conta para o tamanho da família no `summarizeFamily`
(`registry.length`, não filtra por IC presente), então omiti-lo
subestimaria o N em correções Bonferroni futuras dessa família. Nenhuma
mudança de código nesta rodada — só diagnóstico. Próximo passo, se o
usuário aprovar: desligar o gate nos 10 `MonitoredAsset` reais (escrita
em produção, fora do escopo desta análise).

### Aplicado em produção — os 10 ativos + default de cadastro (2026-08-20)

Usuário aprovou explicitamente ("sim, pode desligar os 10 ativos e quando
adicionar ativos que também já fique desligado por padrão"). Aplicado:

- **Escrita direta no Firestore de produção** (`monitoredAssets`, os 10
  ativos reais): `smc_confirm_4h15m: true → false` em todos, confirmado
  por leitura de verificação pós-escrita (mesmo padrão de leitura anônima
  já usado nesta investigação — script Node temporário, apagado depois,
  nunca commitado). BTCUSDT, ETHUSDT, FETUSDT, PENDLEUSDT, ZROUSDT,
  NEARUSDT, ARBUSDT, ENAUSDT, ETHFIUSDT, PAXGUSDT — os 10.
- **`AddAssetForm.jsx`**: default de cadastro mudado de `true` para
  `false` (PR #217) — ativo novo já nasce sem o gate. Continua ligável
  manualmente por ativo em `AssetConfigPanel` pra quem quiser testar com
  ele ligado.

**O que isso NÃO faz**: não é uma promessa de lucro — o resultado medido
sem o gate (item 108, seção acima) segue inconclusivo (IC95 cruza zero).
É a correção de um mecanismo que, na amostra testada, zerava a cascata
inteira; o que vem depois (se as próximas operações reais tiverem
expectância positiva ou não) só o tempo/mais dado decide. Nenhum outro
gate/config foi tocado nesta mudança.
