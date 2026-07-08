import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Loader2 } from 'lucide-react';

export default function AssetConfigPanel({ asset, onSave }) {
  const [config, setConfig] = useState({
    timeframes_enabled: asset.timeframes_enabled || { '1h': true, '4h': true, '1d': true },
    rf_period: asset.rf_period || 20,
    rf_multiplier: asset.rf_multiplier || 3.5,
    rsi_period: asset.rsi_period || 14,
    rsi_overbought: asset.rsi_overbought || 70,
    rsi_oversold: asset.rsi_oversold || 30,
    macd_fast: asset.macd_fast || 12,
    macd_slow: asset.macd_slow || 26,
    macd_signal: asset.macd_signal || 9,
    ema_short: asset.ema_short || 9,
    ema_long: asset.ema_long || 21,
    alert_cooldown_minutes: asset.alert_cooldown_minutes || 60,
  });
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    await base44.entities.MonitoredAsset.update(asset.id, config);
    setSaving(false);
    onSave();
  };

  const updateTf = (tf, enabled) => {
    setConfig(prev => ({
      ...prev,
      timeframes_enabled: { ...prev.timeframes_enabled, [tf]: enabled }
    }));
  };

  return (
    <div className="space-y-5 max-h-[70vh] overflow-y-auto pr-1">
      {/* Timeframes */}
      <div>
        <Label className="text-sm font-medium mb-2 block">Timeframes</Label>
        <div className="space-y-2">
          {['1h', '4h', '1d'].map(tf => (
            <div key={tf} className="flex items-center justify-between">
              <span className="text-sm font-mono">{tf.toUpperCase()}</span>
              <Switch
                checked={config.timeframes_enabled[tf] !== false}
                onCheckedChange={(v) => updateTf(tf, v)}
              />
            </div>
          ))}
        </div>
      </div>

      {/* Range Filter */}
      <div>
        <Label className="text-sm font-medium mb-2 block">Range Filter</Label>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label className="text-xs text-muted-foreground">Período</Label>
            <Input type="number" value={config.rf_period} onChange={e => setConfig({...config, rf_period: Number(e.target.value)})} className="mt-1" />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">Multiplicador</Label>
            <Input type="number" step="0.1" value={config.rf_multiplier} onChange={e => setConfig({...config, rf_multiplier: Number(e.target.value)})} className="mt-1" />
          </div>
        </div>
      </div>

      {/* RSI */}
      <div>
        <Label className="text-sm font-medium mb-2 block">RSI</Label>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <Label className="text-xs text-muted-foreground">Período</Label>
            <Input type="number" value={config.rsi_period} onChange={e => setConfig({...config, rsi_period: Number(e.target.value)})} className="mt-1" />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">Overbought</Label>
            <Input type="number" value={config.rsi_overbought} onChange={e => setConfig({...config, rsi_overbought: Number(e.target.value)})} className="mt-1" />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">Oversold</Label>
            <Input type="number" value={config.rsi_oversold} onChange={e => setConfig({...config, rsi_oversold: Number(e.target.value)})} className="mt-1" />
          </div>
        </div>
      </div>

      {/* MACD */}
      <div>
        <Label className="text-sm font-medium mb-2 block">MACD</Label>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <Label className="text-xs text-muted-foreground">Fast</Label>
            <Input type="number" value={config.macd_fast} onChange={e => setConfig({...config, macd_fast: Number(e.target.value)})} className="mt-1" />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">Slow</Label>
            <Input type="number" value={config.macd_slow} onChange={e => setConfig({...config, macd_slow: Number(e.target.value)})} className="mt-1" />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">Signal</Label>
            <Input type="number" value={config.macd_signal} onChange={e => setConfig({...config, macd_signal: Number(e.target.value)})} className="mt-1" />
          </div>
        </div>
      </div>

      {/* EMAs */}
      <div>
        <Label className="text-sm font-medium mb-2 block">Médias Móveis (EMA)</Label>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label className="text-xs text-muted-foreground">Curta</Label>
            <Input type="number" value={config.ema_short} onChange={e => setConfig({...config, ema_short: Number(e.target.value)})} className="mt-1" />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">Longa</Label>
            <Input type="number" value={config.ema_long} onChange={e => setConfig({...config, ema_long: Number(e.target.value)})} className="mt-1" />
          </div>
        </div>
      </div>

      {/* Cooldown */}
      <div>
        <Label className="text-sm font-medium mb-2 block">Cooldown de Alertas</Label>
        <div className="flex items-center gap-2">
          <Input type="number" value={config.alert_cooldown_minutes} onChange={e => setConfig({...config, alert_cooldown_minutes: Number(e.target.value)})} className="w-24" />
          <span className="text-xs text-muted-foreground">minutos entre alertas iguais</span>
        </div>
      </div>

      <Button onClick={handleSave} disabled={saving} className="w-full bg-primary text-primary-foreground">
        {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
        Salvar Configurações
      </Button>
    </div>
  );
}