#!/usr/bin/env node
// CLI da sonda das fontes do Contexto de Mercado — docs/known-risks.md item 285.
// A lógica mora em scripts/contextProbe.mjs (testável sem rede); aqui só
// sequencia as requisições e imprime.
//
// Uso:
//   node scripts/context-probe.mjs [--only bls-calendar,alternative-me-fng] [--json saida.json] [--pause-ms 1000]
//
// Imprime a tabela em markdown (no GitHub Actions: `| tee -a "$GITHUB_STEP_SUMMARY"`).
// Código de saída 1 quando o portão da fase reprova (alguma fonte obrigatória
// falhou) — o job fica vermelho, de propósito. Só leitura de dados públicos:
// 1 requisição por fonte, pausa entre elas, nenhum banco, nenhum Telegram,
// nenhuma ordem. A única variável de ambiente lida é COINGECKO_API_KEY
// (opcional; sem ela o /global é pulado).
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { SOURCES, probeSource, summarize, formatProbeMarkdown } from './contextProbe.mjs';

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  const only = typeof args.only === 'string' ? new Set(args.only.split(',').map((s) => s.trim()).filter(Boolean)) : null;
  const pauseMs = Number.isFinite(Number(args['pause-ms'])) ? Number(args['pause-ms']) : 1000;

  let sources = SOURCES;
  if (only) {
    const unknown = [...only].filter((id) => !SOURCES.some((s) => s.id === id));
    if (unknown.length) {
      console.error(`[context-probe] fonte(s) desconhecida(s): ${unknown.join(', ')}`);
      return 1;
    }
    sources = SOURCES.filter((s) => only.has(s.id));
  }

  const startedAt = new Date().toISOString();
  const results = [];
  for (let i = 0; i < sources.length; i += 1) {
    results.push(await probeSource(sources[i], { env }));
    if (i < sources.length - 1 && pauseMs > 0) await sleep(pauseMs);
  }

  // Só a execução no GitHub Actions vale como teste do lugar onde o coletor vai rodar.
  const runner = env.GITHUB_ACTIONS === 'true'
    ? 'servidor do GitHub Actions (o mesmo lugar onde o coletor vai rodar)'
    : 'ambiente local — NÃO vale como teste do GitHub';
  console.log(formatProbeMarkdown(results, { startedAt, runner }));
  if (typeof args.json === 'string') {
    fs.writeFileSync(args.json, JSON.stringify({ startedAt, results, summary: summarize(results) }, null, 2));
  }

  const { gateOk } = summarize(results);
  if (!gateOk && !only) {
    console.error('[context-probe] portão reprovado: veja a tabela acima.');
    return 1;
  }
  return 0;
}

// Só roda quando executado direto (node scripts/context-probe.mjs), nunca ao ser importado.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; });
}
