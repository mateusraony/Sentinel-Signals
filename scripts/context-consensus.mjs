#!/usr/bin/env node
// CLI do "Registrar projeção" — docs/known-risks.md item 285, addendum 30 (Fase 4b-4). O usuário digita a PROJEÇÃO que vê no calendário do TradingView (e, se quiser,
// o "Anterior" dos tipos sem fonte oficial automática: PCE e FOMC); o resultado vai para `<dir>/consensus.json`, que os avisos do Telegram leem.
// As regras moram em scripts/contextConsensus.mjs (formatos fechados, testáveis sem rede).
//
// Uso (no workflow context-consensus.yml, com a branch `context-data` aberta na pasta `data`):
//   node scripts/context-consensus.mjs --dir data --tipo CPI [--data AAAA-MM-DD] [--projecao "0,3 / 3,1"] [--anterior "..."]
//
// Sem `--data`, vale o PRÓXIMO evento do tipo. Entrada inválida: explica o que corrigir, não grava nada e sai com 1. Nenhum segredo, nenhum banco, nenhuma rede.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readEvents, escapeHtml } from './contextMessages.mjs';
import { formatEventWhen } from '../src/lib/marketContextBand.js';
import {
  CONSENSUS_FILE, parseConsensus, setEntry, serializeConsensus, resolveTarget, parseProjection, parsePrevious,
} from './contextConsensus.mjs';

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

const str = (v) => (typeof v === 'string' ? v.trim() : '');

export function main(argv = process.argv.slice(2), _env = process.env, { now = Date.now } = {}) {
  const args = parseArgs(argv);
  const out = ['## Registrar projeção do Contexto', ''];
  const fail = (msg) => { out.push(`**Não gravei nada:** ${msg}`); console.log(out.join('\n')); return 1; };

  const dir = str(args.dir);
  if (!dir) return fail('falta --dir (pasta da branch context-data).');
  const kind = str(args.tipo).toUpperCase();
  const projecao = str(args.projecao);
  const anterior = str(args.anterior);
  if (!projecao && !anterior) return fail('preencha a projeção e/ou o anterior.');

  let events;
  try {
    events = readEvents(JSON.parse(fs.readFileSync(path.join(dir, 'events.json'), 'utf8')));
  } catch {
    return fail('não consegui ler a agenda (events.json da branch context-data).');
  }
  const nowMs = now();
  const target = resolveTarget(events, kind, str(args.data), nowMs);
  if (!target.ok) return fail(`${target.error}.`);

  const fields = {};
  if (projecao) {
    const p = parseProjection(kind, projecao);
    if (!p.ok) return fail(`projeção — ${p.error}.`);
    fields.projection = p.text;
  }
  if (anterior) {
    const a = parsePrevious(kind, anterior);
    if (!a.ok) return fail(`anterior — ${a.error}.`);
    fields.previous = a.text;
  }

  let current = parseConsensus(null, nowMs);
  try { current = parseConsensus(JSON.parse(fs.readFileSync(path.join(dir, CONSENSUS_FILE), 'utf8')), nowMs); } catch { /* arquivo ausente ou ilegível: começa vazio */ }
  const next = setEntry(current, target.event.id, fields, nowMs);
  let texto;
  try {
    texto = serializeConsensus(next);
  } catch (err) {
    return fail(`${err.message}.`);
  }
  const file = path.join(dir, CONSENSUS_FILE);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, texto);
  fs.renameSync(tmp, file);

  out.push(`**Registrado** para \`${target.event.id}\` (${escapeHtml(formatEventWhen(target.event.startsAtUtc))}):`, '');
  if (fields.projection) out.push(`- Projeção: **${fields.projection}**`);
  if (fields.previous) out.push(`- Anterior: **${fields.previous}**`);
  out.push('', 'Os avisos do Telegram (1 h antes e o resultado) passam a usar estes números e a dizer que a projeção foi informada por você.');
  console.log(out.join('\n'));
  return 0;
}

// Só roda quando executado direto (node scripts/context-consensus.mjs), nunca ao ser importado.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
