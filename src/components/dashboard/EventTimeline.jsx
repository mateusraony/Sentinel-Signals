import React from 'react';
import moment from 'moment';

/**
 * Apresentação da linha do tempo (docs/known-risks.md item 161).
 *
 * `CandleBoundTag` e `DetectionLag` nasceram dentro de `src/pages/TradeHistory.jsx`
 * e viviam só lá; aqui viram compartilhados, para que card de operação, card
 * de aviso e histórico contem a mesma história do mesmo jeito. Também unifica
 * o `fmtBRT` que estava duplicado em `TradeCard.jsx` e `TradeHistory.jsx`.
 *
 * Só apresentação: quem decide QUAIS eventos existem é `src/lib/eventTimeline.js`.
 */

/** Horário absoluto no fuso do usuário (BRT). */
export function fmtBRT(iso, { withDate = true } = {}) {
  if (!iso) return '—';
  const m = moment(iso);
  if (!m.isValid()) return '—';
  return m.utcOffset(-3).format(withDate ? 'DD/MM HH:mm' : 'HH:mm');
}

// Codex review (PR #213): os campos *_real_time são o CLOSE da vela que
// confirmou um toque intrabar — cota máxima do cruzamento real, não o
// instante exato (só há OHLC, sem tick). A etiqueta deixa isso explícito em
// vez de fingir precisão de tick.
export function CandleBoundTag() {
  return (
    <span className="text-[8px] text-muted-foreground/50"
      title="Fechamento da vela que confirmou o toque — cota máxima; o cruzamento real do nível pode ter sido antes, dentro da mesma vela (só há dado OHLC, sem tick intrabar)">
      {' '}(vela)
    </span>
  );
}

// Diferença entre o horário de mercado e o momento em que o scan detectou.
// É o sinal de diagnóstico que denuncia uma falha do cron ou uma queda de
// cota (docs/known-risks.md item 106) — exatamente o que o usuário quer
// poder comparar depois.
const LAG_THRESHOLD_MS = 20 * 60 * 1000;

export function DetectionLag({ realTime, detectedAt }) {
  if (!realTime || !detectedAt) return null;
  const gapMs = new Date(detectedAt).getTime() - new Date(realTime).getTime();
  if (!Number.isFinite(gapMs) || gapMs < LAG_THRESHOLD_MS) return null;
  const hours = gapMs / 3_600_000;
  const label = hours >= 1 ? `${hours.toFixed(1)}h` : `${Math.round(gapMs / 60_000)}min`;
  return (
    <span className="text-[8px] text-amber-500/80"
      title="Diferença entre o fechamento real do candle e quando o scan detectou/gravou — atraso grande aqui indica falha do cron ou queda de cota">
      {' '}(detectado {label} depois)
    </span>
  );
}

/**
 * Uma linha: "Aberta · 05/09 08:15". Compacta de propósito — é registro de
 * auditoria, não manchete.
 */
export function EventRow({ event, color = 'rgba(255,255,255,0.45)' }) {
  return (
    <div className="flex items-baseline gap-1.5 text-[9px] font-mono leading-relaxed">
      <span className="shrink-0" style={{ color: 'rgba(255,255,255,0.3)' }}>{event.label}</span>
      <span style={{ color }}>{fmtBRT(event.at)}</span>
      {event.candleBound && <CandleBoundTag />}
      <DetectionLag realTime={event.at} detectedAt={event.detectedAt} />
    </div>
  );
}

/**
 * A linha do tempo inteira. `events` vem de `opTimeline`/`signalTimeline`.
 */
export function EventTimeline({ events, title = 'Horários (BRT)' }) {
  if (!events?.length) return null;
  return (
    <div className="space-y-0.5">
      {title && (
        <div className="text-[8px] font-mono uppercase tracking-wide" style={{ color: 'rgba(255,255,255,0.28)' }}>
          🕐 {title}
        </div>
      )}
      {events.map((event) => <EventRow key={event.key} event={event} />)}
    </div>
  );
}

export default EventTimeline;
