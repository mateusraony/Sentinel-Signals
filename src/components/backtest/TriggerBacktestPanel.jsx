import React, { useEffect, useRef, useState } from 'react';
import { Rocket, Loader2, CheckCircle2, AlertTriangle, ExternalLink, ChevronDown, ChevronUp } from 'lucide-react';
import { callBackend } from '@/lib/apiBackend';

const STATUS_POLL_MS = 10000;

// Dispara o workflow .github/workflows/backtest.yml (já isolado — backend
// fake em memória, Telegram no-op, só leitura pública na Binance) via
// server/index.js, acompanha o status e carrega o relatório pronto sozinho
// quando o job termina. Não roda simulação nenhuma aqui no navegador — só
// aciona e lê o run no GitHub.
export default function TriggerBacktestPanel({ onReportReady }) {
  const [expanded, setExpanded] = useState(false);
  const [trialLabel, setTrialLabel] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [symbols, setSymbols] = useState('');
  const [minTrades, setMinTrades] = useState('');
  const [noCosts, setNoCosts] = useState(false);
  const [pineConfigText, setPineConfigText] = useState('');

  const [status, setStatus] = useState('idle'); // idle | triggering | queued | in_progress | fetching_artifact | success | failure | error
  const [runId, setRunId] = useState(null);
  const [htmlUrl, setHtmlUrl] = useState(null);
  const [errorMsg, setErrorMsg] = useState(null);

  const pollRef = useRef(null);

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  const stopPolling = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  };

  const fetchArtifact = async (id) => {
    setStatus('fetching_artifact');
    try {
      const report = await callBackend(`/api/backtest/artifact/${id}`);
      setStatus('success');
      onReportReady(report);
    } catch (e) {
      setStatus('error');
      setErrorMsg(e.message);
    }
  };

  const pollStatus = (id) => {
    pollRef.current = setInterval(async () => {
      try {
        const data = await callBackend(`/api/backtest/status/${id}`, undefined, { method: 'GET' });
        if (data.status === 'completed') {
          stopPolling();
          if (data.conclusion === 'success') {
            fetchArtifact(id);
          } else {
            setStatus('failure');
            setErrorMsg(`Run terminou com "${data.conclusion}" — veja os logs no GitHub.`);
          }
        } else {
          setStatus(data.status); // 'queued' | 'in_progress'
        }
      } catch (e) {
        stopPolling();
        setStatus('error');
        setErrorMsg(e.message);
      }
    }, STATUS_POLL_MS);
  };

  const handleTrigger = async () => {
    if (!trialLabel.trim()) {
      setErrorMsg('Rótulo do teste (trial_label) é obrigatório.');
      return;
    }
    let pineConfig = '';
    if (pineConfigText.trim()) {
      try {
        JSON.parse(pineConfigText);
        pineConfig = pineConfigText.trim();
      } catch {
        setErrorMsg('Overrides de config: JSON inválido.');
        return;
      }
    }

    setErrorMsg(null);
    setStatus('triggering');
    try {
      const data = await callBackend('/api/backtest/trigger', {
        trial_label: trialLabel.trim(),
        from: from || undefined,
        to: to || undefined,
        symbols: symbols.trim() || undefined,
        min_trades: minTrades || undefined,
        no_costs: noCosts ? 'true' : undefined,
        pine_config: pineConfig || undefined,
      });
      if (!data.runId) {
        setStatus('error');
        setErrorMsg(data.warning || 'Não foi possível localizar o run disparado.');
        return;
      }
      setRunId(data.runId);
      setHtmlUrl(data.htmlUrl);
      setStatus('queued');
      pollStatus(data.runId);
    } catch (e) {
      setStatus('error');
      setErrorMsg(e.message);
    }
  };

  const isBusy = ['triggering', 'queued', 'in_progress', 'fetching_artifact'].includes(status);

  const STATUS_LABELS = {
    idle: null,
    triggering: 'Disparando workflow no GitHub...',
    queued: 'Na fila do GitHub Actions...',
    in_progress: 'Rodando (isso pode levar de alguns minutos a algumas horas)...',
    fetching_artifact: 'Baixando o relatório...',
    success: 'Relatório carregado!',
    failure: 'O run falhou ou foi cancelado.',
    error: 'Erro.',
  };

  return (
    <div className="rounded-xl p-5 space-y-3 max-w-2xl mx-auto" style={{ background: 'rgba(10,13,22,0.8)', border: '1px solid rgba(0,229,255,0.15)' }}>
      <div className="flex items-center gap-2">
        <Rocket className="w-4 h-4" style={{ color: '#00e5ff' }} />
        <h2 className="text-base font-bold text-foreground">Disparar novo backtest</h2>
      </div>
      <p className="text-[10px] font-mono text-muted-foreground">
        Roda o workflow <code>backtest.yml</code> direto no GitHub Actions (mesmo motor isolado de sempre — sem gravar nada
        em produção, sem Telegram real) e carrega o relatório aqui sozinho quando terminar.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="text-[9px] font-mono text-muted-foreground block mb-1">Rótulo do teste (obrigatório)</label>
          <input value={trialLabel} onChange={e => setTrialLabel(e.target.value)} placeholder="ex.: bull-baseline"
            disabled={isBusy}
            className="w-full px-3 py-1.5 rounded-lg text-[10px] font-mono outline-none disabled:opacity-50"
            style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.8)' }} />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-[9px] font-mono text-muted-foreground block mb-1">De (opcional)</label>
            <input type="date" value={from} onChange={e => setFrom(e.target.value)} disabled={isBusy}
              className="w-full px-3 py-1.5 rounded-lg text-[10px] font-mono outline-none disabled:opacity-50"
              style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.8)' }} />
          </div>
          <div>
            <label className="text-[9px] font-mono text-muted-foreground block mb-1">Até (opcional)</label>
            <input type="date" value={to} onChange={e => setTo(e.target.value)} disabled={isBusy}
              className="w-full px-3 py-1.5 rounded-lg text-[10px] font-mono outline-none disabled:opacity-50"
              style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.8)' }} />
          </div>
        </div>
      </div>
      <p className="text-[8px] font-mono text-muted-foreground/60">Vazio = padrão do workflow (12 meses até agora).</p>

      <button onClick={() => setExpanded(v => !v)} className="flex items-center gap-1 text-[9px] font-mono text-muted-foreground">
        {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}Avançado
      </button>
      {expanded && (
        <div className="space-y-2 pl-1">
          <div>
            <label className="text-[9px] font-mono text-muted-foreground block mb-1">Símbolos (vazio = padrão do workflow)</label>
            <input value={symbols} onChange={e => setSymbols(e.target.value)} placeholder="BTCUSDT,ETHUSDT,..." disabled={isBusy}
              className="w-full px-3 py-1.5 rounded-lg text-[10px] font-mono outline-none disabled:opacity-50"
              style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.8)' }} />
          </div>
          <div className="grid grid-cols-2 gap-2 items-end">
            <div>
              <label className="text-[9px] font-mono text-muted-foreground block mb-1">Mínimo de operações</label>
              <input value={minTrades} onChange={e => setMinTrades(e.target.value)} placeholder="30" disabled={isBusy}
                className="w-full px-3 py-1.5 rounded-lg text-[10px] font-mono outline-none disabled:opacity-50"
                style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.8)' }} />
            </div>
            <label className="flex items-center gap-1.5 text-[9px] font-mono text-muted-foreground pb-1.5">
              <input type="checkbox" checked={noCosts} onChange={e => setNoCosts(e.target.checked)} disabled={isBusy} />
              Rodar sem custos (taxa/slippage/funding)
            </label>
          </div>
          <div>
            <label className="text-[9px] font-mono text-muted-foreground block mb-1">Overrides de pineConfig (JSON, opcional)</label>
            <textarea value={pineConfigText} onChange={e => setPineConfigText(e.target.value)} rows={2} disabled={isBusy}
              placeholder='{"minScore":80}'
              className="w-full px-3 py-1.5 rounded-lg text-[10px] font-mono outline-none resize-none disabled:opacity-50"
              style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.8)' }} />
          </div>
        </div>
      )}

      <button onClick={handleTrigger} disabled={isBusy}
        className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-[11px] font-mono font-bold transition-all disabled:opacity-50"
        style={{ background: 'rgba(0,229,255,0.1)', border: '1px solid rgba(0,229,255,0.3)', color: '#00e5ff' }}>
        {isBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Rocket className="w-4 h-4" />}
        {isBusy ? STATUS_LABELS[status] : 'Disparar backtest'}
      </button>

      {status === 'success' && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg text-[10px] font-mono" style={{ background: 'rgba(0,255,128,0.1)', border: '1px solid rgba(0,255,128,0.3)', color: '#00ff80' }}>
          <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />Relatório carregado abaixo.
        </div>
      )}
      {(status === 'failure' || status === 'error') && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg text-[10px] font-mono" style={{ background: 'rgba(255,20,120,0.1)', border: '1px solid rgba(255,20,120,0.3)', color: '#ff1478' }}>
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />{errorMsg}
        </div>
      )}
      {htmlUrl && isBusy && (
        <a href={htmlUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-[9px] font-mono" style={{ color: '#00e5ff' }}>
          <ExternalLink className="w-3 h-3" />Acompanhar no GitHub
        </a>
      )}
    </div>
  );
}
