/**
 * Classificação de falha do scan/backfill (docs/known-risks.md item 162).
 *
 * ## O bug que este módulo existe para matar
 *
 * `scanTimeout.mjs` monta a mensagem de timeout assim:
 *
 *   "Timeout: <etapa> não retornou em <N>ms — provável travamento em retry de
 *    RESOURCE_EXHAUSTED do Firestore (ver docs/known-risks.md item 142)."
 *
 * A parte depois do travessão é uma **hipótese**, não um fato observado. Só
 * que `run-scan.mjs` e `run-backfill-check.mjs` decidiam "é cota esgotada"
 * com `/RESOURCE_EXHAUSTED/i.test(mensagem)` — que casa com a própria
 * hipótese. Resultado: **todo timeout, de qualquer causa, virava um alerta de
 * "Cota do Firestore esgotada"**, mesmo com a cota inteira disponível.
 *
 * Aconteceu em produção em 2026-09-05: o backfill travou em UM ativo
 * (`checkOneAsset:LDOUSDT`, 5 min) e o usuário recebeu alerta de cota
 * esgotada — enquanto o scan rodava verde a cada 5 minutos, provando que a
 * cota estava normal.
 *
 * ## A regra
 *
 * Só é cota esgotada o que traz a **assinatura real** do erro do Firestore:
 * `Quota exceeded`, ou o código gRPC 8 (`8 RESOURCE_EXHAUSTED`). A prosa da
 * hipótese é removida antes de testar, então nem o texto antigo (que ainda
 * pode estar em logs e no marcador) engana o detector.
 *
 * Módulo puro: sem I/O, sem dependência de Firestore. Só lê uma string.
 */

/** Assinatura REAL do erro do Firestore, não a suposição de quem deu timeout. */
const REAL_QUOTA_RE = /Quota exceeded|\b\d+\s+RESOURCE_EXHAUSTED\b/i;

/** A frase de hipótese que `scanTimeout.mjs` anexa — removida antes de testar. */
const HYPOTHESIS_RE = /—\s*prov[áa]vel travamento em retry de[\s\S]*$/i;

/**
 * Índice composto faltando no Firestore.
 *
 * Adicionado no item 165 depois de a auditoria de saúde (164) falhar 3 de 5
 * checagens com isto — e a mensagem genérica de erro dela CHUTAR que a causa
 * era cota, que é exatamente o bug que o item 162 acabara de corrigir noutro
 * lugar. Não é falha de dado nem de cota: é uma consulta que combina filtro
 * com ordenação em campo diferente sem o índice correspondente. Só aparece
 * contra o banco real.
 */
const MISSING_INDEX_RE = /requires an index|FAILED_PRECONDITION/i;

/** O formato da mensagem de timeout, de onde sai o nome da etapa travada. */
const TIMEOUT_RE = /^Timeout:\s*(.+?)\s+n[ãa]o retornou em\s*(\d+)\s*ms/i;

function text(message) {
  return String(message ?? '');
}

/**
 * Timeout de etapa? Devolve `{ step, ms }` ou `null`.
 *
 * O `step` é o rótulo passado ao `withTimeout` (`scanAllAssets`,
 * `checkOneAsset:LDOUSDT`, …) — é ele que diz O QUE travou, que é a
 * informação que o alerta precisa dar em vez de chutar a causa.
 */
export function parseStepTimeout(message) {
  const match = text(message).match(TIMEOUT_RE);
  if (!match) return null;
  return { step: match[1], ms: Number(match[2]) };
}

/**
 * Cota do Firestore realmente esgotada?
 *
 * A prosa da hipótese é descartada primeiro — é o que impedia distinguir
 * "travou por cota" de "travou, e alguém chutou que fosse cota".
 */
export function isFirestoreQuotaExhausted(message) {
  return REAL_QUOTA_RE.test(text(message).replace(HYPOTHESIS_RE, ''));
}

/** Consulta sem o índice composto que ela exige? */
export function isMissingIndex(message) {
  return MISSING_INDEX_RE.test(text(message));
}

/**
 * Classifica a falha para o alerta saber o que dizer.
 *
 * `missing_index` é lido hoje só pela auditoria de saúde (item 165). Os pontos
 * de entrada do scan não agem sobre ele de propósito: as consultas deles são
 * todas cobertas por `firestore.indexes.json`, então um índice faltando ali
 * seria bug de deploy, não condição de runtime a alertar.
 *
 * @returns {{ kind: 'quota'|'timeout'|'missing_index'|'other', step: string|null, ms: number|null }}
 */
export function classifyFailure(message) {
  // Cota real vence: um timeout CAUSADO por cota traz a assinatura de
  // verdade junto e deve ser tratado como cota.
  if (isFirestoreQuotaExhausted(message)) {
    return { kind: 'quota', step: parseStepTimeout(message)?.step ?? null, ms: null };
  }
  const timeout = parseStepTimeout(message);
  if (timeout) return { kind: 'timeout', step: timeout.step, ms: timeout.ms };
  if (isMissingIndex(message)) return { kind: 'missing_index', step: null, ms: null };
  return { kind: 'other', step: null, ms: null };
}

/**
 * Rótulos técnicos das etapas → português simples.
 *
 * O alerta vai pro Telegram do usuário, que não é dev: `checkOneAsset:LDOUSDT`
 * não diz nada a ele. `.claude/rules/operating-principles.md` — "nome que o
 * usuário vê, não o interno".
 */
const STEP_LABEL = Object.freeze({
  scanAllAssets: 'a varredura dos ativos',
  priceCheckActiveOps: 'a checagem de preço das operações abertas',
  checkAssetHealthchecks: 'a checagem de saúde dos ativos',
  getPineConfig: 'a leitura dos parâmetros da estratégia',
  'MonitoredAsset.filter(pending)': 'a leitura dos ativos na fila de checagem retroativa',
});

/** Texto em português simples da etapa, com o ativo quando houver. */
export function describeStep(step) {
  if (!step) return 'uma etapa do sistema';
  const known = STEP_LABEL[step];
  if (known) return known;
  const perAsset = step.match(/^checkOneAsset:(.+)$/);
  if (perAsset) return `a checagem retroativa do ${perAsset[1]}`;
  return step;
}

/** "5min" / "45s" — duração legível, sem arredondar 90s para "1min". */
export function formatStepDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const minutes = ms / 60_000;
  return `${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)}min`;
}
