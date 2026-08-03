// Relatório sob demanda do modo sombra prospectivo da Fase 1 (RF 1h
// condicionado ao 4h — docs/known-risks.md item 56 "Modo sombra"). Lê as
// TradeOperation acumuladas pelo scan-shadow.yml (coleção Firestore isolada
// experimentalRf1hShadowTradeOperations — nunca a coleção real de produção)
// e resume por cascade: nº de operações fechadas, expectância líquida (R),
// o IC 95% padrão (mesma fórmula que summarizeOps já usa em todo o resto do
// projeto) e o IC corrigido por Bonferroni (m=2 — esta cascata experimental
// compete com a pergunta ainda aberta do Bloco 0 sobre a RF 4h nativa, não é
// um teste independente). NUNCA decide sozinho: só formata o dado — o
// critério de decisão completo (amostra mínima/alvo, condição de sucesso,
// condição de parada) está registrado em docs/known-risks.md item 56.
//
// Diferente de scripts/analyze-backtest.mjs (lê um JSON de relatório já
// pronto), este script lê Firestore AO VIVO — precisa de
// FIREBASE_SERVICE_ACCOUNT_JSON no ambiente. Roda direto com Node (sem
// esbuild) porque src/lib/tradeMetrics.js não usa alias `@/` nem JSX, mesmo
// precedente do analyze-backtest.mjs.
//
// Usage:
//   node scripts/analyze-shadow-rf1h.mjs [--json]
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { summarizeOps, expectancyCIAtZ } from '../src/lib/tradeMetrics.js';

const SHADOW_TRADE_OPERATIONS_COLLECTION = 'experimentalRf1hShadowTradeOperations';
const EXPERIMENTAL_CASCADE = 'rf1h_cond4h_15m';
const NATIVE_CASCADE = '4h_15m';
// m=2 comparações (esta cascata + a pergunta ainda aberta do Bloco 0 sobre
// RF 4h nativo, docs/known-risks.md item 56) — Bonferroni a alpha=0.05:
// alpha/m=0.025 two-sided -> z≈2.24.
const BONFERRONI_Z_M2 = 2.24;
const MIN_TRADES = 30;
const TARGET_TRADES = 100;

function parseArgs(argv) {
  const args = { json: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') args.json = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Argumento desconhecido: ${arg}`);
  }
  return args;
}

const fmt = (value, digits = 3) => (value === null || value === undefined ? '—' : value.toFixed(digits));
const ciStr = (ci) => (ci ? `[${fmt(ci[0])}, ${fmt(ci[1])}]` : '—');

// Exportado para poder ser testado sem Firestore — recebe os grupos de ops
// já separados por cascade e devolve o mesmo shape que main() imprime.
export function buildShadowComparison(opsByCascade) {
  const result = {};
  for (const [cascade, ops] of Object.entries(opsByCascade)) {
    const summary = summarizeOps(ops, { minTrades: MIN_TRADES });
    const bonferroniCI = cascade === EXPERIMENTAL_CASCADE
      ? expectancyCIAtZ(summary.expectancyR, summary.expectancyRStdErr, BONFERRONI_Z_M2)
      : null;
    let verdict = 'INCONCLUSIVO (amostra < mínimo)';
    if (summary.counted >= MIN_TRADES) {
      const ciToCheck = bonferroniCI ?? summary.expectancyRCI95;
      if (ciToCheck && !(ciToCheck[0] <= 0 && ciToCheck[1] >= 0)) {
        verdict = summary.counted >= TARGET_TRADES
          ? (summary.expectancyR > 0 ? 'SINAL POSITIVO (decisão-grade)' : 'SINAL NEGATIVO (decisão-grade)')
          : `SINAL (${summary.expectancyR > 0 ? 'positivo' : 'negativo'}), mas amostra ainda abaixo do alvo (${TARGET_TRADES})`;
      } else {
        verdict = 'INCONCLUSIVO (IC cruza zero)';
      }
    }
    result[cascade] = { ...summary, bonferroniCI, bonferroniZ: bonferroniCI ? BONFERRONI_Z_M2 : null, verdict };
  }
  return result;
}

function renderComparison(comparison) {
  const out = [];
  out.push('=== Modo sombra — RF 1h condicionado ao 4h (Fase 1) ===');
  out.push('Nunca decide sozinho — critério completo em docs/known-risks.md item 56.');
  out.push('');
  for (const [cascade, s] of Object.entries(comparison)) {
    const label = cascade === EXPERIMENTAL_CASCADE ? `${cascade} (EXPERIMENTAL)`
      : cascade === NATIVE_CASCADE ? `${cascade} (controle nativo, sombreado de graça)`
        : `${cascade} (fora do veredito — reportado por completude)`;
    out.push(`--- ${label} ---`);
    out.push(`operações fechadas: ${s.total} (com R calculável: ${s.rCounted}, piso mínimo: ${MIN_TRADES}, alvo: ${TARGET_TRADES})`);
    out.push(`expectância líquida: ${fmt(s.expectancyR)} R`);
    out.push(`IC 95% (z=1.96): ${ciStr(s.expectancyRCI95)}`);
    if (s.bonferroniCI) out.push(`IC Bonferroni (z=${s.bonferroniZ}, m=2): ${ciStr(s.bonferroniCI)}`);
    out.push(`veredito: ${s.verdict}`);
    out.push('');
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('node scripts/analyze-shadow-rf1h.mjs [--json]');
    return;
  }

  if (!getApps().length) {
    initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)) });
  }
  const db = getFirestore();
  const snapshot = await db.collection(SHADOW_TRADE_OPERATIONS_COLLECTION).get();
  const ops = snapshot.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));

  const opsByCascade = {};
  for (const op of ops) {
    const cascade = op.cascade || 'unknown';
    (opsByCascade[cascade] ??= []).push(op);
  }
  // Sempre inclui as 2 cascatas do veredito, mesmo com zero operações ainda —
  // um relatório rodado no dia 1 do modo sombra deve mostrar "0 operações",
  // não simplesmente omitir a seção.
  opsByCascade[EXPERIMENTAL_CASCADE] ??= [];
  opsByCascade[NATIVE_CASCADE] ??= [];

  const comparison = buildShadowComparison(opsByCascade);

  if (args.json) {
    console.log(JSON.stringify(comparison, null, 2));
    return;
  }
  console.log(renderComparison(comparison).join('\n'));
}

if (process.argv[1] && process.argv[1].endsWith('analyze-shadow-rf1h.mjs')) main();
