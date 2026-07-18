import React, { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { backend } from '@/api/entities';
import { getLocalPineConfig, getPineConfig } from '@/lib/pineParser';
import { firstPositive } from '@/lib/scanner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Loader2 } from 'lucide-react';

export default function AssetConfigPanel({ asset, onSave }) {
  // handleSave writes this whole object back unconditionally on every save
  // (even when the user only touched, say, the cooldown) — so pre-filling
  // rsi_period/ema_short/ema_long with a fallback that DIVERGES from the
  // Pine script would silently freeze the wrong values into this asset the
  // next time anyone opens and saves this panel for any reason. Falling
  // back to the synced Pine config (not a hardcoded literal) closes that
  // loop — see known-risks.md item 27.
  const localPine = getLocalPineConfig();
  const [config, setConfig] = useState({
    timeframes_enabled: asset.timeframes_enabled || { '1h': true, '4h': true, '1d': true },
    rf_period: asset.rf_period || 20,
    rf_multiplier: asset.rf_multiplier || 3.5,
    rsi_period: firstPositive(asset.rsi_period, localPine.rsiLen, 14),
    rsi_overbought: asset.rsi_overbought || 70,
    rsi_oversold: asset.rsi_oversold || 30,
    macd_fast: asset.macd_fast || 12,
    macd_slow: asset.macd_slow || 26,
    macd_signal: asset.macd_signal || 9,
    ema_short: firstPositive(asset.ema_short, localPine.emaFastLen, 20),
    ema_long: firstPositive(asset.ema_long, localPine.emaSlowLen, 50),
    alert_cooldown_minutes: asset.alert_cooldown_minutes || 60,
    smc_enabled: asset.smc_enabled || false,
    smc_confirm_4h15m: asset.smc_confirm_4h15m || false,
  });
  const [saving, setSaving] = useState(false);

  // Codex review (PR #58): getLocalPineConfig() alone can be stale on a
  // fresh browser/device (localStorage empty, Pine synced elsewhere) — it
  // was only used above for an instant first paint. The Firestore-synced
  // config is the actual source of truth; once it resolves, patch the three
  // fields IF (and only if) the asset itself never had them set — an
  // explicit per-asset override (or a value the user has since typed) must
  // never be silently overwritten here.
  const { data: syncedPine } = useQuery({ queryKey: ['pine-config-synced'], queryFn: getPineConfig, staleTime: 5 * 60 * 1000 });
  useEffect(() => {
    if (!syncedPine) return;
    setConfig(prev => ({
      ...prev,
      rsi_period: asset.rsi_period == null ? firstPositive(syncedPine.rsiLen, prev.rsi_period) : prev.rsi_period,
      ema_short: asset.ema_short == null ? firstPositive(syncedPine.emaFastLen, prev.ema_short) : prev.ema_short,
      ema_long: asset.ema_long == null ? firstPositive(syncedPine.emaSlowLen, prev.ema_long) : prev.ema_long,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-derive when the synced config itself resolves/changes, not on every keystroke
  }, [syncedPine]);

  const handleSave = async () => {
    setSaving(true);
    await backend.entities.MonitoredAsset.update(asset.id, config);
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

      {/* SMC/ICT */}
      <div>
        <Label className="text-sm font-medium mb-2 block">Cascata SMC/ICT</Label>
        <p className="text-xs text-muted-foreground mb-2">
          Padrão de timeframes é sempre automático — 4H/15m para a cascata Range Filter, 1H/5m para a SMC. Não dá pra misturar.
        </p>
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <span className="text-sm block">Ativar cascata 1H → 5M</span>
              <span className="text-xs text-muted-foreground">Entradas próprias por estrutura (BOS/CHoCH) + gatilho de 5m, em paralelo à cascata Range Filter.</span>
            </div>
            <Switch
              checked={config.smc_enabled}
              onCheckedChange={(v) => setConfig({ ...config, smc_enabled: v })}
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <div>
              <span className="text-sm block">Confirmação SMC na cascata 4H/15m</span>
              <span className="text-xs text-muted-foreground">Exige estrutura 4H + zona Premium/Discount alinhadas antes de abrir uma entrada Range Filter.</span>
            </div>
            <Switch
              checked={config.smc_confirm_4h15m}
              onCheckedChange={(v) => setConfig({ ...config, smc_confirm_4h15m: v })}
            />
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