// Retenção do `system_logs` (docs/known-risks.md item 298; roadmap "Prioridades de hoje", linha 4: a tabela cresce sem limite e nada a poda).
//
// O que faz: apaga os logs MAIS VELHOS que N dias (padrão 30), em lotes pequenos, e nada mais. É a única rotina automática que apaga dado
// neste banco, por isso é cercada de travas:
//  - simular é o padrão: sem pedir "aplicar" por extenso, só conta;
//  - dias entre 7 e 3650, número inteiro; valor estranho é RECUSADO (nunca vira um padrão "chutado");
//  - só a tabela `system_logs`, nome fixo no texto do SQL (nenhuma entrada do usuário vira nome de tabela);
//  - nunca lê o CONTEÚDO dos logs (só nível e data): o repositório é público e o resumo do job também;
//  - linha sem data nunca é apagada (`created_date < corte` é falso para NULL);
//  - corte ESTRITO: o log que tem exatamente N dias fica;
//  - trava de "sem logs recentes": se o log mais novo já é mais velho que o corte (queda longa do sistema ou relógio errado), não apaga NADA —
//    nesse momento os logs antigos são justamente a evidência do que aconteceu;
//  - teto de lotes por execução (a próxima continua), cada lote é um comando separado (não segura trava por muito tempo).
//
// Limite que precisa ser dito: no Neon grátis, apagar linhas NÃO devolve espaço em disco na hora (o VACUUM comum não encolhe o arquivo, e o
// VACUUM FULL/pg_repack precisariam de espaço livre para uma 2ª cópia da tabela). O espaço liberado é reaproveitado pelos logs novos, então a
// tabela PARA de crescer — que é o que importa; o que encolhe de verdade é o backup lógico (pg_dump) e a leitura.
//
// Parte pura + SQL com um `db` mínimo (`{ query }`: um Pool ou um Client do `pg`). O CLI é `scripts/logs-retention.mjs`.

export const RETENTION_DEFAULT_DAYS = 30;
export const RETENTION_MIN_DAYS = 7;
export const RETENTION_MAX_DAYS = 3650;
export const BATCH_SIZE = 5000;
export const MAX_BATCHES = 100; // 100 x 5.000 = 500 mil linhas por execução; o resto fica para a próxima
const DAY_MS = 86400000;

/** Erro de ENTRADA (dias/modo inválidos): a mensagem é nossa e pode ir para o log público sem risco. */
export class RetentionInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RetentionInputError';
  }
}

const quoted = (v) => JSON.stringify(String(v).slice(0, 20));

/**
 * Quantos dias de log guardar. Vazio = padrão (30). Só inteiro positivo em texto puro ("30"): "30.5", "1e3", "30 dias" e afins são recusados.
 * @param {unknown} raw
 * @returns {number}
 */
export function parseRetentionDays(raw) {
  if (raw === undefined || raw === null) return RETENTION_DEFAULT_DAYS;
  const text = String(raw).trim();
  if (text === '') return RETENTION_DEFAULT_DAYS;
  if (!/^\d+$/.test(text)) {
    throw new RetentionInputError(`Quantidade de dias inválida (${quoted(text)}): use um número inteiro entre ${RETENTION_MIN_DAYS} e ${RETENTION_MAX_DAYS}.`);
  }
  const n = Number(text);
  if (n < RETENTION_MIN_DAYS || n > RETENTION_MAX_DAYS) {
    throw new RetentionInputError(`Quantidade de dias fora do permitido (${n}): use entre ${RETENTION_MIN_DAYS} e ${RETENTION_MAX_DAYS} dias.`);
  }
  return n;
}

/**
 * "simular" (conta, não apaga) ou "aplicar" (apaga). Vazio = simular. Qualquer outra palavra é recusada: nada vira "aplicar" por engano.
 * @param {unknown} raw
 * @returns {'simular'|'aplicar'}
 */
export function parseRetentionMode(raw) {
  if (raw === undefined || raw === null) return 'simular';
  const text = String(raw).trim().toLowerCase();
  if (text === '') return 'simular';
  if (text === 'simular' || text === 'aplicar') return text;
  throw new RetentionInputError(`Modo inválido (${quoted(text)}): use "simular" ou "aplicar".`);
}

/** O instante de corte (ISO): "agora" menos N dias. Recusa relógio ou dias inválidos, e nunca devolve uma data no futuro. */
export function cutoffFor(nowMs, days) {
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) throw new RetentionInputError('Relógio inválido para calcular o corte da retenção.');
  if (typeof days !== 'number' || !Number.isFinite(days) || days <= 0) throw new RetentionInputError('Quantidade de dias inválida para calcular o corte da retenção.');
  return new Date(nowMs - days * DAY_MS).toISOString();
}

function positiveInt(value, name) {
  if (!Number.isInteger(value) || value < 1) throw new RetentionInputError(`${name} precisa ser um inteiro positivo.`);
  return value;
}

const toIso = (v) => {
  if (v === null || v === undefined) return null;
  const ms = v instanceof Date ? v.getTime() : Date.parse(String(v));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

// Só nível e data. NUNCA `data`/mensagem: o resultado vai para um log público.
const SQL_INSPECT = `SELECT count(*)::int AS total,
       count(*) FILTER (WHERE created_date IS NULL)::int AS sem_data,
       count(*) FILTER (WHERE created_date < $1)::int AS a_apagar,
       min(created_date) AS mais_antigo,
       max(created_date) AS mais_recente
FROM system_logs`;

const SQL_BY_LEVEL = `SELECT COALESCE(level, '(sem nível)') AS level, count(*)::int AS n
FROM system_logs
WHERE created_date < $1
GROUP BY 1
ORDER BY 1`;

// Um lote: os mais antigos primeiro (aproveita o índice system_logs_created_idx). Cada lote é um comando próprio (commit sozinho).
const SQL_DELETE_BATCH = `DELETE FROM system_logs
WHERE id IN (
  SELECT id FROM system_logs
  WHERE created_date < $1
  ORDER BY created_date ASC
  LIMIT $2
)`;

const SQL_COUNT = 'SELECT count(*)::int AS total FROM system_logs';

/**
 * Roda a retenção. `mode: 'simular'` (padrão) só conta; `'aplicar'` apaga.
 * @param {{ db: { query: Function }, mode?: unknown, days?: unknown, nowMs?: number, batchSize?: number, maxBatches?: number }} opts
 * @returns {Promise<{
 *   mode: 'simular'|'aplicar', days: number, cutoff: string, total: number, semData: number, aApagar: number,
 *   porNivel: Record<string, number>, maisAntigo: string|null, maisRecente: string|null,
 *   pulado: null|'tabela_vazia'|'nada_a_apagar'|'sem_logs_recentes',
 *   apagados: number, lotes: number, restante: boolean, totalDepois: number|null
 * }>}
 */
export async function runLogsRetention({ db, mode, days, nowMs = Date.now(), batchSize = BATCH_SIZE, maxBatches = MAX_BATCHES }) {
  // Tudo é validado ANTES de a primeira consulta: entrada ruim nunca chega ao banco.
  const modo = parseRetentionMode(mode);
  const dias = parseRetentionDays(days);
  positiveInt(batchSize, 'batchSize');
  positiveInt(maxBatches, 'maxBatches');
  const cutoff = cutoffFor(nowMs, dias);

  const { rows: [agg] } = await db.query(SQL_INSPECT, [cutoff]);
  const total = Number(agg.total);
  const aApagar = Number(agg.a_apagar);
  const maisAntigo = toIso(agg.mais_antigo);
  const maisRecente = toIso(agg.mais_recente);

  const report = {
    mode: modo, days: dias, cutoff, total, semData: Number(agg.sem_data), aApagar, porNivel: {},
    maisAntigo, maisRecente, pulado: null, apagados: 0, lotes: 0, restante: false, totalDepois: null,
  };

  if (aApagar > 0) {
    const { rows } = await db.query(SQL_BY_LEVEL, [cutoff]);
    for (const r of rows) report.porNivel[r.level] = Number(r.n);
  }

  if (total === 0) report.pulado = 'tabela_vazia';
  else if (aApagar === 0) report.pulado = 'nada_a_apagar';
  else if (maisRecente === null || Date.parse(maisRecente) < Date.parse(cutoff)) report.pulado = 'sem_logs_recentes';

  if (report.pulado || modo === 'simular') return report;

  let ultimo = 0;
  while (report.lotes < maxBatches) {
    const res = await db.query(SQL_DELETE_BATCH, [cutoff, batchSize]);
    ultimo = Number(res.rowCount ?? 0);
    report.lotes += 1;
    report.apagados += ultimo;
    if (ultimo < batchSize) break;
  }
  report.restante = report.lotes >= maxBatches && ultimo >= batchSize;

  const { rows: [depois] } = await db.query(SQL_COUNT);
  report.totalDepois = Number(depois.total);
  return report;
}

const PULADO_TEXTO = {
  tabela_vazia: () => 'A tabela está vazia: nada a fazer.',
  nada_a_apagar: (r) => `Nada a apagar: todos os logs com data têm menos de ${r.days} dias.`,
  sem_logs_recentes: (r) =>
    `Não há nenhum log recente (o mais novo é de ${r.maisRecente ?? 'data desconhecida'}, mais velho que o corte de ${r.days} dias). `
    + `Isso parece uma queda longa do sistema ou um relógio errado, então ${r.mode === 'aplicar' ? 'não apaguei nada' : 'não apagaria nada (e nada foi apagado)'}: `
    + 'nesses casos os logs antigos são a evidência do que aconteceu.',
};

const niveis = (porNivel) => {
  const itens = Object.entries(porNivel);
  return itens.length ? ` (${itens.map(([k, v]) => `${k}: ${v}`).join(' · ')})` : '';
};

/**
 * Texto do relatório (markdown), em português simples. SÓ números, níveis e datas: o resumo do job é público.
 * @param {Awaited<ReturnType<typeof runLogsRetention>>} r
 * @returns {string}
 */
export function formatRetentionReport(r) {
  const linhas = [
    `## Retenção do system_logs — ${r.mode === 'aplicar' ? 'aplicação' : 'simulação'}`,
    '',
    `- Regra: guardar ${r.days} dias (corte: ${r.cutoff}).`,
    `- Logs na tabela: ${r.total}${r.semData ? ` (${r.semData} sem data, que nunca são apagados)` : ''}.`,
    `- Mais antigo: ${r.maisAntigo ?? '—'} · mais recente: ${r.maisRecente ?? '—'}.`,
    `- Mais velhos que o corte: ${r.aApagar}${niveis(r.porNivel)}.`,
    '',
  ];
  if (r.pulado) {
    linhas.push(PULADO_TEXTO[r.pulado](r));
  } else if (r.mode === 'simular') {
    linhas.push(`**Simulação: nada foi apagado.** Rodando para valer, seriam apagados ${r.aApagar} logs.`);
  } else {
    linhas.push(`Apagados: **${r.apagados}** em ${r.lotes} lote${r.lotes === 1 ? '' : 's'}. Logs que sobraram: ${r.totalDepois}.`);
    if (r.restante) linhas.push('Ainda restam logs antigos: a próxima execução continua de onde parou.');
  }
  return linhas.join('\n');
}
