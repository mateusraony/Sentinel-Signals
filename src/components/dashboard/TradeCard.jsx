import React, { useState, useEffect } from 'react';
import moment from 'moment';
import { Clock, TrendingUp, TrendingDown, ChevronDown, ChevronUp, History } from 'lucide-react';
import { formatBackfillLag } from '@/lib/backfillDetection';
import {
  formatPrice, formatSignedPct, describeProximity, rrGeometry, nextMilestone,
  stopPosture, orderLevelsByRail,
} from '@/lib/priceProximity';
import { useLivePrice } from '@/hooks/useLivePrice';

/**
 * Card de operação — reestruturado em 2026-09-04 (docs/known-risks.md item 154).
 *
 * Regra de ouro do layout: o QUE ESTÁ ACONTECENDO cabe num olhar; o PORQUÊ
 * fica a um clique. A versão anterior empilhava ~12 blocos por card (e
 * mostrava os quatro níveis DUAS vezes, uma no PriceGrid e outra no painel de
 * preço ao vivo) — bem acima das 5–9 unidades de informação que um painel
 * suporta antes de a compreensão cair. Ver o registro da pesquisa no item 154.
 *
 * Continua sendo um componente de APRESENTAÇÃO: lê a operação, lê o preço de
 * mercado e desenha. Não muta nada — as ações (Editar/Invalidar/Encerrar)
 * chegam por `actions`, e quem tem as mutações é src/pages/Trades.jsx, que
 * passa pela CAS transacional do motor.
 */

// Só uma operação viva tem "resultado em aberto" e "próximo marco" — em
// operação encerrada esses dois blocos seriam mentira.
const OPEN_STATUSES = new Set(['SIGNAL_CONFIRMED', 'RUNNER_ACTIVE']);

const STATUS_CONFIG = {
  SIGNAL_CONFIRMED: {
    label: 'Entrada confirmada', short: 'Ativa',
    desc: 'Aguardando preço atingir TP1',
    color: '#00ff80', bg: 'rgba(0,255,128,0.08)', border: 'rgba(0,255,128,0.28)',
  },
  RUNNER_ACTIVE: {
    label: 'Runner ativo', short: 'Runner',
    desc: 'TP1 atingido — trailing stop ativo',
    color: '#ffd166', bg: 'rgba(255,209,102,0.08)', border: 'rgba(255,209,102,0.28)',
  },
  TP2_HIT: {
    label: 'TP2 atingido', short: 'TP2',
    desc: 'Operação encerrada com lucro máximo',
    color: '#00ff80', bg: 'rgba(0,255,128,0.1)', border: 'rgba(0,255,128,0.4)',
  },
  STOP_HIT: {
    label: 'Stop atingido', short: 'Stop',
    desc: 'Operação encerrada por stop',
    color: '#ff1478', bg: 'rgba(255,20,120,0.08)', border: 'rgba(255,20,120,0.28)',
  },
  INVALIDATED: {
    label: 'Invalidado', short: 'Inválido',
    desc: 'Condição técnica deixou de existir',
    color: '#ff9f43', bg: 'rgba(255,159,67,0.08)', border: 'rgba(255,159,67,0.28)',
  },
  CLOSED: {
    label: 'Encerrado', short: 'Fechado',
    desc: 'Encerrado manualmente',
    color: '#64748b', bg: 'rgba(100,116,139,0.08)', border: 'rgba(100,116,139,0.2)',
  },
};

const DATA_STATUS = {
  LIVE:    { label: '🔴 LIVE',    color: '#00ff80' },
  STALE:   { label: '⚠️ STALE',  color: '#ff9f43' },
  OFFLINE: { label: '⛔ OFFLINE', color: '#ff1478' },
  ERROR:   { label: '❌ ERROR',   color: '#ff1478' },
};

// Uma cor = um significado. Estrutura fica neutra de propósito: o card antigo
// pintava tudo de neon, e quando tudo grita nada chama atenção.
const LEVEL_COLOR = {
  stop: '#ff1478',
  stopBe: '#ffd166',
  entry: 'rgba(255,255,255,0.75)',
  tp1: '#ffd166',
  tp2: '#00ff80',
};

// A postura do stop vem da comparação stop × entrada — nunca de `tp1_hit`.
// Depois do TP1 o trailing continua avançando (scanner.js:advanceTrailingStop),
// então um runner antigo pode ter o stop bem além da entrada: chamar isso de
// "breakeven" esconderia lucro já garantido.
const STOP_POSTURE_LABEL = { risk: 'Stop', breakeven: 'Stop (BE)', locked: 'Stop 🔒' };
const STOP_POSTURE_COLOR = { risk: LEVEL_COLOR.stop, breakeven: LEVEL_COLOR.stopBe, locked: '#00ff80' };

function levelColor(key, op) {
  if (key === 'stop') return STOP_POSTURE_COLOR[stopPosture(op)] ?? LEVEL_COLOR.stop;
  if (key === 'tp1') return op.tp1_hit ? '#00ff80' : LEVEL_COLOR.tp1;
  if (key === 'tp2') return op.tp2_hit ? '#00ff80' : LEVEL_COLOR.tp2;
  return LEVEL_COLOR.entry;
}

function levelLabel(key, op) {
  if (key === 'stop') return STOP_POSTURE_LABEL[stopPosture(op)] ?? 'Stop';
  if (key === 'entry') return 'Entrada';
  if (key === 'tp1') return op.tp1_hit ? 'TP1 ✓' : 'TP1';
  return op.tp2_hit ? 'TP2 ✓' : 'TP2';
}

function fmtBRT(iso) {
  if (!iso) return '—';
  return moment(iso).utcOffset(-3).format('DD/MM HH:mm');
}

/* ─────────────────────────── Camada 1 — o olhar ─────────────────────────── */

/**
 * Trilha stop → entrada → TP2, com o preço marcado por uma agulha.
 *
 * Substitui a antiga grade de 4 preços E a barra risco/retorno separada —
 * eram duas representações dos MESMOS quatro números no mesmo card. Aqui a
 * posição conta a história e os números ficam logo abaixo, uma vez só.
 */
function LevelRail({ op, price, isStale }) {
  const geo = rrGeometry(op, price);
  const { levels } = describeProximity(op, price);
  if (levels.length === 0) return null;

  const needleColor = isStale ? '#ff9f43' : '#00e5ff';
  const span = (a, b) => ({ left: `${Math.min(a, b)}%`, width: `${Math.abs(b - a)}%` });

  return (
    <div className="space-y-1.5">
      {geo && (
        <div
          className="relative h-1.5 w-full rounded-full"
          role="img"
          aria-label={`Trilha da operação. Stop $${formatPrice(op.current_stop)}, entrada $${formatPrice(op.entry_price)}, TP1 $${formatPrice(op.tp1)}, TP2 $${formatPrice(op.tp2)}.${price !== null ? ` Preço atual $${formatPrice(price)}.` : ''}`}
          style={{ background: 'rgba(255,255,255,0.07)' }}>
          {/* zona de risco (stop ↔ entrada) e zona de lucro (entrada ↔ TP2) */}
          <div className="absolute h-full rounded-full"
            style={{ ...span(geo.positions.stop, geo.positions.entry), background: 'rgba(255,20,120,0.35)' }} />
          <div className="absolute h-full rounded-full"
            style={{ ...span(geo.positions.entry, geo.positions.tp2), background: 'rgba(0,255,128,0.32)' }} />
          {/* marca do TP1 dentro da zona de lucro */}
          <div className="absolute top-0 bottom-0 w-px"
            style={{ left: `${geo.positions.tp1}%`, background: 'rgba(255,209,102,0.9)', transform: 'translateX(-50%)' }} />
          {/* entrada — referência de origem do resultado */}
          <div className="absolute -top-0.5 -bottom-0.5 w-px"
            style={{ left: `${geo.positions.entry}%`, background: 'rgba(255,255,255,0.8)', transform: 'translateX(-50%)' }} />
          {/* agulha do preço */}
          {geo.currentPct !== null && (
            <div className="absolute -top-1.5 -bottom-1.5 rounded-full"
              title={geo.currentOutOfRange
                ? 'Preço fora do intervalo stop–TP2 (agulha presa na borda)'
                : (isStale ? 'Última cotação recebida' : 'Preço agora')}
              style={{
                left: `${geo.currentPct}%`,
                width: 3,
                background: needleColor,
                boxShadow: `0 0 6px ${needleColor}`,
                transform: 'translateX(-50%)',
                opacity: geo.currentOutOfRange || isStale ? 0.55 : 1,
              }} />
          )}
        </div>
      )}

      <div className="grid grid-cols-4 gap-1">
        {orderLevelsByRail(levels).map((level) => {
          const color = levelColor(level.key, op);
          return (
            <div key={level.key} className="min-w-0"
              title={level.pct === null
                ? undefined
                : `O preço precisa andar ${formatSignedPct(level.pct)} para chegar em ${levelLabel(level.key, op)}.`}>
              <div className="flex items-center gap-1 mb-0.5">
                <span className="w-1 h-1 rounded-full shrink-0" style={{ background: color }} />
                <span className="text-[8px] font-mono uppercase tracking-wide truncate"
                  style={{ color: 'rgba(255,255,255,0.4)' }}>{levelLabel(level.key, op)}</span>
              </div>
              <div className="text-[11px] font-mono font-semibold truncate leading-tight" style={{ color }}>
                {formatPrice(level.price)}
              </div>
              <div className="text-[9px] font-mono truncate leading-tight"
                style={{ color: level.isNearest ? 'rgba(255,255,255,0.6)' : 'rgba(255,255,255,0.3)' }}>
                {level.pct === null
                  ? '—'
                  : `${level.position === 'above' ? '↑' : level.position === 'below' ? '↓' : '='} ${Math.abs(level.pct).toFixed(2)}%`}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** A frase de bater o olho: o que acontece a seguir e quanto falta. */
function MilestoneLine({ op, price, isStale }) {
  const milestone = nextMilestone(op, price);
  if (!milestone) return null;

  const isRisk = milestone.kind === 'risk';
  const posture = stopPosture(op);
  const color = isRisk ? (STOP_POSTURE_COLOR[posture] ?? '#ff1478') : '#00ff80';
  const distance = milestone.absPct.toFixed(2);
  const riskText = posture === 'locked'
    ? 'até o stop, que já protege lucro'
    : posture === 'breakeven'
      ? 'até o stop no breakeven'
      : 'até o stop';

  return (
    <div className="flex items-center gap-1.5 text-[11px] font-mono rounded-lg px-2.5 py-1.5"
      style={{ background: `${color}0f`, border: `1px solid ${color}26` }}>
      <span aria-hidden="true">{isRisk ? (posture === 'locked' ? '🔒' : '🛑') : '🎯'}</span>
      <span style={{ color: 'rgba(255,255,255,0.6)' }}>
        {isRisk ? 'Faltam' : 'Faltam'}
      </span>
      <span className="font-bold" style={{ color }}>{distance}%</span>
      <span style={{ color: 'rgba(255,255,255,0.6)' }}>
        {isRisk ? riskText : `para o ${milestone.label}`}
      </span>
      {isStale && (
        <span className="ml-auto text-[9px] shrink-0" style={{ color: '#ff9f43' }} title="Calculado sobre a última cotação recebida.">
          ⚠️
        </span>
      )}
    </div>
  );
}

/* ──────────────────────── Banners excepcionais (raros) ──────────────────── */

// docs/known-risks.md item 137 — pedido explícito do usuário: deixar claro
// que a entrada real aconteceu no passado e só foi encontrada quando o
// ativo foi adicionado/reativado, não pega ao vivo pelo scan normal.
function BackfillBanner({ op }) {
  if (op.source !== 'backfill') return null;
  const lag = formatBackfillLag(op.backfill_entry_lag_ms);
  return (
    <div className="rounded-lg px-3 py-2 flex items-start gap-2"
      style={{ background: 'rgba(0,229,255,0.06)', border: '1px solid rgba(0,229,255,0.25)' }}>
      <History className="w-3.5 h-3.5 shrink-0 mt-0.5" style={{ color: '#00e5ff' }} />
      <p className="text-[10px] font-mono leading-relaxed" style={{ color: '#00e5ff' }}>
        Detectada retroativamente{lag ? ` — entrada real foi há ${lag}` : ''}. Não foi pega ao vivo: o ativo foi adicionado/reativado depois, e o Sentinel reconstruiu a operação a partir do histórico.
      </p>
    </div>
  );
}

// Pedido do usuário (2026-09-01, conselho de revisão em docs/known-risks.md):
// quando exit_ambiguous é true, o candle fechou tocando stop E TP no mesmo
// intervalo — o motor já decidiu sozinho ("stop vence",
// .claude/rules/trading-engine.md) e a operação já está encerrada quando
// isso é visível aqui. Puramente informativo.
function AmbiguousExitBanner({ op }) {
  if (!op.exit_ambiguous) return null;
  return (
    <div className="rounded-lg px-3 py-2" style={{ background: 'rgba(0,229,255,0.06)', border: '1px solid rgba(0,229,255,0.25)' }}>
      <p className="text-[10px] font-mono leading-relaxed" style={{ color: '#00e5ff' }}>
        ℹ️ Nessa vela, o preço tocou o stop e o take ao mesmo tempo — o gráfico não mostra qual foi primeiro de verdade. Por segurança, o sistema sempre considera que o stop aconteceu primeiro nesses casos raros. Essa operação já foi encerrada com esse resultado.
      </p>
    </div>
  );
}

/* ────────────────────────── Camada 2 — o porquê ─────────────────────────── */

export function ScoreBar({ score }) {
  const pct = Math.max(0, Math.min(100, score || 0));
  const color = pct >= 85 ? '#00ff80' : pct >= 65 ? '#ffd166' : '#ff9f43';
  const label = pct >= 85 ? '🔥 Forte' : pct >= 65 ? '⚡ Moderado' : '〰 Fraco';
  return (
    <div className="space-y-0.5">
      <div className="flex items-center gap-2">
        <div className="flex-1 h-1.5 rounded-full" style={{ background: 'rgba(255,255,255,0.06)' }}>
          <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: color, boxShadow: `0 0 6px ${color}60` }} />
        </div>
        <span className="text-[10px] font-mono font-bold" style={{ color }}>{pct}/100</span>
        <span className="text-[10px] font-mono" style={{ color: 'rgba(255,255,255,0.35)' }}>{label}</span>
      </div>
      <p className="text-[8px] font-mono leading-tight" style={{ color: 'rgba(255,255,255,0.25)' }}>
        Confluência de indicadores alinhados — não é uma probabilidade de acerto.
      </p>
    </div>
  );
}

function TFTrendRow({ op }) {
  const dirs = {
    '1d': op.tf_1d_direction ?? null,
    '4h': op.tf_4h_direction ?? null,
    '1h': op.tf_1h_direction ?? null,
  };
  const tfs = Object.entries(dirs).filter(([, v]) => v !== null);
  if (!tfs.length) return null;

  return (
    <div className="flex items-center gap-3 flex-wrap">
      {tfs.map(([tf, dir]) => {
        const color = dir === 1 ? '#00ff80' : dir === -1 ? '#ff1478' : '#64748b';
        const icon = dir === 1 ? '▲' : dir === -1 ? '▼' : '—';
        const label = dir === 1 ? 'Bull' : dir === -1 ? 'Bear' : 'Neu';
        return (
          <span key={tf} className="flex items-center gap-1 text-[9px] font-mono">
            <span style={{ color: 'rgba(255,255,255,0.3)' }}>{tf.toUpperCase()}</span>
            <span style={{ color }}>{icon} {label}</span>
          </span>
        );
      })}
    </div>
  );
}

function StatusBanner({ op }) {
  const banners = {
    SIGNAL_CONFIRMED: { text: '👀 Monitorando — aguardar preço avançar para TP1', color: '#00ff80', bg: 'rgba(0,255,128,0.06)' },
    RUNNER_ACTIVE:    { text: '🚀 Runner ativo — 50% realizado no TP1, deixar correr', color: '#ffd166', bg: 'rgba(255,209,102,0.06)' },
    TP2_HIT:          { text: '🏆 Encerrado com lucro máximo no TP2 — parabéns!', color: '#00ff80', bg: 'rgba(0,255,128,0.06)' },
    STOP_HIT:         { text: op.tp1_hit ? '🔄 Stop no breakeven — sem prejuízo' : '🛑 Stop atingido — revisar setup', color: op.tp1_hit ? '#ffd166' : '#ff1478', bg: op.tp1_hit ? 'rgba(255,209,102,0.06)' : 'rgba(255,20,120,0.06)' },
    INVALIDATED:      { text: '⚠️ Sinal invalidado — não operar agora', color: '#ff9f43', bg: 'rgba(255,159,67,0.06)' },
    CLOSED:           { text: '✖ Operação encerrada manualmente', color: '#64748b', bg: 'rgba(100,116,139,0.06)' },
  };
  const b = banners[op.status];
  if (!b) return null;
  return (
    <div className="rounded-lg px-3 py-2" style={{ background: b.bg, border: `1px solid ${b.color}22` }}>
      <p className="text-[10px] font-mono leading-relaxed" style={{ color: b.color }}>{b.text}</p>
    </div>
  );
}

function Details({ op }) {
  const status = STATUS_CONFIG[op.status] || STATUS_CONFIG.CLOSED;
  const dataStatus = DATA_STATUS[op.data_status] || DATA_STATUS.LIVE;
  const exitModeLabel = { RANGE_FILTER: '🔵 RF', ATR_TRAILING: '🟡 ATR Trail', HYBRID_RF_ATR: '🟣 RF+ATR' }[op.exit_mode] || op.exit_mode;
  const reasons = op.signal_reasons || [];

  return (
    <div className="space-y-3 pt-3" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
      <StatusBanner op={op} />

      <ScoreBar score={op.score} />
      <TFTrendRow op={op} />

      {op.tier && (
        <div className="text-[9px] font-mono" style={{ color: 'rgba(0,229,255,0.7)' }}
          title="Tier de volatilidade (ATR%) classificado na entrada — ver Pine v13.2 Grupo 03">
          🎚 Tier {op.tier}
        </div>
      )}

      <div className="flex items-center justify-between text-[9px] font-mono flex-wrap gap-2">
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <Clock className="w-3 h-3" />
          <span>{fmtBRT(op.candle_open_time)} → {fmtBRT(op.candle_close_time)} BRT</span>
        </div>
        <div className="flex items-center gap-2">
          <span style={{ color: op.candle_status === 'CLOSED' ? '#00ff80' : '#ff9f43' }}>
            {op.candle_status === 'CLOSED' ? '✅ Fechado' : '⏳ Aberto'}
          </span>
          <span style={{ color: dataStatus.color }}>{dataStatus.label}</span>
        </div>
      </div>

      <div className="flex items-center justify-between text-[9px] font-mono text-muted-foreground gap-2 flex-wrap">
        <span>📊 {op.partial_percent}% TP1 · {op.runner_percent}% runner</span>
        <span style={{ color: 'rgba(0,229,255,0.7)' }}>{exitModeLabel}</span>
      </div>

      {/* MFE/MAE — maior favorável/adverso já visto, em múltiplos de R.
          Ausente em ops legadas ou cujo candle de gerenciamento não era
          utilizável (P0-c/P0-g) — não mostra nada nesse caso em vez de 0. */}
      {(Number.isFinite(op.mfe_r) || Number.isFinite(op.mae_r)) && (
        <div className="flex items-center gap-3 text-[9px] font-mono text-muted-foreground"
          title="MFE: maior lucro flutuante já visto nesta operação. MAE: maior perda flutuante já vista. Ambos em múltiplos do risco inicial (R).">
          {Number.isFinite(op.mfe_r) && (
            <span>📈 MFE <span style={{ color: '#00ff80' }}>{op.mfe_r >= 0 ? '+' : ''}{op.mfe_r.toFixed(2)}R</span></span>
          )}
          {Number.isFinite(op.mae_r) && (
            <span>📉 MAE <span style={{ color: '#ff1478' }}>{op.mae_r >= 0 ? '+' : ''}{op.mae_r.toFixed(2)}R</span></span>
          )}
        </div>
      )}

      {reasons.length > 0 && (
        <div className="space-y-1">
          <div className="text-[9px] font-mono uppercase tracking-wide" style={{ color: 'rgba(255,255,255,0.35)' }}>
            🔍 Motivos técnicos ({reasons.length})
          </div>
          {reasons.map((r, i) => (
            <div key={i} className="text-[10px] font-mono text-muted-foreground flex items-start gap-1.5">
              <span style={{ color: '#00ff80', marginTop: 1 }}>·</span> {r}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ──────────────────────────────── Card ──────────────────────────────────── */

export default function TradeCard({ operation: op, actions = null, expandAll = false }) {
  const [open, setOpen] = useState(expandAll);
  useEffect(() => { setOpen(expandAll); }, [expandAll]);

  const { price, isLoading, isStale, ageLabel } = useLivePrice(op.symbol);
  const isOpenOp = OPEN_STATUSES.has(op.status);
  const { unrealizedPct } = describeProximity(op, price);
  const openPnlPct = isOpenOp ? unrealizedPct : null;

  const status = STATUS_CONFIG[op.status] || STATUS_CONFIG.CLOSED;
  const isBuy = op.side === 'BUY';
  const sideColor = isBuy ? '#00ff80' : '#ff1478';
  const pnlColor = openPnlPct === null ? 'rgba(255,255,255,0.4)' : openPnlPct >= 0 ? '#00ff80' : '#ff1478';
  const quoteColor = price === null ? 'rgba(255,255,255,0.35)' : isStale ? '#ff9f43' : 'rgba(255,255,255,0.95)';

  return (
    <article className="rounded-2xl overflow-hidden flex flex-col"
      style={{
        background: 'rgba(10,13,22,0.85)',
        backdropFilter: 'blur(20px)',
        border: '1px solid rgba(255,255,255,0.07)',
        borderLeft: `3px solid ${status.color}`,
      }}>
      <div className="p-4 space-y-3">
        {/* 1 · Identidade e estado */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 flex-wrap min-w-0">
            <span className="font-bold text-base text-foreground">{op.symbol?.replace('USDT', '/USDT')}</span>
            <span className="flex items-center gap-0.5 text-[10px] font-mono px-1.5 py-0.5 rounded font-bold"
              style={{ background: `${sideColor}1f`, color: sideColor, border: `1px solid ${sideColor}4d` }}>
              {isBuy ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
              {op.side}
            </span>
            <span className="text-[10px] font-mono" style={{ color: 'rgba(255,255,255,0.35)' }}>
              {op.timeframe?.toUpperCase()}
            </span>
            {/* Horário absoluto de abertura já na camada 1: é o âncora de
                qualquer comparação posterior (item 161). */}
            <span className="text-[9px] font-mono" style={{ color: 'rgba(255,255,255,0.25)' }}
              title="Quando esta operação foi aberta (horário de Brasília)">
              aberta {fmtBRT(op.created_date)}
            </span>
          </div>
          <span className="text-[10px] font-mono px-2 py-0.5 rounded shrink-0 font-semibold"
            title={status.desc}
            style={{ background: status.bg, color: status.color, border: `1px solid ${status.border}` }}>
            {status.short}
          </span>
        </div>

        <BackfillBanner op={op} />
        <AmbiguousExitBanner op={op} />

        {/* 2 · Número herói: preço agora e como está a operação */}
        <div className="flex items-end justify-between gap-2 flex-wrap">
          <div className="min-w-0">
            <div className="text-2xl font-mono font-bold leading-none truncate" style={{ color: quoteColor }}>
              {price !== null ? `$${formatPrice(price)}` : isLoading ? '···' : '—'}
            </div>
            <div className="flex items-center gap-1.5 mt-1.5">
              <span className={`w-1.5 h-1.5 rounded-full${price !== null && !isStale ? ' animate-pulse motion-reduce:animate-none' : ''}`}
                style={{
                  background: price === null ? 'rgba(255,255,255,0.3)' : isStale ? '#ff9f43' : '#00e5ff',
                  boxShadow: price !== null && !isStale ? '0 0 5px #00e5ff' : 'none',
                }} />
              <span className="text-[9px] font-mono uppercase tracking-widest"
                style={{ color: isStale ? '#ff9f43' : 'rgba(255,255,255,0.35)' }}>
                {isStale ? `Desatualizado${ageLabel ? ` há ${ageLabel}` : ''}` : price !== null ? 'Ao vivo' : 'Sem cotação'}
              </span>
            </div>
          </div>
          {openPnlPct !== null && (
            <div className="text-right shrink-0">
              <div className="text-xl font-mono font-bold leading-none" style={{ color: pnlColor, opacity: isStale ? 0.55 : 1 }}>
                {formatSignedPct(openPnlPct)}
              </div>
              <div className="text-[8px] font-mono uppercase tracking-widest mt-1" style={{ color: 'rgba(255,255,255,0.3)' }}
                title="Resultado em aberto sobre a entrada, sem descontar taxas nem funding.">
                em aberto · bruto
              </div>
            </div>
          )}
        </div>

        {/* 3 · Trilha: onde o preço está entre stop, entrada e alvos */}
        <LevelRail op={op} price={price} isStale={isStale} />

        {/* 4 · O que acontece a seguir */}
        {isOpenOp && <MilestoneLine op={op} price={price} isStale={isStale} />}

        {/* 5 · O porquê, a um clique */}
        <button onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="flex items-center gap-1 text-[10px] font-mono transition-colors hover:text-foreground/70"
          style={{ color: 'rgba(255,255,255,0.4)' }}>
          {open ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          {open ? 'Menos detalhes' : 'Detalhes técnicos'}
        </button>
        {open && <Details op={op} />}
      </div>

      {actions && (
        <div className="mt-auto" style={{ borderTop: '1px solid rgba(255,255,255,0.05)', background: 'rgba(6,8,15,0.6)' }}>
          {actions}
        </div>
      )}
    </article>
  );
}
