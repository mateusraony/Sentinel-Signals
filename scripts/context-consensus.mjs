#!/usr/bin/env node
// CLI do "Registrar projeção" — docs/known-risks.md item 285, addendum 30 (Fase 4b-4). O usuário digita a PROJEÇÃO que vê no calendário do TradingView (e, se quiser,
// o "Anterior" dos tipos sem fonte oficial automática: PCE e FOMC); o resultado vai para `<dir>/consensus.json`, que os avisos do Telegram leem.
// As regras moram em scripts/contextConsensus.mjs (formatos fechados, testáveis sem rede).
//
// Uso (no workflow context-consensus.yml, com a branch `context-data` aberta na pasta `data`):
//   node scripts/context-consensus.mjs --dir data --tipo CPI [--data AAAA-MM-DD] [--mes 0,3] [--ano 3,1] [--vagas 150] [--juros 3,75] [--anterior 0,3]
//
// Um campo para cada coisa (addendum 31): só os campos do tipo escolhido são usados; os outros são IGNORADOS com aviso. Sem `--data`, vale o PRÓXIMO evento do
// tipo. Entrada inválida: diz QUAL campo (pelo número da tela) e dá um exemplo, não grava nada e sai com 1. Nenhum segredo, nenhum banco, nenhuma rede.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readEvents, escapeHtml } from './contextMessages.mjs';
import { formatEventWhen } from '../src/lib/marketContextBand.js';
import {
  CONSENSUS_FILE, parseConsensus, setEntry, serializeConsensus, resolveTarget, buildFields, describeFomc,
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
  const fail = (msg, notes = []) => {
    out.push(`**Não gravei nada:** ${msg}`);
    if (notes.length) out.push('', ...notes.map((n) => `- ${n}`));
    out.push('', 'Como preencher: escolha o **Tipo** (campo 1), deixe a **Data** (campo 2) em branco e preencha SÓ o campo do seu tipo — CPI/PPI/PCE: campo 3 (e o 4, se quiser) · Payroll: campo 5 · FOMC: campo 6. O campo 7 (anterior) é opcional, para PCE ou FOMC.');
    console.log(out.join('\n'));
    return 1;
  };

  const dir = str(args.dir);
  if (!dir) return fail('falta --dir (pasta da branch context-data).');
  const kind = str(args.tipo).toUpperCase();

  let events;
  try {
    events = readEvents(JSON.parse(fs.readFileSync(path.join(dir, 'events.json'), 'utf8')));
  } catch {
    return fail('não consegui ler a agenda (events.json da branch context-data).');
  }
  const nowMs = now();
  const built = buildFields(kind, { mes: str(args.mes), ano: str(args.ano), vagas: str(args.vagas), juros: str(args.juros), anterior: str(args.anterior) });
  if (!built.ok) return fail(`${built.error}.`, built.notes);
  const target = resolveTarget(events, kind, str(args.data), nowMs);
  if (!target.ok) return fail(`${target.error}.`, built.notes);

  let current = parseConsensus(null, nowMs);
  try { current = parseConsensus(JSON.parse(fs.readFileSync(path.join(dir, CONSENSUS_FILE), 'utf8')), nowMs); } catch { /* arquivo ausente ou ilegível: começa vazio */ }
  const next = setEntry(current, target.event.id, built.fields, nowMs);
  let texto;
  try {
    texto = serializeConsensus(next);
  } catch (err) {
    return fail(`${err.message}.`, built.notes);
  }
  const file = path.join(dir, CONSENSUS_FILE);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, texto);
  fs.renameSync(tmp, file);

  const saved = next.items[target.event.id];
  out.push(`**Registrado** para \`${target.event.id}\` (${escapeHtml(formatEventWhen(target.event.startsAtUtc))}):`, '');
  if (saved.projection) out.push(`- Projeção: **${saved.projection}**`);
  if (saved.previous) out.push(`- Anterior: **${saved.previous}**`);
  const fomc = kind === 'FOMC' ? describeFomc(saved.projection, saved.previous) : null;
  if (fomc) out.push(`- Isso significa: ${fomc}`);
  if (built.notes.length) out.push('', ...built.notes.map((n) => `- ${n}`));
  out.push('', 'Os avisos do Telegram (1 h antes e o resultado) passam a usar estes números e a dizer que a projeção foi informada por você. Rodar de novo atualiza.');
  console.log(out.join('\n'));
  return 0;
}

// Só roda quando executado direto (node scripts/context-consensus.mjs), nunca ao ser importado.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
