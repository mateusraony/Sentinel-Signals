import React, { useState, useEffect } from 'react';
import { getTelegramConfig, setTelegramConfig, isTelegramConfigured, getTelegramFilters, setTelegramFilters } from '@/lib/telegram';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { BellRing, X, CheckCircle, AlertCircle, ChevronDown, ChevronUp } from 'lucide-react';

const TF_OPTIONS = ['1h', '4h', '1d'];
const PRIORITY_OPTIONS = [
  { id: 'low', label: '🟡 Baixa', desc: 'Todos os sinais, incluindo fracos' },
  { id: 'medium', label: '🟠 Média', desc: 'Sinais moderados e fortes' },
  { id: 'high', label: '🔴 Alta', desc: 'Somente sinais de alta prioridade (score ≥ 85)' },
];
const SIGNAL_TYPES = [
  { id: 'BUY', label: '🟢 BUY', desc: 'Sinais de compra' },
  { id: 'SELL', label: '🔴 SELL', desc: 'Sinais de venda' },
];
const EVENT_OPTIONS = [
  { id: 'signal_detected', label: '🔔 Novo sinal detectado', desc: 'Quando RF gera um novo sinal' },
  { id: 'entry_confirmed', label: '✅ Entrada confirmada', desc: 'Quando candle fecha confirmando entrada' },
  { id: 'tp1_hit', label: '🎯 TP1 atingido', desc: 'Quando preço toca o primeiro alvo' },
  { id: 'tp2_hit', label: '🏆 TP2 atingido', desc: 'Quando preço toca o alvo final' },
  { id: 'stop_hit', label: '🛑 Stop atingido', desc: 'Quando stop loss é tocado' },
  { id: 'runner_active', label: '⚡ Runner ativado', desc: 'Quando operação entra em modo runner' },
  { id: 'invalidated', label: '⚠️ Sinal invalidado', desc: 'Quando condição técnica falha' },
];

// Filters are now stored/managed centrally in telegram.js — imported above

function Toggle({ checked, onChange }) {
  return (
    <button onClick={() => onChange(!checked)}
      className="w-8 h-4 rounded-full transition-all shrink-0"
      style={{ background: checked ? 'rgba(0,255,128,0.5)' : 'rgba(255,255,255,0.1)', border: `1px solid ${checked ? 'rgba(0,255,128,0.6)' : 'rgba(255,255,255,0.12)'}`, position: 'relative' }}>
      <span className="absolute top-0.5 w-3 h-3 rounded-full transition-all"
        style={{ background: checked ? '#00ff80' : 'rgba(255,255,255,0.3)', left: checked ? '1px' : '1px', transform: checked ? 'translateX(16px)' : 'none' }} />
    </button>
  );
}

function MultiToggle({ options, selected, onChange }) {
  const toggle = (id) => {
    if (selected.includes(id)) onChange(selected.filter(x => x !== id));
    else onChange([...selected, id]);
  };
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map(o => {
        const on = selected.includes(o.id);
        return (
          <button key={o.id} onClick={() => toggle(o.id)}
            className="text-[10px] font-mono px-2 py-1 rounded-md transition-all"
            style={on
              ? { background: 'rgba(0,229,255,0.12)', border: '1px solid rgba(0,229,255,0.35)', color: '#00e5ff' }
              : { background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', color: 'rgba(255,255,255,0.35)' }}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export default function TelegramSettings({ open, onClose }) {
  const [cfg, setCfg] = useState({ botToken: '', chatId: '' });
  const [filters, setFilters] = useState(getTelegramFilters());
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => {
    if (open) {
      setCfg(getTelegramConfig());
      setFilters(getTelegramFilters());
      setTestResult(null);
    }
  }, [open]);

  if (!open) return null;

  const save = async () => {
    await setTelegramConfig(cfg);
    setTelegramFilters(filters);
    onClose();
  };

  const test = async () => {
    setTesting(true); setTestResult(null);
    await setTelegramConfig(cfg);
    const tfStr = filters.timeframes.join(', ').toUpperCase();
    const evStr = EVENT_OPTIONS.filter(e => filters.events.includes(e.id)).map(e => e.label).join('\n• ');
    try {
      const res = await fetch(`https://api.telegram.org/bot${cfg.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: cfg.chatId,
          text: `✅ <b>CryptoRadar conectado!</b>\n\n📊 <b>Timeframes:</b> ${tfStr}\n⚡ <b>Prioridade mínima:</b> ${filters.min_priority}\n📋 <b>Eventos ativos:</b>\n• ${evStr}\n\n<i>⚡ Sistema de monitoramento ativo</i>`,
          parse_mode: 'HTML',
        }),
      });
      setTestResult(res.ok ? 'success' : 'error');
    } catch { setTestResult('error'); }
    finally { setTesting(false); }
  };

  const isValid = cfg.botToken?.length > 20 && cfg.chatId?.length >= 5;
  const setF = (key, val) => setFilters(f => ({ ...f, [key]: val }));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 overflow-y-auto"
      style={{ background: 'rgba(0,0,0,0.8)' }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="w-full max-w-lg my-auto rounded-2xl p-6 space-y-5"
        style={{ background: 'rgba(10,13,22,0.98)', border: '1px solid rgba(255,255,255,0.08)', backdropFilter: 'blur(20px)' }}>

        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <BellRing className="w-5 h-5" style={{ color: '#00e5ff' }} />
            <h2 className="font-bold text-foreground text-base">Alertas Telegram</h2>
            {isTelegramConfigured() && (
              <span className="text-[9px] font-mono px-1.5 py-0.5 rounded"
                style={{ background: 'rgba(0,255,128,0.1)', color: '#00ff80', border: '1px solid rgba(0,255,128,0.2)' }}>
                ● ATIVO
              </span>
            )}
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-white/[0.05]">
            <X className="w-4 h-4 text-muted-foreground" />
          </button>
        </div>

        {/* Instructions */}
        <div className="rounded-xl p-3 space-y-1.5" style={{ background: 'rgba(0,229,255,0.05)', border: '1px solid rgba(0,229,255,0.1)' }}>
          <p className="text-[10px] font-mono font-bold" style={{ color: '#00e5ff' }}>COMO CONFIGURAR:</p>
          <ol className="text-[10px] text-muted-foreground space-y-1 list-decimal list-inside leading-relaxed">
            <li>Telegram → <b className="text-foreground/70">@BotFather</b> → <code className="px-1 rounded" style={{ background: 'rgba(255,255,255,0.06)' }}>/newbot</code> → copie o <b className="text-foreground/70">Token</b></li>
            <li><b className="text-foreground/70">@userinfobot</b> → envie qualquer mensagem → copie o <b className="text-foreground/70">Chat ID</b></li>
          </ol>
          <p className="text-[9px] text-muted-foreground/70 leading-relaxed pt-1" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
            Isto liga os avisos <b>só enquanto esta aba fica aberta</b>. Os avisos automáticos 24h (que rodam mesmo com o navegador fechado) usam o mesmo Token/Chat ID, mas configurados separadamente como segredo no GitHub Actions.
          </p>
        </div>

        {/* Connection fields */}
        <div className="space-y-3">
          <div>
            <label className="text-[10px] font-mono text-muted-foreground mb-1 block">BOT TOKEN</label>
            <Input placeholder="1234567890:ABCdefGHI..." value={cfg.botToken || ''}
              onChange={e => setCfg(c => ({ ...c, botToken: e.target.value }))}
              className="font-mono text-xs h-9"
              style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.8)' }} />
          </div>
          <div>
            <label className="text-[10px] font-mono text-muted-foreground mb-1 block">CHAT ID</label>
            <Input placeholder="123456789" value={cfg.chatId || ''}
              onChange={e => setCfg(c => ({ ...c, chatId: e.target.value }))}
              className="font-mono text-xs h-9"
              style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.8)' }} />
          </div>
        </div>

        {/* Advanced filters toggle */}
        <button onClick={() => setShowAdvanced(!showAdvanced)}
          className="flex items-center gap-2 w-full py-2 px-3 rounded-lg transition-all"
          style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.6)' }}>
          {showAdvanced ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          <span className="text-[11px] font-mono">⚙️ Filtros Avançados de Notificação</span>
          <span className="ml-auto text-[9px] font-mono" style={{ color: '#00e5ff' }}>
            {filters.timeframes.length} TF · {filters.events.length} eventos
          </span>
        </button>

        {showAdvanced && (
          <div className="space-y-4 rounded-xl p-4" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>

            {/* Timeframes */}
            <div>
              <p className="text-[10px] font-mono text-muted-foreground mb-2">📊 TIMEFRAMES A MONITORAR</p>
              <MultiToggle
                options={TF_OPTIONS.map(t => ({ id: t, label: t.toUpperCase() }))}
                selected={filters.timeframes}
                onChange={v => setF('timeframes', v)}
              />
            </div>

            {/* Signal types */}
            <div>
              <p className="text-[10px] font-mono text-muted-foreground mb-2">🎯 TIPOS DE SINAL</p>
              <MultiToggle
                options={SIGNAL_TYPES}
                selected={filters.signal_types}
                onChange={v => setF('signal_types', v)}
              />
            </div>

            {/* Min priority */}
            <div>
              <p className="text-[10px] font-mono text-muted-foreground mb-2">⚡ PRIORIDADE MÍNIMA</p>
              <div className="space-y-1.5">
                {PRIORITY_OPTIONS.map(p => (
                  <button key={p.id} onClick={() => setF('min_priority', p.id)}
                    className="flex items-center gap-3 w-full px-3 py-2 rounded-lg text-left transition-all"
                    style={filters.min_priority === p.id
                      ? { background: 'rgba(0,229,255,0.08)', border: '1px solid rgba(0,229,255,0.25)' }
                      : { background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)' }}>
                    <span className="text-[10px] font-mono font-bold" style={{ color: filters.min_priority === p.id ? '#00e5ff' : 'rgba(255,255,255,0.4)' }}>
                      {p.label}
                    </span>
                    <span className="text-[9px] font-mono text-muted-foreground">{p.desc}</span>
                    {filters.min_priority === p.id && <span className="ml-auto text-[9px]" style={{ color: '#00e5ff' }}>✓</span>}
                  </button>
                ))}
              </div>
            </div>

            {/* Events */}
            <div>
              <p className="text-[10px] font-mono text-muted-foreground mb-2">🔔 EVENTOS PARA NOTIFICAR</p>
              <div className="space-y-1.5">
                {EVENT_OPTIONS.map(e => (
                  <div key={e.id} className="flex items-center justify-between gap-3 px-2 py-1.5 rounded-lg"
                    style={{ background: 'rgba(255,255,255,0.02)' }}>
                    <div className="min-w-0">
                      <div className="text-[10px] font-mono" style={{ color: filters.events.includes(e.id) ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.35)' }}>{e.label}</div>
                      <div className="text-[9px] font-mono text-muted-foreground">{e.desc}</div>
                    </div>
                    <Toggle
                      checked={filters.events.includes(e.id)}
                      onChange={on => {
                        if (on) setF('events', [...filters.events, e.id]);
                        else setF('events', filters.events.filter(x => x !== e.id));
                      }}
                    />
                  </div>
                ))}
              </div>
            </div>

            {/* Score threshold */}
            <div>
              <p className="text-[10px] font-mono text-muted-foreground mb-2">🔥 SCORE MÍNIMO PARA ALERTAR</p>
              <div className="flex items-center gap-3">
                <input type="range" min="0" max="100" step="5"
                  value={filters.min_score ?? 0}
                  onChange={e => setF('min_score', parseInt(e.target.value))}
                  className="flex-1 h-1.5 rounded-full appearance-none"
                  style={{ background: `linear-gradient(to right, #00ff80 ${filters.min_score ?? 0}%, rgba(255,255,255,0.08) ${filters.min_score ?? 0}%)` }}
                />
                <span className="text-[11px] font-mono font-bold min-w-[40px] text-right"
                  style={{ color: (filters.min_score ?? 0) >= 85 ? '#00ff80' : (filters.min_score ?? 0) >= 65 ? '#ffd166' : '#ff9f43' }}>
                  {filters.min_score ?? 0}/100
                </span>
              </div>
              <p className="text-[9px] font-mono text-muted-foreground mt-1">
                {(filters.min_score ?? 0) === 0 ? 'Todos os scores' : `Somente sinais com score ≥ ${filters.min_score}`}
              </p>
            </div>
          </div>
        )}

        {/* Test result */}
        {testResult && (
          <div className="flex items-center gap-2 text-xs font-mono px-3 py-2 rounded-lg"
            style={testResult === 'success'
              ? { background: 'rgba(0,255,128,0.08)', color: '#00ff80', border: '1px solid rgba(0,255,128,0.2)' }
              : { background: 'rgba(255,20,120,0.08)', color: '#ff1478', border: '1px solid rgba(255,20,120,0.2)' }}>
            {testResult === 'success'
              ? <><CheckCircle className="w-3.5 h-3.5" /> Mensagem enviada! Verifique o Telegram.</>
              : <><AlertCircle className="w-3.5 h-3.5" /> Erro — verifique o Token e Chat ID.</>}
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-2 pt-1">
          <Button variant="outline" size="sm" onClick={test} disabled={testing || !isValid} className="flex-1 font-mono text-xs h-9">
            {testing ? '⟳ Testando...' : '↗ Testar Envio'}
          </Button>
          <Button size="sm" onClick={save} disabled={!isValid} className="flex-1 font-mono text-xs h-9"
            style={{ background: 'rgba(0,255,128,0.15)', color: '#00ff80', border: '1px solid rgba(0,255,128,0.3)' }}>
            💾 Salvar Configurações
          </Button>
        </div>
      </div>
    </div>
  );
}