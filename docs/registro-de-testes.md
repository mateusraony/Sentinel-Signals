# Registro de testes e medições

**Para que serve (pedido do usuário, 24/11/2026):** todo teste, medição ou comparação feita neste projeto fica registrado AQUI, no GitHub, com os dados completos,
para que, se alguém pedir de novo, a resposta já esteja pronta e nada fique de fora. Este arquivo é o **índice**; o detalhe mora nos arquivos apontados.

## A regra (vale para toda sessão e para toda pessoa)

Todo teste entra neste registro **no mesmo PR em que o resultado aparece**. Sem isso o teste não está concluído. Cada linha traz:

| Campo | O que escrever |
|---|---|
| **ID** | `T-AAAA-NNN`, sequencial (nunca reutilizar) |
| **Data** | dia em que rodou |
| **Pergunta** | o que o teste quer responder, em uma frase |
| **Configuração** | o JSON exato (ou os parâmetros), a janela, os ativos, a fonte dos candles, o commit |
| **Resultado** | os números principais, **com o N e o IC** (amostra pequena é dita como pequena) |
| **Conclusão** | o que o resultado permite dizer, o que NÃO permite, e a decisão (de quem) |
| **Onde está o detalhe** | item do `docs/known-risks.md`, arquivo em `docs/experiments/` e, se houver backtest, o registro em `docs/backtest-trial-registry.json` |

Como registrar um backtest (cada rodada é uma "tentativa" contada, para a correção de comparações múltiplas):
1. Dê um **rótulo claro** à tentativa (o `Rótulo desta tentativa` do workflow é obrigatório).
2. `node scripts/backtest-trial-registry.mjs --report relatorio.json --family NOME-DA-FAMILIA` (grava no `docs/backtest-trial-registry.json`: configuração completa, commit, N, expectância e IC).
3. Guarde o resultado compacto em `docs/experiments/runs/AAAA-MM-DD-nome.json` (configuração de cada rodada + as operações).
4. Teste que decide algo importante é **pré-registrado ANTES** (`docs/experiments/*-prereg.json`): pergunta, braços, janelas, métrica e regra de decisão. Não se muda depois de ver o resultado; se mudar, é um teste novo.
5. Se o teste ainda não rodou, a linha fica como **PENDENTE**, dizendo o que falta e de quem.

## Testes registrados (do mais novo para o mais antigo)

| ID | Data | Pergunta | Configuração | Resultado | Conclusão | Detalhe |
|---|---|---|---|---|---|---|
| **T-2026-005** | 25/11/2026 | (Não era a pergunta planejada.) Com os PADRÕES do código — confirmação de 15 min LIGADA, trailing pré-TP1 LIGADO, teto de TP2 LIGADO —, quanto rende a carteira de 7 ativos em 12 meses? | 7 ativos, 24/11/2025 a 24/11/2026, `timeframes` 15m,1h,4h,1d, SEM override (rodada do GitHub, commit `85a7988`); rótulo digitado `t004-W1-A-modo-pine` (enganoso: **não é modo Pine**) | **−0,093 R/op** (N=119, IC95 [−0,235; +0,049]), PF 0,73, acerto 39%, conta virtual de 1%/op: −10,8%. Por ativo (soma R): ZRO −5,72 · PAXG −2,62 · BTC −2,52 · PENDLE −2,46 · ETH +0,19 · FET +0,99 · DYDX +1,08 | **Inconclusivo** (IC cruza zero). Coerente com o que o projeto já registra: a entrada não tem vantagem comprovada (264/265). NÃO serve de braço A nem de braço B do T-2026-004 (B tem o 15 min desligado). Dados íntegros | `docs/experiments/runs/2026-11-25-t005-padroes-do-codigo-7ativos-W1.json` · `docs/backtest-trial-registry.json` (família `t004-rodada-sem-override`) · item 308 addendum 2 |
| **T-2026-004** | 24/11/2026 | Em 7 moedas e 2 anos, o "modo Pine" rende mais R/op que a configuração padrão da produção? | 4 rodadas (2 janelas × 2 braços), 7 moedas, `timeframes` 15m,1h,4h,1d; braço A = 9 chaves do modo Pine, braço B = padrões do código + 15 min desligado | **EM ANDAMENTO (0 de 4 válidas).** A 1ª rodada recebida (25/11) saiu com o campo de overrides VAZIO e virou o T-2026-005; faltam as 4 | Pré-registrado antes de rodar; regra de decisão congelada. Toda rodada passa por `--expect-config` antes de contar | `docs/experiments/pine-vs-producao-prereg.json` |
| **T-2026-003** | 24/11/2026 | O Sentinel reproduz as operações do Pine v13.2 que o usuário roda no TradingView? | BTCUSDT 4h, 02/2025 a 11/2026 (33 posições); candles do gráfico do TradingView; 8 rodadas do backtest em "modo Pine" e variações (uma chave da produção por vez); commit `58ac92c` | Modo Pine completo: **33/33 entradas iguais, 27/33 saídas finais iguais**, TP1 idêntico ao centavo; +0,160 R (N=33, IC95 [-0,31; 0,63]). Trailing pré-TP1 ligado: **-0,160 R** (N=36, IC [-0,37; 0,05]); só `skip15m` (≈ produção): -0,125 R (N=35). **Todas inconclusivas** (IC cruza zero; Bonferroni N=8) | O motor reproduz a estratégia quando os 6 interruptores estão como no Pine. Sobram Time Stop (tier por barra no Pine × congelado) e a ordem stop × virada de sinal. O efeito do trailing é um **sinal a testar** (T-2026-004), não evidência para mudar a produção | `docs/known-risks.md` item 308 · `docs/experiments/runs/2026-11-24-paridade-pine-tv-btc4h.json` · `docs/backtest-trial-registry.json` (família `pine-parity-tv-btc4h`) · `scripts/compare-tv-trades.mjs` |
| **T-2026-002** | 24/11/2026 | A janela de candles do scanner (150) muda decisões em relação ao TradingView? | Últimas 2.000 barras de BTCUSDT 4h e 1h, janelas de 150/300/500 candles contra os valores reais do TradingView | 150: 2 (`close>RF`) + 6 (`EMA20>EMA50`) comparações viram o lado no 4h; 300 e 500: nenhuma | **Janela subiu para 300** (decisão do usuário). Guarda permanente | `docs/known-risks.md` item 307 (addendum) · `src/lib/candleWindowParity.test.js` |
| **T-2026-001** | 24/11/2026 | Os indicadores do Sentinel batem com os do TradingView? | CSV real do TradingView Premium, BTCUSDT 4h (10.731 barras) e 1h (16.623), pós aquecimento de 210 barras | RSI, ATR, ADX, Choppiness idênticos (≤ 5e-14); EMAs, MACD e Range Filter ≤ 6,2e-5 relativo, decaindo | Indicadores batem em BTC 4h/1h (só a matemática; não é paridade da estratégia) | `docs/known-risks.md` item 307 · `src/lib/indicators/__fixtures__/golden/tv-export-btcusdt-*.csv` |

## Testes anteriores a este registro

Estavam espalhados; o detalhe de cada um está no `docs/known-risks.md` e os de backtest em `docs/backtest-trial-registry.json` (muitas linhas) e `docs/experiments/*-prereg.json`:
trailing pré-TP1 (itens 132/263) · entrada aleatória e "a entrada não tem vantagem comprovada" (264/265) · laboratório de padrões/smart money (266) · Fibonacci 15m (267) · tendência semanal (268) ·
tamanho pela volatilidade (269) · regra diária EMA 10/21 + Supertrend (271–275) · alvo estrutural (281). Ao tocar em qualquer um deles de novo, abra a linha nova aqui com um ID `T-`.
