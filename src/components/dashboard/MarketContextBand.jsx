import React, { useState } from 'react';
import {
  CalendarClock, Eye, EyeOff, Briefcase, ShoppingCart, Factory, Wallet, Landmark, BadgeCheck, Clock,
  ChevronDown, ChevronUp, History,
} from 'lucide-react';
import { useMarketContext } from '@/hooks/useMarketContext';
import { useNow } from '@/hooks/useNow';
import {
  BAND_STATES, CATEGORY_META, CATEGORY_ACCENTS, EVENT_META, IMPACT_LABELS, MAX_EVENTS_SHOWN, HISTORY_SHOWN,
  bandState, upcomingEvents, splitFeatured, groupEventsByDay, eventUrgency, approachFraction, eventValueSlots,
  splitValueText, resultEvents, releaseHistory,
  formatCountdown, formatCountdownBare, formatEventWhen, formatEventClock, formatAge, isBandEnabled, setBandEnabled,
} from '@/lib/marketContextBand';
import { ResultCard, ReactionPanel, HistoryCard } from '@/components/dashboard/MarketResultCard';
import { useBtcAfterRelease } from '@/hooks/useBtcAfterRelease';
import { lastMove } from '@/lib/btcAfterRelease';

const BOX = { background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' };
const SOFT = { background: 'rgba(255,255,255,0.025)' };

// Cor pelo TIPO da notícia (emprego / inflação / juros) — nunca "bom" ou "ruim". A tabela é ÚNICA e mora na lib (`CATEGORY_ACCENTS`, travada por teste:
// sem roxo, sem o ciano do BTC, com contraste). Aqui, em texto e ícone pequenos, só o `from`; o gradiente inteiro vai nas áreas maiores. O rótulo em
// texto vai sempre junto da cor.
const CATEGORY_COLORS = Object.fromEntries(Object.entries(CATEGORY_ACCENTS).map(([cat, a]) => [cat, a.from]));

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
 * Desenho: um cartão para o PRÓXIMO evento (contagem regressiva grande, importância, barra de aproximação) e, abaixo, uma
 * COLUNA por dia com evento (Hoje / Amanhã / SEX 13), lado a lado. A cor identifica o TIPO da notícia (emprego / inflação /
 * juros), nunca "bom/ruim"; a urgência fica no fundo e na contagem. Os números oficiais do BLS (Anterior, Atual e Revisado) aparecem só
 * quando o evento os traz. Evento do BLS que JÁ saiu (até 24 h) vira um cartão de RESULTADO (Anterior × Atual, com comparação NEUTRA:
 * acima/abaixo/igual, sem verde nem vermelho); depois disso fica na lista "Últimas divulgações". O texto é por extenso ("no mês",
 * "em 12 meses"). Nada aqui prevê direção: a comparação é com o mês anterior, não com a expectativa do mercado.
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

/** Etiqueta do tipo de notícia: ícone + rótulo na cor da categoria (cor + texto, nunca só cor). */
function CategoryTag({ category, Icon }) {
  return (
    <span className="inline-flex items-center gap-1 text-10px font-mono font-bold uppercase tracking-wider"
      style={{ color: CATEGORY_COLORS[category] }}>
      <Icon className="w-3 h-3" aria-hidden="true" />
      {CATEGORY_META[category].label}
    </span>
  );
}

/** O texto do coletor por extenso, uma medida por linha: "+0,3% no mês" / "+3,0% em 12 meses". Formato desconhecido aparece como veio. */
function ValueLines({ text }) {
  return splitValueText(text).map((p, i) => (
    <span key={`${p.key}-${i}`} className="block">
      {p.value}
      {p.label && <span className="ml-1 text-10px font-normal text-muted-foreground">{p.label}</span>}
    </span>
  ));
}

/**
 * Números oficiais (Anterior / Atual) de um evento que AINDA não saiu (ou sem cartão de resultado), só quando o evento os traz.
 * Não existe "Projeção": sem fonte gratuita e licenciada, o painel não inventa número.
 */
function ValueSlots({ e, compact = false }) {
  // Compacto (cartão da coluna): só o que já tem número. O "Atual: aguardando" fica só no cartão do próximo evento —
  // repetido em cada coluna seria ruído.
  const slots = eventValueSlots(e).filter((s) => !compact || s.text !== null);
  if (slots.length === 0) return null;
  return (
    <div className={compact ? 'flex flex-col gap-1' : 'flex flex-wrap items-end gap-x-3 gap-y-1'}>
      <dl className={compact ? 'flex gap-3' : 'flex gap-2'}>
        {slots.map((s) => (
          <div key={s.key} className={compact ? '' : 'rounded-lg px-3 py-1.5'} style={compact ? undefined : SOFT}>
            <dt className="text-10px font-mono uppercase tracking-wider text-muted-foreground">{s.label}</dt>
            <dd className={compact ? 'text-11px font-mono font-bold text-foreground tabular-nums' : 'text-base font-bold font-mono text-foreground tabular-nums'}>
              {s.text === null ? <span className="text-10px font-normal text-muted-foreground">aguardando</span> : <ValueLines text={s.text} />}
            </dd>
          </div>
        ))}
      </dl>
      {e.values?.source && <span className="text-10px font-mono text-muted-foreground">Fonte: {e.values.source}</span>}
    </div>
  );
}

/** "Últimas divulgações": só eventos com o "Atual" oficial (de mais de 24 h atrás). Some inteira enquanto não há nenhuma. */
function ReleaseHistory({ items, now, reactions }) {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
  const shown = open ? items : items.slice(0, HISTORY_SHOWN);
  return (
    <section aria-label="Últimas divulgações" className="space-y-2">
      <h3 className="flex items-center gap-1.5 text-10px font-mono uppercase tracking-wider text-muted-foreground">
        <History className="w-3 h-3" aria-hidden="true" />
        Últimas divulgações
      </h3>
      <ul className="flex flex-col gap-3">
        {shown.map((e) => <HistoryCard key={e.id} e={e} now={now} moves={reactions?.get(e.id)?.moves} />)}
      </ul>
      <p className="text-10px font-mono text-muted-foreground">Fonte: BLS. Compara com o mês anterior, não com a expectativa do mercado (que este painel não tem).</p>
      {shown.some((e) => lastMove(reactions?.get(e.id)?.moves)) && (
        <p className="text-10px font-mono text-muted-foreground">O BTC vem das velas de 1 minuto da Binance e só mostra o que aconteceu depois; não prova que a divulgação causou o movimento.</p>
      )}
      {items.length > HISTORY_SHOWN && (
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}
          className="flex items-center gap-1 text-10px font-mono text-muted-foreground hover:text-foreground transition-colors">
          {open ? <ChevronUp className="w-3 h-3" aria-hidden="true" /> : <ChevronDown className="w-3 h-3" aria-hidden="true" />}
          {open ? 'Mostrar menos' : `Ver todas (${items.length})`}
        </button>
      )}
    </section>
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
        {/* O ícone fica na cor da CATEGORIA (emprego/inflação/juros); a URGÊNCIA fica no fundo, na contagem e no ponto. */}
        <span className="w-10 h-10 sm:w-11 sm:h-11 rounded-lg flex items-center justify-center shrink-0"
          style={{ background: 'rgba(255,255,255,0.06)', color: CATEGORY_COLORS[meta.category] }}>
          <Icon className="w-5 h-5" aria-hidden="true" />
        </span>
        <div className="min-w-0 space-y-1.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="inline-flex items-center gap-1.5 text-10px font-mono uppercase tracking-wider font-bold" style={{ color: tone.color }}>
              {hot && <span className="w-1.5 h-1.5 rounded-full animate-pulse motion-reduce:animate-none" style={{ background: tone.color }} aria-hidden="true" />}
              {tone.head}
            </span>
            <CategoryTag category={meta.category} Icon={Icon} />
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
          <ValueSlots e={e} />
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

/** Cartão de um evento dentro da coluna do dia: tipo (cor + texto), nome, importância, números (se houver) e hora/contagem. */
function EventTile({ e, now }) {
  const meta = EVENT_META[e.kind];
  const Icon = KIND_ICONS[e.kind];
  const pending = e.status === 'a_confirmar';
  const tone = TONES[eventUrgency(e, now)];
  return (
    <li className="relative overflow-hidden rounded-lg p-2.5 pt-3 flex flex-col gap-1.5" style={{ ...SOFT, opacity: pending ? 0.75 : 1 }}>
      <span className="absolute inset-x-0 top-0 h-1" style={{ background: `linear-gradient(90deg, ${CATEGORY_ACCENTS[meta.category].from}, ${CATEGORY_ACCENTS[meta.category].to})` }} aria-hidden="true" />
      <CategoryTag category={meta.category} Icon={Icon} />
      <p className="text-xs font-semibold text-foreground leading-tight">
        {meta.title}
        <span className="ml-1.5 text-10px font-mono font-normal text-muted-foreground">({meta.short})</span>
      </p>
      <ImpactDots impact={meta.impact} />
      <ValueSlots e={e} compact />
      {/* "Data oficial" é o normal: só aparece no cartão do próximo evento. Aqui só a exceção (confirmada / a confirmar). */}
      {e.status !== 'oficial' && <StatusChip status={e.status} />}
      <div className="mt-auto pt-1.5 flex items-baseline justify-between gap-2" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
        <time dateTime={e.startsAtUtc} className="text-xs font-mono font-bold text-foreground tabular-nums">
          {formatEventClock(e.startsAtUtc)}
        </time>
        {!pending && (
          <span className="text-10px font-mono" style={{ color: tone.color }}>
            {e.phase === 'agora' ? 'acabou de sair' : formatCountdown(e.startMs - now)}
          </span>
        )}
      </div>
    </li>
  );
}

/** Coluna de um dia: cabeçalho (SEX 13/11 · em 8 dias) e, embaixo, os eventos daquele dia. */
function DayColumn({ g, now }) {
  const today = g.diff === 0;
  return (
    <div className="flex flex-col gap-1.5 min-w-0 sm:snap-start">
      <div className="flex items-baseline gap-1.5 px-0.5">
        <span className="text-10px font-mono font-bold tracking-wider" style={{ color: today ? '#ffd166' : 'rgba(255,255,255,0.55)' }}>{g.weekday}</span>
        <span className="text-lg font-bold text-foreground tabular-nums leading-none">{g.day}</span>
        <span className="text-10px font-mono text-muted-foreground">/{g.month}</span>
        <span className="ml-auto text-10px font-mono whitespace-nowrap" style={{ color: today ? '#ffd166' : 'rgba(255,255,255,0.45)' }}>{g.relative}</span>
      </div>
      <ul className="flex flex-col gap-1.5 flex-1">
        {g.items.map((e) => <EventTile key={e.id} e={e} now={now} />)}
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
  // O BTC depois de cada divulgação que já saiu (resultado de até 24 h + últimas divulgações). Hook ANTES dos retornos antecipados abaixo; desligada a faixa, não busca nada.
  const reactions = useBtcAfterRelease(enabled ? [...resultEvents(events, now), ...releaseHistory(events, now)] : [], now);

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

  // Evento do BLS que já saiu (≤ 24 h) vira o cartão de RESULTADO e sai do fluxo "próximos" (não aparece duas vezes).
  const results = resultEvents(events, now).slice(0, 3);
  const inResult = new Set(results.map((r) => r.id));
  const notShown = (list) => list.filter((e) => !inResult.has(e.id));
  const total = notShown(upcomingEvents(events, now, 1000)).length;
  const rows = notShown(upcomingEvents(events, now, 1000)).slice(0, expanded ? 1000 : MAX_EVENTS_SHOWN);
  const { featured, rest } = splitFeatured(rows);
  const groups = groupEventsByDay(rest, now);
  const history = releaseHistory(events, now);
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
      {results.map((r) => (
        <div key={r.id} className="space-y-2">
          <ResultCard e={r} now={now} checkedAtMs={checkedAtMs} btc={reactions.get(r.id)} />
          <ReactionPanel kind={r.kind} />
        </div>
      ))}
      {rows.length === 0 ? (
        results.length === 0 && <p className="text-11px font-mono text-muted-foreground">Nenhum evento à frente na agenda.</p>
      ) : (
        <>
          {featured && (
            <div className="space-y-2">
              <NextEventCard e={featured} now={now} />
              <ReactionPanel kind={featured.kind} />
            </div>
          )}
          {groups.length > 0 && (
            <div className="space-y-2">
              {featured && <h3 className="text-10px font-mono uppercase tracking-wider text-muted-foreground">Nos próximos dias</h3>}
              {/* Uma coluna por dia COM evento, lado a lado (rola para o lado se não couber); no celular as colunas empilham.
                  Dias sem evento não ganham coluna: a agenda real tem ~2 eventos por semana, e 5 colunas vazias seriam só ruído. */}
              <div role="region" aria-label="Próximos dias com evento" tabIndex={0}
                className="grid gap-3 sm:grid-flow-col sm:auto-cols-[minmax(11rem,1fr)] sm:overflow-x-auto sm:snap-x sm:pb-1 rounded-lg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
                {groups.map((g) => <DayColumn key={g.key} g={g} now={now} />)}
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
      <ReleaseHistory items={history} now={now} reactions={reactions} />
      <p className="text-10px font-mono text-muted-foreground">
        Só informação — não altera sinais nem operações.
      </p>
    </section>
  );
}
