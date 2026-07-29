# Roadmap — o que está pendente e em que ordem

Índice do que ficou em aberto ao longo das Fases 1-5. **Não duplica conteúdo**:
cada item aponta para a seção canônica em `docs/known-risks.md`. Existe porque a
pendência estava espalhada em cinco itens numerados e num plano de sessão, e
plano de sessão morre com a sessão.

> **Estado em 2026-07-29.** O gate de amostra do Bloco 0 **foi executado**: 344
> operações, 12 meses, 20 símbolos. Resultado: expectância líquida −0,076 R,
> **bruta −0,031 R ± 0,061 — indistinguível de zero**, IC cruzando zero, custo
> (0,045 R/op) maior que o déficit bruto. Ou seja: **nenhuma vantagem
> demonstrada**. E a janela inteira foi um bear market (BTC −37%, ETH −52%,
> SOL −61% — item 46.1), então tudo que foi medido está contaminado por regime.
> Os blocos abaixo continuam válidos como ordem, mas leia-os sabendo disso:
> nenhum deles cria vantagem, todos medem melhor.

## A regra que ordena tudo: amostra

Toda pendência abaixo é uma decisão de "ligar ou não ligar X". Nenhuma dessas
decisões é tomável sem amostra suficiente, e a amostra é hoje o recurso escasso
do projeto: **109 operações fechadas em 12 meses / 7 símbolos**, com expectância
líquida −0,103 R e IC 95% cruzando zero (item 44, "PRIMEIRA MEDIÇÃO REAL").

Por isso a ordem não é por valor esperado da feature — é por **o que destrava o
que**. Um bloco só começa quando o anterior fecha.

---

## Bloco 0 — a janela de ALTA (é o que está aberto agora)

**Rodar `backtest.yml` com `from: 2024-07-27`, `to: 2025-07-27`, a mesma carteira
de 20 símbolos, `trial_label: bull-baseline`.** Zero código: só duas datas
diferentes no `workflow_dispatch`.

### A pergunta que só isto responde

O baseline de 12 meses já rodou e mediu −0,076 R líquido / −0,031 R bruto em 344
operações. Mas a janela inteira foi de **queda** (BTC −37%, ETH −52%, SOL −61% —
item 46.1), e nesse regime "comprar perde, vender ganha" é o que qualquer sistema
produziria. A pergunta em aberto é binária:

> **O motor tem vantagem, ou apenas seguiu o mercado?**

Uma janela de alta, mesma carteira e mesma duração, separa as duas. 2024-07 →
2025-07 é o período imediatamente anterior ao já medido (o BTC sai de ~60k e
chega aos 118k que abrem a janela atual), com todos os 20 símbolos já listados —
mesma carteira, sem viés de sobrevivência.

**Critério escrito ANTES do número** (a disciplina de sempre):

- Se BUY vier positivo e SELL negativo, espelhando o que medimos — o sistema é
  **direcional puro, sem vantagem**: ele ganha do lado que o mercado favorece.
  Isso encerra a linha de otimização de estratégia.
- Se a expectância líquida for positiva nas DUAS janelas, aí sim existe algo
  independente de regime, e vale continuar.
- Se vier negativa nas duas, a resposta também está dada.

Nenhum flag deve ser ligado antes disto. Ligar filtro para consertar um número
contaminado por regime é otimizar ruído com passos extras.

### Histórico: o gate de amostra (CONCLUÍDO)

O que ocupava este bloco era rodar 12 meses × 20 símbolos para sair de 109
operações. Feito — 344 operações, run 30278687522. Fica registrado o raciocínio
porque ele continua valendo para qualquer run futuro.

### Por que ampliar em ATIVOS e não em anos

A primeira ideia foi janela de 4 anos. Foi **descartada a pedido do usuário, com
razão**: 2022 (Luna, FTX, bear) e 2026 são regimes estruturalmente diferentes, e
três dos sete ativos originais nem existiam em 2022 — não seria a mesma carteira
em períodos diferentes. Agregar isso num único número de expectância seria média
de mercados incompatíveis.

Mas aceitar amostra insuficiente também não resolve: a 109 operações,
`sd(R) ≈ 1,1` e erro-padrão 0,107, **um ano só enxerga vantagem de ~0,3 R ou
maior**, e o medido é −0,06 R. Um ano não distingue "levemente negativo" de
"levemente positivo", que é exatamente onde estamos.

Ampliar em ativos resolve os dois: ~20 símbolos nos mesmos 12 meses recentes
dão ~300 operações **no mesmo regime**.

**Ressalva que não pode ser esquecida ao ler o resultado**: altcoins são
fortemente correlacionadas com BTC, então 20 símbolos **não são 20 amostras
independentes** — a amostra efetiva é menor que a nominal. PAXGUSDT (ouro
tokenizado) está na carteira justamente por ser o único de correlação baixa.
O `bySymbol` do diagnóstico é o que expõe concentração.

Nada dos blocos seguintes deve começar antes disto. E o resultado pode encerrar
vários deles de uma vez: se a base não tem vantagem com amostra real, calibrar
filtro em cima dela é otimizar ruído.

### Limite de performance conhecido (medido, não estimado)

O replay é **superlinear no tamanho da janela**, e o gargalo está no backend
fake em memória, não no motor: `fakeBackend.filter`
(`src/lib/__fixtures__/fakeBackend.js`) materializa e **ordena a coleção
inteira** a cada chamada, e `scanner.js` a chama por ativo a cada passo sobre um
store de `SignalEvent` que só cresce durante o replay. Medido:

| Store de SignalEvent | custo por `filter()` |
|---|---|
| 1.000 | 0,39 ms |
| 5.000 | 1,68 ms |
| 20.000 | 6,72 ms |
| 50.000 | 17,04 ms |

Consequência real: o run de 4 anos × 7 símbolos rodou **5h25min sem terminar** e
bateu o `timeout-minutes: 350`
([run 30218382227](https://github.com/mateusraony/Sentinel-Signals/actions/runs/30218382227)).

**Não corrigido de propósito.** 12 meses × 20 símbolos cabe no timeout, e o
`fakeBackend` é compartilhado com `scannerStateMachine.test.js` — mexer nele
para ganhar tempo num run que já cabe seria risco sem necessidade demonstrada.
Se algum dia uma janela mais longa voltar à mesa, **é aqui que se mexe**: índice
secundário por `asset_id`, que é o campo de toda consulta quente.
`sliceClosedAsOf` já foi convertido para busca binária (era varredura linear de
trás para frente) — ajuda, mas não era o termo dominante.

---

## Bloco 0.1 — auditoria externa: VERIFICADO (fechado em 2026-07-29)

As três afirmações do documento externo bateram no número até a terceira casa,
mas o critério escrito antes reprova duas — detalhe completo no item **45.9**:

| Afirmação | σ medido | Veredito |
|---|---|---|
| BUY Tier 3 = −0,414 R | −5,35 | passa o limiar (2,64), mas o rótulo "Tier 3" é enganoso: T3 é 87,5% da amostra, então "BUY T3" ≈ "BUY" |
| SELL isolado positivo | +2,17 | **reprova** — e a vantagem está concentrada num único trimestre |
| `correction_warning` = −0,709 R | −8,52 | passa, mas é **inutilizável**: o aviso chega DEPOIS da entrada em 82 de 82 casos |

E o achado que sobrevive a tudo isso é de regime, não de motor: a janela inteira
foi um bear market (item 46.1), o que explica BUY × SELL sem defeito nenhum e
manda a decisão para o Bloco 0 acima.

**Continua aberto deste bloco**: a cascata SMC é **código morto na prática** —
75 eventos de estrutura → 0 operações (item 45.1). Isso é **medição**. A causa
provável é a tensão geométrica entre gatilho e zona no candle de 5m (item 45.2),
mas isso é **hipótese**: o gatilho de 5m cruza um pivô local, não o `legHigh`
fixo de 1h, então as duas condições são negativamente correlacionadas, não
excludentes. Confirmar exige antes instrumentar o funil (item 45.3) — hoje o
loop de retry descarta o sinal sem registrar o motivo. Depende do Bloco 0: se o
motor não tiver vantagem em regime nenhum, consertar a cascata SMC é ampliar um
gerador de operações sem vantagem.

---

## Bloco 1 — os quatro flags dormentes (o maior débito acumulado)

Fases 2, 3 e 4 construíram quatro mecanismos completos, testados e documentados.
**Nenhum deles jamais foi medido.** Os quatro seguem `false` nos três arquivos de
config, e cada item termina com "não ativar sem comparar backtest antes":

| Flag | Item | O que faz |
|---|---|---|
| `retestEnabled` | 40 | Espera o preço retestar o nível rompido antes de entrar |
| `displacementEnabled` | 41 | Exige candle de deslocamento na confirmação 5m (só SMC) |
| `smcTierEnabled` | 42 | Estende tier/ADX/Choppiness à cascata SMC |
| `smcObFvgEnabled` | 43 | Order Block / FVG como componentes de score (peso 0) |

### Como testar — e como NÃO testar

**Ablação, um de cada vez, declarada antes.** Nunca varredura das 16
combinações. A aritmética: com `sd(R) ≈ 1,1`, um filtro que corte a amostra de
400 para ~200 dá erro-padrão ~0,079. O **máximo de 16 tentativas inúteis** é
esperado em ~+0,14 R só por sorte; o máximo de **4** tentativas, em ~+0,08 R.

Consequência prática a registrar antes de rodar: uma ablação que mostre melhora
**abaixo de ~+0,10 R não é evidência**, é o valor que o acaso entrega quando se
testa quatro coisas. Esse limiar sobe se mais configurações forem testadas.

O item 43 tem um **segundo estágio** separado: ligar o flag com pesos em 0 dá
medição com score byte-idêntico; dar peso aos componentes é decisão própria,
posterior, e mexe em score já consumido pelos limiares de arbitragem da Fase 1.

---

## Bloco 2 — geometria de saída (parcialmente atacada)

Os quatro flags do Bloco 1 são todos **filtros de entrada**. O déficit medido é
de **payoff**: 41,3% de acerto com razão ganho/perda 1,22, quando 1,42 seria o
empate.

### Runner do TP1 — FEITO e medido (item 46)

Deixou de ser hipótese. Sobre as 344 operações, o runner custou **−0,040 R/op
(−13,9 R)**, e fechar 100% no TP1 teria sido melhor em **95 das 121** que o
atingiram. `pineConfig.runnerEnabled` existe (default `true` = comportamento de
sempre) e o diagnóstico imprime a atribuição em qualquer relatório, sem rodar
backtest.

**Não virou default** porque a medição é de um regime só — a mesma crítica que
derrubou a proposta de desligar as compras, aplicada ao próprio achado. A
decisão de ligar depende do Bloco 0.

**E não salva a estratégia**: mesmo eliminando o runner inteiro, o bruto vai a
+0,009 R contra 0,045 R de custo.

### Ainda aberto: `tp1R`/`tp2R`/`trailAtrMult`

TP2 é atingido em 18 de 344 (5,2%). Mexer em `tp1R` (1,5), `tp2R` (3,0) e
`trailAtrMult` (2,0) continua **não testado** — e é busca de 3 parâmetros, com
todo o risco de sobreajuste que isso traz. Mesma disciplina do Bloco 1: uma
hipótese declarada antes, critério escrito antes, contada no `trial_label`.

### PR-1 (item 47.2): dados limpos + telemetria nova, sem mexer em sinal

Avaliação de uma proposta externa de reforma (2026-07-29, detalhe completo em
`docs/known-risks.md` item 47.2) separou o que já existia, o que conflitava
com uma decisão já pesquisada (fonte Futures no backtest — mesmo bloqueio 451
do cron, confirmado desta vez para o `backtest.yml` também) e o que era gap
real de baixo risco: **implementado** — MFE/MAE por operação, funding
ponderado pela fração pós-TP1 (diferente do "pipeline de funding histórico"
do Bloco 3 — aqui é só notional, não taxa real), warm-up opcional
(`--evaluation-from`/`--evaluation-to`), expiração de sinal logada (RF+SMC),
bug do contexto macro morto (`tf_1d/4h/1h_direction` nunca chegava na
`TradeOperation`), concentração top-N no diagnóstico, `reproducibility` no
relatório (commit/config hash). **Candidatos pra rodadas futuras, cada um com
seu próprio A/B e sem entrar no Bloco 0**: resolução de stop/TP no timeframe
de EXECUÇÃO (15m/5m) em vez do de sinal (4h/1h) — o achado tecnicamente mais
sério, toca os invariantes P0; entrada causal 15m ("Fresh RF Flip" — hoje é
decisão deliberada, não bug); separar tier (volatilidade) de regime
(permissão de entrada); runner default `true→false` + Shadow Runner
(rastreamento virtual pós-TP1, mecanismo de validação contínua pro Bloco 2).

---

## Bloco 3 — o que a Fase 5 adiou explicitamente

Registrado em "Fora de escopo, com justificativa" do item 44:

- **Janela histórica longa (4 anos), lida POR TRIMESTRE.** Desceu do Bloco 0
  para cá quando a amostra passou a vir de ativos em vez de anos. Responde uma
  pergunta **diferente** da do Bloco 0 — não "existe vantagem hoje?", mas "isso
  já funcionou em algum regime, e em qual?". Só faz sentido lida trimestre a
  trimestre (`byPeriod`), nunca agregada num número só, pelo mesmo motivo que a
  tirou do gate. Exige antes o índice por `asset_id` no `fakeBackend`
  (ver Bloco 0, limite de performance).
- **Walk-forward / separação treino-validação-holdout.** Adiado por falta de
  amostra, com a tabela de poder estatístico como justificativa. Se o Bloco 0
  entregar ~400 operações, isso passa a ter material — mas continua marginal:
  janelas de 6/2/2 meses dariam ~50 operações por validação.
- **Pipeline de funding histórico.** Foi classificado como custo de segunda
  ordem (~5% da taxa) e **a medição refutou isso**: funding é 58-61% do custo
  real, porque a cascata segura posição ~6 dias. A constante atual (1 bp/8h) é
  a taxa-base da Binance e pode estar longe do funding real de cada período.
  Revisitar só se uma estratégia sobreviver ao Bloco 0.
- **Deflated Sharpe / PBO / CSCV.** Mecanicamente inaplicáveis nesta escala.

---

## Bloco 4 — decisão de arquitetura, nunca aberta

**Cascata 1D / operações independentes por timeframe** (item 37). Registrada
como proposta do usuário e explicitamente **não implementada** — é incompatível
com a invariante "uma operação ativa por ativo" sem uma decisão de arquitetura
própria. Exige `sentinel-council-review` antes de qualquer código.

---

## Bloco 5 — dívidas independentes do gate (podem andar a qualquer momento)

- **Padrão-ouro de paridade Pine**: o CSV oficial do TradingView
  (`docs/claude/golden-tv-export.md`) nunca foi fornecido — exige plano pago do
  usuário. Sem ele, a paridade é validada por consistência interna e por 4
  barras transcritas à mão (`tvSpotCheck.test.js`).
- **`check5mSmcConfirmation` sem teste dedicado** (`.claude/rules/testing.md`,
  "Lacunas restantes"). Valor incremental baixo pelo motivo já registrado ali.
- **`exit_ambiguous`** (item 36): o campo existe e é observável, mas o volume
  real nunca foi conferido. A reconstrução por timeframe menor só se justifica
  se esse número for relevante.
- **`npm run typecheck` fora do CI**, ~80 erros pré-existentes (maioria
  `checkJs` sobre `forwardRef` do shadcn/ui).
- **Bundle principal acima de 500 kB** (Vite avisa, não falha).

---

## Fora de escopo permanente (não são pendências)

Não reabrir sem pedido explícito — cada um tem decisão registrada:

- **Futures, funding rate, open interest, basis, liquidações** — 451 de
  datacenter US, sem workaround gratuito (item 4).
- **Execução real, paper trading, shadow mode, kill switch, reconciliação** —
  `.claude/rules/trading-safety.md`, trading é virtual por política.
- **Cloud Functions / Blaze**, **Vercel/Netlify**, **Base44** — `CLAUDE.md`.
- **Timeframe de confirmação adaptativo** — rejeitado na Fase 3 por ausência de
  precedente e riscos concretos encontrados na pesquisa (item 42).
- **Strategy Reviewer** — pausado de propósito.
