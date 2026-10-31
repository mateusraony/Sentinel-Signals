#!/usr/bin/env node
// CLI do coletor de datas do Contexto de Mercado — docs/known-risks.md item 285, addendum 9.
// A lógica mora em scripts/contextCollect.mjs (testável sem rede); aqui só lê, busca e grava.
//
// Uso (no workflow context-collect.yml, com a branch `context-data` aberta na pasta `data`):
//   node scripts/context-collect.mjs --dir data
//
// Lê `<dir>/events.json` (a coleta anterior, se existir), busca as datas no FRED, monta os
// eventos e grava `<dir>/events.json` e `<dir>/status.json`. Se a trava do conteúdo público
// recusar, NÃO grava nada e sai com 1. Imprime um resumo em markdown (sem chave, sem URL).
// Variáveis de ambiente lidas: FRED_API_KEY (vai só na URL da requisição) e
// CONTEXT_CONTACT_EMAIL (só no cabeçalho User-Agent). Nenhum banco, nenhum Telegram.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildEvents, buildStatus, assertPublicShape, fetchFredDates, FRED_RELEASES } from './contextCollect.mjs';

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

/** O events.json anterior; arquivo ausente ou inválido = começa do zero (sem quebrar a coleta). */
export function readPrevious(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function formatCollectMarkdown(status, events, fredDatesByKind) {
  const lines = ['## Coletor de contexto — datas dos eventos', ''];
  lines.push(`Checado em ${status.checkedAt} (UTC). FRED: **${status.fred}**${status.fred === 'ok' ? '' : ' — os tipos sem resposta usam a lista fixa'}.`);
  const porTipo = Object.keys(FRED_RELEASES).map((k) => `${k} ${Array.isArray(fredDatesByKind[k]) ? 'ok' : 'sem resposta'}`).join(' · ');
  lines.push(`Por tipo: ${porTipo}.`);
  lines.push(`Eventos publicados: ${status.eventsCount}. Cobertura confirmada até: ${status.coverageUntil ?? '—'}.`);
  lines.push('');
  lines.push('| Evento | Hora (UTC) | Situação |');
  lines.push('|---|---|---|');
  for (const e of events) lines.push(`| ${e.id} | ${e.startsAtUtc.slice(0, 16).replace('T', ' ')} | ${e.status} |`);
  return lines.join('\n');
}

export async function main(argv = process.argv.slice(2), env = process.env, { fetchImpl = fetch, now = Date.now } = {}) {
  const args = parseArgs(argv);
  if (typeof args.dir !== 'string') {
    console.error('[context-collect] use --dir <pasta da branch context-data>');
    return 1;
  }
  const eventsFile = path.join(args.dir, 'events.json');
  const statusFile = path.join(args.dir, 'status.json');
  const previous = readPrevious(eventsFile);
  const fredDatesByKind = await fetchFredDates({ fetchImpl, env });
  const nowMs = now();
  const events = buildEvents({ fredDatesByKind, previous, nowMs });
  const status = buildStatus({ events, fredDatesByKind, nowMs });
  try {
    assertPublicShape(events, status);
  } catch (err) {
    console.error(`[context-collect] ${err.message} — nada foi gravado.`);
    return 1;
  }
  fs.mkdirSync(args.dir, { recursive: true });
  fs.writeFileSync(eventsFile, `${JSON.stringify(events, null, 2)}\n`);
  fs.writeFileSync(statusFile, `${JSON.stringify(status, null, 2)}\n`);
  console.log(formatCollectMarkdown(status, events, fredDatesByKind));
  return 0;
}

// Só roda quando executado direto (node scripts/context-collect.mjs), nunca ao ser importado.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; });
}
