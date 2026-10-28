// Contexto de Mercado (docs/known-risks.md item 284/285) — calculadora de
// orçamento. Parte pura (sem rede, sem Date.now). Responde, ANTES de construir
// o coletor: "quantas chamadas por mês cada fonte vai receber, quantos minutos
// de GitHub Actions e quanto a branch de dados cresce — e isso cabe com folga?".
//
// Dois tetos por recurso, de propósito:
//  - `limitPerMonth`  = o limite DOCUMENTADO do provedor (não é nosso);
//  - `internalCapRatio` = fração desse limite que aceitamos usar. Passou, o
//    teste falha — a folga existe para o provedor mudar a regra ou para um
//    erro de conta nosso não nos deixar sem a fonte.
// Os números de `callsPerRun` são o DESENHO (item 284), não medição: a sonda
// (scripts/context-probe.mjs) e a coleta "sombra" da Fase 2 é que medem.

export const DAYS_PER_MONTH = 30;

/** Desenho aprovado: 3 coletas por dia (07h/12h/21h de Brasília). */
export const DEFAULT_CONFIG = Object.freeze({
  runsPerDay: 3,
  sources: Object.freeze([
    // limitPerMonth: limite documentado (CoinGecko Demo = 10.000 créditos/mês). null = sem limite publicado.
    { id: 'coingecko', callsPerRun: 2, limitPerMonth: 10000, internalCapRatio: 0.5, note: '/global + /coins/markets?ids= (1 crédito cada, a confirmar)' },
    { id: 'alternative-me-fng', callsPerRun: 1, limitPerMonth: null, internalCapRatio: null, note: 'sem limite publicado' },
    { id: 'bls-calendar', callsPerRun: 1, limitPerMonth: null, internalCapRatio: null, note: 'bls.ics; poderia ser 1x/dia' },
    { id: 'fed-rss', callsPerRun: 1, limitPerMonth: null, internalCapRatio: null, note: 'RSS' },
    { id: 'binance-spot', callsPerRun: 1, limitPerMonth: null, internalCapRatio: null, note: 'ticker BTC/ETH (1 chamada com as duas)' },
    { id: 'defillama', callsPerRun: 1, limitPerMonth: null, internalCapRatio: null, note: 'opcional (Fase 6)' },
    { id: 'mempool-space', callsPerRun: 1, limitPerMonth: null, internalCapRatio: null, note: 'opcional (Fase 6)' },
  ]),
  actions: Object.freeze({
    // Repositório PÚBLICO: runners padrão são gratuitos (docs.github.com/billing). O teto abaixo é
    // um alarme NOSSO — se o coletor ficar lento a ponto de passar disso, algo está errado.
    minutesPerRun: 3,
    internalCapMinutesPerMonth: 600,
  }),
  storage: Object.freeze({
    // Crescimento bruto da branch `context-data` (antes da compressão do git).
    statusBytesPerRun: 8 * 1024,
    eventsPerDay: 20,
    bytesPerEvent: 1536,
    internalCapMBPerYear: 50,
  }),
});

const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

/**
 * @param {typeof DEFAULT_CONFIG} config
 * @returns {{ ok: boolean, runsPerMonth: number,
 *   sources: { id: string, callsPerMonth: number, limitPerMonth: number|null, ratio: number|null,
 *              internalCapRatio: number|null, ok: boolean, note: string }[],
 *   actions: { minutesPerMonth: number, internalCap: number, ok: boolean },
 *   storage: { mbPerYear: number, internalCapMB: number, ok: boolean } }}
 */
export function estimateBudget(config = DEFAULT_CONFIG) {
  const runsPerMonth = config.runsPerDay * DAYS_PER_MONTH;

  const sources = config.sources.map((s) => {
    const callsPerMonth = s.callsPerRun * runsPerMonth;
    const ratio = s.limitPerMonth ? callsPerMonth / s.limitPerMonth : null;
    const ok = ratio === null || s.internalCapRatio === null || ratio <= s.internalCapRatio;
    return {
      id: s.id, callsPerMonth, limitPerMonth: s.limitPerMonth,
      ratio: ratio === null ? null : round(ratio, 4),
      internalCapRatio: s.internalCapRatio, ok, note: s.note || '',
    };
  });

  const minutesPerMonth = config.actions.minutesPerRun * runsPerMonth;
  const actions = {
    minutesPerMonth,
    internalCap: config.actions.internalCapMinutesPerMonth,
    ok: minutesPerMonth <= config.actions.internalCapMinutesPerMonth,
  };

  const st = config.storage;
  const bytesPerDay = st.statusBytesPerRun * config.runsPerDay + st.eventsPerDay * st.bytesPerEvent;
  const mbPerYear = (bytesPerDay * 365) / (1024 * 1024);
  const storage = {
    mbPerYear: round(mbPerYear, 1),
    internalCapMB: st.internalCapMBPerYear,
    ok: mbPerYear <= st.internalCapMBPerYear,
  };

  return { ok: sources.every((s) => s.ok) && actions.ok && storage.ok, runsPerMonth, sources, actions, storage };
}

/** Cenário de estresse: multiplica a cadência (ex.: 10× = 30 coletas/dia, 20× eventos). */
export function stress(config, factor) {
  return {
    ...config,
    runsPerDay: config.runsPerDay * factor,
    storage: { ...config.storage, eventsPerDay: config.storage.eventsPerDay * factor },
  };
}

/** Em estresse o teto interno não vale (é folga); o que não pode é passar do limite DO PROVEDOR. */
export function exceedsProviderLimit(estimate) {
  return estimate.sources.filter((s) => s.ratio !== null && s.ratio > 1).map((s) => s.id);
}

/** Tabela em markdown para o resumo do job / relatório. */
export function formatBudgetTable(estimate) {
  const pct = (r) => (r === null ? '—' : `${(r * 100).toFixed(1).replace('.', ',')}%`);
  const lines = [
    '| Fonte | Chamadas/mês | Limite do provedor | Uso | Teto interno | Situação |',
    '|---|---:|---:|---:|---:|---|',
  ];
  for (const s of estimate.sources) {
    lines.push(`| ${s.id} | ${s.callsPerMonth} | ${s.limitPerMonth ?? 'sem limite publicado'} | ${pct(s.ratio)} | ${s.internalCapRatio === null ? '—' : pct(s.internalCapRatio)} | ${s.ok ? 'OK' : 'ACIMA DO TETO'} |`);
  }
  lines.push('');
  lines.push(`- GitHub Actions: ${estimate.actions.minutesPerMonth} min/mês (teto interno ${estimate.actions.internalCap}) — ${estimate.actions.ok ? 'OK' : 'ACIMA DO TETO'}`);
  lines.push(`- Branch de dados: ${estimate.storage.mbPerYear} MB/ano (teto interno ${estimate.storage.internalCapMB}) — ${estimate.storage.ok ? 'OK' : 'ACIMA DO TETO'}`);
  return lines.join('\n');
}
