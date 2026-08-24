// Node adapter for the historical backtest — the './pineParser' redirect
// target for scanner.js during a backtest run. Deliberately does NOT reuse
// adminPineConfig.js: that file reads strategyConfig/current from Firestore
// at call time (firebase-admin), which needs a live service account and
// network access — neither available (nor desired) for an offline replay.
// Instead this is a static config: the SAME DEFAULTS as pineParser.js/
// adminPineConfig.js, overridable via setPineConfigOverrides() (called once
// by run-backtest.mjs from --pine-config CLI JSON, if given).
//
// Keep DEFAULTS mirrored by hand with src/lib/pineParser.js and
// scripts/adminPineConfig.js — see those files' own comments on why there's
// no shared module (browser-only APIs on one side, firebase-admin on the
// other). Extracting a shared source is a separate, lower-risk cleanup
// (tracked, not part of this change — see the PR description's "fora de
// escopo" section).
const DEFAULTS = {
  rng_per: 20,
  rng_qty: 3.5,
  minScore: 75,
  atrLen: 14,
  tp1R: 1.5,
  tp1QtyPercent: 50,
  trailAtrMult: 2.0,
  emaFastLen: 20,
  emaSlowLen: 50,
  rsiLen: 14,
  volLen: 20,
  pineVersion: 6,
  strategyTitle: 'NEW ERA - Range Filter Strategy v13.2',
  tier2Threshold: 0.8,
  tier3Threshold: 1.5,
  useADX: true,
  adxLen: 14,
  adxSmooth: 14,
  useChop: true,
  chopLen: 14,
  useTimeStop: true,
  timeStopT1: 48,
  timeStopT2: 64,
  timeStopT3: 96,
  useChopExit: false,
  useInvalidation: false,
  invalidRFBars: 2,
  invalidScoreMin: 75,
  confirmBars: 1,
  onlyClosedCandles: true,
  // Cross-cascade arbitration + R:R gate + SMC score weights (Phase 1 —
  // see src/lib/signalArbitration.js/opExitRules.js/indicators/smcConfluence.js)
  arbEnabled: true,
  arbPromoteMinScore: 75,
  arbReinforceMinScore: 50,
  arbInvalidateOnOppositeMajor: false,
  // Mesmo mecanismo de arbInvalidateOnOppositeMajor, mas para o branch
  // same-timeframe (same_cascade_opposite_direction) em vez do
  // larger-timeframe (critical_opposite). OFF por padrão. Espelha
  // src/lib/pineParser.js/scripts/adminPineConfig.js. Ver docs/known-risks.md
  // item 93. Override via --pine-config to compare backtest reports with/without it.
  arbInvalidateOnOppositeSameTf: false,
  arbOppositeScorePenalty: 15,
  minRR: 1.2,
  smcScoreStructureWeight: 15,
  smcScoreChochBonus: 10,
  smcScoreEmaWeight: 20,
  smcScoreRfWeight: 15,
  smcScoreVolumeWeight: 15,
  smcScoreAlignmentWeight: 15,
  smcScoreSweepWeight: 10,
  // Runner do TP1 (known-risks item 46). LIGADO por padrão = comportamento de
  // sempre. Com `false`, o TP1 fecha 100% e vira saída terminal. Override via
  // --pine-config para comparar relatórios com/sem.
  runnerEnabled: true,
  // Retest confirmation gate (Fase 2 rodada 1, src/lib/indicators/retest.js)
  // — master flag OFF by default, see docs/known-risks.md item 40. Override
  // via --pine-config to compare backtest reports with/without it.
  retestEnabled: false,
  retestToleranceAtrMult: 0.3,
  retestTouchMode: 'close',
  // Displacement candle gate (Fase 2 rodada 2, SMC 1h→5m only) — master flag
  // OFF by default, see docs/known-risks.md item 41. Override via
  // --pine-config to compare backtest reports with/without it.
  displacementEnabled: false,
  displacementBodyAtrMult: 1.5,
  displacementMinVolumeRatio: null,
  // SMC tier/regime gate (Fase 3, src/lib/indicators/tier.js) — master flag
  // OFF by default, see docs/known-risks.md item 42.
  smcTierEnabled: false,
  // Order Block / FVG (Fase 4) — informational score inputs, never a gate.
  // Master flag OFF by default; weights start at 0. Use --pine-config to
  // compare backtest reports with/without. See docs/known-risks.md item 43.
  smcObFvgEnabled: false,
  obFvgAtrLen: 50,
  obMinAtrMult: 0.5,
  obMaxAtrMult: 2.5,
  fvgMinAtrMult: 0.5,
  fvgFillTargetRatio: 0.6,
  smcScoreObWeight: 0,
  smcScoreFvgWeight: 0,
  // Proteção de stop pré-TP1 (known-risks.md item 53/54) — master flag OFF
  // por padrão. Faltava aqui (docs/known-risks.md item 80, E-1) — presente
  // em src/lib/pineParser.js/scripts/adminPineConfig.js, quebrando a
  // convenção "mantenha espelhado à mão" deste próprio arquivo. Aditivo:
  // mesmos defaults dos outros dois arquivos.
  preTp1StopProtectionEnabled: false,
  preTp1StopProtectionAtrMult: 1.0,
  // Gate de padrão de vela (engolfo) na cascata RF 4h→15m — master flag OFF
  // por padrão. Mesma lacuna do item 80, E-1 acima.
  candlePatternEnabled: false,
  // Bypassa check15mConfirmation na cascata RF nativa 4h→15m (known-risks.md
  // item 67) — master flag OFF by default. Override via --pine-config to
  // compare backtest reports with/without it. Espelha src/lib/pineParser.js/
  // scripts/adminPineConfig.js.
  skip15mConfirmationEnabled: false,
  // RF 1h condicionado ao 4h (Fase 1, docs/known-risks.md item 56 "Fase 1")
  // — master flag OFF by default. INTENTIONALLY NOT mirrored to
  // src/lib/pineParser.js / scripts/adminPineConfig.js (breaks the usual
  // "add to all 3" convention on purpose): those two feed
  // strategyConfig/current in Firestore, writable by any anonymous session
  // (no login screen, CLAUDE.md decision item 1) — a key there is a live
  // production toggle with zero code-review gate. This experiment must stay
  // backtest-only, so it can only ever be set via --pine-config here. See
  // src/lib/pineParser.js/scripts/adminPineConfig.js DEFAULTS comments (same
  // note, mirrored) and the tripwire test in scannerStateMachine.test.js
  // that fails if this key ever appears in either of those two files.
  rf1hCondEnabled: false,
  // RF 1h TOTALMENTE independente do 4h (docs/known-risks.md item 68) —
  // mesma mecânica do rf1hCondEnabled acima (mesmo tf4hData pra ATR/tier/
  // regime, mesma check15mConfirmation), SEM o gate de concordância
  // direcional com o 4h. Isola exatamente essa variável em relação ao
  // condicionado, pra comparação A/B direta. Master flag OFF by default.
  // INTENTIONALLY NOT mirrored to src/lib/pineParser.js /
  // scripts/adminPineConfig.js — mesmo motivo do rf1hCondEnabled (chave
  // viva em strategyConfig/current seria toggle de produção sem
  // code-review). Backtest-only, só via --pine-config aqui. Ver o tripwire
  // test em src/lib/rf1hUncondTripwire.test.js. Nunca ligar junto com
  // rf1hCondEnabled no mesmo run — convenção, não validado em runtime.
  rf1hUncondEnabled: false,
  // Filtro de lado na cascata RF nativa (docs/known-risks.md item 71) —
  // 'SELL', 'BUY' ou ausente/null (default, os dois lados, comportamento de
  // sempre). Motivado por achado real: nas operações reais já medidas
  // (20 símbolos/12 meses), BUY teve expectância -0,324R (CONCLUSIVA, IC95
  // não cruza zero) e SELL +0,271R (também CONCLUSIVA) — o padrão mais forte
  // já medido neste projeto. Um parâmetro só (não 2 flags booleanas) evita
  // precisar validar mutex e permite testar SELL-only e BUY-only pela MESMA
  // mecânica, pro contraste que a comparação pede. INTENTIONALLY NOT
  // mirrored to src/lib/pineParser.js/scripts/adminPineConfig.js — mesmo
  // motivo dos outros flags backtest-only acima (chave viva em
  // strategyConfig/current seria toggle de produção sem code-review, e uma
  // mudança de ESTRATÉGIA dessa magnitude exige A/B real antes de cogitar
  // produção). Backtest-only, só via --pine-config. Ver o tripwire test em
  // src/lib/allowedSideTripwire.test.js.
  allowedSide: null,
  // docs/known-risks.md item 109 — sobrescreve o Time Stop por-tier
  // (T1=48/T2=64/T3=96 velas do timeframe de sinal, `indicators/tier.js`)
  // por um valor único, pra medir se encurtar o prazo máximo sem TP1
  // melhora o resultado. Motivação: funding é 59% do custo medido e a
  // duração MÉDIA em posição é de 130,7h. `null` = comportamento de
  // sempre (tier decide), byte-idêntico.
  //
  // A evidência disponível é SUGESTIVA CONTRA encurtar (duração longa
  // concentra-se nas ganhadoras; as saídas por TIME_STOP existentes rendem
  // +0,283R), mas NÃO conclusiva: o P&L relevante é o valor NA vela do
  // corte, e nenhum relatório guarda preço intermediário — só um replay
  // com a regra modificada decide (achado do Codex, PR #221). Este flag
  // existe exatamente pra permitir esse replay.
  //
  // Congelado na CRIAÇÃO da operação (`tier_time_stop_bars`), como
  // runnerEnabled/preTp1StopProtectionEnabled — virar o flag no meio nunca
  // reprograma o prazo de uma posição já viva. INTENTIONALLY NOT mirrored
  // em src/lib/pineParser.js/scripts/adminPineConfig.js — mesmo motivo dos
  // outros flags backtest-only acima. Ver src/lib/timeStopOverrideTripwire.test.js.
  timeStopBarsOverride: null,
  // Bloco 4 Fase 1 (docs/known-risks.md item 37) — permite as cascatas
  // `4h_15m` (RF nativa) e `1h_5m` (SMC) manterem operações INDEPENDENTES
  // simultâneas no mesmo ativo, em vez de compartilhar 1 slot único
  // (comportamento de sempre). Master flag OFF por padrão — destravado
  // pelo usuário (item 37, "Destravado explicitamente"), mas o conselho
  // técnico recomendou manter desligado até uma cascata isolada confirmar
  // vantagem fora da amostra (nenhuma confirmou até hoje — item 71). Sem
  // gatilho de promoção cross-timeframe nesta fase: cada cascata abre só
  // com o próprio sinal nativo; a única mudança de comportamento quando
  // ligada é o slot deixar de ser compartilhado + o stop da perna já ativa
  // avançar pra breakeven quando a outra abre (acoplamento de risco,
  // `advanceToBreakevenOnSiblingOpen`, src/lib/opExitRules.js). 1D e
  // "continuidade" (usar sinal de timeframe menor pra promover abertura do
  // maior) ficam FORA do escopo desta fase — deliberado, ver item 37. NÃO
  // mirror pra src/lib/pineParser.js/scripts/adminPineConfig.js, mesmo
  // motivo dos outros flags backtest-only acima. Ver tripwire test em
  // src/lib/hierarchicalCascadeTripwire.test.js.
  hierarchicalCascadesEnabled: false,
  // Item 76 — versão OBSERVACIONAL do gate existente `asset.smc_confirm_4h15m`:
  // em vez de bloquear a entrada da RF nativa quando a estrutura SMC (4h)
  // discorda, só GRAVA a classificação (`TradeOperation.smc_alignment_at_entry`
  // — 'aligned'/'against'/'unavailable') pra medir depois, via backtest, se
  // isso realmente ajuda ou é só mais filtro atrapalhando — pedido explícito
  // do usuário (2026-08-12): "SMC seria apenas score que precisa validar".
  // Corrige de propósito o defeito latente do gate antigo (item 45.5): usa a
  // zona da PERNA do próprio rompimento (buildOteLeg/classifyZone, mesmo fix
  // do item 38), não a janela genérica de 20 velas que é tautológica pra um
  // candle que acabou de romper estrutura. Nunca bloqueia nada — `entry_score`
  // e a decisão de abrir a operação não mudam em nada com o flag ligado.
  // Master flag OFF por padrão, backtest-only (mesmo motivo dos outros acima)
  // — ver tripwire test em src/lib/smcAlignmentScoreTripwire.test.js.
  smcAlignmentScoreEnabled: false,
  // Item 78 — dado real motivou: um run com rf1hUncondEnabled ligado mediu
  // a cascata nativa (4h_15m) e RF_1H_UNCOND_CASCADE competindo pela MESMA
  // vaga por ativo (67% das rejeições do 1h eram "vaga ocupada", amostra do
  // 4h caiu pela metade só por causa da disputa) — contaminando os dois
  // números, mesma classe de erro de sub-bucket já corrigida nos itens
  // 51/68. Quando ligado, a cascata nativa (4h_15m) não cria NENHUMA
  // operação (1ª passada nem retry) — dá a vaga inteira pra
  // rf1hCondEnabled/rf1hUncondEnabled medir sozinha, sem competição. Sinais
  // RF de 4h continuam sendo emitidos normalmente, só a criação de operação
  // é suprimida. Master flag OFF por padrão, backtest-only (mesmo motivo dos
  // outros acima) — ver tripwire test em src/lib/rf1hExclusiveTripwire.test.js.
  rf1hExclusiveEnabled: false,
  // Filtro de regime pro BUY na cascata RF nativa (docs/known-risks.md item
  // 100) — condiciona entrada BUY ao alinhamento de tendência 1D
  // (signal.context.tf_1d_direction === 1), nunca afeta SELL. Item 88 já
  // tinha nomeado isto como o único caminho formal de reabrir a pergunta do
  // BUY (regime-dependente: positivo em alta, negativo/inconclusivo em
  // baixa) — pesquisa de comunidade confirma que filtro de tendência de
  // timeframe maior (diário filtrando entrada 4h) é técnica padrão em
  // sistemas trend-following (Quantpedia documenta exatamente esse desenho
  // pra Bitcoin), com o custo conhecido de menos sinais e atraso na virada
  // de tendência. Master flag OFF por padrão, backtest-only (mesmo motivo
  // dos outros acima — mudança de ESTRATÉGIA, exige A/B real antes de
  // cogitar produção, mesmo padrão do allowedSide) — ver tripwire test em
  // src/lib/buyRegimeFilterTripwire.test.js.
  buyRegimeFilterEnabled: false,
  // Stop estrutural na cascata RF nativa (docs/known-risks.md item 102) —
  // reusa computeStructuralStop (já testado/em produção na cascata SMC),
  // alimentado pelo swing de 4h que o RF já calcula pra todo sinal
  // (tf4hData.smc.lastSwingLow/lastSwingHigh) — até hoje só metadado
  // informativo, nunca stop. Item 24 já registrou que o RF ficou com o
  // stop por tier×ATR por disciplina de paridade com o Pine real, não
  // porque estrutural foi testado e rejeitado — combinação genuinamente
  // nova. Quando ligado, TAMBÉM busca mais histórico de 4h
  // (RF_4H_STRUCTURAL_STOP_CANDLE_LIMIT em scanner.js, mesmo motivo do
  // item 34 que já ampliou o 1h da SMC — sem isso o swing quase sempre
  // estaria ausente e o experimento cairia no fallback ATR de qualquer
  // jeito). Master flag OFF por padrão, backtest-only (mesmo motivo dos
  // outros acima) — ver tripwire test em
  // src/lib/rfStructuralStopTripwire.test.js.
  rfStructuralStopEnabled: false,
  // docs/known-risks.md item 111 — bypassa o score ponderado (MACD/EMA/RSI/
  // volume/RF/estrutura, min. 75) inteiro: o gate de entrada passa a exigir
  // SÓ o cruzamento de RSI na direção do sinal (calculateSignalStrength,
  // src/lib/indicators/confluence.js). Motivação: mineração do item 110
  // (1.893 sinais brutos pooled, simulador de operação-fantasma item 69)
  // achou RSI como o único componente que se comporta como desenhado
  // (concorda = melhor, discorda = pior — os outros 3 medidos são planos ou
  // invertidos) e o ponto estimado mais alto entre as fatias testadas
  // (+0,049R, NÃO significativo — amostra insuficiente, é indício, não
  // prova). Master flag OFF por padrão, backtest-only (mesmo motivo dos
  // outros acima — chave viva em strategyConfig/current seria toggle de
  // produção sem code-review). INTENTIONALLY NOT mirrored em
  // src/lib/pineParser.js/scripts/adminPineConfig.js. Ver tripwire test em
  // src/lib/rsiOnlyGateTripwire.test.js.
  rsiOnlyGateEnabled: false,
  // docs/known-risks.md item 114 — o Pine real do usuário (src/pages/
  // PineScript.jsx) NÃO tem TP2: o runner pós-TP1 só tem `stop=` (trailing),
  // sem `limit=` — corre até o trailing/RF-exit fechar, sem segundo alvo
  // fixo. `TP2_HIT` (fechar em tp1R×2, hardcoded em buildTradeOpData/
  // buildSmcTradeOpData) é invenção só do Sentinel, nunca antes registrada
  // como divergência deliberada (diferente do stop estrutural SMC, item 24,
  // que tem essa nota explícita). Pesquisa de comunidade (item 114) aponta
  // "parcial no 1º alvo + trailing puro no resto, sem 2º alvo fixo" como o
  // desenho híbrido mais bem avaliado — exatamente o que o Pine real já faz.
  // Quando `true`, a operação nasce com `tp2_cap_disabled: true` (congelado
  // na CRIAÇÃO, mesmo contrato de runnerEnabled/preTp1StopProtectionEnabled
  // — virar o flag no meio nunca muda uma posição já viva): os dois loops de
  // saída (persistScanResults/priceCheckActiveOpsInner) passam a ignorar
  // `op.tp2` e o runner só encerra por STOP_HIT/INVALIDATED/CLOSED (Time
  // Stop/Chop Exit), igual ao Pine. `tp2`/`tp2_hit` continuam gravados
  // (mesmo cálculo de sempre) só para exibição/auditoria — nunca checados
  // como saída quando o flag está ligado. Master flag OFF por padrão
  // (byte-idêntico a hoje). Promovido a toggle de produção (known-risks.md
  // item 128, mesmo raciocínio de paridade com o Pine real do
  // skip15mConfirmationEnabled, item 120/121) — Espelha src/lib/
  // pineParser.js/scripts/adminPineConfig.js.
  disableTp2CapEnabled: false,
};

let overrides = {};

// Called once by run-backtest.mjs before the replay starts, from a
// user-supplied --pine-config JSON file (if any) — lets a backtest run
// compare parameter sets (fase 2 of the user's request) without editing this
// file. Never mutates DEFAULTS itself.
export function setPineConfigOverrides(next = {}) {
  // Codex review (PR #156): um valor inválido (typo, caixa errada, ou não
  // string truthy como `true`) passaria incólume até scanner.js, onde a
  // comparação `signal_type !== allowedSide` rejeitaria os DOIS lados sem
  // erro nenhum — um backtest caro terminaria com zero operações da
  // cascata nativa, parecendo um resultado real em vez de config quebrada.
  // Falha CEDO e alto, antes do replay começar, em vez de silenciosamente.
  if (next.allowedSide != null && next.allowedSide !== 'BUY' && next.allowedSide !== 'SELL') {
    throw new Error(`setPineConfigOverrides: allowedSide inválido (${JSON.stringify(next.allowedSide)}) — só aceita 'BUY', 'SELL' ou ausente/null`);
  }
  overrides = { ...next };
}

export async function getPineConfig() {
  return { ...DEFAULTS, ...overrides };
}
