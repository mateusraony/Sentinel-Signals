// Modo de observação sem banco: ENSAIO do vigia de stop/alvo (docs/known-risks.md item 299, addendum 6).
//
// Por que existe: o vigia (O2) só age numa queda de verdade do Neon, que é rara. Este ensaio roda o MESMO caminho sem esperar a queda e SEM GRAVAR NADA:
//   1. lê o retrato REAL no Realtime Database (o que o scan grava a cada passada);
//   2. confere as regras PUBLICADAS do RTDB (a mesma conferência que libera o vigia a enviar e gravar);
//   3. busca as velas REAIS de 15 min na Binance Spot (janela de 2 h) para cada símbolo do retrato e confere se não falta vela;
//   4. avalia as operações do retrato com as regras do vigia e conta os avisos que ele daria agora;
//   5. manda 2 mensagens "ENSAIO" no Telegram: o relatório e um exemplo do formato do aviso de stop, com valores inventados.
// NÃO grava episódio, NÃO marca livro de avisos, NÃO toca o Postgres. Só LÊ o RTDB e as regras.
//
// O log do Actions é PÚBLICO: a linha de resultado leva só contagens e códigos curtos. Os símbolos aparecem só no Telegram (conversa privada do usuário).
// Nunca lança. Sem `OBSERVATION_DATABASE_URL` não faz nada.
import { sendTelegram } from './contextTelegram.mjs';
import { createObservationWatchStore } from './observationWatchStore.mjs';
import { fetchClosedCandles15m, isValidSymbol } from './observationCandles.mjs';
import { CANDLE_MS, evaluateOperation, checkCandleCoverage, isUsableSnapshot } from './observationWatch.mjs';
import { normalizeSnapshot } from './observationWatcher.mjs';
import { buildWatchAlert, formatBrasilia } from './observationMessages.mjs';
import { safeCode, safeErrorCode } from './observationSnapshot.mjs';

const MIN = 60_000;
export const WINDOW_MS = 2 * 60 * MIN; // janela de velas buscadas
export const MAX_SNAPSHOT_AGE_OK_MIN = 45; // o scan grava a cada ~15 min; 3 passadas perdidas já é problema
const MAX_SYMBOLS = 10;
const PROBE_SYMBOL = 'BTCUSDT';

function escapeHtml(text) {
  return String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const label = (symbol) => escapeHtml(String(symbol ?? '—').replace('USDT', '/USDT'));
const problemCode = (prefix, code) => safeCode(`${prefix}_${safeCode(code)}`);

function buildReport(r, detail) {
  const linhas = ['<b>ENSAIO do vigia de stop/alvo</b> — nada foi gravado e nenhuma operação foi alterada.', ''];
  if (detail.snapshotAtMs !== null) {
    linhas.push(`Retrato: de ${formatBrasilia(detail.snapshotAtMs)} (Brasília), há ${r.snapshotAgeMin} min${r.snapshotAgeMin > MAX_SNAPSHOT_AGE_OK_MIN ? ' — VELHO (o scan grava a cada ~15 min)' : ''}.`);
    linhas.push(`Operações vivas no retrato: ${r.operations}${r.dropped > 0 ? `; ${r.dropped} ${r.dropped === 1 ? 'operação viva ficou' : 'operações vivas ficaram'} FORA do retrato` : ''}.`);
  } else {
    linhas.push('Retrato: NÃO encontrado ou ilegível.');
  }
  const regras = { fechadas: 'fechadas (o vigia pode gravar)', abertas: 'ABERTAS (o vigia NÃO grava nem avisa)', nao_verificadas: 'NÃO deu para ler (o vigia NÃO grava nem avisa)' }[r.rules] ?? 'não verificadas';
  linhas.push(`Regras publicadas do Realtime Database: ${regras}.`);
  linhas.push('');
  linhas.push(r.operations === 0 && detail.snapshotAtMs !== null
    ? `Velas de 15 min da Binance (últimas 2 h): nenhuma operação viva no retrato; testei só o símbolo de prova ${label(PROBE_SYMBOL)}.`
    : 'Velas de 15 min da Binance (últimas 2 h):');
  for (const f of detail.fetches) linhas.push(`• ${label(f.symbol)}: ${f.ok ? `${f.count} velas, sem falta` : `FALHOU (${escapeHtml(f.code)})`}`);
  linhas.push('');
  if (detail.evaluated) {
    linhas.push(`Avaliação com o retrato real: ${r.events === 0 ? 'o vigia não daria nenhum aviso agora' : `o vigia avisaria ${r.events} ${r.events === 1 ? 'evento' : 'eventos'} agora`}.`);
    for (const e of detail.eventLines.slice(0, 10)) linhas.push(`• ${label(e.symbol)}: ${escapeHtml(e.event)}`);
  } else {
    linhas.push('Avaliação com o retrato real: pulada (retrato ausente, velho demais para a janela ou sem velas).');
  }
  linhas.push('');
  linhas.push(r.problems.length === 0 ? '<b>Resultado: TUDO OK.</b> Se você leu esta mensagem, o envio pelo Telegram também funciona.' : `<b>Resultado: PROBLEMAS</b> — ${r.problems.map(escapeHtml).join(', ')}.`);
  linhas.push('');
  linhas.push('<i>⚡ Sentinel Signals — ensaio do modo de observação</i>');
  return linhas.join('\n');
}

function buildSampleAlert(nowMs) {
  const exemplo = buildWatchAlert({
    event: 'stop',
    op: { symbol: 'BTCUSDT', side: 'BUY', signal_timeframe: '4h', entry_price: 100, current_stop: 95 },
    level: 95,
    candleOpenMs: nowMs - 30 * MIN,
    snapshotAtMs: nowMs - 60 * MIN,
    ambiguous: false,
    afterTp1: false,
  });
  return `<b>ENSAIO — exemplo do formato do aviso</b> (valores inventados; nenhuma operação real, nenhum stop foi tocado)\n\n${exemplo}`;
}

/**
 * @param {{ env?: object, store?: object, send?: Function, getCandles?: Function, nowMs?: number }} [p]
 */
export async function runObservationRehearsal({ env = process.env, store, send, getCandles, nowMs = Date.now() } = {}) {
  try {
    const url = typeof env?.OBSERVATION_DATABASE_URL === 'string' ? env.OBSERVATION_DATABASE_URL.trim() : '';
    if (!url) return { ok: false, skipped: 'sem_url' };

    const rtdb = store ?? createObservationWatchStore({ env });
    const enviar = send ?? ((text) => sendTelegram({ text, env }));
    const velas = getCandles ?? fetchClosedCandles15m;

    const r = {
      ok: false, problems: [], operations: 0, dropped: 0, events: 0, candles: { symbols: 0, ok: 0 }, rules: 'nao_verificadas', snapshotAgeMin: null, telegram: 'nao_enviado',
    };
    const detail = { snapshotAtMs: null, fetches: [], evaluated: false, eventLines: [] };

    // 1) retrato real
    const lido = await rtdb.readSnapshot();
    let snapshot = null;
    if (!lido.ok) r.problems.push(problemCode('leitura', lido.erro ?? lido.skipped));
    else {
      const raw = normalizeSnapshot(lido.value);
      snapshot = isUsableSnapshot(raw) ? raw : null;
      if (!snapshot) r.problems.push('sem_retrato');
    }
    if (snapshot) {
      detail.snapshotAtMs = Date.parse(snapshot.snapshot_at);
      r.snapshotAgeMin = Math.round((nowMs - detail.snapshotAtMs) / MIN);
      r.operations = snapshot.operations.length;
      r.dropped = Number.isFinite(snapshot.dropped_operations) ? snapshot.dropped_operations : 0;
      if (r.snapshotAgeMin > MAX_SNAPSHOT_AGE_OK_MIN) r.problems.push('retrato_velho');
    }

    // 2) regras publicadas (só leitura: `ensureWritable` não grava)
    const regras = await rtdb.ensureWritable();
    if (regras.ok) r.rules = 'fechadas';
    else {
      r.rules = regras.erro === 'regras_abertas' ? 'abertas' : 'nao_verificadas';
      const c = safeCode(regras.erro ?? regras.skipped);
      r.problems.push(c.startsWith('regras_') ? c : problemCode('regras', c));
    }

    // 3) velas reais, uma busca por símbolo
    const ops = snapshot ? snapshot.operations.filter((o) => o && typeof o === 'object') : [];
    const simbolos = [];
    for (const o of ops) {
      if (!isValidSymbol(o.symbol)) { if (!r.problems.includes('velas_simbolo_invalido')) r.problems.push('velas_simbolo_invalido'); continue; }
      if (!simbolos.includes(o.symbol) && simbolos.length < MAX_SYMBOLS) simbolos.push(o.symbol);
    }
    if (simbolos.length === 0) simbolos.push(PROBE_SYMBOL);

    const firstOpenMs = Math.ceil((nowMs - WINDOW_MS) / CANDLE_MS) * CANDLE_MS;
    const porSimbolo = new Map();
    r.candles.symbols = simbolos.length;
    for (const symbol of simbolos) {
      const busca = await velas({ symbol, startMs: firstOpenMs, nowMs });
      if (!busca?.ok) {
        const code = safeCode(busca?.reason ?? 'erro_desconhecido');
        detail.fetches.push({ symbol, ok: false, code });
        const p = problemCode('velas', code);
        if (!r.problems.includes(p)) r.problems.push(p);
        continue;
      }
      const cobertura = checkCandleCoverage({ candles: busca.candles, firstOpenMs, nowMs });
      if (!cobertura.ok) {
        detail.fetches.push({ symbol, ok: false, code: 'velas_incompletas' });
        if (!r.problems.includes('velas_incompletas')) r.problems.push('velas_incompletas');
        continue;
      }
      r.candles.ok += 1;
      detail.fetches.push({ symbol, ok: true, count: busca.candles.length });
      porSimbolo.set(symbol, busca.candles);
    }

    // 4) o que o vigia avisaria com o retrato real (só se a janela de 2 h cobre o retrato)
    if (snapshot && r.snapshotAgeMin * MIN <= WINDOW_MS && ops.length > 0) {
      detail.evaluated = true;
      for (const o of ops) {
        const candles = porSimbolo.get(o.symbol);
        if (!candles) continue;
        const ev = evaluateOperation({ op: o, candles, snapshotAtMs: detail.snapshotAtMs, nowMs });
        if (!ev.ok) { if (!r.problems.includes('operacao_invalida')) r.problems.push('operacao_invalida'); continue; }
        r.events += ev.events.length;
        for (const e of ev.events) detail.eventLines.push({ symbol: o.symbol, event: e.event });
      }
    }

    // 5) Telegram: relatório e exemplo
    r.ok = r.problems.length === 0;
    const rel = await enviar(buildReport(r, detail));
    if (!rel?.ok) {
      r.telegram = safeCode(rel?.reason ?? 'erro_desconhecido');
      r.problems.push(problemCode('envio', r.telegram));
    } else {
      r.telegram = 'ok';
      const ex = await enviar(buildSampleAlert(nowMs));
      if (!ex?.ok) {
        r.telegram = safeCode(ex?.reason ?? 'erro_desconhecido');
        r.problems.push(problemCode('envio', r.telegram));
      }
    }
    r.ok = r.problems.length === 0;
    return r;
  } catch (err) {
    return { ok: false, problems: [problemCode('erro', safeErrorCode(err))], operations: 0, dropped: 0, events: 0, candles: { symbols: 0, ok: 0 }, rules: 'nao_verificadas', snapshotAgeMin: null, telegram: 'nao_enviado' };
  }
}

/** A linha do log do ensaio (PÚBLICO): só contagem e código curto. */
export function describeRehearsalResult(r) {
  if (r?.skipped === 'sem_url') return '[ensaio] desligado (sem URL do RTDB): preencha o segredo FIREBASE_DATABASE_URL';
  const partes = [
    `retrato=${Number.isFinite(r?.snapshotAgeMin) ? `${r.snapshotAgeMin}min` : 'ausente'}`,
    `ops=${r?.operations ?? 0}`,
    `velas_ok=${r?.candles?.ok ?? 0}/${r?.candles?.symbols ?? 0}`,
    `avisos_agora=${r?.events ?? 0}`,
    `regras=${safeCode(r?.rules)}`,
    `telegram=${safeCode(r?.telegram)}`,
  ];
  if (r?.ok) return `[ensaio] OK · ${partes.join(' ')}`;
  const codigos = (r?.problems ?? []).map((p) => safeCode(p)).join(', ');
  return `[ensaio] PROBLEMAS (${codigos}) · ${partes.join(' ')}`;
}
