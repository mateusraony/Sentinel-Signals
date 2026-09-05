/**
 * Auditoria de saúde — o que está falhando e ninguém viu (itens 164/165).
 *
 * Diagnóstico **read-only**. Roda 1×/dia de madrugada e sob disparo manual
 * (.github/workflows/health-audit.yml). Não faz parte do relógio de trading,
 * não escreve NADA no Firestore, não abre nem fecha operação.
 *
 * ## Por que isto existe
 *
 * O projeto tem um histórico específico de falha: **erro que não grita**.
 *
 * - Item 136 (P0-h): `undefined` num campo derrubou TODA criação de operação
 *   por ~2 semanas. O erro ia para o `SystemLog` e nunca derrubava o scan —
 *   o job ficava verde, o Telegram mudo, e o usuário só percebeu ao estranhar
 *   uma operação real que sumiu do painel.
 * - Item 162: duas execuções do backfill falharam de madrugada com cota REAL
 *   esgotada, em dois dias seguidos, e ninguém olhou — porque as conferências
 *   eram de manhã, quando a cota já tinha zerado.
 *
 * Os dois têm a mesma forma: **o dado do problema já existia, faltava alguém
 * lendo.** Este script é esse alguém — e por isso ele mesmo não pode depender
 * de alguém abrir um relatório: quando acha algo, avisa no Telegram.
 *
 * ## Duas regras de desenho
 *
 * **1. Nunca custar mais do que anuncia.** O Firestore no plano gratuito cobra
 * por documento lido, com teto DIÁRIO (itens 150/151/155). Uma auditoria que
 * varresse coleções para diagnosticar falta de cota seria o remédio virando a
 * doença. Toda leitura tem teto explícito, os tetos somam um valor conhecido
 * (ORÇAMENTO_TOTAL), e o relatório termina imprimindo o custo REAL medido pelo
 * contador do próprio adaptador.
 *
 * **2. Nenhuma consulta pode exigir índice composto.** Item 165: a primeira
 * execução em produção falhou em 3 de 5 checagens com `FAILED_PRECONDITION:
 * The query requires an index`, porque `filter({campo}, '-created_date')`
 * combina filtro com ordenação em campo diferente. A correção NÃO foi criar os
 * índices: foi ler ordenando só por `created_date` (servido pelo índice
 * automático de campo único) e filtrar em memória. Isso evita índice novo em
 * `systemLogs`, que é a coleção mais escrita do projeto — e evita depender de
 * um deploy manual de índices para o diagnóstico funcionar.
 *
 * **Ao mexer aqui: nunca passe `filters` e `sort` juntos.** É a armadilha que
 * este arquivo já pisou uma vez.
 */
import { backend, rtdb } from './adminEntities.js';
import { agrupar, celula, haQuantoTempo } from './healthAuditFormat.mjs';
import { classifyFailure } from './failureClassification.mjs';
import { isTelegramConfigured, notifyHealthAudit } from './adminTelegram.js';

// ── Orçamento de leitura ────────────────────────────────────────────────────
// Somados: no MÁXIMO 570 documentos por execução (~1% do teto diário de 50k).
// A auditoria mede TENDÊNCIA, não faz inventário.
const LIMITE_LOGS = 300;
const LIMITE_OPS = 120;
const LIMITE_SINAIS = 150;
const ORCAMENTO_TOTAL = LIMITE_LOGS + LIMITE_OPS + LIMITE_SINAIS;

// Uma operação aberta há mais tempo que isto é suspeita em qualquer tier: o
// Time Stop mais longo da tabela é 64 barras de 4h (~10,7 dias). O dobro disso
// não é "operação demorada", é operação PRESA — a assinatura do item 21
// (ponteiro órfão travando o ativo) e do item 136.
const OP_PRESA_MS = 21 * 24 * 60 * 60 * 1000;

const STATUS_TERMINAIS = ['STOP_HIT', 'TP2_HIT', 'INVALIDATED', 'CLOSED'];

const p = (linha = '') => console.log(linha);

/**
 * O que merece acordar alguém. Vazio = a auditoria rodou e não achou nada,
 * e nesse caso ela fica CALADA — um aviso diário de "está tudo bem" treina
 * exatamente o hábito de ignorar o aviso.
 */
const achados = [];

/**
 * Cada checagem é isolada: uma que falhe não pode levar o relatório junto.
 *
 * A mensagem de falha diz **o que foi observado**, nunca o que se supõe. A
 * primeira versão deste arquivo dizia "se a leitura falhou com Quota exceeded,
 * a resposta da auditoria é justamente essa" — e a falha real não tinha nada a
 * ver com cota. Chutar a causa na mensagem é literalmente o bug do item 162,
 * reaparecendo no código escrito para caçá-lo.
 */
async function checar(titulo, fn) {
  p(`\n## ${titulo}\n`);
  try {
    return await fn();
  } catch (e) {
    const { kind } = classifyFailure(e.message);
    const explicacao = {
      quota: '**Cota do Firestore esgotada.** Este é um achado real, não um defeito do relatório.',
      missing_index: '**Falta um índice composto no Firestore** — problema de consulta, não de dado. '
        + 'Nenhuma consulta desta auditoria deveria precisar de índice (ver o cabeçalho do arquivo): '
        + 'se apareceu, alguém combinou filtro com ordenação em campo diferente.',
      timeout: '**A leitura travou** e foi interrompida.',
      other: 'Causa não classificada — a mensagem acima é o que foi observado, sem suposição.',
    }[kind];

    p(`⚠️ **A checagem falhou:** \`${e.message}\``);
    p('');
    p(explicacao);
    achados.push(`"${titulo}" não pôde ser lida (${kind})`);
    return null;
  }
}

// ── 1 · Logs ────────────────────────────────────────────────────────────────
// UMA leitura para erros e avisos: ordena só por created_date (índice
// automático) e separa por nível em memória. Além de dispensar índice, custa
// menos que as duas consultas filtradas da versão anterior.
async function checarLogs() {
  const logs = await backend.entities.SystemLog.list('-created_date', LIMITE_LOGS);
  if (logs.length === 0) { p('Nenhum registro de log.'); return; }

  const erros = logs.filter((l) => l.level === 'error');
  const avisos = logs.filter((l) => l.level === 'warn');
  const janela = `${logs[logs.length - 1]?.created_date} → ${logs[0]?.created_date}`;

  p(`Últimos **${logs.length} registros** (teto ${LIMITE_LOGS}) · **${erros.length} erros**, **${avisos.length} avisos**.`);
  p('');
  p(`_Janela coberta: ${janela}. A auditoria lê os mais recentes, não o histórico inteiro —`);
  p(`um problema antigo que parou de acontecer sai desta janela de propósito._`);

  if (erros.length) {
    const grupos = agrupar(erros);
    p('');
    p(`### Erros → ${grupos.length} problemas distintos`);
    p('');
    p('| # | Módulo · problema | Ativos | Mais recente |');
    p('|---|---|---|---|');
    for (const g of grupos.slice(0, 15)) {
      p(`| ${g.total} | ${celula(g.chave)} | ${g.ativos.size || '—'} | ${haQuantoTempo(g.ultimo)} |`);
    }

    // Um erro em MUITOS ativos ao mesmo tempo não é azar de um ativo — é falha
    // sistêmica. Foi essa a forma exata do item 136.
    const sistemicos = grupos.filter((g) => g.ativos.size >= 3);
    if (sistemicos.length) {
      p('');
      p('🚨 **Suspeita de falha sistêmica** (mesmo erro em 3+ ativos — a assinatura do item 136,');
      p('que parou toda criação de operação por ~2 semanas sem derrubar nenhum job):');
      for (const g of sistemicos.slice(0, 5)) {
        p(`- \`${g.chave}\` — ${g.ativos.size} ativos, ${g.total}×, último ${haQuantoTempo(g.ultimo)}`);
        p(`  - exemplo: \`${String(g.exemplo).slice(0, 200)}\``);
      }
      achados.push(`erro em ${sistemicos[0].ativos.size} ativos ao mesmo tempo: ${sistemicos[0].chave}`);
    }
  }

  if (avisos.length) {
    const grupos = agrupar(avisos);
    p('');
    p(`### Avisos → ${grupos.length} distintos`);
    p('');
    p('| # | Módulo · aviso | Mais recente |');
    p('|---|---|---|');
    for (const g of grupos.slice(0, 8)) {
      p(`| ${g.total} | ${celula(g.chave)} | ${haQuantoTempo(g.ultimo)} |`);
    }
    // O CAS descartando transição é o canal de observação do risco residual
    // documentado em .claude/rules/trading-engine.md.
    const cas = grupos.filter((g) => /Transição descartada pelo CAS/i.test(g.chave));
    if (cas.length) {
      const total = cas.reduce((s, g) => s + g.total, 0);
      p('');
      p(`⚠️ **${total} transições descartadas pelo CAS** nesta janela. É o risco residual`);
      p('"precedência stop>TP entre loops" (`.claude/rules/trading-engine.md`) — volume real');
      p('aqui é o gatilho combinado para investir numa regra dura de precedência.');
      achados.push(`${total} transições descartadas pelo CAS (concorrência entre os dois loops)`);
    }
  }
}

// ── 2 · Operações presas ────────────────────────────────────────────────────
async function checarOpsPresas() {
  const ops = await backend.entities.TradeOperation.list('-created_date', LIMITE_OPS);
  const ativas = ops.filter((o) => !STATUS_TERMINAIS.includes(o.status));
  const agora = Date.now();
  const presas = ativas.filter((o) => agora - new Date(o.created_date).getTime() > OP_PRESA_MS);

  p(`${ops.length} operações lidas (teto ${LIMITE_OPS}) · **${ativas.length} ativas**.`);
  if (presas.length === 0) { p('\n✅ Nenhuma operação aberta além do prazo plausível.'); return; }

  p('');
  p(`🚨 **${presas.length} operação(ões) aberta(s) há mais de 21 dias** — acima do Time Stop`);
  p('mais longo da tabela (64 barras de 4h ≈ 10,7 dias). Ou o Time Stop não está rodando');
  p('para elas, ou o ativo travou (assinatura do item 21, ponteiro órfão).');
  p('');
  p('| Ativo | Status | Aberta |');
  p('|---|---|---|');
  for (const o of presas.slice(0, 10)) {
    p(`| ${o.symbol} | ${o.status} | ${haQuantoTempo(o.created_date, agora)} |`);
  }
  achados.push(`${presas.length} operação(ões) aberta(s) há mais de 21 dias`);
}

// ── 3 · Funil de entrada ────────────────────────────────────────────────────
// Também sem filtro na consulta (item 165): lê os mais recentes de qualquer
// timeframe e separa o 4h em memória.
async function checarFunil() {
  const todos = await backend.entities.SignalEvent.list('-created_date', LIMITE_SINAIS);
  const sinais = todos.filter((s) => s.timeframe === '4h');
  if (sinais.length === 0) {
    p(`Nenhum aviso 4h entre os ${todos.length} avisos mais recentes.`);
    return;
  }

  const porMotivo = new Map();
  for (const s of sinais) {
    if (!s.last_rejection_reason) continue;
    const chave = s.last_rejection_detail
      ? `${s.last_rejection_reason} / ${s.last_rejection_detail}`
      : s.last_rejection_reason;
    porMotivo.set(chave, (porMotivo.get(chave) ?? 0) + 1);
  }
  const expirados = sinais.filter((s) => s.expired_logged === true).length;

  p(`${sinais.length} avisos 4h (de ${todos.length} lidos, teto ${LIMITE_SINAIS}) · **${expirados} expiraram sem virar operação**.`);
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

// ── 4 · Episódio de cota ────────────────────────────────────────────────────
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
    achados.push(`episódio de cota ABERTO desde ${m.alert_started_at ?? '?'}`);
  } else {
    p('\n✅ Nenhum episódio aberto — a última queda já foi anunciada como normalizada.');
  }

  // O alerta de cota tem cooldown de 1h e o episódio fecha sozinho na primeira
  // passada limpa (item 160). Então "nenhum episódio aberto" às 04:40 UTC NÃO
  // prova que a madrugada foi limpa: pode ter havido queda e recuperação entre
  // as duas execuções. Um alerta recente é o sinal que importa aqui.
  const horasDesde = (Date.now() - new Date(m.last_alert_at).getTime()) / 3_600_000;
  if (Number.isFinite(horasDesde) && horasDesde < 24 && !m.alert_active) {
    p('');
    p(`⚠️ Houve alerta de cota nas últimas 24h (${haQuantoTempo(m.last_alert_at)}), já normalizado.`);
    p('Episódio fechado não é o mesmo que dia limpo — a cota chegou a estourar.');
    achados.push(`a cota estourou nas últimas 24h (${haQuantoTempo(m.last_alert_at)}), já normalizada`);
  }
}

async function main() {
  const runUrl = process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : null;

  p('# 🩺 Auditoria de saúde do Sentinel');
  p('');
  p(`Gerado em **${new Date().toISOString()}** · leitura pura, nada foi escrito.`);
  p(`Orçamento máximo: **${ORCAMENTO_TOTAL} documentos** (~${(ORCAMENTO_TOTAL / 500).toFixed(1)}% do teto diário).`);

  backend.quota.getAndResetOpCounts();

  await checar('1 · Erros e avisos registrados', checarLogs);
  await checar('2 · Operações presas', checarOpsPresas);
  await checar('3 · Funil de entrada — o que mais barra', checarFunil);
  await checar('4 · Cota do Firestore', checarCota);

  const { reads, writes } = backend.quota.getAndResetOpCounts();
  p('\n---\n');
  p(`**Custo real desta auditoria:** ${reads} leitura(s), ${writes} escrita(s).`);
  if (writes > 0) {
    p('');
    p('🚨 **A auditoria escreveu alguma coisa.** Ela é read-only por contrato —');
    p('qualquer escrita aqui é um bug e precisa ser investigada.');
    process.exitCode = 1;
  }

  p('');
  if (achados.length === 0) {
    p('## ✅ Nada a reportar');
    p('');
    p('Nenhum achado que mereça aviso. Nenhuma mensagem foi enviada — um aviso');
    p('diário de "está tudo bem" treina exatamente o hábito de ignorar o aviso.');
    return;
  }

  p(`## 🔔 ${achados.length} achado(s) — avisando`);
  p('');
  for (const a of achados) p(`- ${a}`);
  if (isTelegramConfigured()) {
    await notifyHealthAudit('Auditoria de saúde achou algo', achados, runUrl);
  } else {
    p('');
    p('_Telegram não configurado nesta execução — nada foi enviado._');
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
