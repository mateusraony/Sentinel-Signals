#!/usr/bin/env node
// CLI do aviso AUTOMÁTICO do Contexto no Telegram — docs/known-risks.md item 285, addendum 26 (Fase 4b).
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
import { isCategoryEnabled, readEvents, buildPreEventBriefing } from './contextMessages.mjs';
import { loadReactions, readHistoryFile } from './contextBtcHistory.mjs';
import { sendTelegram, describeSendFailure } from './contextTelegram.mjs';
import { SENT_FILE, pickDueEvents, parseSent, markSent, serializeSent, alertKey } from './contextAlert.mjs';

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
  const out = ['## Aviso automático do Contexto — 1 hora antes do evento', ''];

  const loaded = dir ? loadEvents(dir) : { error: 'falta --dir (pasta da branch context-data)' };
  if (loaded.error) {
    out.push(`**Não montei o aviso:** ${loaded.error}.`);
    console.log(out.join('\n'));
    return 1;
  }

  const nowMs = now();
  const { state, fresh } = loadSent(dir);
  const due = pickDueEvents(loaded.events, nowMs, state);
  if (!due.length) {
    out.push('Nenhum evento com data firme entre 45 e 75 minutos à frente (ou já avisado): nada a enviar.');
    console.log(out.join('\n'));
    return 0;
  }
  if (fresh) out.push('_Ainda não havia registro de avisos enviados (primeira vez, ou arquivo ilegível)._', '');

  // A mensagem completa (addendum 27) inclui o que o BTC fez nas últimas divulgações do mesmo tipo: busca as velas na Binance (sem chave).
  // Falha de rede vira "sem dado" naquela linha — o aviso NUNCA deixa de sair por causa do histórico.
  const history = readHistoryFile(dir);
  const compose = async (event) => buildPreEventBriefing(event, nowMs, { reactions: await loadReactions({ kind: event.kind, history, fetchImpl, env: {}, sleep }) });

  const ligada = isCategoryEnabled('pre-evento', ligadas);
  if (!enviar || !ligada) {
    for (const event of due) out.push(`Evento \`${alertKey(event)}\` — mensagem:`, '', '```', await compose(event), '```', '');
    out.push(enviar
      ? '**Categoria desligada — nada foi enviado.** Para ligar de novo, apague a variável de repositório `CONTEXT_TELEGRAM_CATEGORIES` (vazia = ligado) ou ponha `pre-evento` nela. O valor `nenhuma` desliga.'
      : '**Simulação — nada foi enviado nem registrado.** O aviso automático está ligado por padrão (desligue com o valor `nenhuma` na variável `CONTEXT_TELEGRAM_CATEGORIES`).');
    console.log(out.join('\n'));
    return 0;
  }

  let current = state;
  let falhou = false;
  for (const event of due) {
    const text = await compose(event);
    const result = await sendTelegram({ text, env, fetchImpl });
    if (!result.ok) {
      out.push(`**Não enviada** (\`${alertKey(event)}\`): ${describeSendFailure(result.reason)}. A próxima passada tenta de novo.`);
      falhou = true;
      break;
    }
    current = markSent(current, event, nowMs);
    saveSent(dir, current); // grava a cada envio: se o próximo falhar, este já fica registrado
    out.push(`**Enviada ao Telegram:** \`${alertKey(event)}\`.`);
  }
  console.log(out.join('\n'));
  return falhou ? 1 : 0;
}

// Só roda quando executado direto (node scripts/context-alert.mjs), nunca ao ser importado.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; });
}
