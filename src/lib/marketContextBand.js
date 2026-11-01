// Contexto de Mercado — Fase 3 (docs/known-risks.md item 285, addendum 11): lógica PURA da faixa de eventos do
// Dashboard. Sem rede, sem React. O dado vem do `events.json` que o coletor (`context-collect.yml`) grava na branch
// pública `context-data`; este módulo só valida, filtra, ordena e formata.
//
// Isolamento: nada do motor de trading importa este arquivo (travado por `scripts/contextIsolationTripwire.test.js`:
// o nome começa com "marketContext"). A faixa é INFORMAÇÃO — não altera sinal, stop, alvo, score nem operação.
// Texto neutro de propósito: "evento à frente", nunca "vai subir/cair" nem probabilidade.

export const CONTEXT_DATA_BASE = 'https://raw.githubusercontent.com/mateusraony/Sentinel-Signals/context-data';
/** Sem checagem nova há mais que isto = "desatualizado" (o coletor roda ≥ 3x/dia; 36 h tolera um dia sem coleta). */
export const STALE_AFTER_MS = 36 * 60 * 60 * 1000;
/** Evento que começou há até isto ainda aparece, como "acabou de sair". */
export const JUST_RELEASED_MS = 30 * 60 * 1000;
export const MAX_EVENTS_SHOWN = 4;

export const EVENT_LABELS = Object.freeze({ CPI: 'CPI', NFP: 'Payroll', PPI: 'PPI', PCE: 'PCE', FOMC: 'FOMC' });
export const EVENT_HINTS = Object.freeze({
  CPI: 'inflação dos EUA',
  NFP: 'emprego dos EUA',
  PPI: 'inflação ao produtor',
  PCE: 'inflação do consumo',
  FOMC: 'decisão de juros do Fed',
});
export const STATUS_LABELS = Object.freeze({ oficial: 'oficial', confirmada: 'confirmada', a_confirmar: 'data a confirmar' });

export const BAND_STATES = Object.freeze({
  FRESH: 'atualizado',
  STALE: 'desatualizado',
  UNAVAILABLE: 'indisponivel',
  OFF: 'desligado',
});

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const isoMs = (v) => (typeof v === 'string' && ISO_RE.test(v) ? Date.parse(v) : NaN);

/**
 * Do JSON público, só as linhas bem formadas (tipo e situação conhecidos, hora ISO válida). O arquivo vem da rede:
 * qualquer outra coisa é ignorada em vez de quebrar a tela. Lança se o corpo nem é uma lista.
 */
export function parseEvents(json) {
  if (!Array.isArray(json)) throw new Error('events.json não é uma lista');
  const out = [];
  const seen = new Set();
  for (const e of json) {
    if (!e || typeof e !== 'object' || typeof e.id !== 'string') continue;
    // Id repetido (arquivo público, vem da rede): vale o primeiro — senão a tela teria `key` duplicada no React.
    if (seen.has(e.id)) continue;
    if (!Object.prototype.hasOwnProperty.call(EVENT_LABELS, e.kind)) continue;
    if (!Object.prototype.hasOwnProperty.call(STATUS_LABELS, e.status)) continue;
    const startMs = isoMs(e.startsAtUtc);
    if (!Number.isFinite(startMs)) continue;
    seen.add(e.id);
    out.push({ id: e.id, kind: e.kind, status: e.status, startsAtUtc: e.startsAtUtc, startMs });
  }
  return out;
}

/** Hora da última checagem do coletor (`status.json`), em ms; null se o corpo não serve. */
export function parseCheckedAt(json) {
  const ms = isoMs(json?.checkedAt);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Eventos de agora em diante (mais os que saíram há até 30 min), em ordem de hora. `phase`: 'agora' = já começou
 * (acabou de sair), 'futuro' = ainda não.
 */
export function upcomingEvents(events, nowMs, limit = MAX_EVENTS_SHOWN) {
  return (Array.isArray(events) ? events : [])
    .filter((e) => Number.isFinite(e?.startMs) && e.startMs >= nowMs - JUST_RELEASED_MS)
    .sort((a, b) => (a.startMs === b.startMs ? String(a.id).localeCompare(String(b.id)) : a.startMs - b.startMs))
    .slice(0, limit)
    .map((e) => ({ ...e, phase: e.startMs <= nowMs ? 'agora' : 'futuro' }));
}

/**
 * Estado da faixa. `events === null` = nunca conseguiu ler (rede, branch ainda inexistente) → indisponível.
 * Lido mas a última checagem do coletor é velha (ou não tem hora) → desatualizado.
 */
export function bandState({ enabled, events, checkedAtMs, nowMs }) {
  if (!enabled) return BAND_STATES.OFF;
  if (!Array.isArray(events)) return BAND_STATES.UNAVAILABLE;
  if (!Number.isFinite(checkedAtMs) || nowMs - checkedAtMs > STALE_AFTER_MS) return BAND_STATES.STALE;
  return BAND_STATES.FRESH;
}

/** "em 12 min", "em 5h 20min", "em 3d 4h". */
export function formatCountdown(msUntil) {
  if (!Number.isFinite(msUntil) || msUntil <= 0) return 'agora';
  const total = Math.floor(msUntil / 60000);
  if (total < 1) return 'em menos de 1 min';
  if (total < 60) return `em ${total} min`;
  if (total < 1440) {
    const h = Math.floor(total / 60);
    const m = total % 60;
    return m ? `em ${h}h ${m}min` : `em ${h}h`;
  }
  const d = Math.floor(total / 1440);
  const h = Math.floor((total % 1440) / 60);
  return h ? `em ${d}d ${h}h` : `em ${d}d`;
}

const BRT = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo', weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

/** "seg 10/11, 10:30 (Brasília)" — a hora vem sempre de UTC convertida (nunca deslocamento fixo). */
export function formatEventWhen(iso) {
  const ms = isoMs(iso);
  if (!Number.isFinite(ms)) return '—';
  const p = Object.fromEntries(BRT.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${String(p.weekday).replace('.', '')} ${p.day}/${p.month}, ${p.hour}:${p.minute} (Brasília)`;
}

/** "há 5 h" / "há 40 min"; null se não há hora. */
export function formatAge(checkedAtMs, nowMs) {
  if (!Number.isFinite(checkedAtMs)) return null;
  const min = Math.max(0, Math.floor((nowMs - checkedAtMs) / 60000));
  if (min < 60) return `há ${min} min`;
  return `há ${Math.floor(min / 60)} h`;
}

// Chave de ligar/desligar (por navegador). Padrão: ligada. Tudo em try/catch — localStorage pode não existir
// (modo privado, quota, teste), e a faixa tem que continuar funcionando.
const OFF_KEY = 'sentinel_market_context_band_off';

export function isBandEnabled() {
  try { return localStorage.getItem(OFF_KEY) !== '1'; } catch { return true; }
}

export function setBandEnabled(enabled) {
  try {
    if (enabled) localStorage.removeItem(OFF_KEY);
    else localStorage.setItem(OFF_KEY, '1');
  } catch { /* sem localStorage: a escolha vale só nesta sessão da tela */ }
}
