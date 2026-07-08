import React, { useState, useEffect } from 'react';
import { backend } from '@/api/entities';
import { Save, Copy, RefreshCw, Code2, AlertTriangle, CheckCircle2, Info, Layers, Zap } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { savePineConfig, getPineConfig, syncPineToAssets } from '@/lib/pineParser';
import { logInfo } from '@/lib/logger';

// Full NE RF v12 script stored as raw string — no template literal conflicts
const PINE_V12_LINES = [
  '//@version=6',
  'strategy(',
  '     title           = "NEW ERA - Range Filter Strategy v12",',
  '     shorttitle      = "NE RF v12",',
  '     overlay         = true,',
  '     initial_capital = 10000,',
  '     commission_type = strategy.commission.percent,',
  '     commission_value = 0.05,',
  '     slippage        = 1,',
  '     pyramiding      = 0,',
  '     process_orders_on_close = true,',
  '     margin_long     = 100,',
  '     margin_short    = 100,',
  '     max_labels_count = 500',
  ')',
  '',
  '// ====================================================================',
  '// FUNÇÕES',
  '// ====================================================================',
  'rng_size(float x, float qty, int n) =>',
  '    int   wper  = n * 2 - 1',
  '    float avrng = ta.ema(math.abs(x - x[1]), n)',
  '    float ac    = ta.ema(avrng, wper) * qty',
  '    ac',
  '',
  'rng_filt(float x, float r) =>',
  '    var float rf = na',
  '    float prev   = nz(rf[1], x)',
  '    rf := x - r > prev ? x - r : x + r < prev ? x + r : prev',
  '    float hi_band = rf + r',
  '    float lo_band = rf - r',
  '    [hi_band, lo_band, rf]',
  '',
  'getMtfDir(float qty, int per) =>',
  '    [_hb, _lb, _f] = rng_filt(close, rng_size(close, qty, per))',
  '    var float _fdir = 0.0',
  '    _fdir := _f > _f[1] ? 1.0 : _f < _f[1] ? -1.0 : nz(_fdir[1], 0.0)',
  '    _fdir',
  '',
  '// ====================================================================',
  '// GRUPO 01 — RANGE FILTER',
  '// ====================================================================',
  'groupRF  = "01. Range Filter"',
  'rng_src  = input.source(close, "Fonte",            group = groupRF)',
  'rng_per  = input.int(20,       "Swing Period",     group = groupRF, minval = 1)',
  'rng_qty  = input.float(3.5,    "Swing Multiplier", group = groupRF, minval = 0.0000001)',
  '',
  '// ====================================================================',
  '// GRUPO 02 — CONFIRMAÇÃO DO SINAL',
  '// ====================================================================',
  'groupConfirm    = "02. Confirmação do Sinal"',
  'onlyClosedCandles = input.bool(true, "Confirmar somente com candle fechado", group = groupConfirm)',
  'confirmBars       = input.int(1,     "Candles de validação após o sinal",    group = groupConfirm, minval = 1, maxval = 5)',
  'minScore          = input.int(75,    "Score mínimo para entrada (0-100)",    group = groupConfirm, minval = 0, maxval = 100)',
  '',
  '// ====================================================================',
  '// GRUPO 03 — AUTO-AJUSTE POR TIPO DE ATIVO',
  '// ====================================================================',
  'groupTier      = "03. Auto-Ajuste por Tipo de Ativo"',
  'tierMode       = input.string("Automático", "Modo de classificação",',
  '     options   = ["Automático","Forçar Tier 1 (Blue chip)","Forçar Tier 2 (Mid cap)","Forçar Tier 3 (Altcoin)"],',
  '     group     = groupTier)',
  'tier2Threshold = input.float(0.8, "ATR% mínimo Tier 2", group = groupTier, minval = 0.1, step = 0.1)',
  'tier3Threshold = input.float(1.5, "ATR% mínimo Tier 3", group = groupTier, minval = 0.1, step = 0.1)',
  '',
  '// ====================================================================',
  '// GRUPO 04 — FILTRO MULTI-TIMEFRAME (4h)',
  '// ====================================================================',
  'groupMTF  = "04. Filtro Timeframe Superior (4h)"',
  'useMTF    = input.bool(true,       "Ativar filtro 4h",     group = groupMTF)',
  'mtfTF     = input.timeframe("240", "Timeframe superior",   group = groupMTF)',
  'mtfRngPer = input.int(20,          "MTF Swing Period",     group = groupMTF, minval = 1)',
  'mtfRngQty = input.float(3.5,       "MTF Swing Multiplier", group = groupMTF, minval = 0.0000001)',
  '',
  '// ====================================================================',
  '// GRUPO 05 — FILTROS DE REGIME',
  '// ====================================================================',
  'groupRegime = "05. Filtros de Regime de Mercado"',
  'useADX    = input.bool(true, "Usar filtro ADX",              group = groupRegime)',
  'adxLen    = input.int(14,    "ADX — Período",                group = groupRegime, minval = 1)',
  'adxSmooth = input.int(14,    "ADX — Suavização",             group = groupRegime, minval = 1)',
  'useChop   = input.bool(true, "Usar filtro Choppiness Index", group = groupRegime)',
  'chopLen   = input.int(14,    "Choppiness — Período",         group = groupRegime, minval = 2)',
  '',
  '// ====================================================================',
  '// GRUPO 06 — FILTRO DE SESSÃO',
  '// ====================================================================',
  'groupSession     = "06. Filtro de Sessão"',
  'useSessionFilter = input.bool(false, "Ativar filtro de sessão",            group = groupSession)',
  'sessionTimezone  = input.string("America/Sao_Paulo", "Fuso horário",       group = groupSession)',
  'useFxSession     = input.bool(false, "Forex: Londres/NY (08h-17h UTC)",    group = groupSession)',
  'useBRSession     = input.bool(false, "Futuros BR: 09h-18h Brasília",       group = groupSession)',
  '',
  '// ====================================================================',
  '// GRUPO 07 — INDICADORES DE APOIO',
  '// ====================================================================',
  'groupInd   = "07. Indicadores de Apoio"',
  'emaFastLen = input.int(20, "EMA rápida",   group = groupInd, minval = 1)',
  'emaSlowLen = input.int(50, "EMA lenta",    group = groupInd, minval = 1)',
  'rsiLen     = input.int(14, "RSI período",  group = groupInd, minval = 1)',
  'volLen     = input.int(20, "Volume média", group = groupInd, minval = 1)',
  '',
  '// ====================================================================',
  '// GRUPO 08 — GESTÃO DA OPERAÇÃO',
  '// ====================================================================',
  'groupRisk     = "08. Gestão da Operação"',
  'orderSizePct  = input.float(100.0, "% do capital por operação",  group = groupRisk, minval = 0.1, maxval = 100.0, step = 0.5)',
  'atrLen        = input.int(14,      "ATR período",                group = groupRisk, minval = 1)',
  'tp1R          = input.float(1.5,   "TP1 em R (1.5 = equilíbrio)",group = groupRisk, minval = 0.1, step = 0.1)',
  'tp1QtyPercent = input.float(50.0,  "% para realizar no TP1",    group = groupRisk, minval = 1.0, maxval = 99.0, step = 1.0)',
  'trailAtrMult  = input.float(2.0,   "Trailing ATR multiplicador",  group = groupRisk, minval = 0.1, step = 0.1)',
  'exitMode      = input.string("Híbrido RF + ATR", "Modo de saída do runner",',
  '     options  = ["Range Filter","ATR Trailing","Híbrido RF + ATR"],',
  '     group    = groupRisk)',
  'useChopExit    = input.bool(false, "Fechar se mercado lateralizar (Chop Exit)", group = groupRisk)',
  'useTimeStop    = input.bool(true,  "Ativar time stop",                          group = groupRisk)',
  'timeStopT1     = input.int(48,     "Time stop — Tier 1 (candles)",              group = groupRisk, minval = 5, maxval = 500)',
  'timeStopT2     = input.int(64,     "Time stop — Tier 2 (candles)",              group = groupRisk, minval = 5, maxval = 500)',
  'timeStopT3     = input.int(96,     "Time stop — Tier 3 (candles)",              group = groupRisk, minval = 5, maxval = 500)',
  'useInvalidation = input.bool(false, "Ativar invalidação por RF/Score",           group = groupRisk)',
  'invalidRFBars   = input.int(2,     "Candles consecutivos RF para invalidar",    group = groupRisk, minval = 1, maxval = 5)',
  'invalidScoreMin = input.int(75,    "Score contrário mínimo para invalidar",     group = groupRisk, minval = 50, maxval = 100)',
  '',
  '// ====================================================================',
  '// GRUPO 09 — VISUAL',
  '// ====================================================================',
  'groupStyle    = "09. Visual / Cores"',
  'showBarColor  = input.bool(false, "Colorir candles",              group = groupStyle)',
  'showEMA200    = input.bool(true,  "Mostrar EMA 200 (visual)",     group = groupStyle)',
  'showRiskBox   = input.bool(true,  "Mostrar caixa de risco/lucro", group = groupStyle)',
  'tableMode     = input.string("Compacta", "Tabela de debug",',
  '     options  = ["Compacta","Completa","Oculta"],',
  '     group    = groupStyle)',
  'timezoneInput = input.string("America/Sao_Paulo", "Fuso horário da análise", group = groupStyle)',
  '',
  '// ====================================================================',
  '// GRUPO 10 — CONFIGURAÇÃO DO BOT / WEBHOOK',
  '// ====================================================================',
  'groupBot      = "10. Configuração do Bot / Webhook"',
  'webhookSecret = input.string("MEU_SECRET_AQUI", "Webhook Secret (mesmo do bot Python)", group = groupBot)',
  '',
  '// ====================================================================',
  '// CÁLCULO PRINCIPAL — RANGE FILTER',
  '// ====================================================================',
  '[h_band, l_band, filt] = rng_filt(rng_src, rng_size(rng_src, rng_qty, rng_per))',
  '',
  'var float fdir = 0.0',
  'fdir := filt > filt[1] ? 1 : filt < filt[1] ? -1 : nz(fdir[1], 0)',
  '',
  'bool upward   = fdir == 1',
  'bool downward = fdir == -1',
  '',
  'bool longCond  = (rng_src > filt and rng_src > rng_src[1] and upward)  or (rng_src > filt and rng_src < rng_src[1] and upward)',
  'bool shortCond = (rng_src < filt and rng_src < rng_src[1] and downward) or (rng_src < filt and rng_src > rng_src[1] and downward)',
  '',
  'var int condIni = 0',
  'condIni := longCond ? 1 : shortCond ? -1 : nz(condIni[1], 0)',
  '',
  'bool longSignalRaw  = longCond  and nz(condIni[1], 0) == -1',
  'bool shortSignalRaw = shortCond and nz(condIni[1], 0) == 1',
  '',
  '// ====================================================================',
  '// SCORE 0–100',
  '// ====================================================================',
  'float emaFast  = ta.ema(close, emaFastLen)',
  'float emaSlow  = ta.ema(close, emaSlowLen)',
  'float ema200   = ta.ema(close, 200)',
  '[macdLine, macdSignal, macdHist] = ta.macd(close, 12, 26, 9)',
  'float rsi      = ta.rsi(close, rsiLen)',
  'float volMa    = ta.sma(volume, volLen)',
  'bool  volumeOk = volume > volMa',
  '',
  'int buyScore = 0',
  'buyScore += longCond    ? 25 : 0',
  'buyScore += macdHist > 0 ? 20 : 0',
  'buyScore += emaFast > emaSlow ? 20 : 0',
  'buyScore += (ta.crossover(rsi, 50) or (rsi > 50 and rsi[1] > 50 and rsi[2] < 50)) ? 15 : 0',
  'buyScore += volumeOk   ? 10 : 0',
  'buyScore += close > filt ? 10 : 0',
  '',
  'int sellScore = 0',
  'sellScore += shortCond   ? 25 : 0',
  'sellScore += macdHist < 0 ? 20 : 0',
  'sellScore += emaFast < emaSlow ? 20 : 0',
  'sellScore += (ta.crossunder(rsi, 50) or (rsi < 50 and rsi[1] < 50 and rsi[2] > 50)) ? 15 : 0',
  'sellScore += volumeOk   ? 10 : 0',
  'sellScore += close < filt ? 10 : 0',
  '',
  '// ====================================================================',
  '// FILTRO MULTI-TIMEFRAME (4h)',
  '// ====================================================================',
  'float mtfDir     = request.security(syminfo.tickerid, mtfTF, getMtfDir(mtfRngQty, mtfRngPer), lookahead = barmerge.lookahead_off)',
  'bool  mtfLongOk  = not useMTF or mtfDir == 1.0',
  'bool  mtfShortOk = not useMTF or mtfDir == -1.0',
  '',
  '// ====================================================================',
  '// GATE FINAL',
  '// ====================================================================',
  'bool candleConfirmed = onlyClosedCandles ? barstate.isconfirmed : true',
  '[diPlus, diMinus, adxVal] = ta.dmi(adxLen, adxSmooth)',
  '',
  'float atrRaw       = ta.atr(atrLen)',
  'float atrPct       = atrRaw / close * 100.0',
  'float atrPctSmooth = ta.sma(atrPct, 20)',
  'int activeTier     = atrPctSmooth >= tier3Threshold ? 3 : atrPctSmooth >= tier2Threshold ? 2 : 1',
  'float atrStopMult  = activeTier == 3 ? 3.0 : activeTier == 2 ? 2.5 : 2.0',
  'float adxMinVal    = activeTier == 3 ? 18.0 : activeTier == 2 ? 22.0 : 25.0',
  'float chopMaxVal   = activeTier == 3 ? 62.0 : activeTier == 2 ? 58.0 : 55.0',
  '',
  'float chopHighest  = ta.highest(high, chopLen)',
  'float chopLowest   = ta.lowest(low,  chopLen)',
  'float chopRange    = chopHighest - chopLowest',
  'float chopAtrSum   = math.sum(ta.tr(true), chopLen)',
  'float chopIndex    = chopRange > 0 ? 100.0 * math.log10(chopAtrSum / chopRange) / math.log10(chopLen) : 50.0',
  '',
  'bool adxOk     = not useADX  or adxVal    >= adxMinVal',
  'bool chopOk    = not useChop or chopIndex <= chopMaxVal',
  'bool allFilters = adxOk and chopOk',
  '',
  'int barsSinceBuy  = ta.barssince(longSignalRaw)',
  'int barsSinceSell = ta.barssince(shortSignalRaw)',
  'bool freshBuy     = not na(barsSinceBuy)  and barsSinceBuy  == confirmBars - 1',
  'bool freshSell    = not na(barsSinceSell) and barsSinceSell == confirmBars - 1',
  '',
  'bool finalBuy  = candleConfirmed and freshBuy  and buyScore  >= minScore and allFilters and mtfLongOk',
  'bool finalSell = candleConfirmed and freshSell and sellScore >= minScore and allFilters and mtfShortOk',
  '',
  '// ====================================================================',
  '// ENTRADAS',
  '// ====================================================================',
  'float atr = atrRaw',
  'float orderCapital = strategy.equity * (orderSizePct / 100.0)',
  'float orderQty     = orderCapital / close',
  '',
  'if finalBuy and strategy.position_size <= 0',
  '    strategy.entry("BUY", strategy.long, qty = orderQty)',
  '',
  'if finalSell and strategy.position_size >= 0',
  '    strategy.entry("SELL", strategy.short, qty = orderQty)',
  '',
  '// ====================================================================',
  '// SAÍDAS',
  '// ====================================================================',
  'float longStop  = strategy.position_size > 0 ? strategy.position_avg_price - atr * atrStopMult : na',
  'float shortStop = strategy.position_size < 0 ? strategy.position_avg_price + atr * atrStopMult : na',
  'float longTp1   = strategy.position_size > 0 ? strategy.position_avg_price + (atr * atrStopMult) * tp1R : na',
  'float shortTp1  = strategy.position_size < 0 ? strategy.position_avg_price - (atr * atrStopMult) * tp1R : na',
  '',
  'if strategy.position_size > 0',
  '    strategy.exit("BUY TP1",    from_entry="BUY", qty_percent=tp1QtyPercent,           stop=longStop, limit=longTp1)',
  '    strategy.exit("BUY RUNNER", from_entry="BUY", qty_percent=100.0 - tp1QtyPercent,   stop=longStop)',
  '',
  'if strategy.position_size < 0',
  '    strategy.exit("SELL TP1",    from_entry="SELL", qty_percent=tp1QtyPercent,          stop=shortStop, limit=shortTp1)',
  '    strategy.exit("SELL RUNNER", from_entry="SELL", qty_percent=100.0 - tp1QtyPercent,  stop=shortStop)',
  '',
  '// ====================================================================',
  '// VISUAL',
  '// ====================================================================',
  'color filtColor = upward ? color.new(color.green,20) : downward ? color.new(color.red,20) : color.new(color.gray,20)',
  'fPlot = plot(filt,   "Range Filter", color=filtColor, linewidth=3)',
  'hPlot = plot(h_band, "High Band",    color=color.new(color.green,100))',
  'lPlot = plot(l_band, "Low Band",     color=color.new(color.red,100))',
  'fill(hPlot, fPlot, color=color.new(color.green,92))',
  'fill(lPlot, fPlot, color=color.new(color.red,92))',
  'plot(emaFast, "EMA Fast", color=color.new(color.aqua,40))',
  'plot(emaSlow, "EMA Slow", color=color.new(color.orange,40))',
  'plot(showEMA200 ? ema200 : na, "EMA 200", color=color.new(color.purple,30), linewidth=2)',
  '',
  'plotshape(finalBuy,  title="BUY",  style=shape.triangleup,   location=location.belowbar, color=color.new(color.green,0), size=size.large)',
  'plotshape(finalSell, title="SELL", style=shape.triangledown, location=location.abovebar, color=color.new(color.red,0),   size=size.large)',
  '',
  '// Regime bloqueado: fundo laranja',
  'bgcolor(not allFilters ? color.new(color.orange,90) : na, title="Regime bloqueado")',
];

const DEFAULT_PINE = PINE_V12_LINES.join('\n');

const SYNC_NOTES = [
  { icon: '🔄', label: 'rng_per / rng_qty (RF Period / Multiplier)', desc: 'Sincronizado com MonitoredAsset.rf_period e rf_multiplier — padrão 20 / 3.5' },
  { icon: '📊', label: 'ADX + Choppiness (Filtros de Regime)', desc: 'ADX mín e Chop máx são auto-ajustados pelo Tier do ativo (ATR%)' },
  { icon: '🏗️', label: 'Auto-Tier: T1 / T2 / T3', desc: 'T1 Blue chip ATR%<0.8 → stop 2x | T2 Mid cap → 2.5x | T3 Altcoin → 3x' },
  { icon: '📈', label: 'Filtro MTF 4h (mtfTF = "240")', desc: 'Scanner valida direção 4h antes de emitir sinal — só entra a favor do 4h' },
  { icon: '⏱️', label: 'Entrada em 15m após sinal 4h', desc: 'Scanner detecta sinal 4h e aguarda confirmação no 15m para entrada precisa' },
  { icon: '⚡', label: 'Score 0–100 (minScore = 75)', desc: 'BuyScore/SellScore calculados via RF+MACD+EMA+RSI+Volume — mínimo 75 para entrar' },
  { icon: '🎯', label: 'TP1 em 1.5R + Runner', desc: 'TP1 = entry ± (atr * atrStopMult) * 1.5 | Runner com trailing ATR ou RF exit' },
  { icon: '🛑', label: 'Stop = entry ± atr * atrStopMult', desc: 'Stop dinâmico por Tier: 2x / 2.5x / 3x ATR — move para BE após TP1' },
  { icon: '⏰', label: 'Time Stop por Tier', desc: 'T1: 48 candles | T2: 64 candles | T3: 96 candles sem TP1 → fecha posição' },
];

export default function PineScript() {
  const queryClient = useQueryClient();
  const [code, setCode] = useState(() => localStorage.getItem('pine_script_code_v12') || DEFAULT_PINE);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [activeTab, setActiveTab] = useState('editor');
  const [syncStatus, setSyncStatus] = useState(null); // null | 'syncing' | 'synced' | 'error'
  const [parsedConfig, setParsedConfig] = useState(() => getPineConfig());

  const { data: assets = [] } = useQuery({
    queryKey: ['all-assets'],
    queryFn: () => backend.entities.MonitoredAsset.list('-created_date'),
  });

  const handleSave = async () => {
    localStorage.setItem('pine_script_code_v12', code);
    // Parse Pine Script and persist config — scanner reads this automatically
    const config = savePineConfig(code);
    setParsedConfig(config);
    setSaved(true);

    // Auto-sync RF parameters to all active assets
    setSyncStatus('syncing');
    try {
      const updated = await syncPineToAssets();
      queryClient.invalidateQueries({ queryKey: ['all-assets'] });
      setSyncStatus('synced');
      logInfo('pine', `Pine Script sincronizado — ${updated} ativo(s) atualizado(s)`, {
        rng_per: config.rng_per, rng_qty: config.rng_qty, minScore: config.minScore,
      });
      setTimeout(() => setSyncStatus(null), 3000);
    } catch {
      setSyncStatus('error');
      setTimeout(() => setSyncStatus(null), 3000);
    }

    setTimeout(() => setSaved(false), 2000);
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleReset = () => {
    if (confirm('Restaurar o NE RF v12 padrão? Isso vai sobrescrever as edições.')) {
      setCode(DEFAULT_PINE);
      localStorage.setItem('pine_script_code_v12', DEFAULT_PINE);
    }
  };

  useEffect(() => {
    const t = setTimeout(() => {
      localStorage.setItem('pine_script_code_v12', code);
      // Auto-parse on edit so config is always fresh
      const config = savePineConfig(code);
      setParsedConfig(config);
    }, 1000);
    return () => clearTimeout(t);
  }, [code]);

  return (
    <div className="space-y-5 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <p className="text-[11px] font-mono uppercase tracking-[0.2em] text-muted-foreground mb-1">Estratégia</p>
          <h1 className="text-3xl font-bold text-foreground tracking-tight">Pine Script</h1>
          <p className="text-[10px] font-mono text-muted-foreground mt-1">NEW ERA — Range Filter Strategy v12</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1.5 text-[9px] font-mono px-2 py-1 rounded"
            style={{ background: 'rgba(0,255,128,0.08)', border: '1px solid rgba(0,255,128,0.2)', color: '#00ff80' }}>
            <span className="w-1.5 h-1.5 rounded-full inline-block" style={{ background: '#00ff80', boxShadow: '0 0 4px #00ff80' }} />
            v12 · MTF 4h + Entrada 15m
          </div>
          {/* Auto-sync indicator */}
          <div className="flex items-center gap-1.5 text-[9px] font-mono px-2 py-1 rounded"
            style={{
              background: syncStatus === 'syncing' ? 'rgba(0,229,255,0.1)' : syncStatus === 'synced' ? 'rgba(0,255,128,0.1)' : syncStatus === 'error' ? 'rgba(255,20,120,0.1)' : 'rgba(0,229,255,0.06)',
              border: syncStatus === 'syncing' ? '1px solid rgba(0,229,255,0.3)' : syncStatus === 'synced' ? '1px solid rgba(0,255,128,0.3)' : syncStatus === 'error' ? '1px solid rgba(255,20,120,0.3)' : '1px solid rgba(0,229,255,0.15)',
            }}>
            <Zap className={`w-3 h-3 ${syncStatus === 'syncing' ? 'animate-spin' : ''}`} style={{
              color: syncStatus === 'syncing' ? '#00e5ff' : syncStatus === 'synced' ? '#00ff80' : syncStatus === 'error' ? '#ff1478' : 'rgba(0,229,255,0.5)',
            }} />
            <span style={{
              color: syncStatus === 'syncing' ? '#00e5ff' : syncStatus === 'synced' ? '#00ff80' : syncStatus === 'error' ? '#ff1478' : 'rgba(0,229,255,0.5)',
            }}>
              {syncStatus === 'syncing' ? 'Sincronizando...' : syncStatus === 'synced' ? '✓ Auto-sync OK' : syncStatus === 'error' ? 'Erro sync' : 'Auto-sync ativo'}
            </span>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1">
        {[
          { id: 'editor', label: '📝 Editor v12', icon: Code2 },
          { id: 'sync', label: '🔄 Sincronização', icon: Layers },
          { id: 'params', label: '⚙️ Parâmetros Ativos', icon: Info },
        ].map(tab => (
          <button key={tab.id} onClick={() => setActiveTab(tab.id)}
            className="text-[10px] font-mono px-3 py-2 rounded-lg transition-all"
            style={activeTab === tab.id
              ? { background: 'rgba(0,229,255,0.12)', border: '1px solid rgba(0,229,255,0.3)', color: '#00e5ff' }
              : { background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.4)' }}>
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'editor' && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <button onClick={handleSave}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-mono font-bold transition-all"
              style={{ background: saved ? 'rgba(0,255,128,0.15)' : 'rgba(0,255,128,0.08)', border: '1px solid rgba(0,255,128,0.3)', color: '#00ff80' }}>
              {saved ? <CheckCircle2 className="w-3 h-3" /> : <Save className="w-3 h-3" />}
              {saved ? 'Salvo!' : 'Salvar'}
            </button>
            <button onClick={handleCopy}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-mono transition-all"
              style={{ background: 'rgba(0,229,255,0.07)', border: '1px solid rgba(0,229,255,0.2)', color: '#00e5ff' }}>
              <Copy className="w-3 h-3" />
              {copied ? 'Copiado!' : 'Copiar'}
            </button>
            <button onClick={handleReset}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-mono transition-all"
              style={{ background: 'rgba(255,159,67,0.07)', border: '1px solid rgba(255,159,67,0.2)', color: '#ff9f43' }}>
              <RefreshCw className="w-3 h-3" />Restaurar v12
            </button>
            <span className="text-[9px] font-mono text-muted-foreground ml-auto">Auto-salvo · {code.split('\n').length} linhas</span>
          </div>

          <div className="relative rounded-xl overflow-hidden" style={{ border: '1px solid rgba(0,255,128,0.15)' }}>
            <div className="flex items-center gap-2 px-4 py-2" style={{ background: 'rgba(6,8,15,0.9)', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
              <Code2 className="w-3 h-3" style={{ color: '#00e5ff' }} />
              <span className="text-[9px] font-mono" style={{ color: '#00e5ff' }}>NE_RF_v12.pine</span>
              <span className="text-[8px] font-mono px-1.5 py-0.5 rounded ml-2"
                style={{ background: 'rgba(0,229,255,0.1)', border: '1px solid rgba(0,229,255,0.2)', color: '#00e5ff' }}>
                @version=6
              </span>
              <div className="flex gap-1 ml-auto">
                <span className="w-2.5 h-2.5 rounded-full" style={{ background: '#ff5f57' }} />
                <span className="w-2.5 h-2.5 rounded-full" style={{ background: '#febc2e' }} />
                <span className="w-2.5 h-2.5 rounded-full" style={{ background: '#28c840' }} />
              </div>
            </div>
            <textarea
              value={code}
              onChange={e => setCode(e.target.value)}
              spellCheck={false}
              className="w-full font-mono text-[11px] outline-none resize-none leading-relaxed p-4"
              style={{ background: 'rgba(6,8,15,0.95)', color: 'rgba(0,255,128,0.85)', minHeight: '60vh', tabSize: 4 }}
            />
          </div>

          <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg text-[9px] font-mono"
            style={{ background: 'rgba(0,229,255,0.05)', border: '1px solid rgba(0,229,255,0.12)', color: 'rgba(0,229,255,0.6)' }}>
            <Info className="w-3 h-3 shrink-0 mt-0.5" />
            <span>
              <strong style={{ color: '#00e5ff' }}>Sincronização automática ativa.</strong> Ao salvar, o sistema
              extrai os parâmetros do Pine Script (rng_per, rng_qty, minScore, ATR mult, TP1R, etc.) e os
              aplica automaticamente ao scanner e aos ativos — <strong style={{ color: '#00ff80' }}>sem precisar
              alterar nada no bot</strong>. Os parâmetros ativos são:
            </span>
          </div>
          {/* Parsed config preview */}
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
            {[
              { label: 'RF Period', value: parsedConfig.rng_per, pine: 'rng_per' },
              { label: 'RF Mult', value: parsedConfig.rng_qty, pine: 'rng_qty' },
              { label: 'Min Score', value: parsedConfig.minScore, pine: 'minScore' },
              { label: 'ATR Mult', value: parsedConfig.trailAtrMult, pine: 'trailAtrMult' },
              { label: 'TP1 R', value: parsedConfig.tp1R, pine: 'tp1R' },
              { label: 'TP1 %', value: parsedConfig.tp1QtyPercent, pine: 'tp1QtyPercent' },
            ].map(p => (
              <div key={p.label} className="rounded-lg px-2 py-2 text-center"
                style={{ background: 'rgba(0,255,128,0.04)', border: '1px solid rgba(0,255,128,0.1)' }}>
                <div className="text-[8px] font-mono text-muted-foreground">{p.label}</div>
                <div className="text-sm font-mono font-bold" style={{ color: '#00ff80' }}>{p.value}</div>
                <div className="text-[7px] font-mono" style={{ color: 'rgba(0,255,128,0.35)' }}>{p.pine}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {activeTab === 'sync' && (
        <div className="space-y-3">
          <div className="rounded-xl p-4 space-y-3" style={{ background: 'rgba(10,13,22,0.85)', border: '1px solid rgba(0,255,128,0.12)' }}>
            <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest mb-2">🔗 NE RF v12 → Sistema</div>
            {SYNC_NOTES.map(note => (
              <div key={note.label} className="flex items-start gap-3 py-2.5 px-3 rounded-lg"
                style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)' }}>
                <span className="text-base shrink-0">{note.icon}</span>
                <div className="min-w-0">
                  <div className="text-[10px] font-mono font-bold text-foreground">{note.label}</div>
                  <div className="text-[9px] font-mono text-muted-foreground mt-0.5">{note.desc}</div>
                </div>
                <CheckCircle2 className="w-3.5 h-3.5 shrink-0 ml-auto mt-0.5" style={{ color: '#00ff80' }} />
              </div>
            ))}
          </div>

          <div className="rounded-xl p-4 space-y-2" style={{ background: 'rgba(255,159,67,0.05)', border: '1px solid rgba(255,159,67,0.15)' }}>
            <div className="flex items-center gap-2 text-[10px] font-mono" style={{ color: '#ff9f43' }}>
              <AlertTriangle className="w-3.5 h-3.5" />
              <span className="font-bold">Fluxo de entrada 4h → 15m</span>
            </div>
            <div className="text-[9px] font-mono space-y-1.5" style={{ color: 'rgba(255,255,255,0.5)' }}>
              <p>1. Scanner detecta sinal RF no <span className="text-yellow-400">4h</span> com score ≥ 75 e direção MTF alinhada</p>
              <p>2. Sistema entra em modo de observação no <span className="text-yellow-400">15m</span> para aquele ativo</p>
              <p>3. Aguarda confirmação RF no 15m <strong className="text-white">na mesma direção</strong> do 4h</p>
              <p>4. Quando o 15m confirma, cria o TradeOperation com entry/stop/TP do 4h (ATR do 4h)</p>
              <p>5. Stop loss e targets são calculados usando o ATR do <span className="text-yellow-400">4h</span> para preservar o R:R</p>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'params' && (
        <div className="space-y-3">
          <div className="text-[10px] font-mono text-muted-foreground mb-2">
            Parâmetros NE RF v12 por ativo — sincronizados com o scanner:
          </div>
          {assets.length === 0 ? (
            <div className="rounded-xl p-8 text-center" style={{ background: 'rgba(10,13,22,0.7)', border: '1px solid rgba(255,255,255,0.06)' }}>
              <p className="text-sm text-muted-foreground">Nenhum ativo cadastrado.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {assets.map(asset => (
                <div key={asset.id} className="rounded-xl p-4"
                  style={{ background: 'rgba(10,13,22,0.85)', border: asset.is_active ? '1px solid rgba(0,255,128,0.1)' : '1px solid rgba(255,255,255,0.05)' }}>
                  <div className="flex items-center gap-2 mb-3">
                    <span className="font-bold text-sm text-foreground">{asset.display_name}</span>
                    <span className="text-[8px] font-mono px-1.5 py-0.5 rounded"
                      style={asset.is_active
                        ? { background: 'rgba(0,255,128,0.1)', color: '#00ff80', border: '1px solid rgba(0,255,128,0.2)' }
                        : { background: 'rgba(255,255,255,0.04)', color: 'rgba(255,255,255,0.3)', border: '1px solid rgba(255,255,255,0.07)' }}>
                      {asset.is_active ? 'ATIVO' : 'INATIVO'}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 gap-2">
                    {[
                      { label: 'RF Period', value: asset.rf_period ?? 20, pine: 'rng_per' },
                      { label: 'RF Mult', value: asset.rf_multiplier ?? 3.5, pine: 'rng_qty' },
                      { label: 'RSI Period', value: asset.rsi_period ?? 14, pine: 'rsiLen' },
                      { label: 'MACD Fast', value: asset.macd_fast ?? 12, pine: 'emaFastLen' },
                      { label: 'EMA Short', value: asset.ema_short ?? 20, pine: 'emaFastLen' },
                      { label: 'EMA Long', value: asset.ema_long ?? 50, pine: 'emaSlowLen' },
                    ].map(p => (
                      <div key={p.label} className="rounded-lg px-2.5 py-2"
                        style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)' }}>
                        <div className="text-[8px] font-mono text-muted-foreground">{p.label}</div>
                        <div className="text-sm font-mono font-bold text-foreground mt-0.5">{p.value}</div>
                        <div className="text-[7px] font-mono" style={{ color: 'rgba(0,255,128,0.4)' }}>{p.pine}</div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}