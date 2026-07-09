import React, { useState, useEffect } from 'react';
import { backend } from '@/api/entities';
import { Save, Copy, RefreshCw, Code2, AlertTriangle, CheckCircle2, Info, Layers, Zap } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { savePineConfig, getLocalPineConfig, getPineConfig, syncPineToAssets } from '@/lib/pineParser';
import { logInfo } from '@/lib/logger';

// Full NE RF v13.2 script — the real strategy configured on TradingView,
// stored as a template literal (the source has no backticks/${} to escape).
const DEFAULT_PINE = `//@version=6
strategy(
     title           = "NEW ERA - Range Filter Strategy v13.2",
     shorttitle      = "NE RF v13.2",
     overlay         = true,
     initial_capital = 10000,
     commission_type = strategy.commission.percent,
     commission_value = 0.05,
     slippage        = 1,
     pyramiding      = 0,
     process_orders_on_close = true,
     margin_long     = 100,
     margin_short    = 100,
     max_labels_count = 500
)

// ====================================================================
// v13 — MESMA ESTRATÉGIA DO v12 (nenhuma lógica de entrada/saída mudou)
// Só correções de engenharia validadas em auditoria + backtest:
//   1. Alertas JSON em TODAS as saídas (TP1, SL, runner, RF Exit)
//   2. Filtro 4h sem repaint (usa candle superior FECHADO)
//   3. Padrão canônico do runner (fecha 100% do restante, sem resíduo)
//   4. Símbolo limpo p/ API ("ETHUSDT.P" -> "ETHUSDT")
// v13.1: filtro superior corrigido para gráficos em TF igual/maior (ex.: 4h)
//        + novo modo "Clássico v12" para comparação com o backtest antigo
// v13.2: Grupo 11 — Janela de Backtest (treino/teste-cego no próprio TradingView)
// ====================================================================

// ====================================================================
// FUNÇÕES — declaradas primeiro
// ====================================================================
rng_size(float x, float qty, int n) =>
    int   wper  = n * 2 - 1
    float avrng = ta.ema(math.abs(x - x[1]), n)
    float ac    = ta.ema(avrng, wper) * qty
    ac

rng_filt(float x, float r) =>
    var float rf = na
    float prev   = nz(rf[1], x)
    rf := x - r > prev ? x - r : x + r < prev ? x + r : prev
    float hi_band = rf + r
    float lo_band = rf - r
    [hi_band, lo_band, rf]

// MTF: parâmetros passados como argumento para funcionar antes dos inputs
getMtfDir(float qty, int per) =>
    [_hb, _lb, _f] = rng_filt(close, rng_size(close, qty, per))
    var float _fdir = 0.0
    _fdir := _f > _f[1] ? 1.0 : _f < _f[1] ? -1.0 : nz(_fdir[1], 0.0)
    _fdir

// ====================================================================
// GRUPO 01 — RANGE FILTER
// ====================================================================
groupRF = "01. Range Filter"
rng_src = input.source(close, "Fonte",            group = groupRF)
rng_per = input.int(20,       "Swing Period",     group = groupRF, minval = 1)
rng_qty = input.float(3.5,    "Swing Multiplier", group = groupRF, minval = 0.0000001)

// ====================================================================
// GRUPO 02 — CONFIRMAÇÃO DO SINAL
// ====================================================================
groupConfirm = "02. Confirmação do Sinal"
onlyClosedCandles = input.bool(true,  "Confirmar somente com candle fechado", group = groupConfirm)
confirmBars       = input.int(1,      "Candles de validação após o sinal",    group = groupConfirm, minval = 1, maxval = 5)
minScore          = input.int(75,     "Score mínimo para entrada (0–100)",    group = groupConfirm, minval = 0, maxval = 100)

// ====================================================================
// GRUPO 03 — AUTO-AJUSTE POR TIPO DE ATIVO
// ====================================================================
// Detecta a volatilidade do ativo automaticamente e ajusta stop/ADX/Chop.
// T1 Blue chip (BTC/ETH): ATR% < 0.8 → stop 2x ATR
// T2 Mid cap (SOL/BNB):   ATR% 0.8–1.5 → stop 2.5x ATR
// T3 Altcoin (FET/AVAX):  ATR% > 1.5 → stop 3x ATR
groupTier = "03. Auto-Ajuste por Tipo de Ativo"
tierMode       = input.string("Automático", "Modo de classificação",
     options   = ["Automático","Forçar Tier 1 (Blue chip)","Forçar Tier 2 (Mid cap)","Forçar Tier 3 (Altcoin)"],
     group     = groupTier)
tier2Threshold = input.float(0.8,  "ATR% mínimo Tier 2", group = groupTier, minval = 0.1, step = 0.1)
tier3Threshold = input.float(1.5,  "ATR% mínimo Tier 3", group = groupTier, minval = 0.1, step = 0.1)

// ====================================================================
// GRUPO 04 — FILTRO MULTI-TIMEFRAME (4h)
// ====================================================================
groupMTF  = "04. Filtro Timeframe Superior (4h)"
useMTF    = input.bool(true,       "Ativar filtro 4h",    group = groupMTF)
mtfTF     = input.timeframe("240", "Timeframe superior",  group = groupMTF)
mtfRngPer = input.int(20,          "MTF Swing Period",    group = groupMTF, minval = 1)
mtfRngQty = input.float(3.5,       "MTF Swing Multiplier",group = groupMTF, minval = 0.0000001)

// ====================================================================
// GRUPO 05 — FILTROS DE REGIME
// ====================================================================
groupRegime = "05. Filtros de Regime de Mercado"
useADX    = input.bool(true, "Usar filtro ADX",              group = groupRegime)
adxLen    = input.int(14,    "ADX — Período",                group = groupRegime, minval = 1)
adxSmooth = input.int(14,    "ADX — Suavização",             group = groupRegime, minval = 1)
useChop   = input.bool(true, "Usar filtro Choppiness Index", group = groupRegime)
chopLen   = input.int(14,    "Choppiness — Período",         group = groupRegime, minval = 2)

// ====================================================================
// GRUPO 06 — FILTRO DE SESSÃO
// ====================================================================
groupSession     = "06. Filtro de Sessão"
useSessionFilter = input.bool(false,"Ativar filtro de sessão", group = groupSession)
sessionTimezone  = input.string("America/Sao_Paulo","Fuso horário", group = groupSession)
useFxSession     = input.bool(false,"Forex: Londres/NY (08h–17h UTC)", group = groupSession)
useBRSession     = input.bool(false,"Futuros BR: 09h–18h Brasília",    group = groupSession)
fxSession = "0800-1700"
brSession = "0900-1800"

// ====================================================================
// GRUPO 07 — INDICADORES DE APOIO
// ====================================================================
groupInd   = "07. Indicadores de Apoio"
emaFastLen = input.int(20, "EMA rápida",  group = groupInd, minval = 1)
emaSlowLen = input.int(50, "EMA lenta",   group = groupInd, minval = 1)
rsiLen     = input.int(14, "RSI período", group = groupInd, minval = 1)
volLen     = input.int(20, "Volume média",group = groupInd, minval = 1)

// ====================================================================
// GRUPO 08 — GESTÃO DA OPERAÇÃO
// ====================================================================
groupRisk = "08. Gestão da Operação"
// 100% = comparável com backtests anteriores
// Para bot real: use 10–20%
orderSizePct  = input.float(100.0, "% do capital por operação",       group = groupRisk, minval = 0.1, maxval = 100.0, step = 0.5, tooltip = "100% para backtest. Para bot real use 10–20%.")
atrLen        = input.int(14,      "ATR período",                      group = groupRisk, minval = 1)
tp1R          = input.float(1.5,   "TP1 em R (1.5 = equilíbrio)",      group = groupRisk, minval = 0.1, step = 0.1)
tp1QtyPercent = input.float(50.0,  "% para realizar no TP1",           group = groupRisk, minval = 1.0, maxval = 99.0, step = 1.0)
trailAtrMult  = input.float(2.0,   "Trailing ATR multiplicador",       group = groupRisk, minval = 0.1, step = 0.1)
exitMode      = input.string("Híbrido RF + ATR","Modo de saída do runner",
     options  = ["Range Filter","ATR Trailing","Híbrido RF + ATR"],
     group    = groupRisk)

// --- SAÍDA INTELIGENTE DURANTE O TRADE (antes do TP1) ---
// Chop Exit e Time Stop: testados e aprovados pela comunidade.
// Invalidação por RF/Score: disponível mas DESLIGADA por padrão.
// Motivo: no ETH 1h o RF oscila naturalmente — 1 candle de inversão é ruído.
// Se quiser testar a invalidação, ligue manualmente e avalie par a par.

// --- Chop Exit: fecha se mercado lateralizar ---
useChopExit    = input.bool(false, "Fechar se mercado lateralizar (Chop Exit)",  group = groupRisk,
     tooltip = "DESLIGADO por padrão — testado no ETH 1h e prejudicou o resultado. Ligue para testar par a par.")

// --- Time Stop: fecha se o trade ficar parado por muito tempo ---
useTimeStop    = input.bool(true,  "Ativar time stop (máx. candles no trade)",   group = groupRisk,
     tooltip = "LIGADO por padrão. Fecha o trade se TP1 não for atingido em N candles. O limite é automático por tier do ativo.")
timeStopT1     = input.int(48,     "Time stop — Tier 1 Blue chip (candles)",      group = groupRisk,
     minval = 5, maxval = 500,
     tooltip = "ETH, BTC: 48 candles = 2 dias no 1h. Testado e aprovado no ETH.")
timeStopT2     = input.int(64,     "Time stop — Tier 2 Mid cap (candles)",        group = groupRisk,
     minval = 5, maxval = 500,
     tooltip = "AVAX, BNB, SOL: 64 candles = 2,7 dias no 1h.")
timeStopT3     = input.int(96,     "Time stop — Tier 3 Altcoin (candles)",        group = groupRisk,
     minval = 5, maxval = 500,
     tooltip = "FET, PENDLE e altcoins: 96 candles = 4 dias no 1h. Altcoins levam mais tempo para desenvolver o trade.")

// --- Invalidação por RF/Score: DESLIGADA por padrão ---
// Testada no ETH 1h e produziu resultado pior que sem invalidação.
// Ligue só se quiser testar em altcoins com tendências mais limpas.
useInvalidation = input.bool(false, "Ativar invalidação por RF/Score (avançado — DESLIGADO por padrão)", group = groupRisk,
     tooltip = "Liga invalidação quando RF inverte ou score contrário surge. Desligado por padrão pois prejudicou ETH 1h. Teste par a par antes de ligar no bot.")
invalidRFBars   = input.int(2,     "Candles consecutivos RF para invalidar",     group = groupRisk,
     minval = 1, maxval = 5,
     tooltip = "Quantos candles consecutivos o RF precisa estar invertido antes de fechar. 2 = recomendado pela comunidade.")
invalidScoreMin = input.int(75,    "Score contrário mínimo para invalidar",      group = groupRisk,
     minval = 50, maxval = 100,
     tooltip = "Score na direção oposta para fechar a posição antes do TP1.")

// ====================================================================
// GRUPO 09 — VISUAL
// ====================================================================
groupStyle    = "09. Visual / Cores"
showBarColor  = input.bool(false,  "Colorir candles",            group = groupStyle)
showEMA200    = input.bool(true,   "Mostrar EMA 200 (visual)",   group = groupStyle)
showRiskBox   = input.bool(true,   "Mostrar caixa de risco/lucro", group = groupStyle, tooltip = "Caixa vermelha = zona de risco. Caixa verde = zona de lucro até TP1.")
tableMode     = input.string("Compacta","Tabela de debug",
     options  = ["Compacta","Completa","Oculta"],
     group    = groupStyle)
timezoneInput = input.string("America/Sao_Paulo","Fuso horário da análise", group = groupStyle)

buyColor      = input.color(#00b36b,"Cor BUY",              group = groupStyle)
sellColor     = input.color(#b8005d,"Cor SELL",             group = groupStyle)
bullColor     = input.color(#05ff9b,"Cor tendência alta",   group = groupStyle)
bearColor     = input.color(#ff0583,"Cor tendência baixa",  group = groupStyle)
neutralColor  = input.color(#cccccc,"Cor neutra",           group = groupStyle)
emaFastColor  = input.color(#00d8ff,"Cor EMA rápida",       group = groupStyle)
emaSlowColor  = input.color(#ffb000,"Cor EMA lenta",        group = groupStyle)
tp1Color      = input.color(#ffd166,"Cor TP1",              group = groupStyle)
stopColor     = input.color(#ff3b6b,"Cor Stop",             group = groupStyle)
debugBgColor  = input.color(#111827,"Cor fundo Debug",      group = groupStyle)
blockedColor  = input.color(#ff9900,"Cor regime bloqueado", group = groupStyle)
tier1Color    = input.color(#00d8ff,"Cor Tier 1",           group = groupStyle)
tier2Color    = input.color(#ffd166,"Cor Tier 2",           group = groupStyle)
tier3Color    = input.color(#ff9900,"Cor Tier 3",           group = groupStyle)
ema200Color   = input.color(#9b59b6,"Cor EMA 200",          group = groupStyle)

// ====================================================================
// GRUPO 10 — CONFIGURAÇÃO DO BOT / WEBHOOK
// ====================================================================
// O secret é enviado no JSON para o bot validar a origem do sinal.
// NUNCA compartilhe esse valor publicamente.
// Use o mesmo valor em WEBHOOK_SECRET no seu bot Python.
groupBot = "10. Configuração do Bot / Webhook"

webhookSecret = input.string("MEU_SECRET_AQUI", "Webhook Secret (mesmo do bot Python)", group = groupBot,
     tooltip = "Token secreto enviado em cada alerta. Configure o mesmo valor em WEBHOOK_SECRET no seu bot. Nunca use o valor padrão em produção.")

// v13 (fix 4): símbolo limpo para a API da Binance.
// No TradingView os perpétuos vêm como "ETHUSDT.P" — a Binance espera "ETHUSDT".
string apiSymbol = str.replace(syminfo.ticker, ".P", "")

// ====================================================================
// GRUPO 11 — JANELA DE BACKTEST (treino / teste-cego)
// ====================================================================
// Ferramenta de validação: ajuste a estratégia olhando só um período
// (treino) e depois avalie às cegas em outro período (teste), direto
// no TradingView. DESLIGADO por padrão = comportamento igual ao v13.1.
groupWindow = "11. Janela de Backtest (treino/teste)"
useDateFilter = input.bool(false, "Ativar janela de backtest", group = groupWindow,
     tooltip = "Quando ligado, a estratégia só abre trades entre a data inicial e a final. Uso correto: ajuste parâmetros olhando um período (treino) e depois avalie em um período que a estratégia nunca viu (teste-cego). Desligado = opera todo o histórico, idêntico ao v13.1.")
startDate = input.time(timestamp("01 Jan 2024 00:00 +0000"), "Data inicial", group = groupWindow)
endDate   = input.time(timestamp("01 Jan 2099 00:00 +0000"), "Data final",   group = groupWindow)


[h_band, l_band, filt] = rng_filt(rng_src, rng_size(rng_src, rng_qty, rng_per))

var float fdir = 0.0
fdir := filt > filt[1] ? 1 : filt < filt[1] ? -1 : nz(fdir[1], 0)

bool upward   = fdir == 1
bool downward = fdir == -1

bool longCond  = (rng_src > filt and rng_src > rng_src[1] and upward)  or (rng_src > filt and rng_src < rng_src[1] and upward)
bool shortCond = (rng_src < filt and rng_src < rng_src[1] and downward) or (rng_src < filt and rng_src > rng_src[1] and downward)

var int condIni = 0
condIni := longCond ? 1 : shortCond ? -1 : nz(condIni[1], 0)

bool longSignalRaw  = longCond  and nz(condIni[1], 0) == -1
bool shortSignalRaw = shortCond and nz(condIni[1], 0) == 1

// ====================================================================
// AUTO-AJUSTE — TIER DO ATIVO
// ====================================================================
float atrRaw       = ta.atr(atrLen)
float atrPct       = atrRaw / close * 100.0
float atrPctSmooth = ta.sma(atrPct, 20)

int detectedTier = atrPctSmooth >= tier3Threshold ? 3 :
                   atrPctSmooth >= tier2Threshold ? 2 : 1

int activeTier = tierMode == "Forçar Tier 1 (Blue chip)" ? 1 :
                 tierMode == "Forçar Tier 2 (Mid cap)"   ? 2 :
                 tierMode == "Forçar Tier 3 (Altcoin)"   ? 3 : detectedTier

// Parâmetros ajustados por tier
float atrStopMult = activeTier == 3 ? 3.0 : activeTier == 2 ? 2.5 : 2.0
float adxMinVal   = activeTier == 3 ? 18.0 : activeTier == 2 ? 22.0 : 25.0
float chopMaxVal  = activeTier == 3 ? 62.0 : activeTier == 2 ? 58.0 : 55.0

string tierName  = activeTier == 1 ? "T1 Blue chip" : activeTier == 2 ? "T2 Mid cap" : "T3 Altcoin"
color  tierColor = activeTier == 1 ? tier1Color : activeTier == 2 ? tier2Color : tier3Color

// Time stop dinâmico por tier — cada tipo de ativo tem seu próprio limite
// T1 mais curto (ETH/BTC têm movimentos mais rápidos)
// T3 mais longo (altcoins precisam de mais tempo para desenvolver o trade)
int timeStopBars = activeTier == 3 ? timeStopT3 : activeTier == 2 ? timeStopT2 : timeStopT1

// ====================================================================
// FILTRO MULTI-TIMEFRAME
// ====================================================================
// v13.1 — três comportamentos:
// SEM REPAINT (padrão): usa o último candle superior FECHADO ([1] no TF
//   maior). O backtest mostra o mesmo que você teria ao vivo. Número real.
// CLÁSSICO V12 (compatibilidade): reproduz o v12 exatamente. No histórico
//   ele enxerga a direção FINAL do candle superior ainda em formação, por
//   isso o backtest dele sai inflado. Use somente para comparar.
// GRÁFICO EM TF IGUAL OU MAIOR QUE O FILTRO (ex.: gráfico 4h, filtro 240):
//   usa a direção do próprio gráfico, como o v12 fazia na prática. Sem
//   isso, o filtro olharia sempre o candle anterior ao sinal — que aponta
//   na direção contrária — e bloquearia todas as entradas.
mtfMode   = input.string("Sem repaint (recomendado)", "Modo do filtro superior",
     options = ["Sem repaint (recomendado)","Clássico v12 (compatibilidade)"],
     group   = groupMTF,
     tooltip = "Sem repaint: usa o candle superior FECHADO — o backtest mostra o mesmo que você teria ao vivo (número real). Clássico v12: reproduz o comportamento antigo para comparação; no histórico ele enxerga a direção final do candle superior ainda em formação, então o backtest sai inflado. Use apenas para comparar.")
float mtfDirConfirmed = request.security(syminfo.tickerid, mtfTF,
     getMtfDir(mtfRngQty, mtfRngPer)[1], lookahead = barmerge.lookahead_on)
float mtfDirClassic = request.security(syminfo.tickerid, mtfTF,
     getMtfDir(mtfRngQty, mtfRngPer), lookahead = barmerge.lookahead_off)
float mtfDirLocal = getMtfDir(mtfRngQty, mtfRngPer)
bool  mtfSameOrLowerTF = timeframe.in_seconds(mtfTF) <= timeframe.in_seconds(timeframe.period)

float mtfDir = mtfMode == "Clássico v12 (compatibilidade)" ? mtfDirClassic :
     mtfSameOrLowerTF ? mtfDirLocal : mtfDirConfirmed

bool mtfUpward   = mtfDir == 1.0
bool mtfDownward = mtfDir == -1.0
bool mtfLongOk   = not useMTF or mtfUpward
bool mtfShortOk  = not useMTF or mtfDownward

// ====================================================================
// CONFIRMAÇÃO DE CANDLES
// ====================================================================
int barsSinceBuy  = ta.barssince(longSignalRaw)
int barsSinceSell = ta.barssince(shortSignalRaw)

bool freshBuy  = not na(barsSinceBuy)  and barsSinceBuy  == confirmBars - 1
bool freshSell = not na(barsSinceSell) and barsSinceSell == confirmBars - 1

bool buyFollowThrough  = true
bool sellFollowThrough = true

for i = 0 to confirmBars - 1
    buyFollowThrough  := buyFollowThrough  and close[i] > filt[i] and fdir[i] == 1
    sellFollowThrough := sellFollowThrough and close[i] < filt[i] and fdir[i] == -1

bool candleConfirmed = onlyClosedCandles ? barstate.isconfirmed : true

// ====================================================================
// INDICADORES DE APOIO
// ====================================================================
float emaFast = ta.ema(close, emaFastLen)
float emaSlow = ta.ema(close, emaSlowLen)
float ema200  = ta.ema(close, 200)
bool  emaBull = emaFast > emaSlow
bool  emaBear = emaFast < emaSlow

float rsi = ta.rsi(close, rsiLen)
bool rsiCrossedBull = ta.crossover(rsi, 50)  or (rsi > 50 and rsi[1] > 50 and rsi[2] < 50)
bool rsiCrossedBear = ta.crossunder(rsi, 50) or (rsi < 50 and rsi[1] < 50 and rsi[2] > 50)

[macdLine, macdSignal, macdHist] = ta.macd(close, 12, 26, 9)
float volMa    = ta.sma(volume, volLen)
bool  volumeOk = volume > volMa

// ====================================================================
// SCORE 0–100
// ====================================================================
int buyScore = 0
buyScore += buyFollowThrough ? 25 : 0
buyScore += macdHist > 0     ? 20 : 0
buyScore += emaBull          ? 20 : 0
buyScore += rsiCrossedBull   ? 15 : 0
buyScore += volumeOk         ? 10 : 0
buyScore += close > filt     ? 10 : 0

int sellScore = 0
sellScore += sellFollowThrough ? 25 : 0
sellScore += macdHist < 0      ? 20 : 0
sellScore += emaBear           ? 20 : 0
sellScore += rsiCrossedBear    ? 15 : 0
sellScore += volumeOk          ? 10 : 0
sellScore += close < filt      ? 10 : 0

// ====================================================================
// FILTROS DE REGIME
// ====================================================================
[diPlus, diMinus, adxVal] = ta.dmi(adxLen, adxSmooth)
bool adxOk = not useADX or adxVal >= adxMinVal

float chopHighest = ta.highest(high, chopLen)
float chopLowest  = ta.lowest(low,  chopLen)
float chopRange   = chopHighest - chopLowest
float chopAtrSum  = math.sum(ta.tr(true), chopLen)
float chopIndex   = chopRange > 0 ?
     100.0 * math.log10(chopAtrSum / chopRange) / math.log10(chopLen) : 50.0
bool chopOk = not useChop or chopIndex <= chopMaxVal

// ====================================================================
// FILTRO DE SESSÃO
// ====================================================================
bool inFxSession = not useFxSession or not na(time(timeframe.period, fxSession, "UTC"))
bool inBRSession = not useBRSession or not na(time(timeframe.period, brSession, sessionTimezone))
bool sessionOk   = not useSessionFilter or (inFxSession and inBRSession)

// ====================================================================
// GATE FINAL
// ====================================================================
// Janela de backtest (Grupo 11): fora dela nenhum sinal novo é gerado
bool inBacktestWindow = not useDateFilter or (time >= startDate and time <= endDate)

bool regimeOk   = adxOk and chopOk
bool allFilters = regimeOk and sessionOk

bool finalBuy  = candleConfirmed and freshBuy  and buyFollowThrough  and buyScore  >= minScore and allFilters and mtfLongOk and inBacktestWindow
bool finalSell = candleConfirmed and freshSell and sellFollowThrough and sellScore >= minScore and allFilters and mtfShortOk and inBacktestWindow

// ====================================================================
// VARIÁVEIS DA OPERAÇÃO
// ====================================================================
float atr = atrRaw

var float longEntry        = na
var float longInitialStop  = na
var float longTp1          = na
var float longRunnerStop   = na
var bool  longTp1Hit       = false
var int   longBarsOpen     = 0

var float shortEntry       = na
var float shortInitialStop = na
var float shortTp1         = na
var float shortRunnerStop  = na
var bool  shortTp1Hit      = false
var int   shortBarsOpen    = 0

// Contador de candles consecutivos com RF na direção contrária (para invalidação)
var int rfDownCount = 0
var int rfUpCount   = 0

float runnerQtyPercent = 100.0 - tp1QtyPercent

if strategy.position_size == 0
    longEntry        := na
    longInitialStop  := na
    longTp1          := na
    longRunnerStop   := na
    longTp1Hit       := false
    longBarsOpen     := 0
    shortEntry       := na
    shortInitialStop := na
    shortTp1         := na
    shortRunnerStop  := na
    shortTp1Hit      := false
    shortBarsOpen    := 0
    rfDownCount      := 0
    rfUpCount        := 0

// Incrementa contadores de candles e RF enquanto posição aberta
if strategy.position_size > 0
    longBarsOpen  := longBarsOpen + 1
    rfDownCount   := downward ? rfDownCount + 1 : 0
    rfUpCount     := 0
else if strategy.position_size < 0
    shortBarsOpen := shortBarsOpen + 1
    rfUpCount     := upward ? rfUpCount + 1 : 0
    rfDownCount   := 0

// ====================================================================
// HORÁRIO
// ====================================================================
string candleOpenTxt  = str.format_time(time,       "dd/MM HH:mm", timezoneInput)
string candleCloseTxt = str.format_time(time_close, "dd/MM HH:mm", timezoneInput)

// Versão ISO do candle_close para usar no signal_id (sem espaços ou barras)
// Formato: YYYY-MM-DDTHH:MM:00Z — único por barra, idêntico em reenvios do mesmo sinal
string candleCloseISO = str.format_time(time_close, "yyyy-MM-dd'T'HH:mm:00'Z'", "UTC")

// signal_id único por barra: symbol_side_timeframe_candleclose
string signalIdBuy  = apiSymbol + "_BUY_"  + timeframe.period + "_" + candleCloseISO
string signalIdSell = apiSymbol + "_SELL_" + timeframe.period + "_" + candleCloseISO

// ====================================================================
// JSON DO ALERTA — completo para o bot Binance
// ====================================================================
string buyAlertJson =
     '{"secret":"'       + webhookSecret                                            +
     '","signal_id":"'   + signalIdBuy                                             + '"' +
     ',"action":"OPEN"'                                                             +
     ',"symbol":"'       + apiSymbol                                               + '"' +
     ',"side":"BUY"'                                                               +
     ',"timeframe":"'    + timeframe.period                                        + '"' +
     ',"price":'         + str.tostring(close, format.mintick)                    +
     ',"stop_loss":'     + str.tostring(close - atr * atrStopMult, format.mintick) +
     ',"take_profit":'   + str.tostring(close + (atr * atrStopMult) * tp1R, format.mintick) +
     ',"score":'         + str.tostring(buyScore)                                 +
     ',"tier":'          + str.tostring(activeTier)                               +
     ',"atr_pct":'       + str.tostring(atrPctSmooth, "#.##")                     +
     ',"adx":'           + str.tostring(adxVal, "#.##")                           +
     ',"chop":'          + str.tostring(chopIndex, "#.##")                        +
     ',"mtf_trend":"'    + (mtfUpward ? "UP" : mtfDownward ? "DOWN" : "NEUTRAL") + '"' +
     ',"candle_open":"'  + candleOpenTxt                                          + '"' +
     ',"candle_close":"' + candleCloseISO                                         + '"' +
     ',"confirmed":true'                                                           +
     ',"management":"TP1 1.5R + breakeven + runner"'                              +
     '}'

string sellAlertJson =
     '{"secret":"'       + webhookSecret                                            +
     '","signal_id":"'   + signalIdSell                                            + '"' +
     ',"action":"OPEN"'                                                             +
     ',"symbol":"'       + apiSymbol                                               + '"' +
     ',"side":"SELL"'                                                              +
     ',"timeframe":"'    + timeframe.period                                        + '"' +
     ',"price":'         + str.tostring(close, format.mintick)                    +
     ',"stop_loss":'     + str.tostring(close + atr * atrStopMult, format.mintick) +
     ',"take_profit":'   + str.tostring(close - (atr * atrStopMult) * tp1R, format.mintick) +
     ',"score":'         + str.tostring(sellScore)                                +
     ',"tier":'          + str.tostring(activeTier)                               +
     ',"atr_pct":'       + str.tostring(atrPctSmooth, "#.##")                     +
     ',"adx":'           + str.tostring(adxVal, "#.##")                           +
     ',"chop":'          + str.tostring(chopIndex, "#.##")                        +
     ',"mtf_trend":"'    + (mtfUpward ? "UP" : mtfDownward ? "DOWN" : "NEUTRAL") + '"' +
     ',"candle_open":"'  + candleOpenTxt                                          + '"' +
     ',"candle_close":"' + candleCloseISO                                         + '"' +
     ',"confirmed":true'                                                           +
     ',"management":"TP1 1.5R + breakeven + runner"'                              +
     '}'

// ====================================================================
// v13 (fix 1) — JSON DOS ALERTAS DE SAÍDA
// ====================================================================
// Antes (v12), o bot só recebia OPEN e as saídas inteligentes.
// Agora TODA saída envia alerta: TP1 (REDUCE), SL, RUNNER e RF EXIT (CLOSE).
// Os níveis enviados são os vigentes na última atualização da ordem.
// Obs: num stop total antes do TP1 podem chegar 2 alertas CLOSE — o bot
// deve ser idempotente pelo estado da posição (fechar posição já fechada = ignorar).
string tp1BuyAlert    = '{"secret":"' + webhookSecret + '","signal_id":"' + apiSymbol + '_TP1_BUY_'    + timeframe.period + '_' + candleCloseISO + '","action":"REDUCE","symbol":"' + apiSymbol + '","side":"BUY","reason":"TP1","qty_pct":' + str.tostring(tp1QtyPercent, "#.#") + ',"level":' + str.tostring(nz(longTp1, 0), format.mintick) + ',"timeframe":"' + timeframe.period + '","candle_close":"' + candleCloseISO + '"}'
string slBuyAlert     = '{"secret":"' + webhookSecret + '","signal_id":"' + apiSymbol + '_SL_BUY_'     + timeframe.period + '_' + candleCloseISO + '","action":"CLOSE","symbol":"'  + apiSymbol + '","side":"BUY","reason":"SL","level":' + str.tostring(nz(longInitialStop, 0), format.mintick) + ',"timeframe":"' + timeframe.period + '","candle_close":"' + candleCloseISO + '"}'
string runnerBuyAlert = '{"secret":"' + webhookSecret + '","signal_id":"' + apiSymbol + '_RUNNER_BUY_' + timeframe.period + '_' + candleCloseISO + '","action":"CLOSE","symbol":"'  + apiSymbol + '","side":"BUY","reason":"' + (longTp1Hit ? "RUNNER_STOP" : "SL") + '","level":' + str.tostring(nz(longRunnerStop, 0), format.mintick) + ',"timeframe":"' + timeframe.period + '","candle_close":"' + candleCloseISO + '"}'
string rfExitBuyAlert = '{"secret":"' + webhookSecret + '","signal_id":"' + apiSymbol + '_RFEXIT_BUY_' + timeframe.period + '_' + candleCloseISO + '","action":"CLOSE","symbol":"'  + apiSymbol + '","side":"BUY","reason":"RF_EXIT","level":' + str.tostring(close, format.mintick) + ',"timeframe":"' + timeframe.period + '","candle_close":"' + candleCloseISO + '"}'

string tp1SellAlert    = '{"secret":"' + webhookSecret + '","signal_id":"' + apiSymbol + '_TP1_SELL_'    + timeframe.period + '_' + candleCloseISO + '","action":"REDUCE","symbol":"' + apiSymbol + '","side":"SELL","reason":"TP1","qty_pct":' + str.tostring(tp1QtyPercent, "#.#") + ',"level":' + str.tostring(nz(shortTp1, 0), format.mintick) + ',"timeframe":"' + timeframe.period + '","candle_close":"' + candleCloseISO + '"}'
string slSellAlert     = '{"secret":"' + webhookSecret + '","signal_id":"' + apiSymbol + '_SL_SELL_'     + timeframe.period + '_' + candleCloseISO + '","action":"CLOSE","symbol":"'  + apiSymbol + '","side":"SELL","reason":"SL","level":' + str.tostring(nz(shortInitialStop, 0), format.mintick) + ',"timeframe":"' + timeframe.period + '","candle_close":"' + candleCloseISO + '"}'
string runnerSellAlert = '{"secret":"' + webhookSecret + '","signal_id":"' + apiSymbol + '_RUNNER_SELL_' + timeframe.period + '_' + candleCloseISO + '","action":"CLOSE","symbol":"'  + apiSymbol + '","side":"SELL","reason":"' + (shortTp1Hit ? "RUNNER_STOP" : "SL") + '","level":' + str.tostring(nz(shortRunnerStop, 0), format.mintick) + ',"timeframe":"' + timeframe.period + '","candle_close":"' + candleCloseISO + '"}'
string rfExitSellAlert = '{"secret":"' + webhookSecret + '","signal_id":"' + apiSymbol + '_RFEXIT_SELL_' + timeframe.period + '_' + candleCloseISO + '","action":"CLOSE","symbol":"'  + apiSymbol + '","side":"SELL","reason":"RF_EXIT","level":' + str.tostring(close, format.mintick) + ',"timeframe":"' + timeframe.period + '","candle_close":"' + candleCloseISO + '"}'

// ====================================================================
// ENTRADAS
// ====================================================================
float orderCapital = strategy.equity * (orderSizePct / 100.0)
float orderQty     = orderCapital / close

if finalBuy and strategy.position_size <= 0
    longEntry        := close
    longInitialStop  := close - atr * atrStopMult
    float risk        = math.max(close - longInitialStop, syminfo.mintick)
    longTp1          := close + risk * tp1R
    longRunnerStop   := longInitialStop
    longTp1Hit       := false
    shortEntry       := na
    shortInitialStop := na
    shortTp1         := na
    shortRunnerStop  := na
    shortTp1Hit      := false
    strategy.entry("BUY", strategy.long, qty = orderQty, alert_message = buyAlertJson)

if finalSell and strategy.position_size >= 0
    shortEntry       := close
    shortInitialStop := close + atr * atrStopMult
    float risk        = math.max(shortInitialStop - close, syminfo.mintick)
    shortTp1         := close - risk * tp1R
    shortRunnerStop  := shortInitialStop
    shortTp1Hit      := false
    longEntry        := na
    longInitialStop  := na
    longTp1          := na
    longRunnerStop   := na
    longTp1Hit       := false
    strategy.entry("SELL", strategy.short, qty = orderQty, alert_message = sellAlertJson)

// ====================================================================
// DETECÇÃO DO TP1
// ====================================================================
if strategy.position_size > 0 and not longTp1Hit  and not na(longTp1)
    longTp1Hit  := high >= longTp1
if strategy.position_size < 0 and not shortTp1Hit and not na(shortTp1)
    shortTp1Hit := low  <= shortTp1

bool longTp1JustHit  = strategy.position_size > 0 and longTp1Hit  and not longTp1Hit[1]
bool shortTp1JustHit = strategy.position_size < 0 and shortTp1Hit and not shortTp1Hit[1]

// ====================================================================
// CONDUÇÃO DO RUNNER
// ====================================================================
if strategy.position_size > 0 and not na(longInitialStop)
    float be = math.max(strategy.position_avg_price, longInitialStop)
    float tr = close - atr * trailAtrMult
    float ds = longTp1Hit ? be : longInitialStop
    if longTp1Hit and (exitMode == "ATR Trailing" or exitMode == "Híbrido RF + ATR")
        ds := math.max(be, tr)
    longRunnerStop := na(longRunnerStop) ? ds : math.max(longRunnerStop, ds)

if strategy.position_size < 0 and not na(shortInitialStop)
    float be = math.min(strategy.position_avg_price, shortInitialStop)
    float tr = close + atr * trailAtrMult
    float ds = shortTp1Hit ? be : shortInitialStop
    if shortTp1Hit and (exitMode == "ATR Trailing" or exitMode == "Híbrido RF + ATR")
        ds := math.min(be, tr)
    shortRunnerStop := na(shortRunnerStop) ? ds : math.min(shortRunnerStop, ds)

// ====================================================================
// SAÍDAS — v13 (fix 3): padrão canônico do TradingView
// ====================================================================
// TP1: só é (re)enviado enquanto o TP1 ainda não foi atingido.
// RUNNER: SEM qty_percent = fecha sempre 100% do que restar (sem resíduo).
// O grupo OCA "reduce" (padrão do strategy.exit) ajusta as quantidades
// automaticamente quando uma das ordens é preenchida.
if strategy.position_size > 0 and not na(longInitialStop) and not na(longTp1)
    if not longTp1Hit
        strategy.exit("BUY TP1", from_entry = "BUY", qty_percent = tp1QtyPercent,
             stop = longInitialStop, limit = longTp1,
             comment_profit = "TP1", comment_loss = "SL",
             alert_profit = tp1BuyAlert, alert_loss = slBuyAlert)
    strategy.exit("BUY RUNNER", from_entry = "BUY", stop = longRunnerStop,
         comment_loss = longTp1Hit ? "RUNNER" : "SL",
         alert_loss = runnerBuyAlert)

if strategy.position_size < 0 and not na(shortInitialStop) and not na(shortTp1)
    if not shortTp1Hit
        strategy.exit("SELL TP1", from_entry = "SELL", qty_percent = tp1QtyPercent,
             stop = shortInitialStop, limit = shortTp1,
             comment_profit = "TP1", comment_loss = "SL",
             alert_profit = tp1SellAlert, alert_loss = slSellAlert)
    strategy.exit("SELL RUNNER", from_entry = "SELL", stop = shortRunnerStop,
         comment_loss = shortTp1Hit ? "RUNNER" : "SL",
         alert_loss = runnerSellAlert)

bool useRangeFilterExit = exitMode == "Range Filter" or exitMode == "Híbrido RF + ATR"
if useRangeFilterExit and strategy.position_size > 0 and longTp1Hit  and candleConfirmed and close < filt
    strategy.close("BUY",  comment="RF EXIT", alert_message = rfExitBuyAlert)
if useRangeFilterExit and strategy.position_size < 0 and shortTp1Hit and candleConfirmed and close > filt
    strategy.close("SELL", comment="RF EXIT", alert_message = rfExitSellAlert)

// Janela de backtest: fecha posição remanescente ao fim da janela,
// para o resultado do período analisado ficar completo e comparável
if useDateFilter and time > endDate and strategy.position_size != 0
    strategy.close_all(comment="FIM JANELA")

// ====================================================================
// SAÍDA INTELIGENTE DURANTE O TRADE (antes do TP1)
// ====================================================================
// Chop Exit e Time Stop: ativos por padrão — aprovados pela comunidade.
// Invalidação por RF/Score: desligada por padrão — prejudicou ETH 1h.
//
// Alertas JSON específicos para o bot saber o motivo de cada saída:
string chopBuyAlert  = '{"secret":"' + webhookSecret + '","signal_id":"' + apiSymbol + '_CLOSE_CHOP_BUY_'   + timeframe.period + '_' + candleCloseISO + '","action":"CLOSE","symbol":"' + apiSymbol + '","side":"BUY","reason":"CHOP_EXIT","timeframe":"'  + timeframe.period + '"}'
string chopSellAlert = '{"secret":"' + webhookSecret + '","signal_id":"' + apiSymbol + '_CLOSE_CHOP_SELL_'  + timeframe.period + '_' + candleCloseISO + '","action":"CLOSE","symbol":"' + apiSymbol + '","side":"SELL","reason":"CHOP_EXIT","timeframe":"' + timeframe.period + '"}'
string timeBuyAlert  = '{"secret":"' + webhookSecret + '","signal_id":"' + apiSymbol + '_CLOSE_TIME_BUY_'   + timeframe.period + '_' + candleCloseISO + '","action":"CLOSE","symbol":"' + apiSymbol + '","side":"BUY","reason":"TIME_STOP","bars":' + str.tostring(longBarsOpen) + ',"timeframe":"' + timeframe.period + '"}'
string timeSellAlert = '{"secret":"' + webhookSecret + '","signal_id":"' + apiSymbol + '_CLOSE_TIME_SELL_'  + timeframe.period + '_' + candleCloseISO + '","action":"CLOSE","symbol":"' + apiSymbol + '","side":"SELL","reason":"TIME_STOP","bars":' + str.tostring(shortBarsOpen) + ',"timeframe":"' + timeframe.period + '"}'
string invalBuyAlert  = '{"secret":"' + webhookSecret + '","signal_id":"' + apiSymbol + '_CLOSE_INVAL_BUY_'  + timeframe.period + '_' + candleCloseISO + '","action":"CLOSE","symbol":"' + apiSymbol + '","side":"BUY","reason":"INVALIDATION","timeframe":"' + timeframe.period + '"}'
string invalSellAlert = '{"secret":"' + webhookSecret + '","signal_id":"' + apiSymbol + '_CLOSE_INVAL_SELL_' + timeframe.period + '_' + candleCloseISO + '","action":"CLOSE","symbol":"' + apiSymbol + '","side":"SELL","reason":"INVALIDATION","timeframe":"' + timeframe.period + '"}'

if candleConfirmed

    // ---- Saída inteligente de BUY (antes do TP1) ----
    if strategy.position_size > 0 and not longTp1Hit

        // Chop Exit: mercado lateralizou durante o trade
        bool _chopLong = useChopExit and chopIndex > chopMaxVal
        // Time Stop: trade aberto há muitos candles sem atingir TP1
        bool _timeLong = useTimeStop and longBarsOpen >= timeStopBars
        // Invalidação por RF (N candles consecutivos) + Score contrário
        bool _rfLong   = useInvalidation and rfDownCount >= invalidRFBars
        bool _scLong   = useInvalidation and sellScore   >= invalidScoreMin

        if _rfLong or _scLong
            string _r = _rfLong ? "RF " + str.tostring(rfDownCount) + "b" : "SCORE " + str.tostring(sellScore)
            strategy.close("BUY", comment="INVAL: " + _r, alert_message=invalBuyAlert)
        else if _chopLong
            strategy.close("BUY", comment="CHOP EXIT", alert_message=chopBuyAlert)
        else if _timeLong
            strategy.close("BUY", comment="TIME STOP " + str.tostring(longBarsOpen) + "b", alert_message=timeBuyAlert)

    // ---- Saída inteligente de SELL (antes do TP1) ----
    if strategy.position_size < 0 and not shortTp1Hit

        bool _chopShort = useChopExit and chopIndex > chopMaxVal
        bool _timeShort = useTimeStop and shortBarsOpen >= timeStopBars
        bool _rfShort   = useInvalidation and rfUpCount   >= invalidRFBars
        bool _scShort   = useInvalidation and buyScore    >= invalidScoreMin

        if _rfShort or _scShort
            string _r = _rfShort ? "RF " + str.tostring(rfUpCount) + "b" : "SCORE " + str.tostring(buyScore)
            strategy.close("SELL", comment="INVAL: " + _r, alert_message=invalSellAlert)
        else if _chopShort
            strategy.close("SELL", comment="CHOP EXIT", alert_message=chopSellAlert)
        else if _timeShort
            strategy.close("SELL", comment="TIME STOP " + str.tostring(shortBarsOpen) + "b", alert_message=timeSellAlert)

// ====================================================================
// VISUAL — RANGE FILTER E MÉDIAS
// ====================================================================
color filtColor = upward ? bullColor : downward ? bearColor : neutralColor
color barColor  = upward and rng_src > filt ? bullColor : downward and rng_src < filt ? bearColor : neutralColor

fPlot = plot(filt,   "Range Filter", color=color.new(filtColor,20), linewidth=3)
hPlot = plot(h_band, "High Band",    color=color.new(bullColor,100))
lPlot = plot(l_band, "Low Band",     color=color.new(bearColor,100))

fill(hPlot, fPlot, color=color.new(buyColor,92))
fill(lPlot, fPlot, color=color.new(sellColor,92))

plot(emaFast, "EMA rápida", color=emaFastColor)
plot(emaSlow, "EMA lenta",  color=emaSlowColor)
plot(showEMA200 ? ema200 : na, "EMA 200", color=color.new(ema200Color,30), linewidth=2)

barcolor(showBarColor ? barColor : na)

// Fundo laranja suave quando regime bloqueado
bgcolor(not allFilters and strategy.position_size == 0 ? color.new(blockedColor,90) : na, title="Regime bloqueado")

// Sinal visual de INVALIDAÇÃO DETECTADA (antes do TP1)
// Triângulo laranja no gráfico no candle onde o trade seria invalidado
bool invalidSignalLong  = useInvalidation and strategy.position_size > 0 and not longTp1Hit  and candleConfirmed and (rfDownCount >= invalidRFBars or sellScore >= invalidScoreMin)
bool invalidSignalShort = useInvalidation and strategy.position_size < 0 and not shortTp1Hit and candleConfirmed and (rfUpCount   >= invalidRFBars or buyScore  >= invalidScoreMin)

plotshape(invalidSignalLong,
     title    = "⚠ Invalidação BUY",
     style    = shape.xcross,
     location = location.abovebar,
     color    = blockedColor,
     size     = size.small)

plotshape(invalidSignalShort,
     title    = "⚠ Invalidação SELL",
     style    = shape.xcross,
     location = location.belowbar,
     color    = blockedColor,
     size     = size.small)

// ====================================================================
// VISUAL — SETAS DE ENTRADA (grandes e claras)
// ====================================================================
// BUY: seta verde grande apontando para cima, ABAIXO da barra
plotshape(finalBuy,
     title    = "▲ Entrada BUY",
     style    = shape.triangleup,
     location = location.belowbar,
     color    = buyColor,
     size     = size.large)

// SELL: seta vermelha grande apontando para baixo, ACIMA da barra
plotshape(finalSell,
     title    = "▼ Entrada SELL",
     style    = shape.triangledown,
     location = location.abovebar,
     color    = sellColor,
     size     = size.large)

// TP1 atingido — check amarelo pequeno
plotshape(longTp1JustHit,
     title    = "✓ TP1 BUY",
     style    = shape.labeldown,
     location = location.abovebar,
     color    = tp1Color,
     text     = "TP1",
     textcolor= color.black,
     size     = size.small)

plotshape(shortTp1JustHit,
     title    = "✓ TP1 SELL",
     style    = shape.labelup,
     location = location.belowbar,
     color    = tp1Color,
     text     = "TP1",
     textcolor= color.black,
     size     = size.small)

// ====================================================================
// VISUAL — LINHAS DE ENTRADA, TP1 E STOP
// ====================================================================
// Linha branca = preço de entrada
plot(strategy.position_size > 0 ? longEntry        : na, "Entrada BUY",   color=color.new(color.white,20), style=plot.style_linebr, linewidth=1)
plot(strategy.position_size < 0 ? shortEntry       : na, "Entrada SELL",  color=color.new(color.white,20), style=plot.style_linebr, linewidth=1)
// Linha amarela = TP1
plot(strategy.position_size > 0 ? longTp1          : na, "TP1 BUY",       color=tp1Color,  style=plot.style_linebr, linewidth=2)
plot(strategy.position_size < 0 ? shortTp1         : na, "TP1 SELL",      color=tp1Color,  style=plot.style_linebr, linewidth=2)
// Linha vermelha = stop atual
plot(strategy.position_size > 0 ? longRunnerStop   : na, "Stop BUY",      color=stopColor, style=plot.style_linebr, linewidth=2)
plot(strategy.position_size < 0 ? shortRunnerStop  : na, "Stop SELL",     color=stopColor, style=plot.style_linebr, linewidth=2)

// ====================================================================
// VISUAL — LABEL NO CANDLE DE ENTRADA COM PAINEL COMPLETO DO TRADE
// ====================================================================
if finalBuy
    float _stop = close - atr * atrStopMult
    float _tp1  = close + (atr * atrStopMult) * tp1R
    float _risk = math.max(close - _stop, syminfo.mintick)
    float _rew  = _tp1 - close
    float _rr   = _rew / _risk
    float _stopPct = (_risk / close) * 100
    float _tp1Pct  = (_rew  / close) * 100

    string _txt =
         "▲ BUY\\n" +
         "Entrada:  " + str.tostring(close, format.mintick) + "\\n" +
         "Stop:     " + str.tostring(_stop, format.mintick) + "  (-" + str.tostring(_stopPct, "#.##") + "%)\\n" +
         "TP1:      " + str.tostring(_tp1,  format.mintick) + "  (+" + str.tostring(_tp1Pct,  "#.##") + "%)\\n" +
         "R:R       1:" + str.tostring(_rr, "#.##") + "\\n" +
         "Score:    " + str.tostring(buyScore) + "/100  |  " + tierName

    label.new(
         bar_index, low - atr * 0.5,
         text      = _txt,
         color     = color.new(buyColor, 15),
         textcolor = color.white,
         style     = label.style_label_up,
         size      = size.small)

if finalSell
    float _stop = close + atr * atrStopMult
    float _tp1  = close - (atr * atrStopMult) * tp1R
    float _risk = math.max(_stop - close, syminfo.mintick)
    float _rew  = close - _tp1
    float _rr   = _rew / _risk
    float _stopPct = (_risk / close) * 100
    float _tp1Pct  = (_rew  / close) * 100

    string _txt =
         "▼ SELL\\n" +
         "Entrada:  " + str.tostring(close, format.mintick) + "\\n" +
         "Stop:     " + str.tostring(_stop, format.mintick) + "  (+" + str.tostring(_stopPct, "#.##") + "%)\\n" +
         "TP1:      " + str.tostring(_tp1,  format.mintick) + "  (-" + str.tostring(_tp1Pct,  "#.##") + "%)\\n" +
         "R:R       1:" + str.tostring(_rr, "#.##") + "\\n" +
         "Score:    " + str.tostring(sellScore) + "/100  |  " + tierName

    label.new(
         bar_index, high + atr * 0.5,
         text      = _txt,
         color     = color.new(sellColor, 15),
         textcolor = color.white,
         style     = label.style_label_down,
         size      = size.small)

// ====================================================================
// VISUAL — CAIXA DE RISCO/LUCRO (zona visual entre entrada e níveis)
// ====================================================================
var box riskBoxLong    = na
var box profitBoxLong  = na
var box riskBoxShort   = na
var box profitBoxShort = na
var bool boxLongClosed  = true
var bool boxShortClosed = true

if finalBuy and showRiskBox
    float _stop = close - atr * atrStopMult
    float _tp1  = close + (atr * atrStopMult) * tp1R
    riskBoxLong   := box.new(bar_index, close, bar_index + 1, _stop,
         bgcolor=color.new(stopColor,82), border_color=color.new(stopColor,60), border_width=1)
    profitBoxLong := box.new(bar_index, close, bar_index + 1, _tp1,
         bgcolor=color.new(buyColor,82), border_color=color.new(buyColor,60), border_width=1)
    boxLongClosed := false

if finalSell and showRiskBox
    float _stop = close + atr * atrStopMult
    float _tp1  = close - (atr * atrStopMult) * tp1R
    riskBoxShort   := box.new(bar_index, close, bar_index + 1, _stop,
         bgcolor=color.new(stopColor,82), border_color=color.new(stopColor,60), border_width=1)
    profitBoxShort := box.new(bar_index, close, bar_index + 1, _tp1,
         bgcolor=color.new(buyColor,82), border_color=color.new(buyColor,60), border_width=1)
    boxShortClosed := false

if strategy.position_size > 0 and showRiskBox and not boxLongClosed
    if not na(riskBoxLong)
        box.set_right(riskBoxLong,   bar_index + 1)
    if not na(profitBoxLong)
        box.set_right(profitBoxLong, bar_index + 1)

if strategy.position_size < 0 and showRiskBox and not boxShortClosed
    if not na(riskBoxShort)
        box.set_right(riskBoxShort,   bar_index + 1)
    if not na(profitBoxShort)
        box.set_right(profitBoxShort, bar_index + 1)

bool justClosedLong  = strategy.position_size == 0 and strategy.position_size[1] > 0
bool justClosedShort = strategy.position_size == 0 and strategy.position_size[1] < 0

if justClosedLong and showRiskBox and not boxLongClosed
    if not na(riskBoxLong)
        box.set_right(riskBoxLong,   bar_index)
    if not na(profitBoxLong)
        box.set_right(profitBoxLong, bar_index)
    boxLongClosed := true

if justClosedShort and showRiskBox and not boxShortClosed
    if not na(riskBoxShort)
        box.set_right(riskBoxShort,   bar_index)
    if not na(profitBoxShort)
        box.set_right(profitBoxShort, bar_index)
    boxShortClosed := true

// ====================================================================
// TABELA DE DEBUG
// ====================================================================
string directionTxt = upward ? "Alta ▲" : downward ? "Baixa ▼" : "Neutro —"
string decisionTxt  = finalBuy ? "BUY ▲" : finalSell ? "SELL ▼" : "aguardando"
string positionTxt  = strategy.position_size > 0 ? "LONG ▲" : strategy.position_size < 0 ? "SHORT ▼" : "FLAT"
string statusTxt    = barstate.isconfirmed ? "fechado" : "aberto"

float _activeEntry = strategy.position_size > 0 ? longEntry  : strategy.position_size < 0 ? shortEntry  : na
float _activeTp1   = strategy.position_size > 0 ? longTp1   : strategy.position_size < 0 ? shortTp1   : na
float _activeStop  = strategy.position_size > 0 ? longRunnerStop : strategy.position_size < 0 ? shortRunnerStop : na

float _dynamicRR = na
if not na(_activeEntry) and not na(_activeTp1) and not na(_activeStop)
    float _rew = math.abs(_activeTp1 - _activeEntry)
    float _risk = math.abs(_activeEntry - _activeStop)
    _dynamicRR := _risk > 0 ? _rew / _risk : na

string tp1StatusTxt = strategy.position_size > 0 ?
     (longTp1Hit  ? "TP1 atingido ✓" : "TP1 pendente") :
     strategy.position_size < 0 ?
     (shortTp1Hit ? "TP1 atingido ✓" : "TP1 pendente") : "—"

string adxTxt  = str.tostring(adxVal,    "#.#") + (adxOk  ? " ✓" : " ✗") + " (min " + str.tostring(adxMinVal,  "#") + ")"
string chopTxt = str.tostring(chopIndex, "#.#") + (chopOk ? " ✓" : " ✗") + " (max " + str.tostring(chopMaxVal, "#") + ")"
string mtf4hTxt   = mtfUpward ? "Alta ▲" : mtfDownward ? "Baixa ▼" : "Neutro"
string ema200Txt  = close > ema200 ? "Acima ✓" : "Abaixo ✗"
string regimeTxt  = allFilters ? "LIVRE ✓" : "BLOQUEADO ✗"
string scoreTxt   = str.tostring(buyScore > sellScore ? buyScore : sellScore) + "/100"

if barstate.islast and tableMode != "Oculta"
    int nRows = tableMode == "Compacta" ? 15 : 28
    var table dbg = table.new(position.top_right, 2, nRows, border_width=1, frame_color=color.new(color.white,80))

    table.cell(dbg, 0, 0, "NE RF v13.2 — " + syminfo.ticker + " " + timeframe.period,
         text_color=color.white, bgcolor=debugBgColor, text_size=size.small)
    table.cell(dbg, 1, 0, tierName + " | " + str.tostring(atrStopMult,"#.#") + "x",
         text_color=tierColor, bgcolor=debugBgColor, text_size=size.small)

    table.cell(dbg, 0, 1,  "Tier / Stop",  text_color=color.white, text_size=size.tiny)
    table.cell(dbg, 1, 1,  tierName + "  " + str.tostring(atrStopMult,"#.#") + "x ATR", text_color=tierColor, text_size=size.tiny)

    table.cell(dbg, 0, 2,  "EMA 200",      text_color=color.white, text_size=size.tiny)
    table.cell(dbg, 1, 2,  ema200Txt,      text_color=close > ema200 ? bullColor : bearColor, text_size=size.tiny)

    table.cell(dbg, 0, 3,  "4h Trend",     text_color=color.white, text_size=size.tiny)
    table.cell(dbg, 1, 3,  mtf4hTxt,       text_color=mtfUpward ? bullColor : mtfDownward ? bearColor : neutralColor, text_size=size.tiny)

    table.cell(dbg, 0, 4,  "Regime",       text_color=color.white, text_size=size.tiny)
    table.cell(dbg, 1, 4,  regimeTxt,      text_color=allFilters ? bullColor : blockedColor, text_size=size.tiny)

    table.cell(dbg, 0, 5,  "Direção 1h",   text_color=color.white, text_size=size.tiny)
    table.cell(dbg, 1, 5,  directionTxt,   text_color=upward ? bullColor : downward ? bearColor : neutralColor, text_size=size.tiny)

    table.cell(dbg, 0, 6,  "Score",        text_color=color.white, text_size=size.tiny)
    table.cell(dbg, 1, 6,  scoreTxt,       text_color=math.max(buyScore,sellScore) >= minScore ? bullColor : neutralColor, text_size=size.tiny)

    table.cell(dbg, 0, 7,  "Decisão",      text_color=color.white, text_size=size.tiny)
    table.cell(dbg, 1, 7,  decisionTxt,    text_color=finalBuy ? bullColor : finalSell ? bearColor : neutralColor, text_size=size.tiny)

    table.cell(dbg, 0, 8,  "Posição",      text_color=color.white, text_size=size.tiny)
    table.cell(dbg, 1, 8,  positionTxt,    text_color=strategy.position_size > 0 ? bullColor : strategy.position_size < 0 ? bearColor : neutralColor, text_size=size.tiny)

    table.cell(dbg, 0, 9,  "Entrada",      text_color=color.white, text_size=size.tiny)
    table.cell(dbg, 1, 9,  na(_activeEntry) ? "—" : str.tostring(_activeEntry, format.mintick), text_color=color.white, text_size=size.tiny)

    table.cell(dbg, 0, 10, "TP1",          text_color=color.white, text_size=size.tiny)
    table.cell(dbg, 1, 10, na(_activeTp1)  ? "—" : str.tostring(_activeTp1,  format.mintick), text_color=tp1Color, text_size=size.tiny)

    table.cell(dbg, 0, 11, "Stop atual",   text_color=color.white, text_size=size.tiny)
    table.cell(dbg, 1, 11, na(_activeStop) ? "—" : str.tostring(_activeStop, format.mintick), text_color=stopColor, text_size=size.tiny)

    table.cell(dbg, 0, 12, "R:R atual",    text_color=color.white, text_size=size.tiny)
    table.cell(dbg, 1, 12, na(_dynamicRR)  ? "—" : "1:" + str.tostring(_dynamicRR, "#.##"), text_color=tp1Color, text_size=size.tiny)

    table.cell(dbg, 0, 13, "Status TP1",   text_color=color.white, text_size=size.tiny)
    table.cell(dbg, 1, 13, tp1StatusTxt,   text_color=tp1Color, text_size=size.tiny)

    int  _barsOpen  = strategy.position_size > 0 ? longBarsOpen  : strategy.position_size < 0 ? shortBarsOpen : 0
    int  _rfCount   = strategy.position_size > 0 ? rfDownCount   : strategy.position_size < 0 ? rfUpCount     : 0
    bool _posOpen   = strategy.position_size != 0
    bool _preTP1    = strategy.position_size > 0 ? not longTp1Hit : strategy.position_size < 0 ? not shortTp1Hit : false
    bool _chopRisk  = _posOpen and _preTP1 and useChopExit   and chopIndex > chopMaxVal
    bool _timeRisk  = _posOpen and _preTP1 and useTimeStop   and _barsOpen >= timeStopBars - 5
    bool _invalRisk = _posOpen and _preTP1 and useInvalidation and (_rfCount >= invalidRFBars or (strategy.position_size > 0 and sellScore >= invalidScoreMin) or (strategy.position_size < 0 and buyScore >= invalidScoreMin))
    string _exitTxt = not _posOpen ? "—" : not _preTP1 ? "TP1 atingido" :
         _chopRisk  ? "⚠ CHOP lateral" :
         _timeRisk  ? "⚠ TIME " + str.tostring(_barsOpen) + "/" + str.tostring(timeStopBars) :
         _invalRisk ? "⚠ INVAL RF " + str.tostring(_rfCount) + "/" + str.tostring(invalidRFBars) : "OK"
    color _exitCol  = (_chopRisk or _timeRisk or _invalRisk) ? blockedColor : bullColor
    table.cell(dbg, 0, 14, "Saída Smart",  text_color=color.white, text_size=size.tiny)
    table.cell(dbg, 1, 14, _exitTxt,       text_color=_exitCol, text_size=size.tiny)

    string _barsTxt = _barsOpen == 0 ? "—" : str.tostring(_barsOpen) + "/" + str.tostring(timeStopBars) + " candles"
    table.cell(dbg, 0, 15, "Tempo no trade", text_color=color.white, text_size=size.tiny)
    table.cell(dbg, 1, 15, _barsTxt,         text_color=_timeRisk ? blockedColor : neutralColor, text_size=size.tiny)

    if tableMode == "Completa"
        table.cell(dbg, 0, 16, "Candle",       text_color=color.white, text_size=size.tiny)
        table.cell(dbg, 1, 16, statusTxt,       text_color=barstate.isconfirmed ? bullColor : color.orange, text_size=size.tiny)

        table.cell(dbg, 0, 17, "ATR%",          text_color=color.white, text_size=size.tiny)
        table.cell(dbg, 1, 17, str.tostring(atrPctSmooth,"#.##") + "%", text_color=tierColor, text_size=size.tiny)

        table.cell(dbg, 0, 18, "ADX",           text_color=color.white, text_size=size.tiny)
        table.cell(dbg, 1, 18, adxTxt,          text_color=adxOk ? bullColor : blockedColor, text_size=size.tiny)

        table.cell(dbg, 0, 19, "Choppiness",    text_color=color.white, text_size=size.tiny)
        table.cell(dbg, 1, 19, chopTxt,         text_color=chopOk ? bullColor : blockedColor, text_size=size.tiny)

        table.cell(dbg, 0, 20, "Buy Score",     text_color=color.white, text_size=size.tiny)
        table.cell(dbg, 1, 20, str.tostring(buyScore) + "/" + str.tostring(minScore), text_color=buyScore >= minScore ? bullColor : neutralColor, text_size=size.tiny)

        table.cell(dbg, 0, 21, "Sell Score",    text_color=color.white, text_size=size.tiny)
        table.cell(dbg, 1, 21, str.tostring(sellScore) + "/" + str.tostring(minScore), text_color=sellScore >= minScore ? bearColor : neutralColor, text_size=size.tiny)

        table.cell(dbg, 0, 22, "4h Long OK",    text_color=color.white, text_size=size.tiny)
        table.cell(dbg, 1, 22, mtfLongOk  ? "SIM ✓" : "NÃO ✗", text_color=mtfLongOk  ? bullColor : blockedColor, text_size=size.tiny)

        table.cell(dbg, 0, 23, "4h Short OK",   text_color=color.white, text_size=size.tiny)
        table.cell(dbg, 1, 23, mtfShortOk ? "SIM ✓" : "NÃO ✗", text_color=mtfShortOk ? bearColor  : blockedColor, text_size=size.tiny)

        table.cell(dbg, 0, 24, "RSI",           text_color=color.white, text_size=size.tiny)
        table.cell(dbg, 1, 24, str.tostring(rsi,"#.#"), text_color=color.white, text_size=size.tiny)

        table.cell(dbg, 0, 25, "MACD Hist",     text_color=color.white, text_size=size.tiny)
        table.cell(dbg, 1, 25, str.tostring(macdHist, format.mintick), text_color=macdHist >= 0 ? bullColor : bearColor, text_size=size.tiny)

        table.cell(dbg, 0, 26, "Modo saída",    text_color=color.white, text_size=size.tiny)
        table.cell(dbg, 1, 26, exitMode,        text_color=color.white, text_size=size.tiny)

        table.cell(dbg, 0, 27, "Sessão",        text_color=color.white, text_size=size.tiny)
        table.cell(dbg, 1, 27, sessionOk ? "Aberta ✓" : "Fechada ✗", text_color=sessionOk ? bullColor : blockedColor, text_size=size.tiny)
`;

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
  const [parsedConfig, setParsedConfig] = useState(() => getLocalPineConfig());

  // Refresh with the Firestore-synced business params (minScore/tp1R/...)
  // once on mount, since getPineConfig() is async (reads strategyConfig).
  useEffect(() => {
    let cancelled = false;
    getPineConfig().then(config => {
      if (!cancelled) setParsedConfig(config);
    });
    return () => { cancelled = true; };
  }, []);

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