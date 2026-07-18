import React from 'react';
import { Sliders, Activity, Clock } from 'lucide-react';
import RFHistoryChart from './RFHistoryChart';
import moment from 'moment';

function fmt(price) {
  if (!price && price !== 0) return '—';
  if (price >= 10000) return price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (price >= 100) return price.toFixed(2);
  if (price >= 1) return price.toFixed(4);
  return price.toFixed(6);
}

function ParamCard({ label, value, pineVar, color }) {
  return (
    <div className="rounded-lg px-2.5 py-2 text-center"
      style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)' }}>
      <div className="text-[8px] font-mono text-muted-foreground uppercase tracking-wider">{label}</div>
      <div className="text-sm font-mono font-bold mt-0.5" style={{ color: color || 'rgba(255,255,255,0.8)' }}>{value}</div>
      {pineVar && <div className="text-[7px] font-mono mt-0.5" style={{ color: 'rgba(0,255,128,0.35)' }}>{pineVar}</div>}
    </div>
  );
}

function TFStateCard({ tf, state, enabled }) {
  if (!enabled) {
    return (
      <div className="rounded-lg p-3 text-center opacity-40"
        style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.04)' }}>
        <div className="text-[9px] font-mono text-muted-foreground">{tf.toUpperCase()}</div>
        <div className="text-[10px] font-mono text-muted-foreground mt-1">Desativado</div>
      </div>
    );
  }

  if (!state) {
    return (
      <div className="rounded-lg p-3 text-center"
        style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.04)' }}>
        <div className="text-[9px] font-mono text-muted-foreground">{tf.toUpperCase()}</div>
        <div className="text-[10px] font-mono text-muted-foreground mt-1">Sem dados</div>
      </div>
    );
  }

  const dir = state.rf_direction;
  const dirColor = dir === 1 ? '#00ff80' : dir === -1 ? '#ff1478' : '#64748b';
  const dirLabel = dir === 1 ? '▲ Bull' : dir === -1 ? '▼ Bear' : '— Neu';
  const rsiZone = state.rsi_zone;
  const rsiColor = rsiZone === 'overbought' ? '#ff1478' : rsiZone === 'oversold' ? '#00ff80' : 'rgba(255,255,255,0.6)';
  const macdH = state.macd_histogram || 0;
  const macdColor = macdH > 0 ? '#00ff80' : macdH < 0 ? '#ff1478' : '#64748b';
  const emaTrend = state.trend_ema;
  const emaColor = emaTrend === 'bullish' ? '#00ff80' : emaTrend === 'bearish' ? '#ff1478' : '#64748b';

  return (
    <div className="rounded-lg p-3 space-y-2"
      style={{ background: 'rgba(255,255,255,0.03)', border: `1px solid ${dirColor}30` }}>
      <div className="flex items-center justify-between">
        <span className="text-[9px] font-mono font-bold text-foreground">{tf.toUpperCase()}</span>
        <span className="text-[9px] font-mono font-bold" style={{ color: dirColor }}>{dirLabel}</span>
      </div>

      <div className="space-y-1 text-[9px] font-mono">
        <div className="flex justify-between">
          <span className="text-muted-foreground">RF Value</span>
          <span style={{ color: 'rgba(0,229,255,0.7)' }}>${fmt(state.rf_filter_value)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">RF Band</span>
          <span style={{ color: 'rgba(255,255,255,0.5)' }}>
            ${fmt(state.rf_low_band)} ~ ${fmt(state.rf_high_band)}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Last Close</span>
          <span style={{ color: 'rgba(255,255,255,0.7)' }}>${fmt(state.last_close)}</span>
        </div>
      </div>

      <div style={{ height: 1, background: 'rgba(255,255,255,0.05)' }} />

      <div className="grid grid-cols-3 gap-1 text-center">
        <div>
          <div className="text-[7px] font-mono text-muted-foreground">RSI</div>
          <div className="text-[10px] font-mono font-bold" style={{ color: rsiColor }}>
            {state.rsi_value ? state.rsi_value.toFixed(0) : '—'}
          </div>
        </div>
        <div>
          <div className="text-[7px] font-mono text-muted-foreground">MACD</div>
          <div className="text-[10px] font-mono font-bold" style={{ color: macdColor }}>
            {macdH > 0 ? '▲' : macdH < 0 ? '▼' : '—'}
          </div>
        </div>
        <div>
          <div className="text-[7px] font-mono text-muted-foreground">EMA</div>
          <div className="text-[10px] font-mono font-bold" style={{ color: emaColor }}>
            {emaTrend === 'bullish' ? '▲' : emaTrend === 'bearish' ? '▼' : '—'}
          </div>
        </div>
      </div>

      {/* processed_at only advances when the state actually changes (see
          src/lib/assetStateDiff.js) — for slow timeframes (4h/1d) this
          reflects the last closed candle, not the last scan attempt; use
          the asset's own healthcheck (docs/known-risks.md item 12) to judge
          whether the scan itself is still running. */}
      {state.processed_at && (
        <div className="text-[7px] font-mono text-muted-foreground/60 text-center">
          {moment(state.processed_at).fromNow()}
        </div>
      )}
    </div>
  );
}

export default function AssetDetailPanel({ asset, states, expanded }) {
  if (!expanded) return null;

  return (
    <div className="mt-3 rounded-xl p-4 space-y-4"
      style={{ background: 'rgba(6,8,15,0.6)', border: '1px solid rgba(255,255,255,0.04)' }}>

      {/* Section: RF Parameters */}
      <div>
        <div className="flex items-center gap-1.5 mb-2">
          <Sliders className="w-3 h-3" style={{ color: '#00e5ff' }} />
          <span className="text-[9px] font-mono font-bold text-muted-foreground uppercase tracking-wider">
            Parâmetros Range Filter
          </span>
        </div>
        <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
          <ParamCard label="RF Period" value={asset.rf_period ?? 20} pineVar="rng_per" color="#00e5ff" />
          <ParamCard label="RF Mult" value={asset.rf_multiplier ?? 3.5} pineVar="rng_qty" color="#00e5ff" />
          <ParamCard label="RSI Period" value={asset.rsi_period ?? 14} pineVar="rsiLen" />
          <ParamCard label="RSI OB/OS" value={`${asset.rsi_overbought ?? 70}/${asset.rsi_oversold ?? 30}`} />
          <ParamCard label="MACD" value={`${asset.macd_fast ?? 12}/${asset.macd_slow ?? 26}/${asset.macd_signal ?? 9}`} />
          <ParamCard label="EMA" value={`${asset.ema_short ?? 20}/${asset.ema_long ?? 50}`} />
        </div>
      </div>

      {/* Section: Config */}
      <div className="flex items-center gap-4 flex-wrap text-[9px] font-mono">
        <div className="flex items-center gap-1.5">
          <Clock className="w-3 h-3 text-muted-foreground" />
          <span className="text-muted-foreground">Alert Cooldown:</span>
          <span className="text-foreground/70 font-bold">{asset.alert_cooldown_minutes ?? 60}min</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Activity className="w-3 h-3 text-muted-foreground" />
          <span className="text-muted-foreground">Timeframes:</span>
          {['1h', '4h', '1d'].map(tf => {
            const enabled = asset.timeframes_enabled?.[tf] !== false;
            return (
              <span key={tf} className="px-1.5 py-0.5 rounded font-bold"
                style={enabled
                  ? { background: 'rgba(0,255,128,0.1)', color: '#00ff80', border: '1px solid rgba(0,255,128,0.2)' }
                  : { background: 'rgba(255,255,255,0.03)', color: 'rgba(255,255,255,0.2)', border: '1px solid rgba(255,255,255,0.05)' }}>
                {tf.toUpperCase()}
              </span>
            );
          })}
        </div>
      </div>

      {/* Section: Per-TF State */}
      <div>
        <div className="flex items-center gap-1.5 mb-2">
          <Activity className="w-3 h-3" style={{ color: '#00ff80' }} />
          <span className="text-[9px] font-mono font-bold text-muted-foreground uppercase tracking-wider">
            Estado por Timeframe
          </span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          {['1h', '4h', '1d'].map(tf => {
            const state = states.find(s => s.timeframe === tf);
            const enabled = asset.timeframes_enabled?.[tf] !== false;
            return <TFStateCard key={tf} tf={tf} state={state} enabled={enabled} />;
          })}
        </div>
      </div>

      {/* Section: RF History */}
      <div>
        <RFHistoryChart asset={asset} />
      </div>
    </div>
  );
}