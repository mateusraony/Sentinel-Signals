// Decide, a partir dos pings recentes do `keep-warm.yml`, se o servidor da API (Render) acabou de CAIR ou de VOLTAR (docs/known-risks.md item 309).
// Módulo PURO: sem rede, sem relógio, sem ambiente. Quem lê o GitHub e manda o Telegram é `scripts/api-health-alert.mjs` + `api-health-alert.yml`.
//
// Entrada: o resultado do passo "Ping /health" de cada execução, da MAIS NOVA para a mais velha:
//   'success' | 'failure' | qualquer outra coisa (passo pulado fora da janela do dia, execução cancelada, passo ausente) = IGNORADO.
// Regras (para o aviso sair UMA vez, não a cada ping):
//   - 'down'  : a mais nova falhou e há exatamente `threshold` falhas seguidas (a 3ª falha; ~30-45 min de queda).
//   - 'up'    : a mais nova deu certo e logo antes dela havia pelo menos `threshold` falhas seguidas (voltou).
//   - 'none'  : qualquer outro caso (queda já avisada, servidor bem, poucas falhas ainda).
export const DEFAULT_THRESHOLD = 3;

/** @param {Array<string | null | undefined>} results mais nova primeiro */
export function decideApiAlert(results, threshold = DEFAULT_THRESHOLD) {
  const r = results.filter((x) => x === 'success' || x === 'failure');
  if (r.length === 0) return { action: 'none', streak: 0, previousStreak: 0 };
  if (r[0] === 'failure') {
    let streak = 0;
    while (streak < r.length && r[streak] === 'failure') streak += 1;
    return { action: streak === threshold ? 'down' : 'none', streak, previousStreak: 0 };
  }
  let previousStreak = 0;
  while (1 + previousStreak < r.length && r[1 + previousStreak] === 'failure') previousStreak += 1;
  return { action: previousStreak >= threshold ? 'up' : 'none', streak: 0, previousStreak };
}

/** Resultado do passo de ping de uma execução, a partir da lista de jobs que a API do GitHub devolve (ou null se não houve ping). */
export function pingStepResult(jobs) {
  const job = (jobs || []).find((j) => j.name === 'ping');
  const step = job?.steps?.find((s) => s.name === 'Ping /health');
  return step?.conclusion ?? null;
}

export function alertText(action, streak) {
  if (action === 'down') {
    return {
      icon: '🔴',
      title: 'Servidor da API (Render) FORA DO AR',
      hint: `${streak} pings seguidos no /health falharam (cerca de ${streak * 15} min). O painel fica sem dados ("Failed to fetch"); o scan, o Telegram e a gestão virtual de stops/alvos continuam normais. Abra o Render (serviço sentinel-signals-api): se estiver "Suspended", é o limite grátis do mês (docs/known-risks.md item 309). Este aviso sai uma vez por queda.`,
    };
  }
  return {
    icon: '🟢',
    title: 'Servidor da API (Render) VOLTOU',
    hint: 'O /health respondeu de novo. O painel deve carregar os dados normalmente.',
  };
}
