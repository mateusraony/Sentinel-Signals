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
const MS_PER_MONTH = 30 * 24 * 60 * 60 * 1000;

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

// Janela compartilhada (min..max created_date de TODAS as ops, das 2
// cascatas juntas) — as 2 cascatas são amostradas pelo MESMO scan sombra
// contínuo, então usar uma janela por-cascade enviesaria a taxa se uma
// delas começou a produzir operação depois da outra. Retorna null quando
// não há dado suficiente pra medir um intervalo (0 ou 1 timestamp).
function sharedWindowMonths(allOps) {
  const timestamps = allOps
    .map((op) => new Date(op.created_date).getTime())
    .filter((t) => Number.isFinite(t));
  if (timestamps.length < 2) return null;
  const spanMs = Math.max(...timestamps) - Math.min(...timestamps);
  return spanMs > 0 ? spanMs / MS_PER_MONTH : null;
}

// Exportado para poder ser testado sem Firestore — recebe os grupos de ops
// já separados por cascade e devolve o mesmo shape que main() imprime.
//
// Codex review (PR #129, P2): a versão anterior declarava veredito
// "decisão-grade" só com amostra+IC, sem checar a condição de volume que
// docs/known-risks.md item 56 também exige ("operações/mês do experimental
// meaningfully maior que a nativa"). Corrigido: o rótulo "decisão-grade"
// nunca é emitido sozinho — o critério de volume é numérico (operationsPerMonth
// por cascade, janela compartilhada) e sempre reportado ao lado, mas a
// palavra "meaningfully" fica deliberadamente sem um multiplicador
// hard-coded aqui (evita trocar um número arbitrário do achado por outro) —
// quem lê o relatório compara os 2 números e decide, mesmo espírito de
// "nunca decide sozinho, só formata" do resto deste script.
export function buildShadowComparison(opsByCascade) {
  const allOps = Object.values(opsByCascade).flat();
  const windowMonths = sharedWindowMonths(allOps);

  const result = {};
  for (const [cascade, ops] of Object.entries(opsByCascade)) {
    const summary = summarizeOps(ops, { minTrades: MIN_TRADES });
    const bonferroniCI = cascade === EXPERIMENTAL_CASCADE
      ? expectancyCIAtZ(summary.expectancyR, summary.expectancyRStdErr, BONFERRONI_Z_M2)
      : null;
    const operationsPerMonth = windowMonths ? summary.total / windowMonths : null;

    let verdict = 'INCONCLUSIVO (amostra < mínimo)';
    if (summary.counted >= MIN_TRADES) {
      const ciToCheck = bonferroniCI ?? summary.expectancyRCI95;
      if (ciToCheck && !(ciToCheck[0] <= 0 && ciToCheck[1] >= 0)) {
        const direction = summary.expectancyR > 0 ? 'positivo' : 'negativo';
        if (summary.counted >= TARGET_TRADES) {
          // Estatisticamente decisivo (amostra+IC) — mas isso NUNCA é o
          // critério de sucesso completo pra cascade === EXPERIMENTAL_CASCADE
          // sozinho: known-risks item 56 exige TAMBÉM volume/mês > nativa.
          verdict = cascade === EXPERIMENTAL_CASCADE
            ? `SINAL ESTATÍSTICO ${direction.toUpperCase()} (amostra+IC) — falta confirmar volume/mês vs cascade nativa (ver comparação abaixo, known-risks item 56) antes de chamar de decisão-grade`
            : `SINAL ${direction.toUpperCase()} (decisão-grade)`;
        } else {
          verdict = `SINAL (${direction}), mas amostra ainda abaixo do alvo (${TARGET_TRADES})`;
        }
      } else {
        verdict = 'INCONCLUSIVO (IC cruza zero)';
      }
    }
    result[cascade] = {
      ...summary, bonferroniCI, bonferroniZ: bonferroniCI ? BONFERRONI_Z_M2 : null, operationsPerMonth, verdict,
    };
  }

  // Comparação de volume explícita — número, não veredito. null quando
  // qualquer um dos 2 lados não tem janela mensurável ainda (amostra cedo
  // demais pra ter um intervalo created_date com span > 0).
  const expRate = result[EXPERIMENTAL_CASCADE]?.operationsPerMonth ?? null;
  const nativeRate = result[NATIVE_CASCADE]?.operationsPerMonth ?? null;
  result.volumeComparison = {
    experimentalOperationsPerMonth: expRate,
    nativeOperationsPerMonth: nativeRate,
    ratio: expRate !== null && nativeRate !== null && nativeRate > 0 ? expRate / nativeRate : null,
  };

  return result;
}

function renderComparison(comparison) {
  const out = [];
  out.push('=== Modo sombra — RF 1h condicionado ao 4h (Fase 1) ===');
  out.push('Nunca decide sozinho — critério completo em docs/known-risks.md item 56.');
  out.push('');
  for (const [cascade, s] of Object.entries(comparison)) {
    if (cascade === 'volumeComparison') continue; // renderizado à parte, abaixo
    const label = cascade === EXPERIMENTAL_CASCADE ? `${cascade} (EXPERIMENTAL)`
      : cascade === NATIVE_CASCADE ? `${cascade} (controle nativo, sombreado de graça)`
        : `${cascade} (fora do veredito — reportado por completude)`;
    out.push(`--- ${label} ---`);
    out.push(`operações fechadas: ${s.total} (com R calculável: ${s.rCounted}, piso mínimo: ${MIN_TRADES}, alvo: ${TARGET_TRADES})`);
    out.push(`expectância líquida: ${fmt(s.expectancyR)} R`);
    out.push(`IC 95% (z=1.96): ${ciStr(s.expectancyRCI95)}`);
    if (s.bonferroniCI) out.push(`IC Bonferroni (z=${s.bonferroniZ}, m=2): ${ciStr(s.bonferroniCI)}`);
    out.push(`operações/mês (janela compartilhada com a outra cascade): ${fmt(s.operationsPerMonth, 2)}`);
    out.push(`veredito: ${s.verdict}`);
    out.push('');
  }
  const vc = comparison.volumeComparison;
  if (vc) {
    out.push('--- Comparação de volume (o objetivo original — aumentar operações/mês) ---');
    out.push(`experimental: ${fmt(vc.experimentalOperationsPerMonth, 2)} op/mês · nativa: ${fmt(vc.nativeOperationsPerMonth, 2)} op/mês`
      + ` · razão: ${vc.ratio !== null ? `${fmt(vc.ratio, 2)}x` : '—'}`);
    out.push('Sem multiplicador fixo aqui de propósito — "meaningfully maior" (known-risks');
    out.push('item 56) é julgamento humano sobre estes 2 números, não um limiar automático.');
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
