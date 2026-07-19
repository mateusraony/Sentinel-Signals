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
numa branch separada (`backups`, não `main`, pra não inchar o histórico
principal), mantendo os últimos 30 dias.

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

**Limitações mantidas (aceitas)**: sem taxas, funding ou slippage (trading
virtual, sem fills reais); perna TP1 a preço teórico; `scanner.js` intocado
nesta rodada (tudo calculado dos campos já persistidos).

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

## 25. Backup diário publicava dados de negócio em branch pública — pausado (P0 de segurança)

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

**Deliberadamente não conectados** (mesma auditoria apontou, decisão
registrada, não bug): `confirmBars` e `onlyClosedCandles` continuam
sincronizados mas nunca lidos por `scanner.js`. `onlyClosedCandles` é
vestigial — o scanner já sempre filtra candles fechados incondicionalmente;
ligar esse parâmetro só faria sentido para permitir `false` (avaliar
candles não fechados), o que seria uma troca de segurança, não uma
correção. `confirmBars` mudaria **quando** um sinal dispara (exigir N
candles de continuação) — feature nova de timing de entrada, não um
parâmetro desalinhado; merece rodada própria com testes próprios se um dia
for implementada.

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

**Fora de escopo**: `runner_active` já existe como opção em `EVENT_OPTIONS`
(`TelegramSettings.jsx`) mas segue sem função `notify*` correspondente —
nunca foi implementado, não é regressão desta rodada, não implementado aqui
por não ter sido pedido.

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
