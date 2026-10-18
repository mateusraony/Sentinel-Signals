// Seção `targets` do relatório de backtest — docs/known-risks.md item 281.
// Pura: recebe as operações do backend do replay e descreve o que o braço de
// alvo fez — quantas operações ficaram com o alvo estrutural e quantas caíram
// no alvo do controle (e por quê), a que distância da entrada o TP1 ficou e
// como as operações saíram. A regra pré-registrada usa `fallbackRate` (entre as
// operações da cascata 4h_15m, as únicas que o braço toca): acima de 50%, a
// janela é INCONCLUSIVA para o braço.

import { getOpenedAt, getExitPrice, isClosedOp } from './tradeMetrics.js';
import { TARGET_RULES } from './indicators/structuralTargets.js';

// Mesma regra do relatório principal (backtestEngine.js): operação aberta no
// aquecimento não conta; sem horário de abertura, não filtra (fail-open).
const inWindow = (op, fromMs, toMs) => {
  const iso = getOpenedAt(op);
  if (!iso) return true;
  const t = new Date(iso).getTime();
  return !Number.isFinite(t) || ((fromMs == null || t >= fromMs) && (toMs == null || t <= toMs));
};

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function summarizeTargets({ ops = [], targetMode, targetNearPolicy, fromMs = null, toMs = null }) {
  const armOps = ops.filter((op) => op.target_mode != null && inWindow(op, fromMs, toMs));
  const byBasis = {};
  const fallbackReasons = {};
  for (const op of armOps) {
    byBasis[op.target_basis] = (byBasis[op.target_basis] || 0) + 1;
    if (op.target_fallback_reason) fallbackReasons[op.target_fallback_reason] = (fallbackReasons[op.target_fallback_reason] || 0) + 1;
  }
  const fallbacks = byBasis.R_MULTIPLE_FALLBACK || 0;
  const closed = armOps.filter(isClosedOp);
  // Stop antes do TP1 em lucro = trailing pré-TP1 (item 132), não perda.
  const exits = { stopBeforeTp1Loss: 0, stopBeforeTp1Profit: 0, stopAfterTp1: 0, tp2: 0, timeStop: 0, other: 0 };
  const inProfit = (op) => {
    const exit = getExitPrice(op);
    return Number.isFinite(exit) && (exit - op.entry_price) * (op.side === 'SELL' ? -1 : 1) > 0;
  };
  for (const op of closed) {
    if (op.status === 'TP2_HIT') exits.tp2 += 1;
    else if (op.status === 'STOP_HIT' && op.tp1_hit) exits.stopAfterTp1 += 1;
    else if (op.status === 'STOP_HIT') exits[inProfit(op) ? 'stopBeforeTp1Profit' : 'stopBeforeTp1Loss'] += 1;
    else if (op.closed_reason === 'TIME_STOP') exits.timeStop += 1;
    else exits.other += 1;
  }
  const tp1R = armOps.map((op) => op.rr_at_entry_target).filter(Number.isFinite);
  const firstLevelR = armOps.map((op) => op.target_first_level_r).filter(Number.isFinite);
  return {
    targetMode: targetMode ?? null,
    targetNearPolicy: targetNearPolicy ?? null,
    ops: armOps.length,
    byBasis,
    fallbackReasons,
    fallbackRate: armOps.length ? fallbacks / armOps.length : null,
    inconclusiveByFallback: armOps.length ? fallbacks / armOps.length > 0.5 : null,
    medianTp1R: median(tp1R),
    medianFirstLevelR: median(firstLevelR),
    firstLevelBelowMinR: firstLevelR.filter((r) => r < TARGET_RULES.minTargetR).length,
    closedOps: closed.length,
    exits,
    tp1Rate: closed.length ? closed.filter((op) => op.tp1_hit).length / closed.length : null,
    // report.indicatorAttribution simula os sinais rejeitados com o alvo do
    // controle (1,5R/3R, indicatorAttribution.js) — não com o alvo do braço.
    note: 'indicatorAttribution deste relatório usa os alvos do controle (1,5R/3R)',
  };
}

const TARGET_KEYS = new Set(['targetMode', 'targetNearPolicy']);
const hasSmcArg = (trialArgs) => /--smc(-confirm)?\s+(?!--)\S/.test(String(trialArgs ?? ''));
// Opções que só nomeiam arquivo ou rótulo da rodada — legitimamente diferentes
// entre controle e braço. Todo o resto (moedas, janela, --rf-period,
// --rf-multiplier, custos, --smc...) tem que ser igual.
const LABEL_ONLY_ARGS = new Set(['--out', '--trial-label', '--pine-config']);
function runArgs(trialArgs) {
  const tokens = String(trialArgs ?? '').split(/\s+/).filter(Boolean);
  const out = [];
  for (let i = 0; i < tokens.length; i += 1) {
    if (LABEL_ONLY_ARGS.has(tokens[i])) {
      if (tokens[i + 1] && !tokens[i + 1].startsWith('--')) i += 1;
      continue;
    }
    out.push(tokens[i]);
  }
  return out.join(' ');
}

/**
 * Procedência de um par controle × braço antes da comparação (item 281):
 * o compare-backtest-reports.mjs confere janela, moedas, commit e custos, mas
 * não a config da estratégia. Aqui: controle com o alvo de hoje, braço com um
 * alvo estrutural, e as duas configs IGUAIS fora das duas chaves de alvo; os
 * argumentos da rodada iguais fora de arquivo/rótulo (os parâmetros do ativo,
 * como --rf-period, não ficam no pineConfig — achado do Codex, PR #507); sem
 * cascata SMC em nenhum dos dois (pré-registro, runConfig).
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function checkArmProvenance(control, arm) {
  const errors = [];
  const cc = control?.reproducibility?.pineConfig;
  const ac = arm?.reproducibility?.pineConfig;
  if (!cc || !ac) return { ok: false, errors: ['relatório sem reproducibility.pineConfig'] };
  if ((cc.targetMode ?? 'r_multiple') !== 'r_multiple') errors.push(`controle com targetMode ${cc.targetMode}`);
  if (!['fib_ext_15m', 'swing_4h'].includes(ac.targetMode)) errors.push(`braço com targetMode ${ac.targetMode}`);
  const keys = new Set([...Object.keys(cc), ...Object.keys(ac)]);
  for (const k of keys) {
    if (TARGET_KEYS.has(k)) continue;
    if (JSON.stringify(cc[k]) !== JSON.stringify(ac[k])) errors.push(`config difere fora das chaves de alvo: ${k}`);
  }
  if (runArgs(control?.trialArgs) !== runArgs(arm?.trialArgs)) errors.push('argumentos da rodada diferem fora de --out/--trial-label/--pine-config');
  if (hasSmcArg(control?.trialArgs) || hasSmcArg(arm?.trialArgs)) errors.push('cascata SMC ligada (o pré-registro fixa smc vazio)');
  return { ok: errors.length === 0, errors };
}
