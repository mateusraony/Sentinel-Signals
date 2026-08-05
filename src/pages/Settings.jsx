import React, { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { backend } from '@/api/entities';
import { getPineConfig, getLocalPineConfig } from '@/lib/pineParser';
import { logInfo } from '@/lib/logger';
import { Slider } from '@/components/ui/slider';
import { SlidersHorizontal, Save, CheckCircle2, RotateCcw } from 'lucide-react';

// Cada slider: chave no pineConfig, alvo de gravação ('strategyConfig' ou
// 'assets'), faixa e passo. Os 5 primeiros já são sincronizados via
// strategyConfig/current (mesmo doc que a aba "Parâmetros Ativos" do Pine
// Script lê) — rng_per/rng_qty são por-ativo (MonitoredAsset.rf_period/
// rf_multiplier), mesma exceção documentada em pineParser.js.
const FIELDS = [
  { key: 'minScore', label: 'Score mínimo', target: 'strategyConfig', min: 0, max: 100, step: 1, suffix: '' },
  { key: 'tp1R', label: 'TP1 (em R)', target: 'strategyConfig', min: 0.5, max: 5, step: 0.1, suffix: 'R' },
  { key: 'tp1QtyPercent', label: '% de realização no TP1', target: 'strategyConfig', min: 10, max: 100, step: 5, suffix: '%' },
  { key: 'trailAtrMult', label: 'Multiplicador de ATR (trailing)', target: 'strategyConfig', min: 0.5, max: 5, step: 0.1, suffix: '×' },
  { key: 'atrLen', label: 'Período do ATR', target: 'strategyConfig', min: 5, max: 50, step: 1, suffix: ' velas' },
  { key: 'rng_per', label: 'Período do Range Filter', target: 'assets', min: 5, max: 100, step: 1, suffix: ' velas' },
  { key: 'rng_qty', label: 'Multiplicador do Range Filter', target: 'assets', min: 0.5, max: 10, step: 0.1, suffix: '×' },
];

const STRATEGY_KEYS = FIELDS.filter(f => f.target === 'strategyConfig').map(f => f.key);

function fmtValue(value, suffix) {
  if (value == null) return '—';
  const rounded = Number.isInteger(value) ? value : Math.round(value * 100) / 100;
  return `${rounded}${suffix}`;
}

export default function Settings() {
  const queryClient = useQueryClient();
  const [values, setValues] = useState(null);
  const [saveStatus, setSaveStatus] = useState(null); // null | 'saving' | 'saved' | 'error'

  const { data: assets = [] } = useQuery({
    queryKey: ['all-assets'],
    queryFn: () => backend.entities.MonitoredAsset.list('-created_date'),
  });

  useEffect(() => {
    let cancelled = false;
    getPineConfig().then(config => {
      if (cancelled) return;
      setValues({
        minScore: config.minScore,
        tp1R: config.tp1R,
        tp1QtyPercent: config.tp1QtyPercent,
        trailAtrMult: config.trailAtrMult,
        atrLen: config.atrLen,
        rng_per: config.rng_per,
        rng_qty: config.rng_qty,
      });
    });
    return () => { cancelled = true; };
  }, []);

  const handleReset = () => {
    const defaults = getLocalPineConfig();
    setValues(v => ({ ...v, ...Object.fromEntries(FIELDS.map(f => [f.key, defaults[f.key]])) }));
  };

  const handleSave = async () => {
    if (!values) return;
    setSaveStatus('saving');
    try {
      const strategyPayload = {};
      for (const key of STRATEGY_KEYS) strategyPayload[key] = values[key];
      await backend.entities.StrategyConfig.set('current', {
        ...strategyPayload,
        updated_at: new Date().toISOString(),
      });

      const activeAssets = assets.filter(a => a.is_active);
      const toUpdate = activeAssets.filter(
        a => a.rf_period !== values.rng_per || a.rf_multiplier !== values.rng_qty
      );
      await Promise.all(
        toUpdate.map(a => backend.entities.MonitoredAsset.update(a.id, {
          rf_period: values.rng_per,
          rf_multiplier: values.rng_qty,
        }))
      );
      queryClient.invalidateQueries({ queryKey: ['all-assets'] });

      logInfo('settings', `Ajustes finos salvos — ${toUpdate.length} ativo(s) atualizado(s)`, strategyPayload);
      setSaveStatus('saved');
    } catch (e) {
      setSaveStatus('error');
    } finally {
      setTimeout(() => setSaveStatus(null), 3000);
    }
  };

  if (!values) {
    return (
      <div className="flex justify-center py-20">
        <div className="text-[11px] font-mono text-muted-foreground animate-pulse">Carregando configuração...</div>
      </div>
    );
  }

  return (
    <div className="space-y-5 max-w-3xl mx-auto">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <p className="text-[11px] font-mono uppercase tracking-[0.2em] text-muted-foreground mb-1">Estratégia</p>
          <h1 className="text-3xl font-bold text-foreground tracking-tight">Ajustes Finos</h1>
          <p className="text-[10px] font-mono text-muted-foreground mt-1">
            Multiplicadores de ATR, alvos de lucro e parâmetros do Range Filter — sincronizados com o scanner ao vivo.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={handleReset}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-mono transition-all"
            style={{ background: 'rgba(255,159,67,0.07)', border: '1px solid rgba(255,159,67,0.2)', color: '#ff9f43' }}>
            <RotateCcw className="w-3 h-3" />Restaurar
          </button>
          <button onClick={handleSave} disabled={saveStatus === 'saving'}
            className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-[10px] font-mono font-bold transition-all disabled:opacity-50"
            style={{
              background: saveStatus === 'saved' ? 'rgba(0,255,128,0.15)' : 'rgba(0,255,128,0.08)',
              border: '1px solid rgba(0,255,128,0.3)', color: '#00ff80',
            }}>
            {saveStatus === 'saved' ? <CheckCircle2 className="w-3 h-3" /> : <Save className="w-3 h-3" />}
            {saveStatus === 'saving' ? 'Salvando...' : saveStatus === 'saved' ? 'Salvo!' : saveStatus === 'error' ? 'Erro ao salvar' : 'Salvar e sincronizar'}
          </button>
        </div>
      </div>

      <div className="rounded-xl p-5 space-y-6" style={{ background: 'rgba(10,13,22,0.8)', border: '1px solid rgba(255,255,255,0.06)' }}>
        <div className="flex items-center gap-2 pb-1" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
          <SlidersHorizontal className="w-4 h-4" style={{ color: '#00e5ff' }} />
          <h2 className="text-sm font-bold text-foreground">Parâmetros de entrada e saída</h2>
        </div>

        {FIELDS.map(field => (
          <div key={field.key} className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-mono text-muted-foreground">{field.label}</span>
              <span className="text-xs font-mono font-bold" style={{ color: '#00e5ff' }}>
                {fmtValue(values[field.key], field.suffix)}
              </span>
            </div>
            <Slider
              value={[values[field.key] ?? field.min]}
              min={field.min}
              max={field.max}
              step={field.step}
              onValueChange={([v]) => setValues(prev => ({ ...prev, [field.key]: v }))}
            />
          </div>
        ))}

        <p className="text-[9px] font-mono text-muted-foreground/70 pt-1">
          Score mínimo, TP1, % de realização, ATR e período do trailing gravam em <code>strategyConfig/current</code> (o mesmo
          documento que o cron de scan lê). Período e multiplicador do Range Filter aplicam a todos os ativos monitorados ativos.
        </p>
      </div>
    </div>
  );
}
