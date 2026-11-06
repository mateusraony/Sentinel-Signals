// Medidor do uso de computação do Neon (docs/known-risks.md item 294). Parte PURA: sem rede, sem banco, sem Date.now.
//
// Por que existe: a cota grátis do Neon é de 100 CU-h de computação por mês (itens 282/286) e, até aqui, só dava para saber que ela
// tinha acabado DEPOIS que o sistema parava. Ler o consumo real exige uma chave de API do Neon (o usuário não a achou no console), então
// este medidor ESTIMA pelo que o GitHub enxerga: cada execução de workflow que usa o banco o mantém acordado por (duração + 5 min de
// ociosidade, o tempo que o Neon espera para suspender); somando o tempo acordado (sem contar duas vezes o que se sobrepõe) e
// multiplicando pela computação mínima de 0,25 CU, sai o consumo.
//
// HONESTIDADE: é um MÍNIMO, não o valor do console. Não vê o painel aberto (uma aba visível consulta o banco a cada 60 s e o mantém
// acordado), nem o servidor do Render, nem consultas feitas à mão. Por isso os avisos começam em 60% (não 70%) e a mensagem sempre diz o
// que fica de fora. Se o usuário um dia achar o painel "Usage" do Neon, pode CALIBRAR: informar o valor lido e a data (variáveis do
// repositório) e o medidor passa a somar só o que vem depois.
import { NEON_FREE_CU_HOURS, NEON_MIN_CU, NEON_IDLE_SUSPEND_MIN } from './neonComputeBudget.mjs';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

/** Daqui para cima o aviso vira "ATENÇÃO" / "CRÍTICO" (frações do limite de 100 CU-h; mais cedo que 70/90 porque a conta é um mínimo). */
export const WARN_RATIO = 0.6;
export const CRIT_RATIO = 0.8;
/** Uma execução que durou mais que isto conta só isto (uma execução travada não pode inflar o mês). */
export const MAX_RUN_MIN = 60;
/**
 * O ritmo "recente" (para projetar o fim do mês) é o MAIOR entre o das últimas 24 h e o das últimas 72 h: um aumento aparece na hora
 * (24 h) e uma queda só é creditada aos poucos (72 h). Para um alarme de limite, errar para cima é o lado seguro — olhar só as 72 h
 * subestimava o mês logo depois de o scan ser religado (dias desligados puxavam o ritmo para baixo). Com menos de 24 h de dados não se projeta.
 */
export const RECENT_WINDOWS_H = [24, 72];
export const MIN_HOURS_FOR_PROJECTION = 24;
/** O resumo diário (nível OK) sai só na execução da manhã (antes das 18h UTC); a da noite só fala se o nível não for OK. */
export const MORNING_BEFORE_UTC_HOUR = 18;

/**
 * Período de cobrança que contém `nowMs`: do dia `billingDay` (1..28, UTC) deste mês ou do anterior até o mesmo dia do mês seguinte.
 * A doc do Neon diz que a cota zera "no início do período mensal de cobrança" (provavelmente dia 1; não confirmado) — por isso o dia é ajustável.
 */
export function billingPeriod(nowMs, billingDay = 1) {
  const day = Number.isInteger(billingDay) && billingDay >= 1 && billingDay <= 28 ? billingDay : 1;
  const d = new Date(nowMs);
  let startMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), day);
  if (startMs > nowMs) startMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, day);
  const s = new Date(startMs);
  return { startMs, endMs: Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + 1, day) };
}

/**
 * Execuções → janelas em que o banco ficou acordado: [início, início + duração (no máximo MAX_RUN_MIN) + ociosidade].
 * @param {{ startMs: number, endMs?: number|null }[]} runs `endMs` ausente = ainda em andamento (vale até `nowMs`)
 */
export function toIntervals(runs, { nowMs, idleMin = NEON_IDLE_SUSPEND_MIN, maxRunMin = MAX_RUN_MIN }) {
  const out = [];
  for (const r of Array.isArray(runs) ? runs : []) {
    if (!Number.isFinite(r?.startMs)) continue;
    const end = Number.isFinite(r.endMs) ? r.endMs : nowMs;
    if (end < r.startMs) continue;
    out.push([r.startMs, r.startMs + Math.min(end - r.startMs, maxRunMin * MIN) + idleMin * MIN]);
  }
  return out;
}

/** Tempo (ms) em que ALGUMA janela estava ativa dentro de [fromMs, toMs] — janelas que se sobrepõem contam uma vez só. */
export function awakeMs(intervals, fromMs, toMs) {
  const clipped = intervals
    .map(([a, b]) => [Math.max(a, fromMs), Math.min(b, toMs)])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  let total = 0;
  let cur = null;
  for (const [a, b] of clipped) {
    if (!cur) cur = [a, b];
    else if (a <= cur[1]) cur[1] = Math.max(cur[1], b);
    else { total += cur[1] - cur[0]; cur = [a, b]; }
  }
  if (cur) total += cur[1] - cur[0];
  return total;
}

/** Valores de calibração das variáveis do repositório: `{ cuHours, atMs }` ou null se faltar/for inválido. */
export function parseBaseline(env = {}) {
  const cuHours = Number(String(env.NEON_BASELINE_CU_HOURS ?? '').replace(',', '.'));
  const atMs = Date.parse(String(env.NEON_BASELINE_AT ?? ''));
  if (String(env.NEON_BASELINE_CU_HOURS ?? '').trim() === '' || !Number.isFinite(cuHours) || cuHours < 0 || !Number.isFinite(atMs)) return null;
  return { cuHours, atMs };
}

/** 'critico' (≥ 80% do limite), 'atencao' (≥ 60%, ou a projeção do mês passa do limite) ou 'ok'. */
export function levelOf({ usedCu, projectedCu, limit = NEON_FREE_CU_HOURS }) {
  if (usedCu >= CRIT_RATIO * limit) return 'critico';
  if (usedCu >= WARN_RATIO * limit || (projectedCu !== null && projectedCu >= limit)) return 'atencao';
  return 'ok';
}

/**
 * A conta do mês.
 * @param {object} p
 * @param {{ startMs: number, endMs?: number|null }[]} p.runs execuções de workflows que usam o banco
 * @param {number} p.nowMs
 * @param {number} [p.billingDay]
 * @param {{ cuHours: number, atMs: number }|null} [p.baseline] valor lido no console do Neon e quando (só vale dentro do período atual)
 */
export function summarize({ runs, nowMs, billingDay = 1, baseline = null, limit = NEON_FREE_CU_HOURS, cu = NEON_MIN_CU }) {
  const { startMs, endMs } = billingPeriod(nowMs, billingDay);
  const intervals = toIntervals(runs, { nowMs });
  let usedCu = (awakeMs(intervals, startMs, nowMs) / HOUR) * cu;
  let calibratedAtMs = null;
  if (baseline && Number.isFinite(baseline.cuHours) && baseline.cuHours >= 0 && baseline.atMs >= startMs && baseline.atMs <= nowMs) {
    usedCu = baseline.cuHours + (awakeMs(intervals, baseline.atMs, nowMs) / HOUR) * cu;
    calibratedAtMs = baseline.atMs;
  }
  const remainingH = (endMs - nowMs) / HOUR;
  const recentShare = (nowMs - startMs) / HOUR >= MIN_HOURS_FOR_PROJECTION
    ? Math.max(...RECENT_WINDOWS_H.map((h) => {
      const from = Math.max(startMs, nowMs - h * HOUR);
      return awakeMs(intervals, from, nowMs) / (nowMs - from);
    }))
    : null;
  const projectedCu = recentShare === null ? null : usedCu + remainingH * recentShare * cu;
  return {
    periodStartMs: startMs,
    periodEndMs: endMs,
    limit,
    usedCu,
    ratio: usedCu / limit,
    recentShare,
    projectedCu,
    // Quanto cada hora de painel aberto soma: nessa hora o banco fica 100% acordado em vez de só `recentShare` do tempo.
    panelHourCu: recentShare === null ? null : (1 - recentShare) * cu,
    calibratedAtMs,
    level: levelOf({ usedCu, projectedCu, limit }),
  };
}

/** Política de envio: manual (botão "Enviar") sempre; agendado só no resumo da manhã ou quando o nível não é OK. */
export function shouldSend({ level, nowMs, trigger }) {
  if (trigger !== 'schedule') return true;
  return new Date(nowMs).getUTCHours() < MORNING_BEFORE_UTC_HOUR || level !== 'ok';
}

const fmt1 = (x) => (Math.round(x * 10) / 10).toFixed(1).replace('.', ',');
const fmt2 = (x) => (Math.round(x * 100) / 100).toFixed(2).replace('.', ',');
const dayMonth = (ms) => {
  const d = new Date(ms);
  return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

const LEVEL_TEXT = Object.freeze({ ok: 'OK', atencao: 'ATENÇÃO', critico: 'CRÍTICO' });
const LEVEL_ADVICE = Object.freeze({
  ok: null,
  atencao: 'Para gastar menos: feche as abas do painel quando não estiver usando e evite disparar o scan à mão.',
  critico: 'Perto do limite: se a cota acabar, o scan e o painel param até o próximo período. Feche as abas do painel e não dispare nada à mão.',
});

/** Mensagem em português simples para o Telegram (HTML; só texto fixo e números — nada vindo de fora). Sem emoji. */
export function buildMessage(s) {
  const lines = [
    '<b>Neon: uso de computação do mês (estimado)</b>',
    `Situação: <b>${LEVEL_TEXT[s.level]}</b>`,
    `Usado até agora: ${fmt1(s.usedCu)} de ${fmt1(s.limit)} CU-h (${Math.round(s.ratio * 100)}%)`,
    s.projectedCu === null
      ? 'Ainda sem dados suficientes para projetar o fim do mês.'
      : `No ritmo recente (o maior entre o último dia e os últimos 3), o mês termina com cerca de ${fmt1(s.projectedCu)} CU-h.`,
    `Período: ${dayMonth(s.periodStartMs)} a ${dayMonth(s.periodEndMs)} (horário UTC).`,
  ];
  const advice = LEVEL_ADVICE[s.level];
  if (advice) lines.push('', advice);
  lines.push('');
  lines.push(
    s.calibratedAtMs !== null
      ? `Calibrado com o valor do console do Neon de ${dayMonth(s.calibratedAtMs)}; o que vem depois é estimado pelo GitHub.`
      : 'É um mínimo: conta só o que o GitHub enxerga (scan, backup, auditorias).',
  );
  lines.push(
    s.panelHourCu === null
      ? 'Não inclui o painel aberto: ele mantém o banco acordado.'
      : `Não inclui o painel aberto: cada hora com ele aberto soma cerca de ${fmt2(s.panelHourCu)} CU-h.`,
  );
  return lines.join('\n');
}
