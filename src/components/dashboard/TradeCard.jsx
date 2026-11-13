import TokenIcon from '@/components/TokenIcon';
import React, { useState, useEffect } from 'react';
import { operationProvenance, PROVENANCE_LABEL } from '@/lib/operationProvenance';
import { agreementLabel, AGREEMENT_HINT } from '@/lib/ruleAgreement';
import moment from 'moment';
import { Clock, TrendingUp, TrendingDown, ChevronDown, ChevronUp, History } from 'lucide-react';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { formatBackfillLag } from '@/lib/backfillDetection';
import {
  formatPrice, formatSignedPct, describeProximity, nextMilestone, stopPosture,
} from '@/lib/priceProximity';
import { classifyOutcome } from '@/lib/tradeMetrics';
import { closedReasonLabel } from '@/lib/eventTimeline';
import { explainOperationDecision } from '@/lib/decisionExplanation';
import { buildTradeRail, layoutRailLabels } from '@/lib/tradeRail';
import { stopOutcomeIfHit, formatSignedR } from '@/lib/stopGuarantee';
import { buildOpenTradeStory, describeProtectionProgress } from '@/lib/openTradeStory';
import { explainSignalReasons, formatReasonPoints } from '@/lib/signalReasonGlossary';
import { opSignalTimeframe, timeframeChipLabel } from '@/lib/tradeStory';
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

// Qual mercado da Binance gerou os dados desta operação — 'futures' quando
// nasceu no painel (navegador), 'spot' quando nasceu no cron 24h (ver
// docs/known-risks.md item 4: divergência Spot×Futures aceita como limitação
// permanente do projeto gratuito, não é bug). Puramente informativo — não
// tenta detectar/decidir divergência aqui, só mostra o fato já gravado na
// operação (`market_source`); decidir SE isso importa é papel do motor
// (`shouldSkipCrossSourceManagement`, src/lib/opTransition.js).
const MARKET_SOURCE_LABEL = { spot: 'Spot', futures: 'Futures' };

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

// Mesmo horário (Brasília), por extenso — usado onde a data é lida em frase.
function fmtBRTLong(iso) {
  return moment(iso).utcOffset(-3).format('DD/MM [às] HH:mm');
}

/* ─────────────────────────── Camada 1 — o olhar ─────────────────────────── */

// Item 303: cada faixa da trilha tem UM sentido, e não depende só da cor — o
// risco eliminado é listrado, o lucro protegido é cheio, o que falta buscar é
// claro, e a legenda logo abaixo escreve o nome de cada uma.
const RAIL_ZONE = {
  riskRemoved: {
    label: 'risco já eliminado',
    style: { background: 'repeating-linear-gradient(135deg, rgba(255,255,255,0.22) 0 3px, rgba(255,255,255,0.05) 3px 6px)' },
  },
  risk: { label: 'risco em jogo', style: { background: 'rgba(255,20,120,0.6)' } },
  locked: { label: 'lucro protegido', style: { background: 'rgba(0,255,128,0.85)' } },
  reward: { label: 'falta buscar', style: { background: 'rgba(0,255,128,0.18)' } },
};
const RAIL_LABEL_ROW_PX = 13;
const INITIAL_STOP_COLOR = 'rgba(255,255,255,0.5)';

const railLabelText = (key, op) => (key === 'initialStop' ? 'Stop inicial' : levelLabel(key, op));
const railLabelColor = (key, op) => (key === 'initialStop' ? INITIAL_STOP_COLOR : levelColor(key, op));
const railAnchorStyle = (label) => (
  label.anchor === 'start' ? { left: 0 }
    : label.anchor === 'end' ? { right: 0 }
      : { left: `${label.pos}%`, transform: 'translateX(-50%)' }
);

/**
 * Trilha da operação: stop inicial → entrada → TP1 → TP2, com os nomes
 * escritos em cima, o preço marcado por uma agulha e uma faixa para cada
 * coisa (risco eliminado, risco em jogo, lucro protegido, o que falta buscar).
 *
 * Geometria em `src/lib/tradeRail.js` (pura, testada). Os números (preço e
 * distância de cada nível) ficam na grade logo abaixo, na MESMA ordem da
 * trilha.
 */
function LevelRail({ op, price, isStale, isOpen }) {
  const rail = buildTradeRail(op, price);
  const { levels } = describeProximity(op, price);
  if (levels.length === 0) return null;

  const needleColor = isStale ? '#ff9f43' : '#00e5ff';
  const { rows, labels } = rail
    ? layoutRailLabels(rail.markers.map((m) => ({ key: m.key, pos: m.pos, text: railLabelText(m.key, op) })))
    : { rows: 0, labels: [] };
  const nowLabel = rail && rail.pricePos !== null
    ? layoutRailLabels([{ key: 'now', pos: rail.pricePos, text: '▲ preço agora' }]).labels[0]
    : null;
  // A grade segue a ordem da trilha (numa venda com o lucro à direita, o stop fica à esquerda).
  const railPos = (key) => rail?.markers.find((m) => m.key === key)?.pos ?? 0;
  const orderedLevels = rail ? [...levels].sort((a, b) => railPos(a.key) - railPos(b.key)) : levels;
  const initialStop = rail?.markers.find((m) => m.key === 'initialStop');

  return (
    <div className="space-y-1.5">
      {rail && (
        <div>
          {/* nomes dos marcadores — decorativos para leitor de tela: o aria-label da trilha já diz tudo */}
          <div className="relative w-full" aria-hidden="true" style={{ height: rows * RAIL_LABEL_ROW_PX + 3 }}>
            {labels.map((label) => (
              <React.Fragment key={label.key}>
                {label.row > 0 && (
                  <div className="absolute w-px" style={{
                    left: `${label.pos}%`, bottom: 0, height: label.row * RAIL_LABEL_ROW_PX + 3,
                    background: railLabelColor(label.key, op), opacity: 0.35, transform: 'translateX(-50%)',
                  }} />
                )}
                <span className="absolute text-8px font-mono font-semibold uppercase tracking-wide whitespace-nowrap leading-none"
                  data-rail-label={label.key}
                  style={{ ...railAnchorStyle(label), bottom: label.row * RAIL_LABEL_ROW_PX + 4, color: railLabelColor(label.key, op) }}>
                  {label.text}
                </span>
              </React.Fragment>
            ))}
          </div>

          <div
            className="relative h-2.5 w-full"
            role="img"
            aria-label={`Trilha da operação. Stop $${formatPrice(op.current_stop)}, entrada $${formatPrice(op.entry_price)}, TP1 $${formatPrice(op.tp1)}, TP2 $${formatPrice(op.tp2)}.${initialStop ? ` Stop inicial $${formatPrice(initialStop.price)}.` : ''}${price !== null ? ` Preço atual $${formatPrice(price)}.` : ''}`}>
            <div className="absolute inset-0 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.07)' }}>
              {rail.zones.map((zone) => (
                <div key={zone.key} className="absolute h-full" data-rail-zone={zone.key}
                  style={{ left: `${zone.from}%`, width: `${zone.to - zone.from}%`, ...RAIL_ZONE[zone.key].style }} />
              ))}
            </div>
            {rail.markers.map((m) => {
              const color = railLabelColor(m.key, op);
              return (
                <div key={m.key} className="absolute -top-1 -bottom-1" data-rail-marker={m.key}
                  style={{
                    left: `${m.pos}%`, width: 2, transform: 'translateX(-50%)',
                    // o stop inicial é passado: tracejado, para não disputar com o stop que vale hoje
                    background: m.key === 'initialStop'
                      ? `repeating-linear-gradient(to bottom, ${color} 0 2px, transparent 2px 4px)`
                      : color,
                  }} />
              );
            })}
            {/* agulha do preço — sem title=/Tooltip de propósito (achado A-6,
                Grupo 5): é um marcador sem foco, e o aria-label do
                <div role="img"> pai (acima) já descreve stop/entrada/TP1/TP2/
                preço atual por completo. */}
            {rail.pricePos !== null && (
              <div className="absolute -top-2 -bottom-2 rounded-full" data-rail-needle=""
                style={{
                  left: `${rail.pricePos}%`,
                  width: 4,
                  background: needleColor,
                  boxShadow: `0 0 6px ${needleColor}`,
                  transform: 'translateX(-50%)',
                  opacity: rail.priceOutOfRange || isStale ? 0.55 : 1,
                }} />
            )}
          </div>

          <div className="relative w-full h-5" aria-hidden="true">
            {nowLabel && (
              <span className="absolute text-8px font-mono font-semibold uppercase tracking-wide whitespace-nowrap leading-none"
                style={{ ...railAnchorStyle(nowLabel), top: 11, color: needleColor }}>
                {nowLabel.text}
              </span>
            )}
          </div>

          <div className="flex items-center gap-x-2.5 gap-y-0.5 flex-wrap text-8px font-mono" style={{ color: 'rgba(255,255,255,0.45)' }}>
            {/* A legenda fala do que está EM JOGO ("falta buscar", "risco em jogo") — numa operação encerrada seria mentira. */}
            {isOpen && rail.zones.map((zone) => (
              <span key={zone.key} className="flex items-center gap-1" data-rail-legend={zone.key}>
                <span className="w-2 h-2 rounded-sm shrink-0" aria-hidden="true" style={RAIL_ZONE[zone.key].style} />
                {RAIL_ZONE[zone.key].label}
              </span>
            ))}
            {!rail.isBuy && (
              <span style={{ color: 'rgba(255,255,255,0.3)' }}>
                {isOpen ? '· ' : ''}venda: o lucro cresce para a direita (preço caindo)
              </span>
            )}
          </div>
        </div>
      )}

      <div className="grid grid-cols-4 gap-1">
        {orderedLevels.map((level) => {
          const color = levelColor(level.key, op);
          const cellBody = (
            <>
              <div className="flex items-center gap-1 mb-0.5">
                <span className="w-1 h-1 rounded-full shrink-0" style={{ background: color }} />
                <span className="text-8px font-mono uppercase tracking-wide truncate"
                  style={{ color: 'rgba(255,255,255,0.4)' }}>{levelLabel(level.key, op)}</span>
              </div>
              <div className="text-11px font-mono font-semibold truncate leading-tight" style={{ color }}>
                {formatPrice(level.price)}
              </div>
              <div className="text-9px font-mono truncate leading-tight"
                style={{ color: level.isNearest ? 'rgba(255,255,255,0.6)' : 'rgba(255,255,255,0.3)' }}>
                {level.pct === null
                  ? '—'
                  : `${level.position === 'above' ? '↑' : level.position === 'below' ? '↓' : '='} ${Math.abs(level.pct).toFixed(2)}%`}
              </div>
            </>
          );
          if (level.pct === null) {
            return <div key={level.key} className="min-w-0">{cellBody}</div>;
          }
          return (
            <Tooltip key={level.key}>
              <TooltipTrigger asChild>
                <div className="min-w-0 cursor-help" tabIndex={0}>{cellBody}</div>
              </TooltipTrigger>
              <TooltipContent className="max-w-[260px] text-10px font-mono normal-case tracking-normal leading-relaxed">
                {`O preço precisa andar ${formatSignedPct(level.pct)} para chegar em ${levelLabel(level.key, op)}.`}
              </TooltipContent>
            </Tooltip>
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
    <div className="flex items-center gap-1.5 text-11px font-mono rounded-lg px-2.5 py-1.5"
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
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="ml-auto text-9px shrink-0 cursor-help" tabIndex={0} style={{ color: '#ff9f43' }}>
              ⚠️
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-[260px] text-10px font-mono normal-case tracking-normal leading-relaxed">
            Calculado sobre a última cotação recebida.
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

// Item 303 — pedido do usuário: "o que já tem garantido se fechar nesse novo
// stop?". A conta vem de `stopOutcomeIfHit` (a mesma do Histórico, bruta).
// A palavra na tela é "protegido", não "garantido": o stop do Sentinel é
// virtual e o preço pode pular o nível — a dica diz isso.
const GUARANTEE_TONE = {
  profit: { lead: '🛡️ Lucro protegido', color: '#00ff80' },
  zero: { lead: '🟡 Breakeven', color: LEVEL_COLOR.stopBe },
  loss: { lead: '🛑 Risco em jogo', color: LEVEL_COLOR.stop },
};

function GuaranteeLine({ op }) {
  const outcome = stopOutcomeIfHit(op);
  if (!outcome) return null;
  const tone = GUARANTEE_TONE[outcome.kind];
  const stopText = `$${formatPrice(outcome.stop)}`;
  const r = formatSignedR(outcome.r);
  const tp1Note = outcome.includesTp1 ? `, já contando os ${outcome.tp1SharePct}% realizados no TP1` : '';

  return (
    <div className="text-11px font-mono rounded-lg px-2.5 py-1.5 leading-relaxed" data-guarantee={outcome.kind}
      style={{ background: `${tone.color}0f`, border: `1px solid ${tone.color}26`, color: 'rgba(255,255,255,0.7)' }}>
      <span className="font-bold" style={{ color: tone.color }}>{tone.lead}</span>
      {outcome.kind === 'zero' ? (
        <>: se o preço voltar e bater no stop ({stopText}), a operação fecha no zero a zero{tp1Note}.</>
      ) : (
        <>
          : se o preço {outcome.kind === 'profit' ? 'voltar e bater' : 'bater'} no stop ({stopText}), a operação fecha com{' '}
          <span className="font-bold" style={{ color: tone.color }}>{formatSignedPct(outcome.pct)}</span>
          {r ? ` (${r})` : ''}{tp1Note}.
        </>
      )}{' '}
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="text-8px uppercase tracking-widest cursor-help whitespace-nowrap" tabIndex={0} style={{ color: 'rgba(255,255,255,0.35)' }}>
            bruto · no preço do stop
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-[260px] text-10px font-mono normal-case tracking-normal leading-relaxed">
          Conta feita no preço do stop, sem descontar taxas nem funding. O stop do Sentinel é virtual (nenhuma ordem fica na corretora): se o preço pular o nível, o resultado real pode ser pior. R = quantas vezes o risco inicial (a distância da entrada até o stop inicial).
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

// Item 303 — "o que aconteceu até agora", no mesmo formato da história do
// trade da aba Histórico (TradeHistory.jsx). Só para operação aberta: a
// fechada tem a história completa lá.
function OpenStory({ op }) {
  const story = buildOpenTradeStory(op, { fmt: fmtBRTLong });
  if (story.length === 0) return null;
  return (
    <div className="rounded-lg px-3 py-2.5" role="group" aria-label="A história até agora"
      style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.07)' }}>
      <div className="text-9px font-mono text-muted-foreground mb-1.5">📖 A história até agora</div>
      <ol className="space-y-1">
        {story.map((step) => (
          <li key={step.key} className="text-10px font-mono leading-relaxed" style={{ color: 'rgba(255,255,255,0.7)' }}>
            {step.text}
          </li>
        ))}
      </ol>
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
      <p className="text-10px font-mono leading-relaxed" style={{ color: '#00e5ff' }}>
        Detectada retroativamente{lag ? ` — entrada real foi há ${lag}` : ''}. Não foi pega ao vivo: o ativo foi adicionado/reativado depois, e o Sentinel reconstruiu a operação a partir do histórico.
      </p>
    </div>
  );
}

// Item 278 (PR-C): operação que não foi decidida pelo motor — simulação
// criada no painel ou encerrada à mão pelo painel — fica fora das
// estatísticas (src/lib/operationProvenance.js) e diz isso aqui.
function ProvenanceBanner({ op }) {
  const text = PROVENANCE_LABEL[operationProvenance(op)]?.banner;
  if (!text) return null;
  return (
    <div className="rounded-lg px-3 py-2" style={{ background: 'rgba(167,139,250,0.08)', border: '1px solid rgba(167,139,250,0.3)' }}>
      <p className="text-10px font-mono leading-relaxed" style={{ color: '#c4b5fd' }}>{text}</p>
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
      <p className="text-10px font-mono leading-relaxed" style={{ color: '#00e5ff' }}>
        ℹ️ Nessa vela, o preço tocou o stop e o take ao mesmo tempo — o gráfico não mostra qual foi primeiro de verdade. Por segurança, o sistema sempre considera que o stop aconteceu primeiro nesses casos raros. Essa operação já foi encerrada com esse resultado.
      </p>
    </div>
  );
}

/* ────────────────────────── Camada 2 — o porquê ─────────────────────────── */

export function ScoreBar({ score }) {
  // Item 277: sem score numérico (operação de MACD/EMA/RSI/SMC), nada — antes
  // virava "0/100" inventado.
  if (!Number.isFinite(score)) return null;
  const pct = Math.max(0, Math.min(100, score));
  const color = pct >= 85 ? '#00ff80' : pct >= 65 ? '#ffd166' : '#ff9f43';
  return (
    <div className="space-y-0.5">
      <div className="flex items-center gap-2">
        <div className="flex-1 h-1.5 rounded-full" style={{ background: 'rgba(255,255,255,0.06)' }}>
          <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: color, boxShadow: `0 0 6px ${color}60` }} />
        </div>
        <span className="text-10px font-mono font-bold" style={{ color }}>{agreementLabel({ score: pct })}</span>
        <span className="text-10px font-mono" style={{ color: 'rgba(255,255,255,0.35)' }}>regras alinhadas</span>
      </div>
      <p className="text-8px font-mono leading-tight" style={{ color: 'rgba(255,255,255,0.25)' }}>
        {AGREEMENT_HINT}
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
          <span key={tf} className="flex items-center gap-1 text-9px font-mono">
            <span style={{ color: 'rgba(255,255,255,0.3)' }}>{tf.toUpperCase()}</span>
            <span style={{ color }}>{icon} {label}</span>
          </span>
        );
      })}
    </div>
  );
}

// O banner de STOP_HIT é sobre uma operação já ENCERRADA — precisa do
// resultado REALIZADO (classifyOutcome, a mesma fonte única que
// PerformanceOverview.jsx/TradeEntryMarkers.jsx usam), nunca de op.tp1_hit
// (item 154) nem de stopPosture(op) (item 166 Fase 2, 1ª correção deste
// banner). stopPosture só compara o preço NOMINAL do stop com a entrada —
// certo para descrever uma posição ainda ABERTA (PriceGrid/MilestoneLine
// abaixo continuam usando stopPosture de propósito, não têm resultado
// realizado ainda), mas errado para o resultado FINAL: um stop pré-TP1
// avançado (`preTp1TrailEnabled`) pode ficar nominalmente acima da entrada e
// mesmo assim fechar em prejuízo/empate líquido depois de taxa/slippage/
// funding (`calcRealizedR`/`calcRealizedPnlPct`, Fase 5 de custos) — Codex
// review, PR #318, achou este banner anunciando "encerrado no lucro" nesse
// caso.
const STOP_HIT_BANNER = {
  WIN: { text: '💰 Stop travou lucro — encerrado no lucro', color: '#00ff80', bg: 'rgba(0,255,128,0.06)' },
  BE:  { text: '🟡 Stop no breakeven — sem prejuízo', color: LEVEL_COLOR.stopBe, bg: 'rgba(255,209,102,0.06)' },
};
const STOP_HIT_BANNER_DEFAULT = { text: '🛑 Stop atingido — operação encerrada pela proteção inicial', color: LEVEL_COLOR.stop, bg: 'rgba(255,20,120,0.06)' };
// Achado da varredura geral (2026-09-18): quando classifyOutcome cai em
// LOSS/UNKNOWN mas o TP1 já tinha sido atingido, o stop que fechou a
// operação não é mais o "inicial" — é o breakeven/trilha pós-TP1
// (reason_code `stop_hit_runner`, ver OPERATION_COPY em
// decisionExplanation.js: "O preço tocou o stop já protegido (breakeven ou
// trilha) depois do TP1."). O texto abaixo do banner (OperationDecisionNote)
// já dizia isso — o banner alegando "proteção inicial" ao lado contradizia
// diretamente a própria explicação da operação.
const STOP_HIT_BANNER_DEFAULT_POST_TP1 = { text: '🛑 Stop atingido — operação encerrada pela proteção pós-TP1', color: LEVEL_COLOR.stop, bg: 'rgba(255,20,120,0.06)' };
const CLOSED_BANNER_DEFAULT = { text: '✖ Operação encerrada manualmente', color: '#64748b', bg: 'rgba(100,116,139,0.06)' };

// CLOSED cobre 3 encerramentos automáticos do motor (Time Stop, Chop Exit,
// TP1_FULL quando o runner está desligado) além do fechamento manual — antes
// o banner dizia sempre "encerrada manualmente", inclusive quando foi o
// próprio motor que decidiu sair. `closedReasonLabel` (src/lib/eventTimeline.js)
// já é a fonte única desse motivo — reaproveitada aqui em vez de duplicar o
// mapa closed_reason→texto (a mesma leitura que Trades.jsx's HistoryRow usa).
function closedBanner(op) {
  const motivo = closedReasonLabel(op);
  if (!motivo) return CLOSED_BANNER_DEFAULT;
  return { text: `✖ Encerrada pelo motor — ${motivo}`, color: '#64748b', bg: 'rgba(100,116,139,0.06)' };
}

function StatusBanner({ op }) {
  const banners = {
    SIGNAL_CONFIRMED: { text: '👀 Monitorando — aguardar preço avançar para TP1', color: '#00ff80', bg: 'rgba(0,255,128,0.06)' },
    RUNNER_ACTIVE:    { text: '🏃 Runner ativo — 50% realizado no TP1, deixar correr', color: '#ffd166', bg: 'rgba(255,209,102,0.06)' },
    TP2_HIT:          { text: '🏆 Encerrado no TP2 — alvo final atingido', color: '#00ff80', bg: 'rgba(0,255,128,0.06)' },
    STOP_HIT:         STOP_HIT_BANNER[classifyOutcome(op)] ?? (op.tp1_hit ? STOP_HIT_BANNER_DEFAULT_POST_TP1 : STOP_HIT_BANNER_DEFAULT),
    INVALIDATED:      { text: '⚠️ Sinal invalidado — não operar agora', color: '#ff9f43', bg: 'rgba(255,159,67,0.06)' },
    CLOSED:           closedBanner(op),
  };
  const b = banners[op.status];
  if (!b) return null;
  return (
    <div className="rounded-lg px-3 py-2" style={{ background: b.bg, border: `1px solid ${b.color}22` }}>
      <p className="text-10px font-mono leading-relaxed" style={{ color: b.color }}>{b.text}</p>
    </div>
  );
}

// Fase 3 — Explainability V2 (HOLDING/PROTECTED, operação aberta). Fase 4
// estendeu decision_snapshot para cobrir EXIT também (scanner.js grava um
// snapshot de EXIT no MESMO momento em que a operação fecha — ver
// src/lib/decisionSnapshot.js) — por isso este componente não é mais
// restrito a operação aberta: renderiza sempre que decision_snapshot existir,
// como acréscimo abaixo do StatusBanner/closedBanner (que continuam sendo a
// fonte do resultado categórico + cor).
//
// Achado de revisão (Codex, PR #376): uma op fechada ANTES da Fase 4 pode
// carregar um decision_snapshot residual de HOLDING/PROTECTED (Fase 3 nunca
// escrevia snapshot de EXIT) — sem este guard, o bloco mostraria
// "Monitorando"/"Runner ativo" numa operação já encerrada há muito tempo.
// Op fechada só mostra o bloco quando o snapshot é realmente de EXIT.
//
// Achado de clareza (pedido do usuário, 2026-09-18): headline+why só
// apareciam AQUI, dentro de "Detalhes técnicos" (fechado por padrão) — o
// resumo agora sobe pra `OperationWhySummary` (sempre visível, sem clique);
// este bloco vira só a evidência numérica granular, pra quem quiser mais.
function OperationDecisionNote({ op }) {
  const snapshot = op.decision_snapshot;
  if (!snapshot) return null;
  if (!OPEN_STATUSES.has(op.status) && snapshot.decision !== 'EXIT') return null;
  // Item 303: os números da proteção pré-TP1 vinham em unidades de preço sem
  // tradução ("movimento favorável 20.3300, gatilho da trilha em 5.6857").
  // Para esses motivos a frase em linguagem simples substitui a técnica; os
  // demais continuam com a evidência de sempre.
  // (só existe em snapshot de proteção pré-TP1; um snapshot de EXIT nunca tem esses motivos)
  const progress = describeProtectionProgress(op);
  const measuredAt = snapshot.evaluated_at && moment(snapshot.evaluated_at).isValid() ? fmtBRTLong(snapshot.evaluated_at) : null;
  const friendly = progress && measuredAt ? `${progress} (medido em ${measuredAt}, Brasília)` : progress;
  const evidence = friendly ?? explainOperationDecision(op).evidence;
  if (!evidence) return null;
  return (
    <div className="text-9px font-mono px-3 py-2 rounded-lg leading-relaxed" style={{ background: 'rgba(0,229,255,0.04)', border: '1px solid rgba(0,229,255,0.12)', color: 'rgba(255,255,255,0.5)' }}>
      📐 {evidence}
    </div>
  );
}

// Item 303 — "por que entrou", com cada motivo explicado. O motor grava só
// a frase curta com os pontos; o glossário (signalReasonGlossary.js) diz o
// que a regra mede e por que entra na soma. Motivo que o glossário não
// conhece aparece como veio, sem explicação inventada.
function EntryReasons({ op }) {
  const reasons = explainSignalReasons(op.signal_reasons, op.side);
  const hasScore = Number.isFinite(op.score);
  if (reasons.length === 0 && !hasScore) return null;
  return (
    <div className="space-y-2" role="group" aria-label="Por que entrou">
      {reasons.length > 0 && (
        <div className="text-9px font-mono uppercase tracking-wide" style={{ color: 'rgba(255,255,255,0.45)' }}>
          🧩 Por que entrou — regras a favor na hora do aviso: {reasons.length}
        </div>
      )}
      <ScoreBar score={op.score} />
      {reasons.length > 0 && (
        <ul className="space-y-2">
          {reasons.map((reason, i) => {
            const points = formatReasonPoints(reason.points);
            return (
              <li key={`${reason.raw}-${i}`} className="text-10px font-mono leading-relaxed pl-2"
                style={{ borderLeft: '2px solid rgba(0,255,128,0.35)' }}>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-semibold" style={{ color: 'rgba(255,255,255,0.85)' }}>{reason.title}</span>
                  {points && (
                    <span className="text-9px shrink-0 whitespace-nowrap" style={{ color: '#00ff80' }}>+{points}</span>
                  )}
                </div>
                {reason.what && (
                  <p style={{ color: 'rgba(255,255,255,0.55)' }}>
                    <span style={{ color: 'rgba(255,255,255,0.4)' }}>O que é: </span>{reason.what}
                  </p>
                )}
                {reason.why && (
                  <p style={{ color: 'rgba(255,255,255,0.55)' }}>
                    <span style={{ color: 'rgba(255,255,255,0.4)' }}>Por que conta: </span>{reason.why}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// Resumo compacto do "por quê" — SEMPRE visível (achado de clareza acima),
// mesmo guard de `OperationDecisionNote` (fail-closed: só quando o snapshot
// realmente descreve o estado atual da operação).
function OperationWhySummary({ op }) {
  const snapshot = op.decision_snapshot;
  if (!snapshot) return null;
  if (!OPEN_STATUSES.has(op.status) && snapshot.decision !== 'EXIT') return null;
  const { headline, why } = explainOperationDecision(op);
  return (
    <p className="text-10px font-mono leading-relaxed" style={{ color: 'rgba(255,255,255,0.5)' }}>
      💡 <span className="font-semibold" style={{ color: 'rgba(0,229,255,0.8)' }}>{headline}</span>
      {why ? ` — ${why}` : ''}
    </p>
  );
}

function Details({ op }) {
  const marketSourceLabel = MARKET_SOURCE_LABEL[op.market_source];
  const exitModeLabel = { RANGE_FILTER: '🔵 RF', ATR_TRAILING: '🟠 ATR Trail', HYBRID_RF_ATR: '🟣 RF+ATR' }[op.exit_mode] || op.exit_mode;
  const signalTf = opSignalTimeframe(op);
  const hasSignalCandle = Boolean(op.candle_open_time || op.candle_close_time);

  return (
    <div className="space-y-3 pt-3" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
      <StatusBanner op={op} />
      <OperationDecisionNote op={op} />

      <EntryReasons op={op} />
      <TFTrendRow op={op} />

      {op.tier && (
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="text-9px font-mono cursor-help" tabIndex={0} style={{ color: 'rgba(0,229,255,0.7)' }}>
              🎚 Tier {op.tier}
            </div>
          </TooltipTrigger>
          <TooltipContent className="max-w-[260px] text-10px font-mono normal-case tracking-normal leading-relaxed">
            Tier de volatilidade (ATR%) classificado na entrada — ver Pine v13.2 Grupo 03
          </TooltipContent>
        </Tooltip>
      )}

      {/* Item 303: aqui aparecia "09:00 → 12:59 BRT ✅ Fechado" — outro
          horário (o da vela do AVISO, não o da abertura) e um "Fechado" que
          falava da vela, numa operação "Ativa". Agora diz o que é. */}
      {hasSignalCandle && (
        <div className="text-9px font-mono text-muted-foreground leading-relaxed">
          🕯️ Vela do aviso{signalTf ? ` (${signalTf.toUpperCase()})` : ''}: {fmtBRT(op.candle_open_time)} → {fmtBRT(op.candle_close_time)} (Brasília)
          {op.candle_status ? ` · ${op.candle_status === 'CLOSED' ? 'vela já fechada' : 'vela ainda aberta'}` : ''}
        </div>
      )}

      <div className="flex items-center justify-between text-9px font-mono text-muted-foreground gap-2 flex-wrap">
        <span>📊 {op.partial_percent}% TP1 · {op.runner_percent}% runner</span>
        <span className="flex items-center gap-2">
          {/* Item 277: o badge "🔴 LIVE" lia op.data_status, gravado sempre
              como 'LIVE' pelo motor — nunca mudava. Frescor real fica no
              cartão do ativo (📡). */}
          {marketSourceLabel && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="cursor-help" tabIndex={0} style={{ color: 'rgba(255,255,255,0.35)' }}>
                  {marketSourceLabel}
                </span>
              </TooltipTrigger>
              <TooltipContent className="max-w-[260px] text-10px font-mono normal-case tracking-normal leading-relaxed">
                De qual mercado da Binance vieram os dados desta operação (item 4, docs/known-risks.md — divergência Spot×Futures aceita como limitação do projeto gratuito).
              </TooltipContent>
            </Tooltip>
          )}
          <span style={{ color: 'rgba(0,229,255,0.7)' }}>{exitModeLabel}</span>
        </span>
      </div>

      {/* MFE/MAE — maior favorável/adverso já visto, em múltiplos de R.
          Ausente em ops legadas ou cujo candle de gerenciamento não era
          utilizável (P0-c/P0-g) — não mostra nada nesse caso em vez de 0. */}
      {(Number.isFinite(op.mfe_r) || Number.isFinite(op.mae_r)) && (
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex items-center gap-3 text-9px font-mono text-muted-foreground cursor-help" tabIndex={0}>
              {Number.isFinite(op.mfe_r) && (
                <span>⬆️ Máx. a favor (MFE) <span style={{ color: '#00ff80' }}>{op.mfe_r >= 0 ? '+' : ''}{op.mfe_r.toFixed(2)}R</span></span>
              )}
              {Number.isFinite(op.mae_r) && (
                <span>⬇️ Máx. contra (MAE) <span style={{ color: '#ff1478' }}>{op.mae_r >= 0 ? '+' : ''}{op.mae_r.toFixed(2)}R</span></span>
              )}
            </div>
          </TooltipTrigger>
          <TooltipContent className="max-w-[260px] text-10px font-mono normal-case tracking-normal leading-relaxed">
            MFE: maior lucro flutuante já visto nesta operação. MAE: maior perda flutuante já vista. Ambos em múltiplos do risco inicial (R).
          </TooltipContent>
        </Tooltip>
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
  const tfChip = timeframeChipLabel(op);
  // "há 2d 20h" só em operação viva — numa fechada seria o tempo desde a abertura, não a duração.
  const openedMs = op.created_date ? new Date(op.created_date).getTime() : NaN;
  const openFor = isOpenOp && Number.isFinite(openedMs) ? formatBackfillLag(Date.now() - openedMs) : null;
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
            <TokenIcon symbol={op.symbol} size={20} />
            <span className="font-bold text-base text-foreground">{op.symbol?.replace('USDT', '/USDT')}</span>
            <span className="flex items-center gap-0.5 text-10px font-mono px-1.5 py-0.5 rounded font-bold"
              style={{ background: `${sideColor}1f`, color: sideColor, border: `1px solid ${sideColor}4d` }}>
              {isBuy ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
              {op.side}
            </span>
            {/* Item 303: "15M" sozinho era o gráfico da ENTRADA; o aviso veio do
                de 4H. O selo diz os dois ("4H → 15M"), como no Histórico. */}
            {tfChip && (
              <span className="text-10px font-mono" style={{ color: 'rgba(255,255,255,0.35)' }}>
                {tfChip}
              </span>
            )}
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-10px font-mono px-2 py-0.5 rounded shrink-0 font-semibold cursor-help" tabIndex={0}
                style={{ background: status.bg, color: status.color, border: `1px solid ${status.border}` }}>
                {status.short}
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-[260px] text-10px font-mono normal-case tracking-normal leading-relaxed">
              {status.desc}
            </TooltipContent>
          </Tooltip>
        </div>

        {/* 1.5 · Quando abriu — uma vez só, legível (item 303; antes era um
            texto de 9px a 25% de opacidade no cabeçalho). É o âncora de
            qualquer comparação posterior (item 161). */}
        {op.created_date && (
          <div className="flex items-center gap-1.5 text-11px font-mono flex-wrap" style={{ color: 'rgba(255,255,255,0.75)' }}>
            <Clock className="w-3 h-3 shrink-0" aria-hidden="true" style={{ color: 'rgba(255,255,255,0.45)' }} />
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="cursor-help" tabIndex={0}>Aberta em {fmtBRTLong(op.created_date)}</span>
              </TooltipTrigger>
              <TooltipContent className="max-w-[260px] text-10px font-mono normal-case tracking-normal leading-relaxed">
                Quando o Sentinel abriu esta operação (horário de Brasília).
              </TooltipContent>
            </Tooltip>
            {openFor && <span style={{ color: 'rgba(255,255,255,0.4)' }}>· há {openFor}</span>}
          </div>
        )}

        <BackfillBanner op={op} />
        <ProvenanceBanner op={op} />
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
              <span className="text-9px font-mono uppercase tracking-widest"
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
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="text-8px font-mono uppercase tracking-widest mt-1 cursor-help" tabIndex={0} style={{ color: 'rgba(255,255,255,0.3)' }}>
                    em aberto · bruto
                  </div>
                </TooltipTrigger>
                <TooltipContent className="max-w-[260px] text-10px font-mono normal-case tracking-normal leading-relaxed">
                  Resultado em aberto sobre a entrada, sem descontar taxas nem funding.
                </TooltipContent>
              </Tooltip>
            </div>
          )}
        </div>

        {/* 3 · Trilha: onde o preço está entre stop, entrada e alvos */}
        <LevelRail op={op} price={price} isStale={isStale} isOpen={isOpenOp} />

        {/* 4 · O que acontece a seguir */}
        {isOpenOp && <MilestoneLine op={op} price={price} isStale={isStale} />}

        {/* 4.2 · Com quanto fecha se bater no stop agora (item 303) */}
        <GuaranteeLine op={op} />

        {/* 4.5 · Por quê — resumo sempre visível, achado de clareza acima */}
        <OperationWhySummary op={op} />

        {/* 4.7 · O que aconteceu até agora (item 303) */}
        {isOpenOp && <OpenStory op={op} />}

        {/* 5 · O porquê completo (evidência numérica), a um clique */}
        <button onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="flex items-center gap-1 text-10px font-mono transition-colors hover:text-foreground/70"
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
