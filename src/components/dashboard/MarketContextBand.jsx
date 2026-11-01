import React, { useState } from 'react';
import { CalendarClock, Eye, EyeOff } from 'lucide-react';
import { useMarketContext } from '@/hooks/useMarketContext';
import { useNow } from '@/hooks/useNow';
import {
  BAND_STATES, EVENT_LABELS, EVENT_HINTS, STATUS_LABELS,
  bandState, upcomingEvents, formatCountdown, formatEventWhen, formatAge, isBandEnabled, setBandEnabled,
} from '@/lib/marketContextBand';

const BOX = { background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' };

/**
 * Caixa de erro LOCAL da faixa. Os únicos ErrorBoundary do app são de página (AppLayout/App): sem esta, um erro de
 * renderização da faixa derrubaria o Dashboard INTEIRO — contra a regra de ouro do Contexto ("o contexto pode parar; o
 * Sentinel não pode depender dele", item 285). Silenciosa de propósito: não chama `logError` (grava SystemLog no banco);
 * se a faixa quebrar, ela some e o resto da tela segue.
 */
class BandBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { crashed: false };
  }

  static getDerivedStateFromError() {
    return { crashed: true };
  }

  componentDidCatch() {
    // Sem log, de propósito (ver o comentário da classe).
  }

  render() {
    return this.state.crashed ? null : this.props.children;
  }
}

/**
 * Faixa "Agenda de eventos dos EUA" (Contexto de Mercado, Fase 3 — docs/known-risks.md item 285, addendum 11).
 * Só informação: não altera sinal, stop, alvo, score nem operação, e o motor nunca importa este componente.
 * 4 estados: atualizado, desatualizado, indisponível e desligado (chave por navegador). Falha em silêncio.
 */
export default function MarketContextBand() {
  return (
    <BandBoundary>
      <MarketContextBandInner />
    </BandBoundary>
  );
}

function MarketContextBandInner() {
  const [enabled, setEnabled] = useState(() => isBandEnabled());
  const now = useNow(60 * 1000);
  const { events, checkedAtMs, isLoading } = useMarketContext({ enabled });

  const toggle = (next) => { setBandEnabled(next); setEnabled(next); };
  const state = bandState({ enabled, events, checkedAtMs, nowMs: now });

  if (state === BAND_STATES.OFF) {
    return (
      <button type="button" onClick={() => toggle(true)}
        className="flex items-center gap-1.5 text-10px font-mono text-muted-foreground hover:text-foreground transition-colors">
        <Eye className="w-3 h-3" aria-hidden="true" />
        Mostrar agenda de eventos dos EUA
      </button>
    );
  }
  if (isLoading) return null;

  const header = (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-2">
        <CalendarClock className="w-3.5 h-3.5" style={{ color: '#00e5ff' }} aria-hidden="true" />
        <h2 className="text-sm font-bold text-foreground tracking-tight">Agenda de eventos dos EUA</h2>
      </div>
      <button type="button" onClick={() => toggle(false)} aria-label="Ocultar agenda de eventos"
        className="flex items-center gap-1 text-10px font-mono text-muted-foreground hover:text-foreground transition-colors">
        <EyeOff className="w-3 h-3" aria-hidden="true" />
        Ocultar
      </button>
    </div>
  );

  if (state === BAND_STATES.UNAVAILABLE) {
    return (
      <section aria-label="Agenda de eventos dos EUA" className="rounded-xl px-4 py-3 space-y-1.5" style={BOX}>
        {header}
        <p className="text-11px font-mono text-muted-foreground">
          Agenda indisponível no momento. Isso não afeta sinais nem operações.
        </p>
      </section>
    );
  }

  const rows = upcomingEvents(events, now);
  const age = formatAge(checkedAtMs, now);
  return (
    <section aria-label="Agenda de eventos dos EUA" className="rounded-xl px-4 py-3 space-y-2" style={BOX}>
      {header}
      {state === BAND_STATES.STALE && (
        <p className="text-11px font-mono" style={{ color: '#ffd166' }}>
          {age ? `Última checagem ${age}` : 'Sem hora da última checagem'} — a agenda pode estar desatualizada; confira a data antes de confiar.
        </p>
      )}
      {rows.length === 0 ? (
        <p className="text-11px font-mono text-muted-foreground">Nenhum evento à frente na agenda.</p>
      ) : (
        <ul className="space-y-1.5">
          {rows.map((e) => {
            const pendente = e.status === 'a_confirmar';
            return (
              <li key={e.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-11px font-mono"
                style={{ opacity: pendente ? 0.65 : 1 }}>
                <span className="font-bold text-foreground">{EVENT_LABELS[e.kind]}</span>
                <span className="text-muted-foreground">{EVENT_HINTS[e.kind]}</span>
                <span className="text-foreground">{formatEventWhen(e.startsAtUtc)}</span>
                {!pendente && (
                  <span style={{ color: e.phase === 'agora' ? '#ffd166' : '#00e5ff' }}>
                    {e.phase === 'agora' ? 'acabou de sair' : formatCountdown(e.startMs - now)}
                  </span>
                )}
                <span className="text-muted-foreground">({STATUS_LABELS[e.status]})</span>
              </li>
            );
          })}
        </ul>
      )}
      <p className="text-10px font-mono text-muted-foreground">
        Só informação — não altera sinais nem operações.
      </p>
    </section>
  );
}
