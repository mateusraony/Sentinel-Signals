#!/usr/bin/env node
// CLI do aviso do Contexto no Telegram — docs/known-risks.md item 285, addendum 12 (Fase 4a).
// A lógica mora em scripts/contextMessages.mjs (mensagens) e scripts/contextTelegram.mjs (envio), testáveis sem rede.
//
// Uso (no workflow context-notify.yml, com a branch `context-data` aberta na pasta `data`):
//   node scripts/context-notify.mjs --categoria agenda --dir data --categorias-ligadas "$CATEGORIAS_LIGADAS" [--enviar]
//
// Sem `--enviar` é SIMULAÇÃO: mostra a mensagem no relatório e não manda nada (o workflow nem entrega os segredos nesse
// caso). Com `--enviar`, a categoria (menos `teste`) precisa estar ligada na variável do repositório
// CONTEXT_TELEGRAM_CATEGORIES; senão nada é enviado e o relatório explica como ligar. Nenhum banco, nenhum motor.
// Imprime Markdown no stdout (vai para o Job Summary). NUNCA imprime segredo, URL de envio ou variável de ambiente.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CATEGORIES, isCategoryEnabled, readEvents, buildTestMessage, buildAgendaMessage, nextAlertableEvent, buildPreEventMessage,
} from './contextMessages.mjs';
import { sendTelegram, describeSendFailure } from './contextTelegram.mjs';

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

export async function main(argv = process.argv.slice(2), env = process.env, { fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const args = parseArgs(argv);
  const categoria = typeof args.categoria === 'string' ? args.categoria : '';
  const enviar = args.enviar === true;
  const ligadas = typeof args['categorias-ligadas'] === 'string' ? args['categorias-ligadas'] : String(env.CATEGORIAS_LIGADAS ?? '');
  const out = [];

  if (!CATEGORIES.includes(categoria)) {
    console.error(`[context-notify] categoria inválida; use uma de: ${CATEGORIES.join(', ')}`);
    return 1;
  }
  out.push(`## Aviso do Contexto no Telegram — categoria \`${categoria}\``, '');

  const nowMs = now();
  let text = null;
  if (categoria === 'teste') {
    text = buildTestMessage(nowMs);
  } else {
    const dir = typeof args.dir === 'string' ? args.dir : '';
    const loaded = dir ? loadEvents(dir) : { error: 'falta --dir (pasta da branch context-data)' };
    if (loaded.error) {
      out.push(`**Não montei a mensagem:** ${loaded.error}.`);
      console.log(out.join('\n'));
      return 1;
    }
    if (categoria === 'agenda') {
      text = buildAgendaMessage(loaded.events, nowMs);
    } else {
      const next = nextAlertableEvent(loaded.events, nowMs);
      if (!next) {
        out.push('Nenhum evento oficial ou confirmado à frente: não há o que avisar.');
        console.log(out.join('\n'));
        return 0;
      }
      text = buildPreEventMessage(next, nowMs);
    }
  }

  out.push('Mensagem:', '', '```', text, '```', '');
  const ligada = isCategoryEnabled(categoria, ligadas);
  if (!enviar) {
    out.push('**Simulação — nada foi enviado.** Para enviar de verdade, rode de novo marcando "Enviar de verdade?".');
    console.log(out.join('\n'));
    return 0;
  }
  if (!ligada) {
    out.push(`**Categoria desligada — nada foi enviado.** Para ligar, crie a variável de repositório \`CONTEXT_TELEGRAM_CATEGORIES\` com o valor \`${categoria}\` (várias: separe por vírgula).`);
    console.log(out.join('\n'));
    return 0;
  }
  const result = await sendTelegram({ text, env, fetchImpl });
  if (result.ok) {
    out.push('**Enviada ao Telegram.**');
    console.log(out.join('\n'));
    return 0;
  }
  out.push(`**Não enviada:** ${describeSendFailure(result.reason)}.`);
  console.log(out.join('\n'));
  return 1;
}

// Só roda quando executado direto (node scripts/context-notify.mjs), nunca ao ser importado.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; });
}
