// Modo de observação sem banco, fase O2b (docs/known-risks.md item 299): o ORQUESTRADOR do vigia de stop/alvo e o fechamento do episódio na volta do banco.
//
// O que faz, a cada passada do scan com o Postgres sem cota (`runObservationWatch`):
//   1. lê o retrato (O1) e o episódio da queda no Realtime Database; abre o episódio no 1º passo (regra das 2 h olha o retrato NO INÍCIO da queda);
//   2. manda UM aviso de abertura ("ligado" / "não está vigiando");
//   3. compara cada operação viva do retrato com as velas de 15 min fechadas desde então (Binance Spot) e avisa stop/TP1/TP2 no Telegram, UMA vez cada
//      (livro de avisos dentro do episódio: envia primeiro, marca depois, então no pior caso repete um aviso e nunca perde um).
// E, quando o banco volta (`closeObservationEpisode`): se o vigia falou durante a queda, manda o aviso de volta com a contagem e lembra da recuperação.
//
// NUNCA toca o Postgres (nem importa o adaptador do banco): o Telegram vai pelo remetente SEM banco (`scripts/contextTelegram.mjs`; o `adminTelegram.js` grava
// log no Postgres quando o envio falha), e tudo o que é estado fica no Realtime Database. NUNCA lança, e o resultado (que vai para o log PÚBLICO do Actions)
// leva só contagens e códigos curtos: nada de símbolo, preço, id de operação nem texto de mensagem. Sem `OBSERVATION_DATABASE_URL` não faz nada.
import { sendTelegram } from './contextTelegram.mjs';
import { createObservationWatchStore } from './observationWatchStore.mjs';
import { fetchClosedCandles15m, isValidSymbol } from './observationCandles.mjs';
import {
  CANDLE_MS, evaluateOperation, checkCandleCoverage, pendingEvents, decideEpisode, isUsableSnapshot, ledgerKey,
} from './observationWatch.mjs';
import {
  buildWatchAlert, buildStartNotice, buildStaleNotice, buildNoSnapshotNotice, buildRecoveryNotice,
} from './observationMessages.mjs';
import { safeCode, safeErrorCode } from './observationSnapshot.mjs';

const DEFAULT_MAX_MESSAGES = 20; // avisos de stop/alvo por passada; o resto fica para a seguinte
const DEFAULT_PAUSE_MS = 1100; // o Telegram aceita ~1 mensagem por segundo por conversa

const sleepDefault = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const bump = (obj, code) => { const k = safeCode(code); obj[k] = (obj[k] ?? 0) + 1; };

/**
 * O RTDB não guarda vetor vazio: um retrato sem operações vivas volta SEM a chave `operations` (e sem `assets`). Isso é um retrato válido, não "sem retrato".
 * Só preenche o que o RTDB poda; um retrato de versão desconhecida ou sem carimbo continua inutilizável.
 */
function normalizeSnapshot(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const s = { ...raw };
  if (s.operations === undefined || s.operations === null) s.operations = [];
  // O RTDB devolve um vetor com furos como objeto; só aceita vetor de verdade.
  if (!Array.isArray(s.operations)) s.operations = Object.values(s.operations);
  return s;
}

const toMs = (iso) => Date.parse(iso);

/**
 * Uma passada do vigia. Chame só quando o Postgres está sem cota.
 * @param {{ env?: object, store?: object, send?: (text:string)=>Promise<{ok:boolean, reason?:string}>, getCandles?: Function, nowMs?: number,
 *           maxMessages?: number, pauseMs?: number, sleep?: (ms:number)=>Promise<void> }} [p]
 */
export async function runObservationWatch({
  env = process.env, store, send, getCandles, nowMs = Date.now(), maxMessages = DEFAULT_MAX_MESSAGES, pauseMs = DEFAULT_PAUSE_MS, sleep = sleepDefault,
} = {}) {
  try {
    const url = typeof env?.OBSERVATION_DATABASE_URL === 'string' ? env.OBSERVATION_DATABASE_URL.trim() : '';
    if (!url) return { ok: false, skipped: 'sem_url' };

    const rtdb = store ?? createObservationWatchStore({ env });
    const enviar = send ?? ((text) => sendTelegram({ text, env }));
    const velas = getCandles ?? fetchClosedCandles15m;

    const [lidoRetrato, lidoEpisodio] = await Promise.all([rtdb.readSnapshot(), rtdb.readEpisode()]);
    if (!lidoRetrato.ok) return { ok: false, erro: safeCode(lidoRetrato.erro ?? lidoRetrato.skipped) };
    if (!lidoEpisodio.ok) return { ok: false, erro: safeCode(lidoEpisodio.erro ?? lidoEpisodio.skipped) };

    const raw = normalizeSnapshot(lidoRetrato.value);
    const snapshot = isUsableSnapshot(raw) ? raw : null;
    const decisao = decideEpisode({ episode: lidoEpisodio.value, snapshot, nowMs });
    if (decisao.kind === 'invalid') return { ok: false, erro: safeCode(decisao.reason) };

    let episode = decisao.episode;
    if (decisao.kind === 'start') {
      // Sem o episódio gravado não há livro de avisos; enviar sem poder marcar repetiria o aviso a cada passada. Melhor parar aqui.
      const gravado = await rtdb.setEpisode(episode);
      if (!gravado.ok) return { ok: false, erro: safeCode(gravado.erro ?? gravado.skipped ?? 'episodio_nao_gravado') };
    }

    const resumo = {
      ok: true, status: episode.status, operations: 0, alerts: 0, deferred: 0,
      send_errors: {}, candle_errors: {}, invalid: {}, mark_errors: 0,
    };
    const ops = snapshot ? snapshot.operations.filter((o) => o && typeof o === 'object') : [];
    resumo.operations = episode.status === 'watching' ? ops.length : 0;
    const dropped = snapshot && Number.isFinite(snapshot.dropped_operations) ? snapshot.dropped_operations : 0;
    const snapshotAtMs = snapshot ? toMs(snapshot.snapshot_at) : NaN;
    const startedAtMs = toMs(episode.started_at);

    let mensagensNestaPassada = 0;
    /** Envia respeitando a pausa entre mensagens; devolve o resultado do envio. */
    const enviarComPausa = async (text) => {
      if (mensagensNestaPassada > 0 && pauseMs > 0) await sleep(pauseMs);
      mensagensNestaPassada += 1;
      return enviar(text);
    };
    /** Marca no episódio (e na cópia local) o que acabou de ser enviado. */
    const marcar = async (updates, local) => {
      const r = await rtdb.patchEpisode(updates);
      if (!r.ok) resumo.mark_errors += 1;
      Object.assign(episode, local);
      return r.ok;
    };

    // 1) Aviso de abertura da queda (uma vez por episódio; se o envio falhar, tenta de novo na passada seguinte).
    if (episode.start_notice_sent !== true) {
      let texto = null;
      if (episode.status === 'stale') texto = buildStaleNotice({ snapshotAtMs, startedAtMs });
      else if (episode.status === 'no_snapshot') texto = buildNoSnapshotNotice({ startedAtMs });
      else if (ops.length > 0 || dropped > 0) texto = buildStartNotice({ operations: ops, dropped, snapshotAtMs });

      if (texto === null) {
        await marcar({ start_notice_sent: true }, { start_notice_sent: true }); // nada a anunciar: não é "ligado" inútil
      } else {
        const r = await enviarComPausa(texto);
        if (r.ok) await marcar({ start_notice_sent: true, announced: true }, { start_notice_sent: true, announced: true });
        else bump(resumo.send_errors, r.reason);
      }
    }

    // 2) Vigia stop/alvo — só com retrato bom o bastante.
    if (episode.status === 'watching' && ops.length > 0) {
      // A 1ª vela que vale é a que ABRE no ou depois do retrato (a que o atravessa tem movimento anterior a ele: achado do Codex, PR #571).
      const firstOpenMs = Math.ceil(snapshotAtMs / CANDLE_MS) * CANDLE_MS;
      const porSimbolo = new Map();
      for (const o of ops) {
        if (!isValidSymbol(o.symbol)) { bump(resumo.candle_errors, 'simbolo_invalido'); continue; }
        if (!porSimbolo.has(o.symbol)) porSimbolo.set(o.symbol, []);
        porSimbolo.get(o.symbol).push(o);
      }

      for (const [symbol, deste] of porSimbolo) {
        const busca = await velas({ symbol, startMs: firstOpenMs, nowMs });
        if (!busca?.ok) { bump(resumo.candle_errors, busca?.reason ?? 'erro_desconhecido'); continue; }
        const cobertura = checkCandleCoverage({ candles: busca.candles, firstOpenMs, nowMs });
        if (!cobertura.ok) { bump(resumo.candle_errors, 'velas_incompletas'); continue; }

        for (const o of deste) {
          const ev = evaluateOperation({ op: o, candles: busca.candles, snapshotAtMs, nowMs });
          if (!ev.ok) { bump(resumo.invalid, ev.reason); continue; }
          const jaViuTp1 = o.tp1_hit === true || o.status === 'RUNNER_ACTIVE';
          const pendentes = pendingEvents({ opId: o.id, events: ev.events, sent: episode.sent });
          for (const p of pendentes) {
            if (resumo.alerts >= maxMessages) { resumo.deferred += 1; continue; }
            const depoisDoTp1 = jaViuTp1 || ev.events.some((e) => e.event === 'tp1' && e.candleOpen <= p.candleOpen && e !== p);
            const texto = buildWatchAlert({
              event: p.event, op: o, level: p.level, candleOpenMs: p.candleOpen, snapshotAtMs, ambiguous: p.ambiguous, afterTp1: depoisDoTp1,
            });
            if (texto === null) continue;
            const r = await enviarComPausa(texto);
            if (!r.ok) { bump(resumo.send_errors, r.reason); continue; }
            resumo.alerts += 1;
            const chave = ledgerKey(o.id, p.event);
            const alertas = (Number.isFinite(episode.alerts_sent) ? episode.alerts_sent : 0) + 1;
            const sent = { ...(episode.sent && typeof episode.sent === 'object' ? episode.sent : {}) };
            const [opKey, evento] = chave.split('/');
            sent[opKey] = { ...(sent[opKey] ?? {}), [evento]: { at: new Date(nowMs).toISOString() } };
            await marcar(
              { [`sent/${chave}`]: { at: new Date(nowMs).toISOString() }, alerts_sent: alertas, announced: true },
              { sent, alerts_sent: alertas, announced: true },
            );
          }
        }
      }
    }

    return resumo;
  } catch (err) {
    return { ok: false, erro: safeErrorCode(err) };
  }
}

/**
 * O banco voltou (passada limpa): se havia um episódio aberto, fecha. Se o vigia falou durante a queda, manda o aviso de volta ANTES de marcar o fim
 * (se o envio falhar, o fim não é marcado e a próxima passada tenta de novo); sem ter falado, fecha em silêncio.
 * 1 leitura pequena do RTDB por passada limpa; sem episódio aberto não grava nada.
 */
export async function closeObservationEpisode({ env = process.env, store, send, nowMs = Date.now() } = {}) {
  try {
    const url = typeof env?.OBSERVATION_DATABASE_URL === 'string' ? env.OBSERVATION_DATABASE_URL.trim() : '';
    if (!url) return { ok: false, skipped: 'sem_url' };
    const rtdb = store ?? createObservationWatchStore({ env });
    const enviar = send ?? ((text) => sendTelegram({ text, env }));

    const lido = await rtdb.readEpisode();
    if (!lido.ok) return { ok: false, erro: safeCode(lido.erro ?? lido.skipped) };
    const ep = lido.value;
    const aberto = ep && typeof ep === 'object' && !Array.isArray(ep) && typeof ep.started_at === 'string' && !ep.ended_at;
    if (!aberto) return { ok: true, closed: false };

    let notified = false;
    if (ep.announced === true) {
      const texto = buildRecoveryNotice({
        alertsSent: ep.alerts_sent, status: ep.status, startedAtMs: toMs(ep.started_at), endedAtMs: nowMs,
      });
      const r = await enviar(texto);
      if (!r.ok) return { ok: false, erro: `envio_${safeCode(r.reason)}` };
      notified = true;
    }
    const marcado = await rtdb.patchEpisode({ ended_at: new Date(nowMs).toISOString() });
    if (!marcado.ok) return { ok: false, erro: safeCode(marcado.erro ?? marcado.skipped), notified };
    return { ok: true, closed: true, notified };
  } catch (err) {
    return { ok: false, erro: safeErrorCode(err) };
  }
}

const sumCodes = (obj) => Object.values(obj ?? {}).reduce((a, n) => a + (Number.isFinite(n) ? n : 0), 0);

/** A linha do log do scan (PÚBLICO): só contagem e código curto. */
export function describeWatchResult(r) {
  if (r?.ok) {
    if (r.status === 'stale') return '[scan] vigia: retrato velho demais no início da queda, NÃO vigiando (1 aviso enviado por episódio)';
    if (r.status === 'no_snapshot') return '[scan] vigia: sem retrato utilizável, NÃO vigiando (1 aviso enviado por episódio)';
    const partes = [`ops=${r.operations ?? 0}`, `avisos=${r.alerts ?? 0}`];
    if (r.deferred > 0) partes.push(`adiados=${r.deferred}`);
    const falhas = sumCodes(r.send_errors) + sumCodes(r.candle_errors) + sumCodes(r.invalid) + (r.mark_errors ?? 0);
    if (falhas > 0) {
      const detalhe = [
        ...Object.entries(r.send_errors ?? {}).map(([k, n]) => `envio_${safeCode(k)}=${n}`),
        ...Object.entries(r.candle_errors ?? {}).map(([k, n]) => `velas_${safeCode(k)}=${n}`),
        ...Object.entries(r.invalid ?? {}).map(([k, n]) => `${safeCode(k)}=${n}`),
        ...(r.mark_errors > 0 ? [`marca=${r.mark_errors}`] : []),
      ];
      partes.push(`falhas{${detalhe.join(' ')}}`);
    }
    return `[scan] vigia: vigiando · ${partes.join(' ')}`;
  }
  if (r?.skipped === 'sem_url') return '[scan] vigia: desligado (sem URL do RTDB)';
  return `[scan] vigia: não rodou (${safeCode(r?.erro ?? r?.skipped)})`;
}

/** Linha do log ao fechar o episódio; `null` quando não há nada a dizer (a maioria das passadas limpas). */
export function describeCloseResult(r) {
  if (r?.ok && r.closed) return `[scan] vigia: episódio encerrado${r.notified ? ' (aviso de volta enviado)' : ' (sem avisos a dar)'}`;
  if (r?.ok) return null;
  if (r?.skipped === 'sem_url') return null;
  return `[scan] vigia: fechamento do episódio falhou (${safeCode(r?.erro ?? r?.skipped)})`;
}
