/**
 * O que exatamente barrou uma entrada, e desde quando (docs/known-risks.md
 * item 163).
 *
 * Pedido do usuário (2026-09-05): *"faz o horário da recusa também, falar que
 * virou para outro lado e bem vazio, sem sentido nenhum, quero saber se o
 * pavio perdeu força ou o que realmente aconteceu, não apenas que viu que
 * acaba ficando vazio a fala!"*
 *
 * Duas lacunas reais por trás dessa queixa, as duas confirmadas no código:
 *
 * 1. **Não havia horário nenhum.** `SignalEvent` gravava
 *    `last_rejection_reason` e mais nada — sem carimbo, sem `updated_date`
 *    (item 161).
 * 2. **O motivo era grosso demais para dizer o que aconteceu.**
 *    `regime_rejected` junta dois gates diferentes (ADX e Choppiness) numa
 *    palavra só, e `confirmation_15m_not_aligned` juntava TRÊS causas
 *    distintas — dado insuficiente, direção contrária e erro de rede — porque
 *    `check15mConfirmation` devolvia `{ confirmed: false }` nos três casos.
 *    Nenhum texto de UI podia ser específico porque **o dado não era**.
 *
 * ## A restrição que desenha esta função
 *
 * `last_rejection_reason` é escrito com **write-on-change** de propósito: um
 * sinal preso no mesmo gate por ~48 passadas de retry custa UMA escrita, não
 * 48 (item 45.3/49). Logo depois de dois incidentes de cota do Firestore
 * (itens 155/158), gastar uma escrita por ativo a cada 5 minutos seria uma
 * regressão séria.
 *
 * Por isso **o detalhe é sempre categórico, nunca numérico**. `adx` muda de
 * 18,3 para 18,7 entre passadas e mataria o write-on-change; "foi o ADX"
 * não muda enquanto o motivo não mudar. E `last_rejection_at` é carimbado só
 * quando motivo/detalhe mudam — o que dá a ele um significado melhor que
 * "última checagem": **desde quando está travado nisto**.
 *
 * Módulo puro: sem I/O, sem Firestore. Quem escreve é `scanner.js`.
 */

/**
 * Detalhes categóricos por motivo. Chaves usadas por `scanner.js` ao rejeitar
 * e traduzidas para frase em `src/lib/signalStatus.js`.
 */
export const REJECTION_DETAIL = Object.freeze({
  // regime_rejected — qual dos dois gates reprovou
  ADX: 'adx',              // movimento sem força
  CHOP: 'chop',            // preço andando de lado
  ADX_CHOP: 'adx_chop',    // os dois

  // confirmation_15m_not_aligned — qual das três causas (antes colapsadas)
  NOT_ALIGNED: 'not_aligned',
  INSUFFICIENT_DATA: 'insufficient_data',
  FETCH_ERROR: 'fetch_error',

  // trend_reversed — para que lado a tendência virou
  NOW_DOWN: 'now_down',
  NOW_UP: 'now_up',
});

/**
 * Traduz `{ adxOk, chopOk }` de `evaluateRegime` no detalhe categórico.
 * `null` quando o regime passou (não há rejeição para detalhar).
 */
export function regimeDetail(regime) {
  if (!regime || regime.ok) return null;
  const adxFailed = regime.adxOk === false;
  const chopFailed = regime.chopOk === false;
  if (adxFailed && chopFailed) return REJECTION_DETAIL.ADX_CHOP;
  if (adxFailed) return REJECTION_DETAIL.ADX;
  if (chopFailed) return REJECTION_DETAIL.CHOP;
  return null;
}

/**
 * Para que lado a tendência do timeframe maior está apontando agora, do ponto
 * de vista de um sinal que apontava para o outro.
 */
export function trendReversedDetail(currentDirection) {
  if (currentDirection === 1) return REJECTION_DETAIL.NOW_UP;
  if (currentDirection === -1) return REJECTION_DETAIL.NOW_DOWN;
  return null;
}

/**
 * O patch a gravar em `SignalEvent`, ou `null` quando nada mudou.
 *
 * `null` é o caminho normal e é o que preserva a otimização: enquanto o sinal
 * continuar preso no MESMO motivo com o MESMO detalhe, não há escrita.
 *
 * @param {object} sig               o SignalEvent como está em memória
 * @param {string} reason            `last_rejection_reason`
 * @param {string|null} [detail]     detalhe categórico (ver REJECTION_DETAIL)
 * @param {string} [nowIso]          carimbo, injetável para teste
 * @returns {object|null}
 */
export function rejectionPatch(sig, reason, detail = null, nowIso = new Date().toISOString()) {
  const normalized = detail ?? null;
  const unchanged = sig?.last_rejection_reason === reason
    && (sig?.last_rejection_detail ?? null) === normalized;
  if (unchanged) return null;
  return {
    last_rejection_reason: reason,
    last_rejection_detail: normalized,
    last_rejection_at: nowIso,
  };
}
