# Roadmap — o que está pendente e em que ordem

Índice do que ficou em aberto ao longo das Fases 1-5. **Não duplica conteúdo**:
cada item aponta para a seção canônica em `docs/known-risks.md`. Existe porque a
pendência estava espalhada em cinco itens numerados e num plano de sessão, e
plano de sessão morre com a sessão.

> **Estado em 2026-08-04.** TRÊS janelas do Bloco 0 já rodaram, mais 2
> reprocessamentos controlados. Baixa (2025-07→2026-07, 344 ops, 20
> símbolos): −0,076 R, INCONCLUSIVA. Alta (2024-07→2025-07, 288 ops, 20
> símbolos, `bull-baseline`): **+0,294 R, CONCLUSIVA** (IC 0,153 a 0,435) —
> a primeira janela do projeto a fechar assim. Janela 3 (2023-07→2024-07,
> 78 ops, 7 símbolos, `bloco0-janela3-2023`): +0,062 R, INCONCLUSIVA. Review
> externa (Codex, PR #122) apontou confound: as 2 primeiras rodaram com
> carteira de 20 símbolos, a 3ª só com 7 — variável não controlada.
> Reprocessando baixa e alta restritas aos mesmos 7 símbolos da janela 3
> (2026-08-04): a baixa **inverteu de sinal** nessa mesma janela de tempo
> (−0,076 R → +0,141 R, ainda INCONCLUSIVA — IC cruza zero), a alta deu
> +0,250 R. **SELL ficou positivo nas 5 medições feitas até hoje** (0,147 a
> 0,401 R, 3 regimes, 2 composições de carteira) — o padrão mais consistente
> já medido neste projeto. BUY segue acompanhando o regime, com oscilação
> bem menor controlando o confound. Detalhe completo: item 48 (inclui a
> subseção "Confound controlado").
>
> **Atualização 2026-08-15 (item 88): critério de decisão revisado.** O
> critério original tratava BUY/SELL como par único e por isso nenhum dos
> três desfechos pré-registrados bateu com o resultado real (assimétrico).
> Decisão tomada: BUY e SELL passam a ser hipóteses separadas — BUY aceito
> como regime-dependente (mesmo tratamento do item 4, não desbloqueia nada
> sozinho); SELL é candidato a edge genuíno mas só desbloqueia mudança de
> produto se uma PRÓXIMA medição, em janela nova, se sustentar sob IC
> corrigido por família (ver item 89, registro de trials). **O Bloco 1
> continua trancado**, agora por esse motivo específico, não por
> "ambiguidade" genérica.
>
> **Fase 1 — RF 1h condicionado ao 4h (esforço paralelo, fora da numeração
> de Blocos abaixo)**: mecanismo backtest-only pronto e testado (nunca em
> produção), modo sombra prospectivo rodando ao vivo (coleções isoladas,
> nunca abre operação real), acumulando amostra rumo ao piso n≥30/alvo
> n≈100 — avisa sozinho quando bater. Backtest exploratório numa janela
> pré-2023 já rodado, inconclusivo. Detalhe: `docs/known-risks.md` item 56.
>
> **Atualização 2026-08-16 (itens 94/95): 3 novos trials, nenhum muda a
> decisão acima.** (1) Reteste com tolerância maior (0,6× e 1,0× ATR, item
> 94): a taxa de confirmação subiu de 2,4% para 6,4%, mas o volume de
> operações continua abaixo do piso de amostra (0→1→4 contra o mínimo de
> 30) — `retestEnabled` segue desligado. (2) SELL-only com carteira
> expandida (8 símbolos, item 95, retomando a linha pausada do item 88):
> **correção Codex (PR #198)** — LTC/DOGE reusavam janela quase idêntica
> ao item 74, então o número válido é só os 6 símbolos genuinamente novos
> (n=50, +0,387R líquida, IC não corrigido não cruza zero — o resultado
> individual mais forte da família até hoje), mas o IC volta a cruzar
> zero depois da correção por família (N=14 agora) — **Bloco 1 continua
> trancado**, mesmo critério
> do item 88.
>
> **Atualização 2026-08-16 (item 97): ferramenta formal de correlação
> entre ativos, piloto confirma efeito real.** No relatório de 72
> operações do item 95, o N efetivo (corrigido por cluster de operações
> sobrepostas no tempo) é ~24, não 72 — o IC95 correto é quase o dobro da
> largura do publicado. Não muda nenhuma decisão registrada (não implica
> reprocessar histórico), mas é a primeira confirmação real, não só
> teórica, de que "20 símbolos não são 20 amostras independentes" tem
> magnitude prática. `scripts/backtest-correlation-check.mjs`, proposto
> pra rodar junto de relatórios futuros relevantes. Detalhe: item 97.
>
> **Atualização 2026-08-16 (item 98): o artifact do item 48/alta (única
> janela CONCLUSIVA) foi recuperado e rodado na ferramenta acima.**
> Resultado continua excluindo zero (IC em cluster [0,028; 0,560], contra
> [0,153; 0,435] ingênuo publicado), mas por margem muito mais estreita
> — N efetivo ≈ 81 de 288 nominal (DEFF=3,56, o maior já medido, G=13
> clusters). Não reverte a decisão do Bloco 1 (permanece trancado pelo
> motivo já registrado no item 88, não por isto) — mas a "melhor
> evidência de vantagem já produzida por este projeto" é mais frágil do
> que o número originalmente publicado sugeria. Detalhe: item 98.
>
> **Atualização 2026-08-16 (item 99): DEFF≈3 se replica num 3º
> relatório independente** (holdout do item 71 — já era inconclusivo,
> decisão não muda). Três relatórios, três janelas/regimes diferentes,
> DEFF sempre entre 2,99 e 3,56 — deixou de ser achado isolado. Regra
> prática até rodar a ferramenta relatório por relatório: **N efetivo
> real ≈ N nominal / 3** em qualquer IC95 já publicado neste projeto.
> Detalhe: item 99.
>
> **Atualização 2026-08-16 (item 100): linha nova, não incremento —
> `buyRegimeFilterEnabled`.** Usuário apontou (com razão) que a linha
> SELL-only tinha virado loop de retorno decrescente (N=14 na família,
> cada trial novo torna o próximo mais difícil de confirmar). Escolhida
> a única linha genuinamente nova já nomeada no projeto (item 88):
> condicionar BUY ao alinhamento de tendência 1D. Implementado,
> testado, opt-in/backtest-only (mesmo isolamento do `allowedSide`) —
> **ainda não medido**. Próximo passo real: rodar `backtest.yml` com/sem
> o flag e comparar. Detalhe: item 100.
>
> **Atualização 2026-08-16 (item 101): medido — melhora aparente
> (+0,162R) não é significativa (z=1,56) e, decompondo por lado, quase
> toda ela vem de composição de carteira** (BUY caiu 83% em volume, SELL
> subiu 11% via vaga liberada — `assetActiveOps` compartilhado), **não
> de BUY melhor filtrado** (subconjunto BUY-ligado, n=30, sem poder pra
> decidir nada). Não ativar. Não é "refutado" — é "não sabemos ainda, e
> o efeito visível não é o que a hipótese previa". Detalhe: item 101.
>
> **Atualização 2026-08-17 (item 102): stop estrutural pro RF nativo —
> primeira linha nova em SAÍDA/risco, não entrada.** Reusa
> `computeStructuralStop` (já testado/em produção na SMC) alimentado
> pelo swing de 4h que o RF já calcula pra todo sinal — nunca usado como
> stop até hoje. Amplia a busca de candles 4h quando ligado (mesmo
> ajuste que o item 34 já fez pro 1h da SMC, evitando um resultado
> ambíguo por falta de dado). `TradeOperation.initial_stop_basis` audita
> qual stop foi usado de verdade em cada operação. Implementado,
> testado, opt-in/backtest-only — **ainda não medido**. Detalhe: item 102.
>
> **Atualização 2026-08-17 (item 103, corrigido 2026-08-18 ×2): `arbInvalidateOnOppositeSameTf`
> medido — sinal negativo, mas NÃO significativo com a referência estatística correta.**
> Casando a MESMA operação exata nos dois relatórios (mesma janela/
> carteira, `id` determinístico), as 81 operações que o mecanismo
> realmente tocou pioraram em média -0,138R (-0,79R vs -0,65R). 1ª
> correção (erro-padrão em cluster, G=24): t=-2,00, parecia "significativo,
> raspando" contra z=1,96. **2ª correção**: a referência certa pra cluster
> com G baixo é t-Student(df=G-1), não z — t(23)=2,069 > |t|=2,00, **não
> passa**. Veredito revisado pra INCONCLUSIVO. Fica o sinal direcional
> (91% dessas operações já iam bater stop de qualquer jeito no mundo sem
> o flag, consistente com a causalidade invertida do item 45.9), mas sem
> confirmação estatística. **Não ativar** (ausência de evidência a favor,
> não "confirmado que piora") — precisa de uma 2ª medição independente pra
> reabrir. Detalhe: item 103.
>
> **Atualização 2026-08-18 (item 104, corrigido 2026-08-18): `rfStructuralStopEnabled`
> medido — resultado CONFUNDIDO por um teto não tier-aware, corrigido no
> código.** `computeStructuralStop` capava sempre em 2,0×ATR mesmo pra
> tiers T2/T3 (89% da amostra usa tier atrStopMult 2,5×/3,0×ATR quando
> desligado) — o trial testava, sem intenção, "ATR mais apertado" em vez
> de "estrutural vs ATR" pra quase toda a amostra. **Corrigido**:
> `scanner.js` agora usa o `atrStopMult` do próprio tier como teto
> (`maxAtrMult: ATR_MULT`), igual ao ramo desligado. O trial já medido
> (-0,036R pareado, não significativo — t=-0,64 contra t(31)=2,04) fica
> registrado como diagnóstico do bug, não como medição válida — precisa
> re-rodar sob o código corrigido antes de qualquer conclusão sobre a
> hipótese em si. **Não ativar** (efeito já não era significativo mesmo
> confundido). Detalhe: item 104.
>
> **Atualização 2026-08-18 (item 105, corrigido 2026-08-18): `preTp1StopProtectionEnabled`
> medido — protege capital como desenhado, mas efeito no subconjunto
> ativado é pequeno e NÃO significativo.** Correção: a leitura original
> confundiu "diferença pareada = zero" com "gatilho não disparou" — usando
> o campo real (`pre_tp1_stop_advanced_at`), o stop avançou em 226 das
> 342 operações pareadas (66%, não 47% como a proxy sugeria); a média
> condicional certa nesse subconjunto é +0,038R (não +0,025R, que era a
> média NÃO condicional sobre todos os 342 pares — erro aritmético),
> t=0,68 em cluster contra t(25)=2,06 crítico — não passa. Reduz risco de
> cauda sem custo detectável na expectância, mas sem ganho comprovado.
> **Não ativar ainda** — nem sinal a favor nem contra. Detalhe: item 105.

## A regra que ordena tudo: amostra

Toda pendência abaixo é uma decisão de "ligar ou não ligar X". Nenhuma dessas
decisões é tomável sem amostra suficiente, e a amostra é hoje o recurso escasso
do projeto: **109 operações fechadas em 12 meses / 7 símbolos**, com expectância
líquida −0,103 R e IC 95% cruzando zero (item 44, "PRIMEIRA MEDIÇÃO REAL").

Por isso a ordem não é por valor esperado da feature — é por **o que destrava o
que**. Um bloco só começa quando o anterior fecha.

---

## Bloco 0 — a janela de ALTA (RODADA — critério revisado, ver itens 48 e 88)

**Rodar `backtest.yml` com `from: 2024-07-27`, `to: 2025-07-27`, a mesma carteira
de 20 símbolos, `trial_label: bull-baseline`.** Zero código: só duas datas
diferentes no `workflow_dispatch`.

**Resultado (2026-07-30, detalhe em `docs/known-risks.md` item 48)**:
+0,294 R líquido, CONCLUSIVO (288 operações) — a primeira janela do projeto a
fechar assim. Não bateu exatamente com nenhum dos três desfechos do critério
original abaixo: os dois lados (BUY e SELL) vieram positivos (derruba o
cenário "puramente direcional"), mas a janela de baixa continua líquida
negativa (ainda que inconclusiva), então "positivo nas duas janelas" também
não se sustentou ao pé da letra.

**Critério revisado (item 88, 2026-08-15)**: BUY e SELL viraram hipóteses
separadas em vez de par único — BUY aceito como regime-dependente, SELL como
candidato a edge genuíno que só desbloqueia o Bloco 1 se confirmado numa
próxima medição em janela nova, sob IC corrigido por família (item 89). Ver
item 88 para o raciocínio completo.

**Linha SELL-only — retomada via símbolos novos (2026-08-16, item 95)**:
a pausa do item 88 (nenhuma janela de calendário nem símbolo genuinamente
novo disponível) foi contornada pelo caminho (b) que o próprio item 88
já previa — expandir a carteira de símbolos além de LTC/DOGE. Rodado com
8 símbolos (`LTCUSDT,DOGEUSDT,TRXUSDT,ATOMUSDT,ETCUSDT,UNIUSDT,ICPUSDT,
FILUSDT`), mas review externa (Codex, PR #198) achou que LTC/DOGE
reusavam janela quase idêntica à já medida no item 74 — o número válido
é só os 6 símbolos genuinamente novos (n=50, +0,387R líquida, IC não
corrigido não cruza zero — o resultado individual mais forte já medido
na família), mas o IC volta a cruzar zero depois da correção por família
(N=14 hoje) — **não desbloqueia o Bloco 1**. Segue
em aberto: expandir a carteira ainda mais (sem bloqueio de calendário,
mas conferindo antes que o novo símbolo×janela não reusa nada já
registrado) ou
esperar 2027-08-10. Detalhe completo: item 95 (e item 88 para o critério
original).

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

**A carteira de 20 símbolos, por extenso** (nunca tinha sido listada por
extenso neste doc — só citada por contagem; recuperada em 2026-08-12 do log
real do run 30278687522, seção "DE ONDE VEM O RESULTADO — por símbolo"):
`BTCUSDT, ETHUSDT, BNBUSDT, ADAUSDT, XRPUSDT, SOLUSDT, AVAXUSDT, LINKUSDT,
DOTUSDT, ARBUSDT, OPUSDT, SUIUSDT, NEARUSDT, AAVEUSDT, ONDOUSDT, FETUSDT,
PENDLEUSDT, ZROUSDT, DYDXUSDT, PAXGUSDT`. Relevante para qualquer teste
futuro que dependa de dado "genuinamente não examinado" (item 73) — símbolo
fora desta lista (e fora do default de 7 do `backtest.yml`) nunca entrou em
nenhum backtest deste projeto.

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

**Diagnóstico do item residual — RODADO e RESOLVIDO (item 75,
2026-08-12).** A cascata SMC continua **código morto na prática** — 78
eventos de estrutura → 0 operações (BTCUSDT, ~19,5 meses, mesma medição
do item 45.1, agora com instrumentação corrigida). Mas a hipótese do item
45.2 (tensão geométrica entre gatilho e zona) foi **refutada como causa
principal**: `ote_zone_unfavorable` explica só 3-5% das rejeições. A causa
dominante (93%) é `no_trigger` — o próprio gatilho de 5m (evento pontual,
`swingLen=10`) quase nunca dispara dentro da janela de retry de 4h.
Consertar isso (relaxar o gatilho, mudar de evento pontual pra estado,
etc.) seria mudança de comportamento real — e a cascata já tem expectância
negativa medida (item 56, −0,778R). **Depende do Bloco 0**: se o motor não
tiver vantagem em regime nenhum, consertar a cascata SMC é ampliar um
gerador de operações sem vantagem — segue sem ação até o Bloco 0 fechar.

---

## Bloco 1 — os quatro flags dormentes (o maior débito acumulado)

> **Recomendação do conselho de revisão (2026-08-10, detalhe em
> `docs/known-risks.md` item 73): não abrir este bloco agora.** A base
> (cascata RF nativa) não tem edge demonstrado após o item 71 não
> confirmar fora da amostra — testar filtros em cima de ruído reproduziria
> o mesmo padrão. Duas alternativas de maior valor: Bloco 4 (mudança
> estrutural) ou um teste pooled walk-forward único **com dado
> genuinamente não examinado** (símbolos novos e/ou janela prospectiva
> futura — os ~3 anos já disponíveis foram lidos 5-8 vezes, reusá-los não
> é confirmação, ver correção do Codex no item 73) em vez de mais ablação
> fragmentada. Decisão de como prosseguir segue com o usuário.

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

### Proteção de stop pré-TP1 — IMPLEMENTADO, opt-in, A/B rodado e fechado (item 53/54/55)

Achado de 2026-08-01: das 96 operações que terminaram em `STOP_HIT` num
backtest real (12 meses/7 símbolos), 61 (52% do total) nunca tiveram TP1
batido — e 98,4% dessas 61 chegaram a ficar positivas (MFE médio +0,578R)
antes de erodir de volta ao `initial_stop` original, sem NENHUMA proteção
intermediária (`advanceTrailingStop` só roda pós-TP1). `pineConfig.
preTp1StopProtectionEnabled` (default `false`) avança o stop pra breakeven
(nunca além) quando o preço se move a favor por `preTp1StopProtectionAtrMult
× ATR` (default 1.0×) — threshold generoso de propósito, pesquisa de
comunidade documenta whipsaw quando o breakeven é prematuro/apertado demais.

**A/B rodado (2026-08-01)**: 116 operações sem a proteção vs. 129 com —
expectância estatisticamente igual (-0,0452R vs -0,0446R, ambas
inconclusivas), mas `maxDrawdownPct` piorou (111,73% → 137,76%) e 36% das
81 operações em que o gate disparou teriam batido TP1 mesmo sem ele
(cortadas cedo pela sacudida que a pesquisa do item 53 já alertava).
**Mantido `preTp1StopProtectionEnabled: false` por padrão** — dado não
mostra ganho e mostra um custo real. Ver `docs/known-risks.md` item 55.

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

## Bloco 4 — Fase 1 IMPLEMENTADA, TESTADA e A/B FECHADO (2026-08-12)

**Cascata 1D / operações independentes por timeframe** (item 37). Fase 1
(escopo reduzido: só as 2 cascatas que já existiam, `4h_15m` e `1h_5m`,
rodando como operações independentes no mesmo ativo — sem cascata 1D, sem
gatilho de "continuidade" cross-timeframe) **implementada e mergeada**
(infraestrutura PR #164, wiring no `scanner.js` PR #165) atrás de
`pineConfig.hierarchicalCascadesEnabled` (backtest-only, default `false`).

**A/B real rodado e registrado (PR #166)**: os 2 runs ficaram
individualmente inconclusivos, sem evidência de ganho na expectância
combinada. Achado mecânico real: o funil confirmou que o mecanismo
funciona (rejeições por slot ocupado da cascata `1h_5m` caíram de 4.704
para 30), mas o volume de operações cresceu pouco porque o gargalo real
dessa cascata é o próprio gatilho SMC 5m, não a disputa de slot.
**Recomendação: não ligar em produção com este dado.** Detalhe completo em
`docs/known-risks.md` item 37.

Fase 2 (cascata 1D nova + gatilho de "continuidade" cross-timeframe) segue
**fora de escopo, não iniciada** — o especialista de trading do conselho já
alertou que um gatilho de promoção cross-timeframe repetiria o mecanismo
que já piorou expectância uma vez (`rf1hCondEnabled`, item 56). Não há
justificativa nova para reabrir isso com o resultado acima.

---

## Bloco 5 — dívidas independentes do gate (podem andar a qualquer momento)

- **Padrão-ouro de paridade Pine**: o CSV oficial do TradingView
  (`docs/claude/golden-tv-export.md`) nunca foi fornecido — exige plano pago do
  usuário. Sem ele, a paridade é validada por consistência interna e por 4
  barras transcritas à mão (`tvSpotCheck.test.js`).
- **`check5mSmcConfirmation` sem teste dedicado — FECHADO.** Reavaliado
  2026-08-13: `.claude/rules/testing.md` já documenta cobertura extensa via
  `persistScanResults`/`scannerStateMachine.test.js` (todos os motivos de
  rejeição/retry/expiração já testados) e marca o item como fechado desde
  2026-08-04 — esta linha aqui estava desatualizada. A função nunca é
  exportada/testada isolada, só via a cascata inteira — decisão aceita, não
  reabrir sem motivo novo. Ver também: a função só serve à cascata `1h_5m`
  independente, hoje código morto na prática (item 75) e fora do caminho
  recomendado (SMC vira score, item 77) — investir em cobertura NOVA dela
  não teria valor.
- **`exit_ambiguous` — volume de BACKTEST já medido, produção ao vivo tem
  card no painel agora (com ressalva de janela).** Reavaliado 2026-08-13: o
  volume em backtest já tinha sido medido (item 36, adendo 2026-08-12:
  19/2.417 operações, 0,79%, 17 relatórios reais) — só o volume EM PRODUÇÃO
  AO VIVO seguia sem observação direta (o agente não tem leitura do
  Firestore de produção, bloqueada pelo classificador de segurança do
  ambiente mesmo com autorização explícita, item 67). Implementado: card de
  estatística em `TradeHistory.jsx` (mesmo padrão de `summarizeOps`/
  `SummaryCard` já usado em `MonthlyReport.jsx`) mostrando contagem/
  porcentagem direto do painel. **Ressalva (achado do Codex no PR #180):**
  a tela já busca só as 200 operações mais recentes
  (`TradeOperation.list('-created_date', 200)`, mesmo teto que toda
  estatística da tela usa) — se a produção acumular mais de 200 operações
  fechadas, o card reflete só a janela mais recente, não o histórico
  completo. Rotulado explicitamente na UI (tooltip); decisão de investir na
  reconstrução por timeframe menor segue condicionada a esse número, dentro
  dessa ressalva de janela.
- **`npm run typecheck` fora do CI — 790→0 erros corrigidos (2026-08-13).**
  A doc antiga dizia "~80 erros" — o real era 790 (a doc nunca tinha sido
  reconferida contra o código). Todos corrigidos: exclusão de arquivos de
  teste do escopo de checagem (não escondia bug real — nenhum arquivo de
  produção importa teste), padrão `forwardRef` do shadcn/ui corrigido na
  raiz (~10 wrappers), `@types/node`/`vite/client` adicionados, e o resto
  (JSDoc de config/API reais em `backtestEngine.js`, `signalArbitration.js`,
  `tradeMetrics.js`, `entities.js`, etc.) anotado um por um. `npm test`/
  `lint`/`build` continuam verdes. **Segue fora do CI** — ligar como gate
  obrigatório é decisão separada, não tomada aqui.
- **Bundle principal acima de 500 kB — reduzido de 2.525 kB para 410 kB
  (2026-08-13).** Nenhum `React.lazy`/code-splitting por rota existia —
  as 12 páginas caíam todas no mesmo chunk. Implementado: `React.lazy` +
  `Suspense` em `App.jsx` (cada página vira seu próprio chunk), `import()`
  dinâmico do `jspdf` em `MonthlyReport.jsx` (só a exportação precisa
  dele), e `manualChunks` isolando `recharts`/`firebase` do chunk
  principal em `vite.config.js`. Esses dois últimos continuam grandes
  como chunks PRÓPRIOS (>500kB cada) — esperado e aceito: são vendor libs
  legítimas que quase nunca mudam entre deploys, cacheiam bem
  separadamente; o que importava era tirá-las do chunk que carrega em
  TODA página. `date-fns`/`framer-motion`/`@hello-pangea/dnd` removidos
  do `package.json` — sem nenhum import em `src/`, dependências mortas.

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
