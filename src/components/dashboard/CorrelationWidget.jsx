import React, { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { backend } from '@/api/entities';
import { fetchCandles } from '@/lib/marketDataProvider';
import { LineChart, Line, ResponsiveContainer, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';
import { GitCompareArrows, Plus, X, AlertTriangle } from 'lucide-react';

const DEFAULT_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
const CANDLES_LIMIT = 100;
const TIMEFRAME = '1h';
const LINE_COLORS = ['#00e5ff', '#ffd166', '#00ff80', '#ff1478', '#a78bfa', '#ff9f43'];

function pearsonCorrelation(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 2) return null;
  // Alinha pela janela mais RECENTE de cada série, não pelas primeiras n
  // amostras — se um símbolo tem histórico mais curto (recém-listado), as
  // primeiras n amostras do símbolo mais longo seriam de um período bem mais
  // antigo, comparando janelas de tempo diferentes.
  const xs = a.slice(a.length - n);
  const ys = b.slice(b.length - n);
  let sumX = 0; let sumY = 0;
  for (let i = 0; i < n; i++) { sumX += xs[i]; sumY += ys[i]; }
  const meanX = sumX / n; const meanY = sumY / n;
  let num = 0; let denX = 0; let denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX; const dy = ys[i] - meanY;
    num += dx * dy; denX += dx * dx; denY += dy * dy;
  }
  if (denX === 0 || denY === 0) return null;
  return num / Math.sqrt(denX * denY);
}

function corrColor(v) {
  if (v === null) return 'rgba(255,255,255,0.2)';
  if (v > 0.6) return '#00ff80';
  if (v < 0.2) return '#ff1478';
  return '#ffd166';
}

export default function CorrelationWidget() {
  const [symbols, setSymbols] = useState(DEFAULT_SYMBOLS);
  const [showAdd, setShowAdd] = useState(false);

  const { data: assets = [] } = useQuery({
    queryKey: ['all-assets'],
    queryFn: () => backend.entities.MonitoredAsset.list('-created_date'),
    staleTime: 60000,
  });

  const { data: candlesBySymbol, isLoading, error } = useQuery({
    queryKey: ['correlation-candles', symbols.join(',')],
    queryFn: async () => {
      const entries = await Promise.all(symbols.map(async (sym) => [sym, await fetchCandles(sym, TIMEFRAME, CANDLES_LIMIT)]));
      return Object.fromEntries(entries);
    },
    staleTime: 60000,
    retry: 1,
  });

  const analysis = useMemo(() => {
    if (!candlesBySymbol) return null;

    // % change normalizado (base 0% no primeiro candle) para o gráfico, e
    // retornos período-a-período (para a correlação de Pearson — correlação
    // sobre níveis de preço/% acumulado é enganosa quando as séries têm
    // tendência comum, retornos são a prática padrão).
    const normalized = {};
    const returns = {};
    let minLen = Infinity;
    for (const sym of symbols) {
      const candles = candlesBySymbol[sym];
      if (!candles || candles.length < 2) continue;
      const closed = candles.filter(c => c.isClosed);
      minLen = Math.min(minLen, closed.length);
      const base = closed[0].close;
      normalized[sym] = closed.map(c => ((c.close - base) / base) * 100);
      returns[sym] = closed.slice(1).map((c, i) => (c.close - closed[i].close) / closed[i].close);
    }

    const validSymbols = symbols.filter(s => normalized[s]);
    if (validSymbols.length < 2 || !Number.isFinite(minLen)) return null;

    // Mesmo alinhamento pela janela mais recente usado em pearsonCorrelation
    // — evita misturar candles antigos de um símbolo com candles recentes de
    // outro quando o histórico fetchado tem tamanhos diferentes.
    const chartData = [];
    for (let i = 0; i < minLen; i++) {
      const point = { i };
      for (const sym of validSymbols) {
        const series = normalized[sym];
        point[sym] = +series[series.length - minLen + i].toFixed(2);
      }
      chartData.push(point);
    }

    const matrix = {};
    const pairCorrs = [];
    for (const a of validSymbols) {
      matrix[a] = {};
      for (const b of validSymbols) {
        const corr = a === b ? 1 : pearsonCorrelation(returns[a], returns[b]);
        matrix[a][b] = corr;
        if (a < b && corr !== null) pairCorrs.push(corr);
      }
    }
    const avgCorr = pairCorrs.length > 0 ? pairCorrs.reduce((s, v) => s + v, 0) / pairCorrs.length : null;

    return { chartData, matrix, validSymbols, avgCorr };
  }, [candlesBySymbol, symbols]);

  const addableAssets = assets.filter(a => !symbols.includes(a.symbol));

  const banner = analysis?.avgCorr === null || analysis?.avgCorr === undefined
    ? null
    : analysis.avgCorr > 0.6
      ? { label: '✅ ALINHADOS', color: '#00ff80', bg: 'rgba(0,255,128,0.1)', border: 'rgba(0,255,128,0.3)' }
      : analysis.avgCorr < 0.2
        ? { label: '⚠ DIVERGINDO', color: '#ff1478', bg: 'rgba(255,20,120,0.1)', border: 'rgba(255,20,120,0.3)' }
        : { label: '~ MISTO', color: '#ffd166', bg: 'rgba(255,209,102,0.08)', border: 'rgba(255,209,102,0.25)' };

  return (
    <div className="rounded-2xl p-4 space-y-3" style={{ background: 'rgba(6,8,15,0.7)', border: '1px solid rgba(255,255,255,0.07)', backdropFilter: 'blur(20px)' }}>
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <GitCompareArrows className="w-3.5 h-3.5" style={{ color: '#00e5ff' }} />
          <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">Correlação de Preço</span>
          {banner && (
            <span className="text-[9px] font-mono px-2 py-0.5 rounded font-bold"
              style={{ background: banner.bg, border: `1px solid ${banner.border}`, color: banner.color }}>
              {banner.label}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 flex-wrap relative">
          {symbols.map(sym => (
            <span key={sym} className="flex items-center gap-1 text-[9px] font-mono px-2 py-1 rounded-md"
              style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.7)' }}>
              {sym.replace('USDT', '')}
              <button onClick={() => setSymbols(s => s.filter(x => x !== sym))} className="hover:opacity-70">
                <X className="w-2.5 h-2.5" />
              </button>
            </span>
          ))}
          <button onClick={() => setShowAdd(v => !v)}
            className="flex items-center gap-1 text-[9px] font-mono px-2 py-1 rounded-md transition-all"
            style={{ background: 'rgba(0,229,255,0.08)', border: '1px solid rgba(0,229,255,0.2)', color: '#00e5ff' }}>
            <Plus className="w-2.5 h-2.5" />Add
          </button>
          {showAdd && (
            <div className="absolute top-full right-0 mt-1 rounded-lg overflow-hidden z-20 max-h-48 overflow-y-auto"
              style={{ background: 'rgba(10,13,22,0.98)', border: '1px solid rgba(255,255,255,0.1)', minWidth: 160 }}>
              {addableAssets.length === 0 ? (
                <div className="px-3 py-2 text-[9px] font-mono text-muted-foreground">Nenhum outro ativo monitorado</div>
              ) : addableAssets.map(a => (
                <button key={a.id} onClick={() => { setSymbols(s => [...s, a.symbol]); setShowAdd(false); }}
                  className="block w-full text-left px-3 py-1.5 text-[9px] font-mono hover:bg-white/[0.04]"
                  style={{ color: 'rgba(255,255,255,0.7)' }}>
                  {a.display_name} <span className="text-muted-foreground">({a.symbol})</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {isLoading && <div className="text-[9px] font-mono text-muted-foreground animate-pulse py-6 text-center">Carregando preços...</div>}

      {!isLoading && (error || !analysis) && (
        <div className="text-center py-4">
          <AlertTriangle className="w-4 h-4 mx-auto mb-1 text-muted-foreground opacity-30" />
          <div className="text-[9px] font-mono text-muted-foreground">Selecione ao menos 2 ativos com dados suficientes.</div>
        </div>
      )}

      {!isLoading && analysis && (
        <>
          <div style={{ height: 160 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={analysis.chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
                <XAxis dataKey="i" hide />
                <YAxis tick={{ fontSize: 9, fill: 'rgba(255,255,255,0.4)' }} unit="%" width={38} />
                <Tooltip
                  contentStyle={{ background: 'rgba(10,13,22,0.95)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, fontSize: 10, fontFamily: 'monospace' }}
                  formatter={(value, name) => [`${value}%`, String(name).replace('USDT', '')]}
                />
                <Legend wrapperStyle={{ fontSize: 9, fontFamily: 'monospace' }} formatter={(v) => String(v).replace('USDT', '')} />
                {analysis.validSymbols.map((sym, i) => (
                  <Line key={sym} type="monotone" dataKey={sym} stroke={LINE_COLORS[i % LINE_COLORS.length]} strokeWidth={1.5} dot={false} />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>

          <div className="overflow-x-auto">
            <table className="text-[9px] font-mono w-full">
              <thead>
                <tr>
                  <th className="text-left px-2 py-1 text-muted-foreground"></th>
                  {analysis.validSymbols.map(sym => (
                    <th key={sym} className="px-2 py-1 text-muted-foreground text-center">{sym.replace('USDT', '')}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {analysis.validSymbols.map(rowSym => (
                  <tr key={rowSym}>
                    <td className="px-2 py-1 text-muted-foreground font-bold">{rowSym.replace('USDT', '')}</td>
                    {analysis.validSymbols.map(colSym => {
                      const v = analysis.matrix[rowSym][colSym];
                      return (
                        <td key={colSym} className="px-2 py-1 text-center font-bold" style={{ color: corrColor(v) }}>
                          {v === null ? '—' : v.toFixed(2)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
