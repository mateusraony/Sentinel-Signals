import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { backend } from '@/api/entities';
import { getPineConfig, getLocalPineConfig } from '@/lib/pineParser';
import { logInfo } from '@/lib/logger';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { SlidersHorizontal, Save, CheckCircle2, RotateCcw, AlertTriangle, BarChart3, ShieldAlert, Zap } from 'lucide-react';

// Cada slider: chave no pineConfig, alvo de gravação ('strategyConfig' ou
// 'assets'), faixa e passo. Agrupados em 3 colunas (Range Filter / Gestão de
// Risco / Confirmação) — mesma separação conceitual que já existia, só
// reorganizada visualmente. rng_per/rng_qty são por-ativo (MonitoredAsset.
// rf_period/rf_multiplier), os demais sincronizam via strategyConfig/current
// (mesmo doc que a aba "Parâmetros Ativos" do Pine Script lê).
const GROUPS = [
  {
    id: 'range_filter', label: 'Range Filter', icon: BarChart3, color: '#00ff80',
    fields: [
      { key: 'rng_per', label: 'Swing Period', target: 'assets', min: 5, max: 50, step: 1, suffix: '',
        help: 'Janela (em candles) do Range Filter. Maior = menos sensível a ruído e mais atraso pra detectar mudança de tendência; menor = reage mais rápido, mas com mais falso sinal.' },
      { key: 'rng_qty', label: 'Swing Multiplier', target: 'assets', min: 0.5, max: 8, step: 0.1, suffix: '',
        help: 'Multiplicador que controla a largura da banda do Range Filter. Maior = banda mais larga, filtra mais reversões pequenas antes de virar sinal.' },
    ],
  },
  {
    id: 'risk', label: 'Gestão de Risco', icon: ShieldAlert, color: '#ff1478',
    fields: [
      { key: 'trailAtrMult', label: 'ATR Multiplicador (Stop)', target: 'strategyConfig', min: 0.5, max: 5, step: 0.1, suffix: 'x',
        help: 'Distância do stop/trailing em múltiplos de ATR. Maior = stop mais largo (menos chance de ser varrido por ruído, mas perde mais se a operação errar).' },
      { key: 'tp1R', label: 'TP1 em R', target: 'strategyConfig', min: 0.5, max: 4, step: 0.1, suffix: 'R',
        help: 'Alvo do primeiro take profit, em múltiplos do risco inicial (R). Ex.: 1,5R = realiza parcial quando o lucro atinge 1,5× o valor arriscado no stop.' },
      { key: 'tp1QtyPercent', label: '% Realizar no TP1', target: 'strategyConfig', min: 10, max: 90, step: 5, suffix: '%',
        help: 'Percentual da posição encerrado no TP1. O restante (runner) segue até TP2, trailing ou Time Stop — ver runnerEnabled em known-risks item 46.' },
    ],
  },
  {
    id: 'confirmation', label: 'Confirmação', icon: Zap, color: '#ffd166',
    fields: [
      { key: 'minScore', label: 'Score Mínimo', target: 'strategyConfig', min: 50, max: 100, step: 1, suffix: '',
        help: 'Score mínimo de confluência (0–100) exigido para confirmar um sinal. Maior = mais seletivo, menos sinais confirmados.' },
      { key: 'atrLen', label: 'ATR Periodo', target: 'strategyConfig', min: 5, max: 30, step: 1, suffix: '',
        help: 'Período (em candles) usado para calcular o ATR (Average True Range) que dimensiona o stop inicial e o trailing.' },
    ],
  },
];

const FIELDS = GROUPS.flatMap(g => g.fields);

// Flags booleanas (não são slider — on/off), mesmo destino strategyConfig.
// docs/known-risks.md item 120: skip15mConfirmationEnabled bypassa
// check15mConfirmation na cascata RF nativa 4h→15m — objetivo é bater 1:1
// com a estratégia real do usuário no TradingView (entra no fechamento do
// candle 4h, sem confirmação de timeframe menor, ver .claude/rules/
// trading-engine.md item 67). Medido em 4 rodadas de backtest (item 120):
// melhor ponto estimado da investigação, ainda sem significância (p~0,16-0,29).
// docs/known-risks.md item 114/128: disableTp2CapEnabled desliga o teto de
// TP2 do runner (tp1R×2, invenção do Sentinel) — o Pine real do usuário só
// tem trailing pós-TP1, sem segundo alvo fixo. Mesmo objetivo de fidelidade
// ao TradingView do skip15mConfirmationEnabled acima. Medido (item 115):
// ponto estimado melhora, ainda sem significância (p=0,688).
const BOOL_FIELDS = [
  {
    key: 'skip15mConfirmationEnabled', target: 'strategyConfig',
    label: 'Bypass confirmação 15m (fidelidade TradingView)',
    help: 'Entra no fechamento do candle 4h, sem esperar confirmação 15m — igual ao Pine real do usuário. Ver known-risks item 120.',
  },
  {
    key: 'disableTp2CapEnabled', target: 'strategyConfig',
    label: 'Desligar teto de TP2 (fidelidade TradingView)',
    help: 'Runner corre até trailing/Time Stop/Chop Exit, sem fechar em 2×TP1 — igual ao Pine real do usuário. Ver known-risks item 128.',
  },
];

const STRATEGY_KEYS = [...FIELDS.filter(f => f.target === 'strategyConfig').map(f => f.key), ...BOOL_FIELDS.map(f => f.key)];

const ACTIVE_CONFIG_PILLS = [
  { key: 'rng_per', label: 'RF Period' },
  { key: 'rng_qty', label: 'RF Mult' },
  { key: 'trailAtrMult', label: 'ATR Mult' },
  { key: 'tp1R', label: 'TP1 R' },
  { key: 'tp1QtyPercent', label: 'TP1 %' },
  { key: 'minScore', label: 'Min Score' },
  { key: 'atrLen', label: 'ATR Len' },
];

function fmtValue(value, suffix) {
  if (value == null) return '—';
  const rounded = Number.isInteger(value) ? value : Math.round(value * 100) / 100;
  return `${rounded}${suffix}`;
}

export default function Settings() {
  const queryClient = useQueryClient();
  const [values, setValues] = useState(null);
  const [saveStatus, setSaveStatus] = useState(null); // null | 'saving' | 'saved' | 'error'
  // Codex review (PR #233): handleSave used to resend EVERY STRATEGY_KEYS
  // value from this component's mount-time snapshot. Firestore merge
  // doesn't protect against that — a stale-but-present key in the payload
  // still overwrites whatever another tab/session wrote to
  // strategyConfig/current in the meantime. Track only the keys the user
  // actually touched (slider drag, switch flip, or explicit Restaurar) and
  // send just those, so flipping one flag can never roll back a value
  // someone else changed live.
  const [dirty, setDirty] = useState(() => new Set());
  const markDirty = (key) => setDirty(prev => new Set(prev).add(key));

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
        skip15mConfirmationEnabled: config.skip15mConfirmationEnabled,
        disableTp2CapEnabled: config.disableTp2CapEnabled,
      });
    });
    return () => { cancelled = true; };
  }, []);

  const handleReset = () => {
    const defaults = getLocalPineConfig();
    const resetKeys = [...FIELDS, ...BOOL_FIELDS].map(f => f.key);
    setValues(v => ({ ...v, ...Object.fromEntries(resetKeys.map(k => [k, defaults[k]])) }));
    setDirty(prev => new Set([...prev, ...resetKeys]));
  };

  const handleSave = async () => {
    if (!values) return;
    setSaveStatus('saving');
    try {
      const strategyPayload = {};
      for (const key of STRATEGY_KEYS) {
        if (dirty.has(key)) strategyPayload[key] = values[key];
      }
      if (Object.keys(strategyPayload).length > 0) {
        await backend.entities.StrategyConfig.set('current', {
          ...strategyPayload,
          updated_at: new Date().toISOString(),
        });
      }

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
      setDirty(new Set());
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
    <div className="space-y-5 max-w-6xl mx-auto">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <p className="text-[11px] font-mono uppercase tracking-[0.2em] text-muted-foreground mb-1">Configuração</p>
          <h1 className="text-3xl font-bold text-foreground tracking-tight">Ajuste Fino</h1>
          <p className="text-[10px] font-mono text-muted-foreground mt-1">
            Altere multiplicadores de ATR, alvos de lucro e parâmetros do Range Filter sem tocar no código.
          </p>
        </div>
        <div className="flex items-center gap-1.5 text-[9px] font-mono px-2.5 py-1.5 rounded-lg"
          style={{ background: 'rgba(0,229,255,0.08)', border: '1px solid rgba(0,229,255,0.2)', color: '#00e5ff' }}>
          <SlidersHorizontal className="w-3 h-3" />Aplicado instantaneamente no próximo scan
        </div>
      </div>

      <div className="rounded-xl p-5 space-y-5" style={{ background: 'rgba(10,13,22,0.8)', border: '1px solid rgba(255,255,255,0.06)' }}>
        <div className="flex items-center justify-between flex-wrap gap-3 pb-1" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
          <div className="flex items-center gap-2">
            <SlidersHorizontal className="w-4 h-4" style={{ color: '#00e5ff' }} />
            <div>
              <h2 className="text-sm font-bold text-foreground">Ajuste Fino de Parâmetros</h2>
              <p className="text-[9px] font-mono text-muted-foreground">Otimize o motor para diferentes níveis de risco</p>
            </div>
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
              {saveStatus === 'saving' ? 'Salvando...' : saveStatus === 'saved' ? 'Salvo!' : saveStatus === 'error' ? 'Erro ao salvar' : 'Salvar & Sincronizar'}
            </button>
          </div>
        </div>

        <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg text-[10px] font-mono" style={{ background: 'rgba(255,159,67,0.08)', border: '1px solid rgba(255,159,67,0.2)', color: '#ff9f43' }}>
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span>
            Alterações são aplicadas instantaneamente ao scanner no próximo scan. Use o{' '}
            <Link to="/backtest" className="font-bold underline underline-offset-2">Backtest</Link> para validar antes.
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {GROUPS.map(group => (
            <div key={group.id} className="rounded-xl p-4 space-y-4" style={{ background: 'rgba(255,255,255,0.02)', border: `1px solid ${group.color}25` }}>
              <div className="flex items-center gap-1.5">
                <group.icon className="w-3.5 h-3.5" style={{ color: group.color }} />
                <span className="text-[10px] font-mono font-bold uppercase tracking-wider" style={{ color: group.color }}>{group.label}</span>
              </div>
              {group.fields.map(field => (
                <div key={field.key} className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-mono text-muted-foreground">{field.label}</span>
                    <span className="text-xs font-mono font-bold" style={{ color: group.color }}>
                      {fmtValue(values[field.key], field.suffix)}
                    </span>
                  </div>
                  <Slider
                    value={[values[field.key] ?? field.min]}
                    min={field.min}
                    max={field.max}
                    step={field.step}
                    aria-label={field.label}
                    onValueChange={([v]) => { setValues(prev => ({ ...prev, [field.key]: v })); markDirty(field.key); }}
                  />
                  <div className="flex items-center justify-between text-[8px] font-mono text-muted-foreground/50">
                    <span>{field.min}</span><span>{field.max}</span>
                  </div>
                  {field.help && (
                    <p className="text-[9px] font-mono text-muted-foreground/70 leading-snug">{field.help}</p>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>

        <div className="space-y-3 pt-1">
          {BOOL_FIELDS.map(field => (
            <div key={field.key} className="flex items-center justify-between gap-4 rounded-xl p-4"
              style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,209,102,0.2)' }}>
              <div className="space-y-0.5">
                <p className="text-[10px] font-mono font-bold text-foreground">{field.label}</p>
                <p className="text-[9px] font-mono text-muted-foreground">{field.help}</p>
              </div>
              <Switch
                checked={!!values[field.key]}
                onCheckedChange={(checked) => { setValues(prev => ({ ...prev, [field.key]: checked })); markDirty(field.key); }}
                aria-label={field.label}
              />
            </div>
          ))}
        </div>

        <div className="pt-3" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          <p className="text-[9px] font-mono text-muted-foreground mb-2">Configuração Ativa (lida pelo scanner):</p>
          <div className="flex items-center gap-2 flex-wrap">
            {ACTIVE_CONFIG_PILLS.map(p => (
              <span key={p.key} className="text-[9px] font-mono px-2.5 py-1 rounded-md"
                style={{ background: 'rgba(0,255,128,0.06)', border: '1px solid rgba(0,255,128,0.2)', color: '#00ff80' }}>
                {p.label}: {fmtValue(values[p.key], '')}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
