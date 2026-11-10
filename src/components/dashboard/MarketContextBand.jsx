import React, { useState } from 'react';
import {
  CalendarClock, Eye, EyeOff, Briefcase, ShoppingCart, Factory, Wallet, Landmark, BadgeCheck, Clock,
  ChevronDown, ChevronUp, ArrowUp, ArrowDown, Equal, History, Activity,
} from 'lucide-react';
import { useMarketContext } from '@/hooks/useMarketContext';
import { useNow } from '@/hooks/useNow';
import {
  BAND_STATES, CATEGORY_META, EVENT_META, IMPACT_LABELS, MAX_EVENTS_SHOWN, HISTORY_SHOWN,
  bandState, upcomingEvents, splitFeatured, groupEventsByDay, eventUrgency, approachFraction, eventValueSlots,
  splitValueText, resultRows, resultEvents, releaseHistory, brtDayDiff, relativeDayLabel,
  formatCountdown, formatCountdownBare, formatEventWhen, formatEventClock, formatAge, isBandEnabled, setBandEnabled,
} from '@/lib/marketContextBand';
import { reactionNote } from '@/lib/reactionStats';
import { useBtcAfterRelease } from '@/hooks/useBtcAfterRelease';
import { HORIZONS_MIN, horizonLabel, formatMove, movesCount, lastMove } from '@/lib/btcAfterRelease';

const BOX = { background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' };
const SOFT = { background: 'rgba(255,255,255,0.025)' };

// Cor pelo TIPO da notícia (emprego / inflação / juros) — nunca "bom" ou "ruim". Escolhidas fora da paleta de urgência
// (ciano / amarelo / laranja / verde), para uma cor não ser confundida com a outra; o rótulo em texto vai sempre junto.
const CATEGORY_COLORS = { emprego: '#60a5fa', inflacao: '#c084fc', juros: '#f472b6' };

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

const DIRECTION_META = {
  acima: { Icon: ArrowUp, text: 'acima' },
  abaixo: { Icon: ArrowDown, text: 'abaixo' },
  igual: { Icon: Equal, text: 'igual' },
};

/** Seta NEUTRA (cor do texto, nunca verde/vermelho) + a palavra: só diz se o número ficou acima, abaixo ou igual ao anterior. */
function DirectionTag({ direction }) {
  const meta = DIRECTION_META[direction];
  if (!meta) return null;
  const { Icon } = meta;
  return (
    <span className="inline-flex items-center gap-1 text-xs font-mono font-bold text-foreground whitespace-nowrap">
      <Icon className="w-3.5 h-3.5" aria-hidden="true" />
      {meta.text}
    </span>
  );
}

/** "Saiu hoje às 10:30 · há 12 min" (ou "ontem"). */
function releasedWhen(e, now) {
  const day = relativeDayLabel(brtDayDiff(e.startMs, now)).toLowerCase();
  return `Saiu ${day} às ${formatEventClock(e.startsAtUtc)}`;
}

/**
 * "Como o BTC se mexeu nas últimas divulgações" (Agenda 4d, addendum 18 do item 285): o TAMANHO do movimento do BTC na 1ª hora e nos 5 primeiros
 * minutos das divulgações passadas do mesmo tipo, contra o mesmo horário num dia normal. Medido, não previsto: sempre com o número de casos e a
 * data da medição, sem sinal de alta/baixa, sem verde/vermelho e sem previsão. Só aparece para o tipo que tem medição (CPI, Payroll, PPI e PCE).
 */
function ReactionNote({ kind }) {
  const n = reactionNote(kind);
  if (!n) return null;
  const strong = n.verdict === 'maior';
  return (
    <aside aria-label="Como o BTC se mexeu nas últimas divulgações" className="rounded-lg px-3 py-2.5 space-y-2"
      style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.08)' }}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <h4 className="flex items-center gap-1.5 text-10px font-mono uppercase tracking-wider text-muted-foreground">
          <Activity className="w-3 h-3 shrink-0" aria-hidden="true" />
          Como o BTC se mexeu nas últimas divulgações
        </h4>
        <span className="text-10px font-mono font-bold rounded-full px-2 py-0.5"
          style={{ color: strong ? '#e2e8f0' : '#94a3b8', border: `1px solid ${strong ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.12)'}` }}>
          {n.chip}
        </span>
      </div>
      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 font-mono tabular-nums">
        <div>
          <dt className="text-10px text-muted-foreground">Na 1ª hora (mediana)</dt>
          <dd className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-lg font-bold text-foreground leading-tight">{n.hour.value}</span>
            <span className="text-10px text-muted-foreground">dia normal: {n.hour.normal}{n.hour.times ? ` · ${n.hour.times} mais` : ''}</span>
          </dd>
        </div>
        <div>
          <dt className="text-10px text-muted-foreground">Nos 5 primeiros minutos</dt>
          <dd className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-lg font-bold text-foreground leading-tight">{n.first5.value}</span>
            <span className="text-10px text-muted-foreground">dia normal: {n.first5.normal}</span>
          </dd>
        </div>
      </dl>
      <p className="text-10px font-mono text-muted-foreground leading-relaxed">
        {n.cases} · medido em {n.measuredAt}. Tamanho do movimento, sem direção: um retrato do passado, que não indica para onde o BTC vai.
        O mercado reage ao que surpreende, e este painel não tem a expectativa.
      </p>
    </aside>
  );
}

/**
 * "O BTC depois da divulgação" (Agenda 4d, parte 2, addendum 18 do item 285): quanto o preço do BTC andou nos 5 min, 30 min e 1 h seguintes a uma divulgação que
 * JÁ saiu, medido nas velas de 1 minuto. Mostra o que aconteceu, com sinal mas sem cor de "bom/ruim", e não afirma que a divulgação causou o movimento.
 * Horizonte cuja vela ainda não fechou aparece como "—". Some inteiro enquanto não há nenhum número (ou se a busca falhou).
 */
function BtcAfter({ moves }) {
  if (!moves || movesCount(moves) === 0) return null;
  return (
    <aside aria-label="O BTC depois da divulgação" className="rounded-lg px-3 py-2.5 space-y-1.5"
      style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.08)' }}>
      <h4 className="flex items-center gap-1.5 text-10px font-mono uppercase tracking-wider text-muted-foreground">
        <Activity className="w-3 h-3 shrink-0" aria-hidden="true" />
        O BTC depois da divulgação
      </h4>
      <dl className="flex flex-wrap gap-x-6 gap-y-1 font-mono tabular-nums">
        {HORIZONS_MIN.map((n) => (
          <div key={n}>
            <dt className="text-10px text-muted-foreground">Em {horizonLabel(n)}</dt>
            <dd className="text-lg font-bold text-foreground leading-tight">{formatMove(moves[n])}</dd>
          </div>
        ))}
      </dl>
      <p className="text-10px font-mono text-muted-foreground leading-relaxed">
        Velas de 1 minuto do BTC na Binance. Mostra o que aconteceu depois; não prova que a divulgação causou o movimento.
      </p>
    </aside>
  );
}

/**
 * Cartão de RESULTADO: evento do BLS que acabou de sair. Tabela com uma linha por medida (no mês, em 12 meses ou vagas do mês):
 * Anterior, Atual e a comparação neutra; "Anterior revisado" só se o BLS corrigiu o mês anterior. Sem o "Atual" ainda, mostra
 * "aguardando" (o número entra na próxima coleta). Não prevê nada: compara com o MÊS ANTERIOR, não com a expectativa do mercado.
 */
function ResultCard({ e, now, checkedAtMs, moves }) {
  const meta = EVENT_META[e.kind];
  const Icon = KIND_ICONS[e.kind];
  const rows = resultRows(e.values);
  const hasActual = rows.some((r) => r.actual !== null);
  const hasRevised = rows.some((r) => r.revised !== null);
  const age = formatAge(checkedAtMs, now);
  return (
    <article aria-label="Resultado" className="rounded-xl p-3 sm:p-4 space-y-3"
      style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', borderTop: `2px solid ${CATEGORY_COLORS[meta.category]}` }}>
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="flex items-start gap-3 min-w-0 flex-1 basis-56">
          <span className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0"
            style={{ background: 'rgba(255,255,255,0.06)', color: CATEGORY_COLORS[meta.category] }}>
            <Icon className="w-5 h-5" aria-hidden="true" />
          </span>
          <div className="min-w-0 space-y-1">
            <CategoryTag category={meta.category} Icon={Icon} />
            <h3 className="text-base font-bold text-foreground leading-tight tracking-tight">
              {meta.title}
              <span className="ml-2 text-xs font-mono font-normal text-muted-foreground">({meta.short})</span>
            </h3>
            <p className="text-11px font-mono text-muted-foreground">
              <time dateTime={e.startsAtUtc} className="text-foreground">{releasedWhen(e, now)}</time>
              {' · '}{formatAge(e.startMs, now)}
            </p>
          </div>
        </div>
        <span className="inline-flex items-center gap-1 text-10px font-mono font-bold uppercase tracking-wider shrink-0"
          style={{ color: hasActual ? '#00ff80' : '#94a3b8' }}>
          {hasActual
            ? <BadgeCheck className="w-3 h-3" aria-hidden="true" />
            : <span className="w-1.5 h-1.5 rounded-full animate-pulse motion-reduce:animate-none" style={{ background: '#94a3b8' }} aria-hidden="true" />}
          {hasActual ? 'Resultado oficial' : 'Aguardando o número'}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full sm:w-auto sm:min-w-[30rem] text-left border-separate border-spacing-y-1">
          <caption className="sr-only">{`${meta.title}: número anterior e número atual`}</caption>
          <thead>
            <tr className="text-10px font-mono uppercase tracking-wider text-muted-foreground">
              <th scope="col" className="font-normal pr-3"><span className="sr-only">Medida</span></th>
              <th scope="col" className="font-normal pr-3 sm:pr-6">Anterior</th>
              {hasRevised && <th scope="col" className="font-normal pr-3 sm:pr-6">Anterior revisado</th>}
              <th scope="col" className="font-normal">Atual</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="font-mono tabular-nums">
                <th scope="row" className="text-xs font-normal text-muted-foreground pr-3 whitespace-nowrap py-1 align-top">{r.label}</th>
                <td className="text-sm text-muted-foreground pr-3 sm:pr-6 py-1 align-top">{r.previous ?? '—'}</td>
                {hasRevised && <td className="text-sm text-muted-foreground pr-3 sm:pr-6 py-1 align-top">{r.revised ?? '—'}</td>}
                <td className="py-1 align-top">
                  {/* O valor e a comparação ficam juntos: no celular a seta desce para baixo do número em vez de ficar numa 5ª coluna cortada. */}
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
                    <span className="text-lg font-bold text-foreground leading-tight">
                      {r.actual ?? <span className="text-10px font-normal text-muted-foreground">aguardando</span>}
                    </span>
                    <DirectionTag direction={r.direction} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <BtcAfter moves={moves} />
      <p className="text-10px font-mono text-muted-foreground">
        {e.values?.source ? `Fonte: ${e.values.source}. ` : ''}
        {hasActual
          ? 'Compara com o mês anterior, não com a expectativa do mercado (que este painel não tem).'
          : `O número entra na próxima coleta${age ? ` (última checagem ${age})` : ''}.`}
      </p>
    </article>
  );
}

/** Uma divulgação da lista "Últimas divulgações": dia, nome, "anterior → atual" da medida principal e a comparação neutra. */
function HistoryRow({ e, now, moves }) {
  const meta = EVENT_META[e.kind];
  const g = groupEventsByDay([e], now)[0];
  const main = resultRows(e.values)[0];
  return (
    <li className="rounded-lg px-3 py-2 flex flex-wrap items-center gap-x-4 gap-y-1" style={SOFT}>
      <span className="text-10px font-mono font-bold tracking-wider text-muted-foreground whitespace-nowrap">{g.weekday} {g.dayMonth}</span>
      <span className="text-xs font-semibold text-foreground">
        {meta.title}
        <span className="ml-1.5 text-10px font-mono font-normal text-muted-foreground">({meta.short})</span>
      </span>
      {main && (
        <span className="text-xs font-mono tabular-nums text-foreground">
          {main.previous ?? '—'} <span aria-label="para" className="text-muted-foreground">→</span> <span className="font-bold">{main.actual}</span>
          <span className="ml-1.5 text-10px text-muted-foreground">{main.label.toLowerCase()}</span>
        </span>
      )}
      {main && <DirectionTag direction={main.direction} />}
      {resultRows(e.values).some((r) => r.revised !== null) && <span className="text-10px font-mono text-muted-foreground">anterior revisado</span>}
      {(() => {
        const m = lastMove(moves);
        return m && (
          <span className="text-10px font-mono text-muted-foreground tabular-nums">
            BTC em {m.label}: <span className="font-bold text-foreground">{m.text}</span>
          </span>
        );
      })()}
    </li>
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
      <ul className="flex flex-col gap-1.5">
        {shown.map((e) => <HistoryRow key={e.id} e={e} now={now} moves={reactions?.get(e.id)?.moves} />)}
      </ul>
      <p className="text-10px font-mono text-muted-foreground">Fonte: BLS. Compara com o mês anterior.</p>
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
      <span className="absolute inset-x-0 top-0 h-0.5" style={{ background: CATEGORY_COLORS[meta.category] }} aria-hidden="true" />
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
          <ResultCard e={r} now={now} checkedAtMs={checkedAtMs} moves={reactions.get(r.id)?.moves} />
          <ReactionNote kind={r.kind} />
        </div>
      ))}
      {rows.length === 0 ? (
        results.length === 0 && <p className="text-11px font-mono text-muted-foreground">Nenhum evento à frente na agenda.</p>
      ) : (
        <>
          {featured && (
            <div className="space-y-2">
              <NextEventCard e={featured} now={now} />
              <ReactionNote kind={featured.kind} />
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
