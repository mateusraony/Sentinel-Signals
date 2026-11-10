import React, { useId } from 'react';
import { ArrowUp, ArrowDown, Equal, BadgeCheck } from 'lucide-react';
import {
  EVENT_META, CATEGORY_META, CATEGORY_ACCENTS, BTC_ACCENT, KIND_EMOJI, CONTEXT_EMOJI, resultRows, brtDayDiff, relativeDayLabel, formatEventClock, formatAge,
} from '@/lib/marketContextBand';
import { reactionNote } from '@/lib/reactionStats';
import { HORIZONS_MIN, horizonLabel, formatMove } from '@/lib/btcAfterRelease';
import {
  compareBars, deltaText, resultSummary, summaryText, altWindowText, gapExplanation, sparkGeometry, markerAt, horizonStatus, sizeFraction, maxAbsMove, gaugeBars, seriesExtremes,
} from '@/lib/resultVisual';

// Cartão de RESULTADO da Agenda (Contexto de Mercado, addendum 20 do item 285 — redesenho de 10/11/2026, a pedido do usuário: "muito simples, cores
// sem vida, tudo encostado num canto"). Só informação: não toca sinal, stop, alvo, score nem operação.
// Regras do desenho (pesquisa de painéis de calendário econômico e de KPI): (1) uma FRASE simples diz o que aconteceu; (2) o número anterior e o atual
// ficam lado a lado, com a janela de comparação explícita; (3) a COR identifica o PAPEL do número (tipo da notícia, anterior, BTC), nunca "bom" ou
// "ruim" — sem a expectativa dos analistas não existe "acima/abaixo do esperado"; a direção vai por seta + palavra, não só por cor; (4) o estado
// "ainda não saiu" e "não deu para calcular" têm cara própria, para nunca parecer dado faltando; (5) os emojis saem da tabela de
// `src/lib/marketContextBand.js` (1 emoji = 1 significado) e são só decoração: o texto ao lado carrega o sentido.

// As cores por TIPO de notícia e a do BTC moram na lib (fonte única, travada por teste): `CATEGORY_ACCENTS` e `BTC_ACCENT`.
const ACCENTS = CATEGORY_ACCENTS;
const BTC = BTC_ACCENT;
const PREVIOUS = '#94a3b8'; // cinza-azulado: o número de ANTES
const OK = '#6ee7b7'; // verde só no selo "Resultado oficial" (estado do dado, não "bom")

/** '#c084fc' + 0.3 → 'rgba(192, 132, 252, 0.3)'. */
function alpha(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/** Emoji de decoração: escondido do leitor de tela (o texto ao lado diz o mesmo). */
function Emoji({ children, className = '' }) {
  return <span aria-hidden="true" className={`select-none ${className}`}>{children}</span>;
}

/** "Saiu hoje às 10:30" (ou "ontem"). */
function releasedWhen(e, now) {
  const day = relativeDayLabel(brtDayDiff(e.startMs, now)).toLowerCase();
  return `Saiu ${day} às ${formatEventClock(e.startsAtUtc)}`;
}

/** Barra horizontal numa trilha com zero marcado (só aparece quando há valor negativo). `geo` = { left, width } em % da trilha. */
function Bar({ label, geo, zero = 0, background }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-16 shrink-0 text-10px font-mono text-muted-foreground">{label}</span>
      <div className="relative h-2.5 flex-1 rounded-full" style={{ background: 'rgba(255,255,255,0.07)' }}>
        {geo && geo.width > 0 && (
          <span className="absolute top-0 bottom-0 rounded-full" style={{ left: `${geo.left}%`, width: `${geo.width}%`, background }} />
        )}
        {zero > 0 && <span className="absolute -top-0.5 -bottom-0.5 w-px" style={{ left: `${zero}%`, background: 'rgba(255,255,255,0.4)' }} />}
      </div>
    </div>
  );
}

const DIRECTION = {
  acima: { Icon: ArrowUp, text: 'acima do anterior' },
  abaixo: { Icon: ArrowDown, text: 'abaixo do anterior' },
  igual: { Icon: Equal, text: 'igual ao anterior' },
};

/** Selo do estado do dado: oficial (verde, estado do DADO, não do número) ou aguardando (pulsa). */
function StatusPill({ official }) {
  if (official) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-11px font-mono font-bold uppercase tracking-wider"
        style={{ background: 'linear-gradient(90deg, rgba(52,211,153,0.22), rgba(34,211,238,0.16))', border: '1px solid rgba(52,211,153,0.5)', color: OK }}>
        <BadgeCheck className="w-3.5 h-3.5" aria-hidden="true" />
        Resultado oficial
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-11px font-mono font-bold uppercase tracking-wider"
      style={{ background: 'rgba(148,163,184,0.12)', border: '1px solid rgba(148,163,184,0.35)', color: '#cbd5e1' }}>
      <span className="w-1.5 h-1.5 rounded-full animate-pulse motion-reduce:animate-none" style={{ background: '#cbd5e1' }} aria-hidden="true" />
      <Emoji>{CONTEXT_EMOJI.waiting}</Emoji>
      Aguardando o número
    </span>
  );
}

/** A frase simples do topo: o que aconteceu, em palavras, medida por medida. Neutra: compara com a divulgação anterior, nunca diz "bom" ou "ruim". */
function Summary({ rows, official, accent }) {
  const items = resultSummary(rows, official);
  if (items.length === 0) return null;
  const hot = { color: accent.from };
  return (
    <div role="group" aria-label="Resumo do resultado" className="rounded-xl px-4 py-3 space-y-1.5"
      style={{ background: 'rgba(0,0,0,0.25)', border: '1px solid rgba(255,255,255,0.08)' }}>
      {items.map((it) => (
        <p key={it.key} className="text-sm sm:text-base leading-snug text-foreground/90">
          {it.kind === 'wait' && (
            <><Emoji className="mr-1.5">{CONTEXT_EMOJI.waiting}</Emoji>O BLS ainda não publicou o número deste mês. Quando sair, ele aparece aqui.</>
          )}
          {it.kind === 'unavailable' && (
            <><Emoji className="mr-1.5">{CONTEXT_EMOJI.unavailable}</Emoji><strong>{it.label}:</strong> indisponível desta vez, não deu para calcular com os dados do BLS.</>
          )}
          {it.kind === 'gap' && (
            <><Emoji className="mr-1.5">{CONTEXT_EMOJI.unavailable}</Emoji><strong>{it.label}:</strong> sem número oficial neste mês. {summaryText(it).split('neste mês. ')[1]}</>
          )}
          {it.kind === 'alone' && (
            <><strong>{it.label}:</strong> <span className="font-extrabold" style={hot}>{it.actual}</span>.</>
          )}
          {it.kind === 'compare' && (
            <>
              <strong>{it.label}:</strong> <span className="font-extrabold" style={hot}>{it.actual}</span>
              {it.word === 'igual' ? ', igual ao da divulgação anterior ' : <>, <strong>{it.word}</strong> dos {it.previous} da divulgação anterior</>}
              {it.word === 'igual' && `(${it.previous})`}.
            </>
          )}
          {it.revised && <span className="text-muted-foreground"> O anterior foi revisado para {it.revised}.</span>}
        </p>
      ))}
    </div>
  );
}

/**
 * A "janela alternativa" (addendum 22): quando o BLS nunca publicou o mês-base do "em 12 meses", a variação de um período MAIS CURTO, só com índices publicados.
 * Rótulo e borda tracejada dizem que NÃO é o número oficial (o mesmo "tracejado" do estado "sem número"); sem seta de acima/abaixo e sem comparação:
 * os períodos são diferentes, comparar enganaria. Nunca é estimativa.
 */
function AltWindow({ alt, accent }) {
  const t = altWindowText(alt);
  if (!t) return null;
  return (
    <div role="group" aria-label="Janela alternativa" className="rounded-xl p-3 space-y-2"
      style={{ background: 'rgba(255,255,255,0.05)', border: `1px dashed ${alpha(accent.from, 0.5)}` }}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <span className="text-10px font-mono font-bold uppercase tracking-wider" style={{ color: accent.from }}>
          <Emoji className="mr-1">{CONTEXT_EMOJI.window}</Emoji>Janela alternativa · {t.title}
        </span>
        <span className="text-10px font-mono text-muted-foreground">não é o número oficial em 12 meses</span>
      </div>
      <div className="flex flex-wrap items-end gap-x-4 gap-y-1">
        <span className="text-3xl sm:text-4xl font-black font-mono tabular-nums leading-none"
          style={{ color: accent.from, backgroundImage: `linear-gradient(135deg, ${accent.from}, ${accent.to})`, WebkitBackgroundClip: 'text', backgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
          {alt.pct}
        </span>
        <span className="text-11px leading-snug text-muted-foreground min-w-0 flex-1 basis-40">{t.body}</span>
      </div>
    </div>
  );
}

/** A caixa "Por que não há número em 12 meses?": largura toda, embaixo do par de colunas (não alonga a coluna das fichas). Só informação; nada estimado. */
function GapNote({ row }) {
  return (
    <aside aria-label="Por que não há número em 12 meses" className="rounded-xl px-4 py-3 space-y-1.5"
      style={{ background: 'rgba(148,163,184,0.10)', border: '1px dashed rgba(148,163,184,0.45)' }}>
      <h4 className="text-10px font-mono font-bold uppercase tracking-wider text-muted-foreground">
        <Emoji className="mr-1.5 text-base">{CONTEXT_EMOJI.unavailable}</Emoji>Por que não há número em 12 meses?
      </h4>
      <p className="text-sm leading-relaxed text-foreground/90">{gapExplanation(row).join(' ')}</p>
    </aside>
  );
}

/** Uma medida (no mês, em 12 meses, vagas): Anterior → Atual lado a lado, barras na mesma escala, direção em palavras e a diferença. */
function MeasureTile({ r, official, accent }) {
  const hasActual = r.actual !== null;
  const unavailable = official && !hasActual;
  const bars = hasActual ? compareBars(r.previous, r.actual) : null;
  const dir = DIRECTION[r.direction];
  const diff = hasActual ? deltaText(r.previous, r.actual) : null;
  return (
    <section aria-label={r.label} className="relative overflow-hidden rounded-2xl p-4 space-y-3.5 flex-auto"
      style={{ background: 'rgba(255,255,255,0.045)', border: `1px solid ${alpha(accent.from, 0.3)}` }}>
      <span className="absolute inset-x-0 top-0 h-1" style={{ background: `linear-gradient(90deg, ${accent.from}, ${accent.to})` }} aria-hidden="true" />
      <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 pt-1">
        <h4 className="text-xs font-mono font-bold uppercase tracking-wider" style={{ color: accent.from }}>{r.label}</h4>
        <span className="text-10px font-mono text-muted-foreground">compara com a divulgação anterior</span>
      </header>
      <dl className="flex flex-wrap items-end gap-x-8 gap-y-3">
        <div className="space-y-1 min-w-0">
          <dt className="text-10px font-mono uppercase tracking-wider text-muted-foreground">Anterior</dt>
          <dd className="text-2xl sm:text-3xl font-bold font-mono tabular-nums leading-none" style={{ color: PREVIOUS }}>{r.previous ?? '—'}</dd>
        </div>
        <div className="space-y-1 min-w-0">
          <dt className="text-10px font-mono uppercase tracking-wider text-muted-foreground">Atual</dt>
          <dd>
            {hasActual && (
              <span className="text-4xl sm:text-5xl font-black font-mono tabular-nums leading-none"
                style={{ color: accent.from, backgroundImage: `linear-gradient(135deg, ${accent.from}, ${accent.to})`, WebkitBackgroundClip: 'text', backgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
                {r.actual}
              </span>
            )}
            {unavailable && (
              <span className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-mono font-bold text-muted-foreground"
                style={{ border: '1px dashed rgba(148,163,184,0.5)', background: 'repeating-linear-gradient(135deg, rgba(148,163,184,0.10) 0 6px, transparent 6px 12px)' }}>
                <Emoji className="text-base">{CONTEXT_EMOJI.unavailable}</Emoji>
                {r.gap ? 'sem número oficial' : 'indisponível'}
              </span>
            )}
            {!official && (
              <span className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-mono text-muted-foreground animate-pulse motion-reduce:animate-none"
                style={{ border: '1px dashed rgba(148,163,184,0.5)', background: 'rgba(148,163,184,0.07)' }}>
                <Emoji className="text-base">{CONTEXT_EMOJI.waiting}</Emoji>
                aguardando
              </span>
            )}
          </dd>
        </div>
      </dl>
      {unavailable && r.gap && r.alt && <AltWindow alt={r.alt} accent={accent} />}
      {r.revised && (
        <p className="text-10px font-mono text-muted-foreground">Anterior revisado para <span className="font-bold text-foreground">{r.revised}</span>.</p>
      )}
      {bars && (
        <div aria-hidden="true" className="space-y-1.5">
          <Bar label="anterior" geo={bars.previous} zero={bars.zero} background={PREVIOUS} />
          <Bar label="atual" geo={bars.actual} zero={bars.zero} background={`linear-gradient(90deg, ${accent.from}, ${accent.to})`} />
        </div>
      )}
      {(dir || diff) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          {dir && (
            <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-mono font-bold"
              style={{ background: alpha(accent.from, 0.16), border: `1px solid ${alpha(accent.from, 0.45)}`, color: accent.from }}>
              <dir.Icon className="w-3.5 h-3.5" aria-hidden="true" />
              {dir.text}
            </span>
          )}
          {diff && <span className="text-11px font-mono text-muted-foreground">{diff}</span>}
        </div>
      )}
    </section>
  );
}

/** O minigráfico "BTC desde a divulgação": a linha cresce com o tempo (eixo fixo de 0 a 60 min), zero tracejado no meio, marcadores em 5, 30 e 60 min. */
function Spark({ geo }) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const xAt = (m) => geo.pad + (m / 60) * (geo.width - geo.pad * 2);
  const down = geo.points[geo.points.length - 1].pct < 0;
  return (
    <svg viewBox={`0 0 ${geo.width} ${geo.height + 12}`} role="img" aria-label="Variação do BTC minuto a minuto desde a divulgação, em porcentagem"
      className="w-full h-auto" style={{ overflow: 'visible' }}>
      <defs>
        {/* O preenchimento é mais forte junto da LINHA do BTC e some perto do zero (sem virar um bloco): cai = opaco embaixo, subiu = opaco em cima. */}
        <linearGradient id={`${uid}-area`} x1="0" y1={down ? 1 : 0} x2="0" y2={down ? 0 : 1}>
          <stop offset="0%" stopColor={BTC.from} stopOpacity="0.34" />
          <stop offset="100%" stopColor={BTC.from} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <line x1={geo.pad} x2={geo.width - geo.pad} y1={geo.zeroY} y2={geo.zeroY} stroke="rgba(255,255,255,0.3)" strokeDasharray="3 4" />
      <path d={geo.area} fill={`url(#${uid}-area)`} />
      <path d={geo.line} fill="none" stroke={BTC.from} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
      {HORIZONS_MIN.map((n) => {
        const p = markerAt(geo, n);
        return p && <circle key={n} cx={p.x} cy={p.y} r="4.5" fill="#0b1220" stroke={BTC.from} strokeWidth="2.5" />;
      })}
      {HORIZONS_MIN.map((n) => (
        <text key={n} x={xAt(n)} y={geo.height + 6} textAnchor={n === 60 ? 'end' : 'middle'} fontSize="9" fontFamily="monospace" fill="rgba(148,163,184,0.95)">
          {n === 60 ? '1 h' : `${n} min`}
        </text>
      ))}
    </svg>
  );
}

/** O horizonte de 5 min, 30 min ou 1 h ainda não fechou? (o painel do BTC se atualiza a cada minuto enquanto isso). */
const btcPending = (e, now) => HORIZONS_MIN.some((n) => !horizonStatus(n, e.startMs, now).closed);

/** O título do painel do BTC, FORA da caixa (alinhado ao título "O número" da coluna ao lado), com o aviso de que ainda atualiza. */
function BtcHeading({ e, now, className = '' }) {
  return (
    <div className={`flex flex-wrap items-center justify-between gap-x-3 gap-y-1 ${className}`}>
      <h4 className="flex items-center gap-2 text-xs font-mono font-bold uppercase tracking-wider" style={{ color: BTC.from }}>
        <Emoji className="text-base">{CONTEXT_EMOJI.btc}</Emoji>
        O BTC depois da divulgação
      </h4>
      {btcPending(e, now) && (
        <span className="inline-flex items-center gap-1.5 text-10px font-mono" style={{ color: BTC.from }}>
          <span className="w-1.5 h-1.5 rounded-full animate-pulse motion-reduce:animate-none" style={{ background: BTC.from }} aria-hidden="true" />
          atualiza a cada minuto
        </span>
      )}
    </div>
  );
}

/**
 * "O BTC depois da divulgação": quanto o preço do BTC andou nos 5 min, 30 min e 1 h seguintes, medido nas velas de 1 minuto. O que aconteceu, com
 * sinal mas sem cor de "bom/ruim", e sem afirmar que a divulgação causou o movimento. A barrinha mostra o TAMANHO do movimento (sem direção); o
 * horizonte que ainda não fechou aparece pontilhado, com quanto falta.
 */
function BtcPanel({ e, now, btc, className = '' }) {
  const moves = btc.moves;
  const geo = sparkGeometry(btc.series);
  const maxAbs = maxAbsMove(moves);
  const ext = seriesExtremes(btc.series);
  return (
    <aside aria-label="O BTC depois da divulgação" className={`relative overflow-hidden rounded-2xl p-4 flex flex-col gap-3.5 ${className}`}
      style={{ background: 'linear-gradient(165deg, rgba(34,211,238,0.14), rgba(255,255,255,0.02) 58%)', border: '1px solid rgba(34,211,238,0.32)' }}>
      {/* O minigráfico fica com a altura que sobrar (centralizado): quando a coluna ao lado é mais alta, o vão é um só, em volta do desenho, e não três espalhados. */}
      {geo && <div className="flex-1 flex items-center"><div className="w-full"><Spark geo={geo} /></div></div>}
      <ol className="grid grid-cols-3 gap-1.5 sm:gap-2">
        {HORIZONS_MIN.map((n) => {
          const st = horizonStatus(n, e.startMs, now);
          const v = moves[n];
          const has = Number.isFinite(v);
          return (
            <li key={n} className="rounded-xl p-2 sm:p-2.5 space-y-1.5"
              style={has
                ? { background: 'rgba(34,211,238,0.09)', border: '1px solid rgba(34,211,238,0.34)' }
                : { background: 'rgba(255,255,255,0.02)', border: '1px dashed rgba(255,255,255,0.2)' }}>
              <p className="text-10px font-mono text-muted-foreground whitespace-nowrap">
                <Emoji className="mr-1">{CONTEXT_EMOJI.horizon}</Emoji>Em {horizonLabel(n)}
              </p>
              <p className="text-lg sm:text-2xl font-black font-mono tabular-nums leading-none" style={{ color: has ? '#f8fafc' : 'rgba(248,250,252,0.35)' }}>
                {formatMove(v)}
              </p>
              {has ? (
                <div aria-hidden="true" className="h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.1)' }}>
                  <div className="h-full rounded-full" style={{ width: `${Math.max(4, Math.round(sizeFraction(v, maxAbs) * 100))}%`, background: `linear-gradient(90deg, ${BTC.from}, ${BTC.to})` }} />
                </div>
              ) : (
                <>
                  <div aria-hidden="true" className="h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.08)' }}>
                    <div className="h-full rounded-full" style={{ width: `${Math.round(st.fraction * 100)}%`, background: 'rgba(148,163,184,0.7)' }} />
                  </div>
                  <p className="text-10px font-mono text-muted-foreground whitespace-nowrap">{st.closed ? 'sem vela' : `faltam ${st.remainingMin} min`}</p>
                </>
              )}
            </li>
          );
        })}
      </ol>
      {ext && (
        <dl className="flex flex-wrap gap-x-5 gap-y-1 text-11px font-mono tabular-nums">
          <div className="flex items-baseline gap-1.5">
            <dt className="text-muted-foreground">Mínimo</dt>
            <dd className="font-bold text-foreground">{formatMove(ext.min.pct)} <span className="font-normal text-muted-foreground">aos {ext.min.m} min</span></dd>
          </div>
          <div className="flex items-baseline gap-1.5">
            <dt className="text-muted-foreground">Máximo</dt>
            <dd className="font-bold text-foreground">{formatMove(ext.max.pct)} <span className="font-normal text-muted-foreground">aos {ext.max.m} min</span></dd>
          </div>
        </dl>
      )}
      <p className="text-10px font-mono text-muted-foreground leading-relaxed">
        Velas de 1 minuto do BTC na Binance. Mostra o que aconteceu depois; não prova que a divulgação causou o movimento.
      </p>
    </aside>
  );
}

/**
 * Cartão de RESULTADO: evento do BLS que acabou de sair (até 24 h). Cabeçalho com o tipo da notícia, a frase do resultado, uma ficha por medida
 * (Anterior × Atual) e, ao lado, o BTC depois da divulgação. Sem o "Atual" ainda: o estado "aguardando"; medida que saiu sem número:
 * "indisponível" (nunca "aguardando", que seria falso). Não prevê nada: compara com a divulgação anterior, não com a expectativa do mercado.
 * @param {{ e: object, now: number, checkedAtMs: number|null, btc?: { moves: Record<number, number|null>, series: {m:number,pct:number}[] } }} props
 */
export function ResultCard({ e, now, checkedAtMs, btc }) {
  const meta = EVENT_META[e.kind];
  const accent = ACCENTS[meta.category];
  const rows = resultRows(e.values, e.reference ?? null);
  const gapRow = rows.find((r) => r.gap && r.actual === null) ?? null;
  const official = rows.some((r) => r.actual !== null);
  const partial = official && rows.some((r) => r.actual === null);
  const age = formatAge(checkedAtMs, now);
  const hasBtc = Boolean(btc?.moves) && Object.values(btc.moves).some((v) => Number.isFinite(v));
  return (
    <article aria-label="Resultado" className="relative overflow-hidden rounded-2xl p-4 sm:p-5"
      style={{
        background: `linear-gradient(135deg, ${alpha(accent.from, 0.16)} 0%, rgba(255,255,255,0.035) 42%, rgba(255,255,255,0.02) 100%)`,
        border: `1px solid ${alpha(accent.from, 0.4)}`,
        boxShadow: `0 14px 44px -22px ${alpha(accent.from, 0.8)}`,
      }}>
      <span aria-hidden="true" className="pointer-events-none absolute -right-20 -top-28 h-80 w-80 rounded-full opacity-60 blur-3xl"
        style={{ background: alpha(accent.from, 0.32) }} />
      <div className="relative space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
          <div className="flex items-start gap-3.5 min-w-0 flex-1 basis-64">
            <span aria-hidden="true" className="w-14 h-14 sm:w-16 sm:h-16 shrink-0 rounded-2xl p-0.5 select-none"
              style={{ background: `linear-gradient(135deg, ${accent.from}, ${accent.to})`, boxShadow: `0 10px 28px -10px ${accent.from}` }}>
              <span className="w-full h-full rounded-[0.9rem] flex items-center justify-center text-3xl sm:text-4xl" style={{ background: '#0f1522' }}>
                {KIND_EMOJI[e.kind]}
              </span>
            </span>
            <div className="min-w-0 space-y-1">
              <span className="text-10px font-mono font-bold uppercase tracking-wider" style={{ color: accent.from }}>{CATEGORY_META[meta.category].label}</span>
              <h3 className="text-lg sm:text-2xl font-extrabold text-foreground leading-tight tracking-tight">
                {meta.title}
                <span className="ml-2 text-xs font-mono font-normal text-muted-foreground">({meta.short})</span>
              </h3>
              <p className="text-11px font-mono text-muted-foreground">
                <Emoji className="mr-1">{CONTEXT_EMOJI.released}</Emoji>
                <time dateTime={e.startsAtUtc} className="text-foreground">{releasedWhen(e, now)}</time>
                {' · '}{formatAge(e.startMs, now)}
              </p>
            </div>
          </div>
          <StatusPill official={official} />
        </div>

        <Summary rows={rows} official={official} accent={accent} />

        {/* Com o painel do BTC ao lado, as DUAS colunas têm título e caixa na mesma linha (grade com 2 linhas) e a mesma altura: o título do BTC saiu de dentro da
            caixa para a caixa começar na altura da 1ª ficha; as fichas dividem a altura que sobrar. No celular tudo empilha (título, caixa, título, caixa). */}
        <div className={hasBtc ? 'grid gap-x-4 gap-y-3 lg:grid-cols-12' : 'grid gap-3'}>
          <section aria-label="O número" className={hasBtc ? 'flex flex-col gap-3 lg:contents' : 'flex flex-col gap-3'}>
            <h4 className={`flex items-center gap-2 text-xs font-mono font-bold uppercase tracking-wider text-foreground ${hasBtc ? 'lg:col-span-7 lg:col-start-1 lg:row-start-1' : ''}`}>
              <Emoji className="text-base">{CONTEXT_EMOJI.compare}</Emoji>
              O número: anterior e atual
            </h4>
            {/* Com o painel do BTC ao lado a coluna é estreita: as fichas empilham (cada uma com a largura toda). Sem ele, lado a lado. */}
            <div className={hasBtc
              ? 'flex flex-col gap-3 lg:col-span-7 lg:col-start-1 lg:row-start-2'
              : (rows.length > 1 ? 'grid gap-3 sm:grid-cols-2' : 'grid gap-3')}>
              {rows.map((r) => <MeasureTile key={r.key} r={r} official={official} accent={accent} />)}
            </div>
          </section>
          {hasBtc && (
            <div className="flex flex-col gap-3 lg:contents">
              <BtcHeading e={e} now={now} className="lg:col-span-5 lg:col-start-8 lg:row-start-1" />
              <BtcPanel e={e} now={now} btc={btc} className="lg:col-span-5 lg:col-start-8 lg:row-start-2" />
            </div>
          )}
        </div>

        {gapRow && <GapNote row={gapRow} />}

        <footer className="pt-3 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1" style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>
          <p className="text-10px font-mono text-muted-foreground leading-relaxed min-w-0 flex-1 basis-80">
            <Emoji className="mr-1">{CONTEXT_EMOJI.howto}</Emoji>
            Como ler:{' '}
            {official
              ? `compara com o mês anterior, não com a expectativa do mercado (que este painel não tem).${partial ? (gapRow ? ' Sem número oficial: o BLS não publicou o índice usado na comparação.' : ' Indisponível: não deu para calcular com os dados do BLS.') : ''}`
              : `o número entra na próxima coleta${age ? ` (última checagem ${age})` : ''}.`}
          </p>
          {e.values?.source && <p className="text-10px font-mono text-muted-foreground whitespace-nowrap">Fonte: {e.values.source}</p>}
        </footer>
      </div>
    </article>
  );
}

/** Uma ficha "nas divulgações × num dia normal": o número grande, a razão em palavras e duas barras na MESMA escala. */
function Gauge({ label, m, accent, showTimes = false }) {
  const bars = gaugeBars(m.value, m.normal);
  return (
    <div className="rounded-xl p-3.5 space-y-2.5" style={{ background: 'rgba(255,255,255,0.045)', border: '1px solid rgba(255,255,255,0.1)' }}>
      <p className="text-10px font-mono uppercase tracking-wider text-muted-foreground">
        <Emoji className="mr-1">{CONTEXT_EMOJI.horizon}</Emoji>{label}
      </p>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-3xl sm:text-4xl font-black font-mono tabular-nums leading-none"
          style={{ color: accent.from, backgroundImage: `linear-gradient(135deg, ${accent.from}, ${accent.to})`, WebkitBackgroundClip: 'text', backgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
          {m.value}
        </span>
        {showTimes && m.times && (
          <span className="rounded-md px-2 py-0.5 text-11px font-mono font-bold" style={{ background: alpha(accent.from, 0.18), color: accent.from }}>
            {m.times} mais que num dia normal
          </span>
        )}
      </div>
      {bars && (
        <div aria-hidden="true" className="space-y-1.5">
          <Bar label="divulgações" geo={{ left: 0, width: bars.value * 100 }} background={`linear-gradient(90deg, ${accent.from}, ${accent.to})`} />
          <Bar label="dia normal" geo={{ left: 0, width: bars.normal * 100 }} background={PREVIOUS} />
        </div>
      )}
      <p className="text-10px font-mono text-muted-foreground">dia normal: {m.normal}</p>
    </div>
  );
}

/**
 * "Como o BTC se mexeu nas últimas divulgações" (Agenda 4d, addendum 18): o TAMANHO do movimento do BTC na 1ª hora e nos 5 primeiros minutos das
 * divulgações passadas do mesmo tipo, contra o mesmo horário num dia normal. Medido, não previsto: sempre com o número de casos e a data da medição,
 * sem sinal de alta/baixa, sem verde/vermelho e sem previsão. Só aparece para o tipo que tem medição (CPI, Payroll, PPI e PCE).
 */
export function ReactionPanel({ kind }) {
  const n = reactionNote(kind);
  if (!n) return null;
  const accent = ACCENTS[EVENT_META[kind].category];
  const strong = n.verdict === 'maior';
  return (
    <aside aria-label="Como o BTC se mexeu nas últimas divulgações" className="relative overflow-hidden rounded-2xl p-4 sm:p-5 space-y-4"
      style={{ background: `linear-gradient(135deg, ${alpha(accent.from, 0.13)}, rgba(255,255,255,0.025) 58%)`, border: `1px solid ${alpha(accent.from, 0.32)}` }}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <h4 className="flex items-center gap-2 text-xs font-mono font-bold uppercase tracking-wider text-foreground">
          <Emoji className="text-base">{CONTEXT_EMOJI.gauge}</Emoji>
          Como o BTC se mexeu nas últimas divulgações
        </h4>
        <span className="inline-flex items-center rounded-full px-3 py-1 text-11px font-mono font-bold"
          style={strong
            ? { background: `linear-gradient(90deg, ${accent.from}, ${accent.to})`, color: '#0b1220' }
            : { background: 'rgba(148,163,184,0.14)', border: '1px solid rgba(148,163,184,0.4)', color: '#cbd5e1' }}>
          {n.chip}
        </span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Gauge label="Na 1ª hora (mediana)" m={n.hour} accent={accent} showTimes />
        <Gauge label="Nos 5 primeiros minutos" m={n.first5} accent={accent} />
      </div>
      <p className="text-10px font-mono text-muted-foreground leading-relaxed">
        {n.cases} · medido em {n.measuredAt}. Tamanho do movimento, sem direção: um retrato do passado, que não indica para onde o BTC vai.
        O mercado reage ao que surpreende, e este painel não tem a expectativa.
      </p>
    </aside>
  );
}
