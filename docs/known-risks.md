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

Ponto de metodologia levantado na mesma auditoria, ainda não alterado (é uma
decisão de design, não um bug): entradas estilo ICT/SMC tradicionalmente
usam stop estrutural (abaixo do sweep ou swing oposto), não stop por ATR —
o stop inicial da cascata SMC aqui continua ATR-based, sem relação direta
com o nível que de fato invalidaria a tese da entrada. Considerar migrar
para um stop estrutural numa fase futura.

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
