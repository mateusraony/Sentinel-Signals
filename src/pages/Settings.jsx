import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { backend } from '@/api/entities';
import { getPineConfig, getLocalPineConfig } from '@/lib/pineParser';
import { logInfo, logError } from '@/lib/logger';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Save, CheckCircle2, RotateCcw } from 'lucide-react';

// Cada slider: chave no pineConfig, alvo de gravação ('strategyConfig' ou
// 'assets'), faixa e passo. Agrupados em 3 colunas (Range Filter / Gestão de
// Risco / Confirmação) — mesma separação conceitual que já existia, só
// reorganizada visualmente. rng_per/rng_qty são por-ativo (MonitoredAsset.
// rf_period/rf_multiplier), os demais sincronizam via strategyConfig/current
// (mesmo doc que a aba "Parâmetros Ativos" do Pine Script lê).
const GROUPS = [
  {
    id: 'range_filter', label: 'Range Filter', color: '#5db586',
    fields: [
      { key: 'rng_per', label: 'Swing Period', target: 'assets', min: 5, max: 50, step: 1, suffix: '',
        help: 'Janela (em candles) do Range Filter. Maior = menos sensível a ruído e mais atraso pra detectar mudança de tendência; menor = reage mais rápido, mas com mais falso sinal.' },
      { key: 'rng_qty', label: 'Swing Multiplier', target: 'assets', min: 0.5, max: 8, step: 0.1, suffix: '',
        help: 'Multiplicador que controla a largura da banda do Range Filter. Maior = banda mais larga, filtra mais reversões pequenas antes de virar sinal.' },
    ],
  },
  {
    id: 'risk', label: 'Gestão de Risco', color: '#e06a5b',
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
    id: 'confirmation', label: 'Confirmação', color: '#e3b45a',
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

  // Valores padrão (os mesmos que o "Restaurar" aplica): cada controle mostra o seu "padrão" e marca o que está diferente dele.
  const defaults = useMemo(() => getLocalPineConfig(), []);

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
      logError('Settings', 'Falha ao salvar ajustes finos', { error: e.message });
      setSaveStatus('error');
    } finally {
      setTimeout(() => setSaveStatus(null), 3000);
    }
  };

  if (!values) {
    return (
      <div className="flex justify-center py-20">
        <div className="text-xs font-mono text-muted-foreground animate-pulse">Carregando configuração...</div>
      </div>
    );
  }

  const pending = dirty.size;

  return (
    <div className="space-y-5 max-w-6xl mx-auto">
      {/* Cabeçalho + ações: Restaurar e Salvar ficam aqui em cima, perto do estado ("N alterações não salvas"), não escondidos num painel dentro de painel. */}
      <div className="flex items-end justify-between flex-wrap gap-4">
        <div>
          <p className="text-xs text-muted-foreground mb-1">Configuração</p>
          <h1 className="text-2xl font-semibold text-foreground tracking-tight">Ajuste Fino</h1>
          <p className="text-xs text-muted-foreground mt-1">
            Altere multiplicadores de ATR, alvos de lucro e parâmetros do Range Filter sem tocar no código.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-mono px-2.5 py-1.5 rounded-md"
            style={pending > 0
              ? { background: 'rgba(227,180,90,0.1)', border: '1px solid rgba(227,180,90,0.25)', color: '#e3b45a' }
              : { background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.55)' }}>
            {pending > 0 ? `${pending} alteraç${pending === 1 ? 'ão' : 'ões'} não salva${pending === 1 ? '' : 's'}` : 'sem alterações pendentes'}
          </span>
          <button onClick={handleReset}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-11px font-mono transition-all"
            style={{ background: 'rgba(221,154,74,0.07)', border: '1px solid rgba(221,154,74,0.2)', color: '#dd9a4a' }}>
            <RotateCcw className="w-3 h-3" />Restaurar
          </button>
          <button onClick={handleSave} disabled={saveStatus === 'saving'}
            className="flex items-center gap-1.5 px-4 py-1.5 rounded-md text-11px font-mono font-semibold transition-all disabled:opacity-50"
            style={saveStatus === 'error'
              ? { background: 'rgba(224,106,91,0.1)', border: '1px solid rgba(224,106,91,0.35)', color: '#e06a5b' }
              : {
                background: saveStatus === 'saved' ? 'rgba(93,181,134,0.15)' : 'rgba(93,181,134,0.08)',
                border: '1px solid rgba(93,181,134,0.3)', color: '#5db586',
              }}>
            {saveStatus === 'saved' ? <CheckCircle2 className="w-3 h-3" /> : <Save className="w-3 h-3" />}
            {saveStatus === 'saving' ? 'Salvando...' : saveStatus === 'saved' ? 'Salvo!' : saveStatus === 'error' ? 'Erro ao salvar' : 'Salvar & Sincronizar'}
          </button>
        </div>
      </div>

      {/* Achado da varredura pós-Raio-X, Round 3 (2026-09-27): o erro
          desaparecia em 3s sem dizer por quê nem o que fazer — mesmo
          padrão de causa/reassurance já usado em QueryErrorState.jsx. */}
      {saveStatus === 'error' && (
        <p className="text-xs font-mono" style={{ color: '#dd9a4a' }}>
          Não foi possível salvar — verifique sua conexão e tente de novo.
        </p>
      )}

      {/* Aviso único (antes a mesma frase aparecia 3 vezes: subtítulo, selo e faixa amarela). */}
      <div className="rounded-md px-4 py-3 flex gap-3" style={{ background: 'rgba(24,23,21,0.8)', border: '1px solid rgba(255,255,255,0.07)' }}>
        <span aria-hidden="true" className="self-stretch shrink-0" style={{ width: 3, borderRadius: 2, background: '#dd9a4a' }} />
        <p className="text-xs text-foreground/80">
          Alterações são aplicadas instantaneamente ao scanner no próximo scan. Use o{' '}
          <Link to="/backtest" className="font-semibold underline underline-offset-2">Backtest</Link> para validar antes.{' '}
          Estes parâmetros também podem ser editados no{' '}
          <Link to="/pine" className="font-semibold underline underline-offset-2">Pine Script</Link>{' '}
          — quem salvar por último vence.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {GROUPS.map(group => (
          <section key={group.id} className="rounded-md p-4 space-y-5" style={{ background: 'rgba(24,23,21,0.8)', border: '1px solid rgba(255,255,255,0.07)' }}>
            <div className="flex items-center gap-2">
              <span aria-hidden="true" style={{ width: 3, height: 16, borderRadius: 2, background: group.color, display: 'inline-block' }} />
              <h2 className="text-sm font-semibold" style={{ color: group.color }}>{group.label}</h2>
            </div>
            {group.fields.map(field => {
              const changed = values[field.key] !== defaults[field.key];
              return (
                <div key={field.key} className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-foreground/80">{field.label}</span>
                    <span className="text-sm font-mono font-semibold tabular-nums" style={{ color: group.color }}>
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
                  <div className="grid grid-cols-3 items-center text-11px font-mono text-muted-foreground/70">
                    <span>{field.min}</span>
                    <span className="text-center" style={changed ? { color: '#e3b45a' } : undefined}>
                      {changed ? '● ' : ''}padrão {fmtValue(defaults[field.key], field.suffix)}
                    </span>
                    <span className="text-right">{field.max}</span>
                  </div>
                  {field.help && (
                    <p className="text-xs text-muted-foreground leading-snug">{field.help}</p>
                  )}
                </div>
              );
            })}
          </section>
        ))}
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-2 px-1">
          <span aria-hidden="true" style={{ width: 3, height: 16, borderRadius: 2, background: '#8db4e2', display: 'inline-block' }} />
          <h2 className="text-sm font-semibold text-foreground/80">Fidelidade ao TradingView</h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {BOOL_FIELDS.map(field => (
            <div key={field.key} className="flex items-start justify-between gap-4 rounded-md p-4"
              style={{ background: 'rgba(24,23,21,0.8)', border: '1px solid rgba(227,180,90,0.2)' }}>
              <div className="space-y-1 min-w-0">
                <p className="text-xs font-semibold text-foreground">{field.label}</p>
                <p className="text-xs text-muted-foreground">{field.help}</p>
              </div>
              <Switch
                checked={!!values[field.key]}
                onCheckedChange={(checked) => { setValues(prev => ({ ...prev, [field.key]: checked })); markDirty(field.key); }}
                aria-label={field.label}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
