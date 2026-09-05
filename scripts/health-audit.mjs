/**
 * Auditoria de saúde — o que está falhando e ninguém viu (item 164).
 *
 * Diagnóstico **read-only**, disparo **manual** (.github/workflows/health-audit.yml).
 * Não faz parte do relógio de trading, não escreve NADA, não abre nem fecha
 * operação. Mesmo molde do `count-1h-signals.mjs`.
 *
 * ## Por que isto existe
 *
 * O projeto tem um histórico específico de falha: **erro que não grita**.
 *
 * - Item 136 (P0-h): `undefined` num campo derrubou TODA criação de operação
 *   por ~2 semanas. O erro ia para o `SystemLog` e nunca derrubava o scan —
 *   então o job ficava verde, o Telegram ficava mudo, e o usuário só percebeu
 *   quando estranhou uma operação real que sumiu do painel.
 * - Item 162 (2026-09-05): duas execuções do backfill falharam de madrugada
 *   com cota REAL esgotada (`code: 8, Quota exceeded`), em dois dias seguidos,
 *   e ninguém olhou — porque nós dois só conferíamos de manhã, quando a cota
 *   já tinha zerado.
 *
 * Os dois têm a mesma forma: **o dado do problema já existia, faltava alguém
 * lendo.** Este script é esse alguém.
 *
 * ## A regra que o desenho segue: nunca custar mais do que anuncia
 *
 * O Firestore no plano gratuito cobra **por documento lido**, com teto DIÁRIO
 * (itens 150/151/155). Uma auditoria que varre coleções inteiras para
 * diagnosticar falta de cota seria a piada de sempre — o remédio virando a
 * doença. Por isso **toda leitura aqui tem teto explícito**, os tetos somam um
 * valor conhecido (ver ORÇAMENTO), e o relatório termina imprimindo o custo
 * REAL medido pelo contador do próprio adaptador (`backend.quota`).
 *
 * Rodar tarde no dia de cota é justamente quando o diagnóstico é mais útil e
 * mais arriscado. O teto é o que torna isso seguro.
 */
import { backend, rtdb } from './adminEntities.js';
import { agrupar, celula, haQuantoTempo } from './healthAuditFormat.mjs';

// ── Orçamento de leitura ────────────────────────────────────────────────────
// Somados: no MÁXIMO 520 documentos por execução (~1% do teto diário de 50k).
// Números escolhidos para responder a pergunta com folga, não para ser
// exaustivo — a auditoria mede TENDÊNCIA, não faz inventário.
const LIMITE_ERROS = 200;
const LIMITE_AVISOS = 100;
const LIMITE_OPS = 120;
const LIMITE_SINAIS = 100;
const ORCAMENTO_TOTAL = LIMITE_ERROS + LIMITE_AVISOS + LIMITE_OPS + LIMITE_SINAIS;

// Uma operação aberta há mais tempo que isto é suspeita em qualquer tier: o
// Time Stop mais longo da tabela é 64 barras de 4h (~10,7 dias). O dobro disso
// não é "operação demorada", é operação PRESA — a assinatura do bug do item 21
// (ponteiro órfão travando o ativo) e do item 136.
const OP_PRESA_MS = 21 * 24 * 60 * 60 * 1000;

const STATUS_TERMINAIS = ['STOP_HIT', 'TP2_HIT', 'INVALIDATED', 'CLOSED'];

const out = [];
const p = (linha = '') => { out.push(linha); console.log(linha); };

/** Cada checagem é isolada: uma que falhe não pode levar o relatório junto. */
async function checar(titulo, fn) {
  p(`\n## ${titulo}\n`);
  try {
    return await fn();
  } catch (e) {
    p(`⚠️ **A checagem falhou:** \`${e.message}\``);
    p('');
    p('Isto é informação, não um bug do relatório: se a leitura falhou com');
    p('`Quota exceeded`, a resposta da auditoria é justamente essa.');
    return null;
  }
}

// ── 1 · Erros ───────────────────────────────────────────────────────────────
async function checarErros() {
  const erros = await backend.entities.SystemLog.filter({ level: 'error' }, '-created_date', LIMITE_ERROS);
  if (erros.length === 0) { p('✅ Nenhum erro registrado.'); return { classes: 0 }; }

  const grupos = agrupar(erros);
  p(`**${erros.length} registros** (teto ${LIMITE_ERROS}) → **${grupos.length} problemas distintos**.`);
  if (erros.length === LIMITE_ERROS) {
    p('');
    p(`> ⚠️ O teto foi atingido: há mais erros do que isto. A janela coberta`);
    p(`> vai de ${erros[erros.length - 1]?.created_date} até ${erros[0]?.created_date}.`);
  }
  p('');
  p('| # | Módulo · problema | Ativos | Mais recente |');
  p('|---|---|---|---|');
  for (const g of grupos.slice(0, 15)) {
    const ativos = g.ativos.size ? `${g.ativos.size}` : '—';
    p(`| ${g.total} | ${celula(g.chave)} | ${ativos} | ${haQuantoTempo(g.ultimo)} |`);
  }

  // Um erro que acontece em MUITOS ativos ao mesmo tempo não é azar de um
  // ativo — é falha sistêmica. Foi essa a forma do item 136.
  const sistemicos = grupos.filter((g) => g.ativos.size >= 3);
  if (sistemicos.length) {
    p('');
    p('🚨 **Suspeita de falha sistêmica** (mesmo erro em 3+ ativos — assinatura do item 136,');
    p('que parou toda criação de operação por ~2 semanas sem derrubar nenhum job):');
    for (const g of sistemicos.slice(0, 5)) {
      p(`- \`${g.chave}\` — ${g.ativos.size} ativos, ${g.total}×, último ${haQuantoTempo(g.ultimo)}`);
      p(`  - exemplo: \`${String(g.exemplo).slice(0, 200)}\``);
    }
  }
  return { classes: grupos.length, sistemicos: sistemicos.length };
}

// ── 2 · Avisos ──────────────────────────────────────────────────────────────
async function checarAvisos() {
  const avisos = await backend.entities.SystemLog.filter({ level: 'warn' }, '-created_date', LIMITE_AVISOS);
  if (avisos.length === 0) { p('✅ Nenhum aviso.'); return; }
  const grupos = agrupar(avisos);
  p(`**${avisos.length} registros** (teto ${LIMITE_AVISOS}) → **${grupos.length} distintos**. Os 8 mais frequentes:`);
  p('');
  p('| # | Módulo · aviso | Mais recente |');
  p('|---|---|---|');
  for (const g of grupos.slice(0, 8)) {
    p(`| ${g.total} | ${celula(g.chave)} | ${haQuantoTempo(g.ultimo)} |`);
  }
  // O CAS descartando transição é o canal de observação do risco residual
  // documentado em .claude/rules/trading-engine.md — volume real aqui é o
  // gatilho para investir numa regra dura de precedência entre os dois loops.
  const cas = grupos.filter((g) => /Transição descartada pelo CAS/i.test(g.chave));
  if (cas.length) {
    p('');
    p(`⚠️ **${cas.reduce((s, g) => s + g.total, 0)} transições descartadas pelo CAS.** É o risco`);
    p('residual "precedência stop>TP entre loops" (`.claude/rules/trading-engine.md`).');
    p('Volume real aqui é o gatilho combinado para investir numa regra dura.');
  }
}

// ── 3 · Operações presas ────────────────────────────────────────────────────
async function checarOpsPresas() {
  const ops = await backend.entities.TradeOperation.list('-created_date', LIMITE_OPS);
  const ativas = ops.filter((o) => !STATUS_TERMINAIS.includes(o.status));
  const agora = Date.now();
  const presas = ativas.filter((o) => agora - new Date(o.created_date).getTime() > OP_PRESA_MS);

  p(`${ops.length} operações lidas (teto ${LIMITE_OPS}) · **${ativas.length} ativas**.`);
  if (presas.length === 0) { p('\n✅ Nenhuma operação aberta além do prazo plausível.'); return; }

  p('');
  p(`🚨 **${presas.length} operação(ões) aberta(s) há mais de 21 dias** — acima do Time Stop`);
  p('mais longo da tabela (64 barras de 4h ≈ 10,7 dias). Ou o Time Stop não está');
  p('rodando para elas, ou o ativo travou (assinatura do item 21, ponteiro órfão).');
  p('');
  p('| Ativo | Status | Aberta |');
  p('|---|---|---|');
  for (const o of presas.slice(0, 10)) {
    p(`| ${o.symbol} | ${o.status} | ${haQuantoTempo(o.created_date, agora)} |`);
  }
}

// ── 4 · Funil de entrada ────────────────────────────────────────────────────
async function checarFunil() {
  const sinais = await backend.entities.SignalEvent.filter({ timeframe: '4h' }, '-created_date', LIMITE_SINAIS);
  if (sinais.length === 0) { p('Nenhum aviso 4h recente.'); return; }

  const porMotivo = new Map();
  for (const s of sinais) {
    if (!s.last_rejection_reason) continue;
    const chave = s.last_rejection_detail
      ? `${s.last_rejection_reason} / ${s.last_rejection_detail}`
      : s.last_rejection_reason;
    porMotivo.set(chave, (porMotivo.get(chave) ?? 0) + 1);
  }
  const expirados = sinais.filter((s) => s.expired_logged === true).length;

  p(`${sinais.length} avisos 4h recentes (teto ${LIMITE_SINAIS}) · **${expirados} expiraram sem virar operação**.`);
  if (porMotivo.size === 0) { p('\nNenhum motivo de recusa registrado ainda.'); return; }
  p('');
  p('| # | O que barrou |');
  p('|---|---|');
  for (const [motivo, n] of [...porMotivo.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    p(`| ${n} | \`${motivo}\` |`);
  }
  p('');
  p('_Motivos com `/` trazem o detalhe do item 163. Sem detalhe = aviso anterior a ele._');
}

// ── 5 · Episódio de cota ────────────────────────────────────────────────────
async function checarCota() {
  if (!rtdb) { p('RTDB não configurado nesta execução — marcador não verificável.'); return; }
  const snap = await rtdb.ref('systemAlerts/firestoreQuota').get();
  const m = snap.exists() ? (snap.val() ?? {}) : {};
  if (!m.last_alert_at) { p('✅ Nenhum alerta de cota já registrado.'); return; }

  p(`Último alerta de cota: **${m.last_alert_at}** (${haQuantoTempo(m.last_alert_at)}).`);
  if (m.alert_active) {
    p('');
    p(`🚨 **Há um episódio ABERTO**, começado em ${m.alert_started_at ?? '?'}.`);
    p('Enquanto ele estiver aberto, nenhuma operação nova é aberta ou atualizada.');
  } else {
    p('\n✅ Nenhum episódio aberto — a última queda já foi anunciada como normalizada.');
  }
  p('');
  p('> A cota é **diária**, com reset ~07:00 UTC. Um relatório rodado logo após o');
  p('> reset dirá "tudo bem" mesmo num dia em que a cota estoure de madrugada —');
  p('> foi exatamente assim que as falhas de 04/09 e 05/09 passaram despercebidas.');
  p('> **Para o teste que discrimina, rode isto entre 03:00 e 06:00 UTC.**');
}

async function main() {
  const agora = new Date().toISOString();
  p('# 🩺 Auditoria de saúde do Sentinel');
  p('');
  p(`Gerado em **${agora}** · leitura pura, nada foi escrito.`);
  p(`Orçamento máximo desta execução: **${ORCAMENTO_TOTAL} documentos** (~${(ORCAMENTO_TOTAL / 500).toFixed(1)}% do teto diário).`);

  backend.quota.getAndResetOpCounts();

  await checar('1 · Erros registrados', checarErros);
  await checar('2 · Avisos registrados', checarAvisos);
  await checar('3 · Operações presas', checarOpsPresas);
  await checar('4 · Funil de entrada — o que mais barra', checarFunil);
  await checar('5 · Cota do Firestore', checarCota);

  const { reads, writes } = backend.quota.getAndResetOpCounts();
  p('\n---\n');
  p(`**Custo real desta auditoria:** ${reads} leitura(s), ${writes} escrita(s).`);
  if (writes > 0) {
    p('');
    p('🚨 **A auditoria escreveu alguma coisa.** Ela é read-only por contrato —');
    p('qualquer escrita aqui é um bug e precisa ser investigada.');
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('[health-audit] FALHOU:', err);
  process.exitCode = 1;
}).finally(() => {
  // Mesmo motivo do run-scan.mjs (item 152): firebase-admin/database mantém um
  // WebSocket aberto e o processo nunca terminaria sozinho.
  process.exit(process.exitCode ?? 0);
});
