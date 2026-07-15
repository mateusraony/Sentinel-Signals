---
name: sentinel-pine-parity
description: Validar paridade barra a barra entre o Pine Script do TradingView e a implementação JS dos indicadores do Sentinel. Use ao alterar indicadores (Range Filter, RSI, MACD, EMA, ATR, ADX, Choppiness, Tier, score, SMC BOS/CHoCH/sweep/PD) ou parâmetros de estratégia. Não use para lógica de estado/ordem (use sentinel-trading-engine-review) nem para UI.
---

# sentinel-pine-parity

## Quando usar
Alteração/criação de indicador ou de parâmetro de estratégia; suspeita de
divergência entre painel e TradingView.

## Quando NÃO usar
Lógica de ciclo de vida da op (`sentinel-trading-engine-review`); UI.

## Arquivos relevantes
`src/lib/indicators/**`, `src/lib/pineParser.js`, `scripts/adminPineConfig.js`,
`.claude/rules/pine-parity.md`.

## Procedimento
1. Identificar o trecho Pine correspondente (convenção de índice barra atual vs
   anterior, seeding, suavização).
2. **Golden test barra a barra** com candles conhecidos do TradingView; comparar
   valor a valor (tolerância explícita para float).
3. Se o parâmetro é sincronizado, confirmar que está espelhado nos DOIS lugares
   (`pineParser.js` e `adminPineConfig.js`).
4. Registrar nuances ainda não validadas numericamente (known-risks 8/9) em vez
   de silenciá-las.
5. `npm test` verde.

## Critérios de sucesso
Saída do JS bate com o TradingView barra a barra dentro da tolerância; par de
config sincronizado; nuances documentadas.

## Testes obrigatórios
Golden tests do(s) indicador(es) tocados.

## Limites de permissão
Não muda estratégia/thresholds sem pedido (são parâmetros do usuário). Só
candles fechados. Não push/PR sem pedido.
