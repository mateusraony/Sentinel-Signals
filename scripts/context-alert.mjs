#!/usr/bin/env node
// CLI do aviso AUTOMÁTICO do Contexto no Telegram — docs/known-risks.md item 285, addendum 26 (Fase 4b); resumo do dia às 21h de Brasília no addendum 35 (Fase 4c).
// As regras moram em scripts/contextAlert.mjs (janela + registro do "já avisei"), a mensagem em scripts/contextMessages.mjs e o
// envio em scripts/contextTelegram.mjs — todos testáveis sem rede.
//
// Uso (no workflow context-alert.yml, com a branch `context-data` aberta na pasta `data`):
//   node scripts/context-alert.mjs --dir data --categorias-ligadas "$CATEGORIAS_LIGADAS" [--enviar]
//
// Sem `--enviar` é SIMULAÇÃO: mostra o que seria enviado agora e não manda nada nem grava o registro (o workflow nem entrega os
// segredos nesse caso). Com `--enviar`, a categoria `pre-evento` precisa estar ligada: LIGADA POR PADRÃO (variável do repositório
// CONTEXT_TELEGRAM_CATEGORIES vazia ou ausente); o valor `nenhuma` desliga tudo; uma lista liga só o que está nela. Desligada = nada é enviado
// (e o workflow nem começa: o `if:` do job confere a mesma variável).
// Registro do "já avisei": `<dir>/alerts-sent.json` — gravado SÓ depois de o Telegram aceitar a mensagem (falha de envio não marca,
// e a próxima passada tenta de novo). Nenhum banco, nenhum motor. Imprime Markdown no stdout (Job Summary); NUNCA imprime segredo.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isCategoryEnabled, readEvents, buildPreEventBriefing, buildResultMessage, buildDaySummary } from './contextMessages.mjs';
import { loadReactions, loadMovesSince, loadBtcDay, summarizeReactions, readHistoryFile } from './contextBtcHistory.mjs';
import { CONSENSUS_FILE, parseConsensus, consensusFor } from './contextConsensus.mjs';
import { sendTelegram, describeSendFailure } from './contextTelegram.mjs';
import { SENT_FILE, pickDueEvents, pickDueResults, pickDueSummary, dayBoundsBrt, parseSent, markSent, serializeSent, alertKey } from './contextAlert.mjs';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { args[key] = next; i += 1; } else { args[key] = true; }
  }
  return args;
}

function loadEvents(dir) {
  try {
    return { events: readEvents(JSON.parse(fs.readFileSync(path.join(dir, 'events.json'), 'utf8'))) };
  } catch {
    return { error: 'não consegui ler a agenda (events.json da branch context-data)' };
  }
}

/** O registro do disco; ausente ou ilegível = vazio (pior caso: um aviso repetido, nunca um evento perdido). */
function loadSent(dir) {
  try {
    return { state: parseSent(JSON.parse(fs.readFileSync(path.join(dir, SENT_FILE), 'utf8'))), fresh: false };
  } catch {
    return { state: parseSent(null), fresh: true };
  }
}

/** Grava por arquivo temporário + rename: nunca deixa um arquivo pela metade (o próximo passo faz `git add` nele). */
function saveSent(dir, state) {
  const file = path.join(dir, SENT_FILE);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, serializeSent(state));
  fs.renameSync(tmp, file);
}

export async function main(argv = process.argv.slice(2), env = process.env, { fetchImpl = globalThis.fetch, now = Date.now, sleep } = {}) {
  const args = parseArgs(argv);
  const enviar = args.enviar === true;
  const ligadas = typeof args['categorias-ligadas'] === 'string' ? args['categorias-ligadas'] : String(env.CATEGORIAS_LIGADAS ?? '');
  const dir = typeof args.dir === 'string' ? args.dir : '';
  const out = ['## Aviso automático do Contexto — antes, depois do evento e resumo do dia', ''];

  const loaded = dir ? loadEvents(dir) : { error: 'falta --dir (pasta da branch context-data)' };
  if (loaded.error) {
    out.push(`**Não montei o aviso:** ${loaded.error}.`);
    console.log(out.join('\n'));
    return 1;
  }

  const nowMs = now();
  const { state, fresh } = loadSent(dir);
  // Duas fases: `pre` (1 h antes) e `post` (o resultado depois da divulgação, addendum 28). Cada uma é uma categoria que se liga/desliga à parte.
  const items = [
    ...pickDueEvents(loaded.events, nowMs, state).map((event) => ({ event, phase: 'pre' })),
    ...pickDueResults(loaded.events, nowMs, state).map((event) => ({ event, phase: 'post' })),
  ];
  // A 3ª fase (addendum 35): o resumo do dia, depois das 21h de Brasília, nos dias em que houve divulgação. O "evento" do registro é `DIA-AAAA-MM-DD`.
  const summary = pickDueSummary(loaded.events, nowMs, state);
  if (summary) items.push({ event: { id: summary.id }, phase: 'dia', summary });
  if (!items.length) {
    out.push('Nada a enviar agora: nenhum evento de data firme entre 45 e 75 minutos à frente, nenhum resultado pendente de aviso e nenhum resumo do dia para esta hora (ou já avisados).');
    console.log(out.join('\n'));
    return 0;
  }
  if (fresh) out.push('_Ainda não havia registro de avisos enviados (primeira vez, ou arquivo ilegível)._', '');

  // As mensagens completas (addenda 27 e 28) usam o que o BTC fez nas divulgações do mesmo tipo e desde a divulgação: velas da Binance (sem chave).
  // Falha de rede vira "sem dado" naquela linha — o aviso NUNCA deixa de sair por causa do preço.
  const history = readHistoryFile(dir);
  // A projeção que o usuário registrou no botão "Registrar projeção do Contexto" (addendum 30); ausente/ilegível = nenhuma.
  let consensusState = null;
  try { consensusState = JSON.parse(fs.readFileSync(path.join(dir, CONSENSUS_FILE), 'utf8')); } catch { consensusState = null; }
  const consensusOf = (event) => consensusFor(parseConsensus(consensusState, nowMs), event, nowMs);
  const categoryOf = ({ phase }) => (phase === 'pre' ? 'pre-evento' : phase === 'dia' ? 'resumo' : 'resultado');
  const compose = async ({ event, phase, summary: due }) => {
    if (phase === 'dia') {
      // Resumo do dia: o que o BTC fez depois de cada divulgação e no dia (velas da Binance, sem chave); falha vira "indisponível" naquela linha.
      const moves = new Map();
      for (const e of due.events) moves.set(e.id, await loadMovesSince({ t0Ms: e.startMs, nowMs, fetchImpl, env: {}, sleep }));
      const btcDay = await loadBtcDay({ dayStartMs: dayBoundsBrt(due.day).startMs, nowMs, fetchImpl, env: {}, sleep });
      return buildDaySummary({ day: due.day, events: due.events, agenda: loaded.events, nowMs, moves, btcDay, consensusOf });
    }
    const rows = await loadReactions({ kind: event.kind, history, fetchImpl, env: {}, sleep });
    const consensus = consensusOf(event);
    if (phase === 'pre') return buildPreEventBriefing(event, nowMs, { reactions: rows, consensus });
    const moves = await loadMovesSince({ t0Ms: event.startMs, nowMs, fetchImpl, env: {}, sleep });
    return buildResultMessage(event, nowMs, { moves, typical: rows.length ? summarizeReactions(rows) : null, consensus });
  };

  if (!enviar) {
    for (const item of items) out.push(`\`${alertKey(item.event, item.phase)}\` — mensagem:`, '', '```', await compose(item), '```', '');
    out.push('**Simulação — nada foi enviado nem registrado.** Os avisos automáticos estão ligados por padrão (desligue com o valor `nenhuma` na variável `CONTEXT_TELEGRAM_CATEGORIES`).');
    console.log(out.join('\n'));
    return 0;
  }

  let current = state;
  let falhou = false;
  let desligadas = 0;
  for (const item of items) {
    const chave = alertKey(item.event, item.phase);
    if (!isCategoryEnabled(categoryOf(item), ligadas)) {
      out.push(`Categoria \`${categoryOf(item)}\` desligada: \`${chave}\` não foi enviado.`);
      desligadas += 1;
      continue;
    }
    const result = await sendTelegram({ text: await compose(item), env, fetchImpl });
    if (!result.ok) {
      out.push(`**Não enviada** (\`${chave}\`): ${describeSendFailure(result.reason)}. A próxima passada tenta de novo.`);
      falhou = true;
      break;
    }
    current = markSent(current, item.event, nowMs, item.phase);
    saveSent(dir, current); // grava a cada envio: se o próximo falhar, este já fica registrado
    out.push(`**Enviada ao Telegram:** \`${chave}\`.`);
  }
  if (desligadas) out.push('', 'Para ligar de novo, apague a variável de repositório `CONTEXT_TELEGRAM_CATEGORIES` (vazia = ligado) ou ponha o nome da categoria nela. O valor `nenhuma` desliga tudo.');
  console.log(out.join('\n'));
  return falhou ? 1 : 0;
}

// Só roda quando executado direto (node scripts/context-alert.mjs), nunca ao ser importado.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; });
}
