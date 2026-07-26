# Roadmap — o que está pendente e em que ordem

Índice do que ficou em aberto ao longo das Fases 1-5. **Não duplica conteúdo**:
cada item aponta para a seção canônica em `docs/known-risks.md`. Existe porque a
pendência estava espalhada em cinco itens numerados e num plano de sessão, e
plano de sessão morre com a sessão.

## A regra que ordena tudo: amostra

Toda pendência abaixo é uma decisão de "ligar ou não ligar X". Nenhuma dessas
decisões é tomável sem amostra suficiente, e a amostra é hoje o recurso escasso
do projeto: **109 operações fechadas em 12 meses / 7 símbolos**, com expectância
líquida −0,103 R e IC 95% cruzando zero (item 44, "PRIMEIRA MEDIÇÃO REAL").

Por isso a ordem não é por valor esperado da feature — é por **o que destrava o
que**. Um bloco só começa quando o anterior fecha.

---

## Bloco 0 — o gate (é o que está aberto agora)

**Rodar `backtest.yml` com janela de ~4 anos** (`from: 2022-07-01`,
`trial_label: 4y-baseline`, resto no default).

A ~109 operações/ano isso dá ~350-450 — o volume mínimo para qualquer teste
posterior significar alguma coisa. O `timeout-minutes` do workflow já foi subido
para 350 justamente para caber.

Nada dos blocos seguintes deve começar antes disto. E o resultado pode encerrar
vários deles de uma vez: se a base não tem vantagem com amostra real, calibrar
filtro em cima dela é otimizar ruído.

**Ressalva de leitura**: ONDO (listada ~2024), ZRO (~2024) e PENDLE (~2023) não
existem no começo da janela — o recorte longo pesa BTC/ETH/FET/DYDX. O
`bySymbol` do diagnóstico expõe isso; comparar com o run de 12 meses como se
fosse a mesma carteira é erro de leitura.

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

## Bloco 2 — geometria de saída (nunca testada, e é onde o dado aponta)

Os quatro flags acima são todos **filtros de entrada**. O déficit medido é de
**payoff**: 43,1% de acerto com razão ganho/perda 1,08, quando 1,32 seria o
empate. E `TP2` é atingido em 6 de 109 operações (5,5%) — zero nos últimos 6
meses — enquanto 29 dos stops são operações que bateram TP1 e foram estopadas
depois.

Isso aponta para a alavanca que nenhuma fase tocou: `tp1R`/`tp2R` (1,5/3,0) e
`trailAtrMult` (2,0). **É hipótese, não fato** — o dado não diz se aqueles 29
chegariam a 3R; isso é contrafactual e exige rodar com outra configuração.

Mesma disciplina do Bloco 1: uma hipótese declarada antes, critério de sucesso
escrito antes, contada no `trial_label`.

---

## Bloco 3 — o que a Fase 5 adiou explicitamente

Registrado em "Fora de escopo, com justificativa" do item 44:

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
