// Entender o mês sem ler a tabela de operações (tela Relatório mensal). Funções PURAS: entra a lista de operações FECHADAS do mês, sai número/texto
// — nada aqui toca banco, motor ou scanner. Todos os números vêm de `summarizeOps` (fonte única de métricas, `tradeMetrics.js`), então o que a tela
// diz é exatamente o que o painel, o Telegram e o PDF já calculam; este arquivo só AGRUPA e EXPLICA.
// Regras desta tela (não do motor): o mês é o da ABERTURA da operação (é o filtro `created_date` da consulta) e só entram operações já fechadas.
// Honestidade: amostra pequena ou margem de erro cruzando zero nunca vira "a estratégia funciona" — o texto diz que não dá para concluir.
import { summarizeOps, getOpenedAt, DEFAULT_COST_MODEL } from '@/lib/tradeMetrics';

/** Percentual com sinal e 2 casas, "—" quando não há número. */
export function fmtPct(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  const sign = v >= 0 ? '+' : '';
  return `${sign}${v.toFixed(2)}%`;
}

/** R com sinal e 2 casas ("+0.12R"), "—" quando não há número. */
export function fmtR(v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}R`;
}

/** Duração legível: "35 min", "6 h", "2 d 4 h". `null` quando não dá para saber. */
export function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const min = Math.round(ms / 60000);
  if (min < 60) return `${Math.max(min, 1)} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h`;
  const d = Math.floor(h / 24);
  const rest = h - d * 24;
  return rest > 0 ? `${d} d ${rest} h` : `${d} d`;
}

/** Quanto tempo a operação ficou aberta (ms) ou `null` quando faltar um dos horários. */
export function opDurationMs(op) {
  // Não usa getClosedAt: o último recurso dele é created_date, que daria duração "0" para um registro antigo sem horário de fechamento.
  const a = getOpenedAt(op);
  const b = op?.closed_at ?? op?.updated_date ?? null;
  const ta = a ? new Date(a).getTime() : NaN;
  const tb = b ? new Date(b).getTime() : NaN;
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null;
  const d = tb - ta;
  return d >= 0 ? d : null;
}

function groupBy(curve, keyOf) {
  const map = new Map();
  for (const c of curve) {
    if (c.pnlPct === null) continue; // operação sem preço de saída conhecido: fora das contas (igual ao summarizeOps)
    const key = keyOf(c.op);
    const g = map.get(key) ?? { key, n: 0, wins: 0, losses: 0, be: 0, pnl: 0 };
    g.n += 1;
    g.pnl += c.pnlPct;
    if (c.outcome === 'WIN') g.wins += 1;
    else if (c.outcome === 'LOSS') g.losses += 1;
    else g.be += 1;
    map.set(key, g);
  }
  return [...map.values()].map((g) => ({ ...g, winRate: g.n > 0 ? (g.wins / g.n) * 100 : 0 }));
}

/**
 * Leitura numérica do mês. `ops` = operações FECHADAS do mês (a tela já filtra com `isClosedOp`).
 * @param {Array<object>} ops
 */
export function analyzeMonth(ops) {
  const s = summarizeOps(ops);
  const known = s.curve.filter((c) => c.pnlPct !== null);
  const pnls = known.map((c) => c.pnlPct);
  const best = known.length > 0 ? known.reduce((a, b) => (b.pnlPct > a.pnlPct ? b : a)) : null;
  const worst = known.length > 0 ? known.reduce((a, b) => (b.pnlPct < a.pnlPct ? b : a)) : null;
  const byAsset = groupBy(s.curve, (op) => op.symbol ?? '—').sort((a, b) => b.pnl - a.pnl);
  const bySide = groupBy(s.curve, (op) => op.side ?? '—').sort((a, b) => b.n - a.n);
  const durations = s.curve.map((c) => opDurationMs(c.op)).filter((d) => d !== null);
  return {
    summary: s,
    n: s.total,
    counted: s.counted,
    unknown: s.unknown,
    totalPnl: s.totalPnlPct,
    wins: s.wins, be: s.be, losses: s.losses,
    winRate: s.winRate,
    profitFactor: s.profitFactor,
    maxDrawdownPct: s.maxDrawdownPct,
    expectancyR: s.expectancyR,
    ci95: s.expectancyRCI95,
    conclusive: s.conclusive,
    inconclusiveReason: s.inconclusiveReason,
    minTrades: s.minTrades,
    avgWinPct: s.avgWinPct,
    avgLossPct: s.avgLossPct,
    totalCostPct: s.totalCostPct,
    bestTrade: best ? { op: best.op, pnl: best.pnlPct } : null,
    worstTrade: worst ? { op: worst.op, pnl: worst.pnlPct } : null,
    bestPct: pnls.length > 0 ? Math.max(...pnls) : null,
    worstPct: pnls.length > 0 ? Math.min(...pnls) : null,
    byAsset,
    bySide,
    avgDurationMs: durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : null,
    durationsCounted: durations.length,
  };
}

const plural = (n, um, varios) => (n === 1 ? um : varios);

/**
 * Leitura do mês em português simples. Só afirma o que os números sustentam.
 * @param {ReturnType<typeof analyzeMonth>} a
 * @param {{ partial?: boolean, openCount?: number }} [ctx] partial = mês ainda em andamento; openCount = operações do mês que ainda não fecharam
 * @returns {{ tone: 'positive'|'negative'|'neutral', headline: string, lines: string[], note: string|null }}
 */
export function explainMonth(a, { partial = false, openCount = 0 } = {}) {
  const lines = [];
  // Nenhuma operação com resultado conhecido (ex.: registros antigos sem preço de saída): não há o que somar — dizer "+0.00%" seria falso.
  if (a.counted === 0) {
    return {
      tone: 'neutral',
      headline: `${a.n} ${plural(a.n, 'operação fechada', 'operações fechadas')}, mas nenhuma com resultado que dê para medir`,
      lines: ['Falta o preço de saída (ou o stop) registrado nessas operações, então resultado, taxa de acerto e média por operação não podem ser calculados.'],
      note: openCount > 0 ? `${openCount} ${plural(openCount, 'operação aberta neste mês ainda não fechou e não entra', 'operações abertas neste mês ainda não fecharam e não entram')} nestas contas.` : null,
    };
  }
  const tone = a.totalPnl > 0 ? 'positive' : a.totalPnl < 0 ? 'negative' : 'neutral';
  const word = a.totalPnl > 0 ? 'positivo' : a.totalPnl < 0 ? 'negativo' : 'zerado';
  const headline = `Mês ${word}: ${fmtPct(a.totalPnl)} em ${a.n} ${plural(a.n, 'operação fechada', 'operações fechadas')}`;

  // 1) O que dá (e o que NÃO dá) para concluir — sempre primeiro.
  if (a.inconclusiveReason === 'sample_too_small') {
    lines.push(`Amostra pequena: ${a.counted} ${plural(a.counted, 'operação contada', 'operações contadas')} (o mínimo para a conta de confiança é ${a.minTrades}). Um mês assim mostra o que aconteceu, não prova se a estratégia tem vantagem.`);
  } else if (a.inconclusiveReason === 'ci_straddles_zero' && a.ci95) {
    lines.push(`Mesmo com ${a.counted} operações, a média por operação (${fmtR(a.expectancyR)}) cabe na margem de erro (de ${fmtR(a.ci95[0])} a ${fmtR(a.ci95[1])}): ainda não dá para dizer se há vantagem.`);
  } else if (a.inconclusiveReason === 'no_r_samples') {
    lines.push('Faltam dados de risco (R) nas operações do mês, então não dá para medir a média por operação com margem de erro.');
  } else if (a.conclusive && a.ci95) {
    lines.push(`A margem de erro (95%) da média por operação fica toda ${a.ci95[0] > 0 ? 'acima' : 'abaixo'} de zero (${fmtR(a.ci95[0])} a ${fmtR(a.ci95[1])}) — conta simples, que trata as operações como independentes.`);
  }

  // 2) Dependência de uma operação só.
  if (a.bestTrade && a.bestTrade.pnl > 0 && a.totalPnl > 0 && a.n > 1) {
    const without = a.totalPnl - a.bestTrade.pnl;
    const sym = a.bestTrade.op.symbol?.replace('USDT', '') ?? 'a melhor operação';
    if (without <= 0) {
      lines.push(`O mês só ficou positivo por causa de uma operação (${sym}, ${fmtPct(a.bestTrade.pnl)}): sem ela, o resultado seria ${fmtPct(without)}.`);
    } else if (a.bestTrade.pnl / a.totalPnl >= 0.5) {
      lines.push(`Uma operação (${sym}, ${fmtPct(a.bestTrade.pnl)}) responde por ${Math.round((a.bestTrade.pnl / a.totalPnl) * 100)}% do resultado; sem ela o mês seria ${fmtPct(without)}.`);
    }
  }

  // 3) Acerto × tamanho do ganho/perda.
  if (a.wins > 0 && a.losses > 0 && a.avgLossPct > 0) {
    const ratio = a.avgWinPct / a.avgLossPct;
    lines.push(`Acertou ${a.winRate.toFixed(0)}% das operações; cada ganho valeu em média ${ratio.toFixed(2).replace('.', ',')}× cada perda (${fmtPct(a.avgWinPct)} contra ${fmtPct(-a.avgLossPct)}).`);
  } else if (a.wins > 0 && a.losses === 0) {
    lines.push('Não houve nenhuma perda no mês — com amostra pequena isso costuma ser sorte de mês, não garantia.');
  } else if (a.wins === 0 && a.losses > 0) {
    lines.push('Não houve nenhum ganho no mês.');
  }

  // 4) Pior trecho.
  if (a.maxDrawdownPct > 0) {
    lines.push(`O pior trecho do mês tirou ${a.maxDrawdownPct.toFixed(2)}% do acumulado (do ponto mais alto ao mais baixo, na ordem em que as operações fecharam).`);
  }

  // 5) Onde nasceu o resultado.
  if (a.byAsset.length >= 2) {
    const top = a.byAsset[0];
    const bottom = a.byAsset[a.byAsset.length - 1];
    const parts = [];
    if (top.pnl > 0) parts.push(`quem mais ajudou: ${top.key.replace('USDT', '')} (${fmtPct(top.pnl)})`);
    if (bottom.pnl < 0 && bottom.key !== top.key) parts.push(`quem mais pesou: ${bottom.key.replace('USDT', '')} (${fmtPct(bottom.pnl)})`);
    if (parts.length > 0) lines.push(`${parts.join('; ').replace(/^./, (c) => c.toUpperCase())}.`);
  }

  // 6) Custos (já dentro dos números).
  if (a.totalCostPct > 0) {
    lines.push(`Taxas, slippage e funding estimados já estão descontados: ${fmtPct(-a.totalCostPct)} no mês.`);
  }

  // 7) O que o relatório não enxerga.
  const notes = [];
  if (openCount > 0) notes.push(`${openCount} ${plural(openCount, 'operação aberta neste mês ainda não fechou e não entra', 'operações abertas neste mês ainda não fecharam e não entram')} nestas contas`);
  if (a.unknown > 0) notes.push(`${a.unknown} ${plural(a.unknown, 'operação fechada sem preço de saída registrado ficou', 'operações fechadas sem preço de saída registrado ficaram')} fora das contas`);
  if (partial) notes.push('o mês ainda está em andamento, então o resultado muda até o fim');
  const note = notes.length > 0 ? `${notes.join('; ').replace(/^./, (c) => c.toUpperCase())}.` : null;

  return { tone, headline, lines, note };
}

/**
 * Compara o mês com o anterior. Cada linha diz quem melhorou (`better`: true/false/null = indiferente/sem base).
 * Só compara quando os dois meses têm operação fechada COM resultado conhecido.
 * @param {ReturnType<typeof analyzeMonth>|null} cur
 * @param {ReturnType<typeof analyzeMonth>|null} prev
 */
export function compareMonths(cur, prev) {
  // Mês sem nenhuma operação com resultado conhecido não tem número para comparar (os agregados seriam zeros inventados).
  if (!cur || !prev || cur.counted === 0 || prev.counted === 0) return null;
  const row = (label, c, p, fmt, higherIsBetter) => {
    const bothNum = Number.isFinite(c) && Number.isFinite(p);
    const delta = bothNum ? c - p : null;
    return {
      label,
      cur: Number.isFinite(c) ? fmt(c) : '—',
      prev: Number.isFinite(p) ? fmt(p) : '—',
      delta,
      // higherIsBetter === null: indicador sem "lado melhor" (mais operações não é melhor nem pior) — só mostra os dois números.
      better: delta === null || delta === 0 || higherIsBetter === null ? null : (delta > 0) === higherIsBetter,
    };
  };
  return [
    row('Resultado do mês', cur.totalPnl, prev.totalPnl, fmtPct, true),
    row('Taxa de acerto', cur.winRate, prev.winRate, (v) => `${v.toFixed(1)}%`, true),
    row('Operações fechadas', cur.n, prev.n, (v) => String(v), null),
    row('Pior trecho', cur.maxDrawdownPct, prev.maxDrawdownPct, (v) => `${v.toFixed(2)}%`, false),
  ];
}

/** Custos que a conta desconta, em texto — lidos do modelo padrão (não escritos à mão aqui, para não divergir). */
export function costModelText(model = DEFAULT_COST_MODEL) {
  const pct = (bps) => `${(bps / 100).toFixed(2).replace('.', ',')}%`;
  return `taxa de ${pct(model.feeBpsEntry)} na entrada e ${pct(model.feeBpsExit)} na saída, slippage de ${pct(model.slippageBpsPerSide)} por lado e funding de ${pct(model.fundingBpsPer8h)} por cada virada de 8 h com a operação aberta`;
}
