import React, { useState } from 'react';
import {
  CalendarClock, Eye, EyeOff, Briefcase, ShoppingCart, Factory, Wallet, Landmark, BadgeCheck, Clock,
  ChevronDown, ChevronUp,
} from 'lucide-react';
import { useMarketContext } from '@/hooks/useMarketContext';
import { useNow } from '@/hooks/useNow';
import {
  BAND_STATES, EVENT_META, IMPACT_LABELS, MAX_EVENTS_SHOWN,
  bandState, upcomingEvents, splitFeatured, groupEventsByDay, eventUrgency, approachFraction,
  formatCountdown, formatCountdownBare, formatEventWhen, formatEventClock, formatAge, isBandEnabled, setBandEnabled,
} from '@/lib/marketContextBand';

const BOX = { background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' };
const SOFT = { background: 'rgba(255,255,255,0.025)' };

// Cor pela urgência (paleta do Dashboard): longe = ciano; nas próximas 24 h = amarelo; em até 1 h ou recém-saído = laranja.
const TONES = {
  distante: { color: '#00e5ff', bg: 'rgba(0,229,255,0.06)', border: 'rgba(0,229,255,0.22)', head: 'Próximo evento' },
  proximo: { color: '#00e5ff', bg: 'rgba(0,229,255,0.06)', border: 'rgba(0,229,255,0.22)', head: 'Próximo evento' },
  em24h: { color: '#ffd166', bg: 'rgba(255,209,102,0.07)', border: 'rgba(255,209,102,0.28)', head: 'Nas próximas 24 h' },
  iminente: { color: '#ff9f43', bg: 'rgba(255,159,67,0.08)', border: 'rgba(255,159,67,0.32)', head: 'Em menos de 1 h' },
  agora: { color: '#ff9f43', bg: 'rgba(255,159,67,0.10)', border: 'rgba(255,159,67,0.35)', head: 'Acabou de sair' },
  pendente: { color: '#94a3b8', bg: 'rgba(255,255,255,0.03)', border: 'rgba(255,255,255,0.08)', head: 'Data a confirmar' },
};

const KIND_ICONS = { NFP: Briefcase, CPI: ShoppingCart, PPI: Factory, PCE: Wallet, FOMC: Landmark };
const STATUS_CHIPS = {
  oficial: { text: 'Data oficial', color: '#00ff80', Icon: BadgeCheck },
  confirmada: { text: 'Data confirmada', color: '#00ff80', Icon: BadgeCheck },
  a_confirmar: { text: 'Data a confirmar', color: '#ffd166', Icon: Clock },
};

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
 * Faixa "Agenda de eventos dos EUA" (Contexto de Mercado, Fase 3 — docs/known-risks.md item 285, addendum 11; visual
 * redesenhado em 04/11/2026). Só informação: não altera sinal, stop, alvo, score nem operação, e o motor nunca importa
 * este componente. 4 estados: atualizado, desatualizado, indisponível e desligado (chave por navegador). Falha em silêncio.
 *
 * Desenho: um cartão para o PRÓXIMO evento (contagem regressiva grande, importância, barra de aproximação) e, abaixo, os
 * seguintes agrupados por dia de Brasília (Hoje / Amanhã / SEX 13). Os números oficiais (Anterior/Atual) entram no cartão
 * quando a coleta existir; hoje a agenda traz só data, hora e situação.
 */
export default function MarketContextBand() {
  return (
    <BandBoundary>
      <MarketContextBandInner />
    </BandBoundary>
  );
}

/** Pontinhos de importância (de REFERÊNCIA do mercado; não é previsão de direção nem de tamanho de movimento). */
function ImpactDots({ impact }) {
  const label = IMPACT_LABELS[impact] ?? IMPACT_LABELS[1];
  return (
    <span className="inline-flex items-center gap-1.5" title={`${label} — referência do mercado`}>
      <span className="inline-flex gap-0.5" aria-hidden="true">
        {[1, 2, 3].map((i) => (
          <span key={i} className="w-1.5 h-1.5 rounded-full"
            style={{ background: i <= impact ? '#00e5ff' : 'rgba(255,255,255,0.16)' }} />
        ))}
      </span>
      <span className="text-10px font-mono text-muted-foreground">{label}</span>
    </span>
  );
}

function StatusChip({ status }) {
  const chip = STATUS_CHIPS[status];
  if (!chip) return null;
  const { Icon } = chip;
  return (
    <span className="inline-flex items-center gap-1 text-10px font-mono" style={{ color: chip.color }}>
      <Icon className="w-3 h-3" aria-hidden="true" />
      {chip.text}
    </span>
  );
}

/** Cartão grande do próximo evento com data firme. */
function NextEventCard({ e, now }) {
  const meta = EVENT_META[e.kind];
  const Icon = KIND_ICONS[e.kind];
  const urgency = eventUrgency(e, now);
  const tone = TONES[urgency];
  const msUntil = e.startMs - now;
  const justOut = e.phase === 'agora';
  const hot = urgency === 'iminente' || urgency === 'agora';
  return (
    <article aria-label="Próximo evento"
      className="rounded-xl p-3 sm:p-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
      style={{ background: tone.bg, border: `1px solid ${tone.border}` }}>
      <div className="flex items-start gap-3 min-w-0">
        <span className="w-10 h-10 sm:w-11 sm:h-11 rounded-lg flex items-center justify-center shrink-0"
          style={{ background: 'rgba(255,255,255,0.06)', color: tone.color }}>
          <Icon className="w-5 h-5" aria-hidden="true" />
        </span>
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="inline-flex items-center gap-1.5 text-10px font-mono uppercase tracking-wider font-bold" style={{ color: tone.color }}>
              {hot && <span className="w-1.5 h-1.5 rounded-full animate-pulse motion-reduce:animate-none" style={{ background: tone.color }} aria-hidden="true" />}
              {tone.head}
            </span>
            <ImpactDots impact={meta.impact} />
          </div>
          <h3 className="text-base sm:text-lg font-bold text-foreground leading-tight tracking-tight">
            {meta.title}
            <span className="ml-2 text-xs font-mono font-normal text-muted-foreground">({meta.short})</span>
          </h3>
          <p className="text-11px font-mono text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <time dateTime={e.startsAtUtc} className="text-foreground">{formatEventWhen(e.startsAtUtc)}</time>
            <StatusChip status={e.status} />
          </p>
        </div>
      </div>
      <div className="sm:w-44 shrink-0 sm:text-right">
        <p className="text-2xl sm:text-3xl font-bold font-mono tabular-nums leading-none" style={{ color: tone.color }}>
          {formatCountdownBare(msUntil)}
        </p>
        <p className="mt-1 text-10px font-mono text-muted-foreground">{justOut ? 'o número acabou de sair' : 'faltam'}</p>
        <div className="mt-2 h-1 rounded-full overflow-hidden" aria-hidden="true" style={{ background: 'rgba(255,255,255,0.08)' }}>
          <div className="h-full rounded-full transition-all"
            style={{ width: `${Math.round(approachFraction(msUntil) * 100)}%`, background: tone.color }} />
        </div>
      </div>
    </article>
  );
}

function TimelineRow({ e, now }) {
  const meta = EVENT_META[e.kind];
  const Icon = KIND_ICONS[e.kind];
  const pending = e.status === 'a_confirmar';
  const tone = TONES[eventUrgency(e, now)];
  return (
    <li className="flex-1 flex items-center gap-2.5 rounded-lg px-2.5 py-2" style={{ ...SOFT, opacity: pending ? 0.75 : 1 }}>
      {/* No celular o ícone sai da linha (o nome já diz o tipo): o espaço vai para o título não quebrar em 3 linhas. */}
      <Icon className="hidden sm:block w-4 h-4 shrink-0" style={{ color: tone.color }} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold text-foreground leading-tight">
          {meta.title}
          <span className="ml-1.5 text-10px font-mono font-normal text-muted-foreground">({meta.short})</span>
        </p>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5">
          <ImpactDots impact={meta.impact} />
          {/* "Data oficial" é o normal: só aparece no cartão do próximo evento. Na lista só a exceção (confirmada / a confirmar). */}
          {e.status !== 'oficial' && <StatusChip status={e.status} />}
        </div>
      </div>
      <div className="text-right shrink-0">
        <time dateTime={e.startsAtUtc} className="block text-xs font-mono font-bold text-foreground tabular-nums">
          {formatEventClock(e.startsAtUtc)}
        </time>
        {!pending && (
          <span className="block text-10px font-mono" style={{ color: tone.color }}>
            {e.phase === 'agora' ? 'acabou de sair' : formatCountdown(e.startMs - now)}
          </span>
        )}
      </div>
    </li>
  );
}

/** Um dia da linha do tempo: bloco de calendário à esquerda (SEX / 13/11 / em 9 dias) e os eventos do dia à direita. */
function DayGroup({ g, now }) {
  const today = g.diff === 0;
  return (
    <div className="flex items-stretch gap-2 sm:gap-3">
      <div className="w-[4.25rem] sm:w-[4.75rem] shrink-0 text-center rounded-lg py-1.5 flex flex-col justify-center"
        style={{ background: today ? 'rgba(255,209,102,0.10)' : 'rgba(255,255,255,0.04)', border: `1px solid ${today ? 'rgba(255,209,102,0.3)' : 'rgba(255,255,255,0.06)'}` }}>
        <p className="text-10px font-mono font-bold tracking-wider" style={{ color: today ? '#ffd166' : 'rgba(255,255,255,0.55)' }}>{g.weekday}</p>
        <p className="leading-tight">
          <span className="text-lg font-bold text-foreground tabular-nums">{g.day}</span>
          <span className="text-10px font-mono text-muted-foreground">/{g.month}</span>
        </p>
        <p className="text-10px font-mono leading-tight whitespace-nowrap" style={{ color: today ? '#ffd166' : 'rgba(255,255,255,0.45)' }}>{g.relative}</p>
      </div>
      <ul className="flex-1 min-w-0 flex flex-col gap-1.5">
        {g.items.map((e) => <TimelineRow key={e.id} e={e} now={now} />)}
      </ul>
    </div>
  );
}

function MarketContextBandInner() {
  const [enabled, setEnabled] = useState(() => isBandEnabled());
  const [expanded, setExpanded] = useState(false);
  // 15 s: a contagem regressiva do último minuto e do evento que acabou de sair não pode ficar parada.
  const now = useNow(15 * 1000);
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

  const age = formatAge(checkedAtMs, now);
  const header = (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-2 min-w-0">
        <CalendarClock className="w-3.5 h-3.5 shrink-0" style={{ color: '#00e5ff' }} aria-hidden="true" />
        <h2 className="text-sm font-bold text-foreground tracking-tight">Agenda de eventos dos EUA</h2>
        {state === BAND_STATES.FRESH && age && (
          <span className="hidden sm:inline text-10px font-mono text-muted-foreground">· checada {age}</span>
        )}
      </div>
      <button type="button" onClick={() => toggle(false)} aria-label="Ocultar agenda de eventos"
        className="flex items-center gap-1 text-10px font-mono text-muted-foreground hover:text-foreground transition-colors shrink-0">
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

  const total = upcomingEvents(events, now, 1000).length;
  const rows = upcomingEvents(events, now, expanded ? 1000 : MAX_EVENTS_SHOWN);
  const { featured, rest } = splitFeatured(rows);
  const groups = groupEventsByDay(rest, now);
  return (
    <section aria-label="Agenda de eventos dos EUA" className="rounded-xl px-4 py-3 space-y-3" style={BOX}>
      {header}
      {state === BAND_STATES.STALE && (
        <p className="flex items-start gap-1.5 text-11px font-mono" style={{ color: '#ffd166' }}>
          <Clock className="w-3 h-3 mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            {age ? `Última checagem ${age}` : 'Sem hora da última checagem'} — a agenda pode estar desatualizada; confira a data antes de confiar.
          </span>
        </p>
      )}
      {rows.length === 0 ? (
        <p className="text-11px font-mono text-muted-foreground">Nenhum evento à frente na agenda.</p>
      ) : (
        <>
          {featured && <NextEventCard e={featured} now={now} />}
          {groups.length > 0 && (
            <div className="space-y-2">
              {featured && <h3 className="text-10px font-mono uppercase tracking-wider text-muted-foreground">Depois</h3>}
              <div className="space-y-2.5">
                {groups.map((g) => <DayGroup key={g.key} g={g} now={now} />)}
              </div>
            </div>
          )}
          {(total > MAX_EVENTS_SHOWN || expanded) && (
            <button type="button" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}
              className="flex items-center gap-1 text-10px font-mono text-muted-foreground hover:text-foreground transition-colors">
              {expanded ? <ChevronUp className="w-3 h-3" aria-hidden="true" /> : <ChevronDown className="w-3 h-3" aria-hidden="true" />}
              {expanded ? 'Mostrar menos' : `Ver todos (${total})`}
            </button>
          )}
        </>
      )}
      <p className="text-10px font-mono text-muted-foreground">
        Só informação — não altera sinais nem operações.
      </p>
    </section>
  );
}
