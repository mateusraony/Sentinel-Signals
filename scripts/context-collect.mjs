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
// Variáveis de ambiente lidas: FRED_API_KEY e BLS_API_KEY (as duas vão só na URL da requisição),
// CONTEXT_CONTACT_EMAIL (só no cabeçalho User-Agent) e COLLECT_MODE (só o valor exato "janela" muda algo). Nenhum banco, nenhum Telegram.
// Os números do BLS (addenda 14 e 15) são opcionais: sem a chave ou sem resposta, o evento sai sem `values`, e a coleta das datas segue.
// Base própria do BLS (addendum 21): `<dir>/bls-base.json` guarda os índices crus já lidos e as lacunas oficiais ("-" do BLS); a resposta da API só ACRESCENTA
// (uma queda ou resposta parcial nunca apaga nada) e os números dos eventos saem de base + API. O arquivo só é criado quando há ao menos 1 valor.
// Modo "janela" (addendum 15): disparado a cada ~10 min nas horas das divulgações; só trabalha se algum evento do BLS saiu há ≤ 4 h e
// ainda não tem o "Atual" — senão sai logo, sem rede e sem gravar nada (o git não tem o que commitar).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildEvents, buildStatus, assertPublicShape, fetchFredDates, sanitizePrevious, needsResultCheck, FRED_RELEASES } from './contextCollect.mjs';
import { fetchBlsSeries, allSeriesIds } from './contextBls.mjs';
import { mergeBase, unionSeries, assertBaseShape, sanitizeBase, serializeBase, describeBase } from './contextBlsBase.mjs';

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

/** A base do BLS anterior; arquivo ausente, ilegível ou fora da lista fechada = só o que presta (no limite, base vazia). Nunca lança. */
export function readBase(file) {
  try {
    return sanitizeBase(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return sanitizeBase(null);
  }
}

/**
 * Grava a base só se ela tem valores, passa na trava da lista fechada e mudou. Devolve o estado para o resumo: 'gravada' | 'inalterada' |
 * 'não gravada (sem valores)' | 'NÃO gravada (a trava recusou)'. Nunca lança.
 */
export function writeBase(file, base) {
  if (!Object.keys(base.values).length) return 'não gravada (sem valores)';
  try {
    assertBaseShape(base);
  } catch (err) {
    console.error(`[context-collect] ${err.message} — a base do BLS não foi gravada.`);
    return 'NÃO gravada (a trava recusou)';
  }
  const texto = serializeBase(base);
  let atual = null;
  try { atual = fs.readFileSync(file, 'utf8'); } catch { atual = null; }
  if (atual === texto) return 'inalterada';
  fs.writeFileSync(file, texto);
  return 'gravada';
}

/**
 * A linha do resumo sobre o BLS: só contagens e o motivo (nunca a chave, a URL nem o texto de erro do BLS).
 * @param {{ tally: { v2: number, v1: number, failed: number }, keyPresent: boolean, keyRejected: boolean, limitHit: boolean }|null} bls
 */
export function describeBls(bls) {
  if (!bls) return null;
  const total = bls.tally.v2 + bls.tally.v1 + bls.tally.failed;
  const lidas = bls.tally.v2 + bls.tally.v1;
  const via = [`v2 com chave: ${bls.tally.v2}`, `v1 sem chave: ${bls.tally.v1}`, `sem resposta: ${bls.tally.failed}`].join(' · ');
  const lines = [`BLS (valor "Anterior"): ${lidas} de ${total} séries lidas (${via}).`];
  if (bls.keyPresent && bls.keyRejected) {
    lines.push('ATENÇÃO: o BLS RECUSOU a chave `BLS_API_KEY` — ela ainda não foi ativada pelo link do e-mail do BLS, ou o segredo foi salvo com erro de cópia. A coleta usou a versão sem chave (25 consultas por dia, por endereço compartilhado).');
  } else if (!bls.keyPresent) {
    lines.push('Sem o segredo `BLS_API_KEY`: a coleta usou a versão sem chave do BLS (25 consultas por dia, por endereço compartilhado).');
  }
  if (bls.limitHit) lines.push('O BLS informou que o limite diário de consultas foi atingido: o "Anterior" já publicado foi mantido.');
  return lines.join('\n');
}

/** 'janela' só com o valor exato; qualquer outra coisa (vazio, outro texto, maiúsculas) é a coleta normal. */
export function resolveMode(env) {
  return env?.COLLECT_MODE === 'janela' ? 'janela' : 'normal';
}

export function formatCollectMarkdown(status, events, fredDatesByKind, bls = null, baseLine = null) {
  const lines = ['## Coletor de contexto — datas dos eventos', ''];
  lines.push(`Checado em ${status.checkedAt} (UTC). FRED: **${status.fred}**${status.fred === 'ok' ? '' : ' — os tipos sem resposta usam a lista fixa'}.`);
  const porTipo = Object.keys(FRED_RELEASES).map((k) => `${k} ${Array.isArray(fredDatesByKind[k]) ? 'ok' : 'sem resposta'}`).join(' · ');
  lines.push(`Por tipo: ${porTipo}.`);
  const blsLine = describeBls(bls);
  if (blsLine) lines.push(blsLine);
  if (baseLine) lines.push(baseLine);
  lines.push(`Eventos publicados: ${status.eventsCount}. Cobertura confirmada até: ${status.coverageUntil ?? '—'}.`);
  lines.push('');
  lines.push('| Evento | Hora (UTC) | Situação | Anterior (BLS) | Atual (BLS) | Revisado (BLS) |');
  lines.push('|---|---|---|---|---|---|');
  for (const e of events) {
    lines.push(`| ${e.id} | ${e.startsAtUtc.slice(0, 16).replace('T', ' ')} | ${e.status} | ${e.values?.previous ?? '—'} | ${e.values?.actual ?? '—'} | ${e.values?.revised ?? '—'} |`);
  }
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
  const nowMs = now();
  if (resolveMode(env) === 'janela' && !needsResultCheck(sanitizePrevious(previous), nowMs)) {
    console.log('## Coletor de contexto — janela de divulgação\n\nNenhum evento do BLS está esperando o número oficial agora. Nada a fazer.');
    return 0;
  }
  const fredDatesByKind = await fetchFredDates({ fetchImpl, env });
  // O BLS é opcional: qualquer falha vira "sem número" e as datas seguem (fetchBlsSeries nunca lança nem devolve texto de erro).
  const bls = await fetchBlsSeries({ fetchImpl, env, ids: allSeriesIds() });
  // A base própria (addendum 21): lê o que já estava guardado, acrescenta o que a API trouxe e calcula os números de base + API.
  // Se a API caiu ou veio parcial, a base completa o que falta; onde as duas têm o mês, a API (mais nova) vence.
  const baseFile = path.join(args.dir, 'bls-base.json');
  const merged = mergeBase(readBase(baseFile), { series: bls.series, gaps: bls.gaps });
  const events = buildEvents({ fredDatesByKind, previous, nowMs, blsSeries: unionSeries(merged.base, bls.series) });
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
  // A base é aditiva: se a trava recusar, os eventos já gravados seguem e só a base fica de fora (o log diz).
  const baseState = writeBase(baseFile, merged.base);
  console.log(formatCollectMarkdown(status, events, fredDatesByKind, bls, describeBase(merged.base, merged.stats, baseState)));
  return 0;
}

// Só roda quando executado direto (node scripts/context-collect.mjs), nunca ao ser importado.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; });
}
