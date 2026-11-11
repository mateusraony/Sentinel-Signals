import TokenIcon, { hasTokenLogo } from '@/components/TokenIcon';
import React, { useRef, useState } from 'react';
import { backend } from '@/api/entities';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2, AlertCircle, CheckCircle2, Zap } from 'lucide-react';
import { validateSymbol } from '@/lib/marketDataProvider';
import { logError } from '@/lib/logger';

const POPULAR_PAIRS = [
  { symbol: 'BTCUSDT', name: 'BTC/USDT' },
  { symbol: 'ETHUSDT', name: 'ETH/USDT' },
  { symbol: 'SOLUSDT', name: 'SOL/USDT' },
  { symbol: 'BNBUSDT', name: 'BNB/USDT' },
  { symbol: 'XRPUSDT', name: 'XRP/USDT' },
  { symbol: 'ADAUSDT', name: 'ADA/USDT' },
  { symbol: 'DOGEUSDT', name: 'DOGE/USDT' },
  { symbol: 'AVAXUSDT', name: 'AVAX/USDT' },
  { symbol: 'DOTUSDT', name: 'DOT/USDT' },
  { symbol: 'LINKUSDT', name: 'LINK/USDT' },
];

export default function AddAssetForm({ onSuccess }) {
  const [symbol, setSymbol] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [validating, setValidating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [validated, setValidated] = useState(false);
  // Número da consulta de validação em andamento. Qualquer edição do símbolo (digitar ou "Adicionar rápido") invalida a consulta pendente: a resposta que
  // chegar depois pertence ao texto ANTIGO e não pode marcar o texto novo como válido (achado do Codex, PR #565: liberava "Adicionar Ativo" sem validar).
  const validationRun = useRef(0);

  const handleValidate = async () => {
    if (!symbol.trim()) return;
    const run = ++validationRun.current;
    const validado = symbol; // o texto que esta consulta valida (a mensagem de erro cita ele, não o que estiver digitado quando a resposta voltar)
    setValidating(true);
    setError('');
    setValidated(false);
    try {
      const isValid = await validateSymbol(validado.toUpperCase().trim());
      if (run !== validationRun.current) return; // texto editado no meio: resposta antiga, descarta
      if (isValid) setValidated(true);
      else setError(`"${validado}" não encontrado na Binance`);
    } catch (err) {
      logError('AddAssetForm', `Falha ao validar símbolo ${validado}`, { error: err.message });
      if (run !== validationRun.current) return;
      setError('Falha ao validar símbolo — verifique sua conexão e tente de novo.');
    } finally {
      // Só a consulta mais recente desliga o "validando": uma antiga que termina tarde não apaga o indicador da consulta nova.
      if (run === validationRun.current) setValidating(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setError('');
    const sym = symbol.toUpperCase().trim();
    const name = displayName.trim() || sym.replace('USDT', '/USDT');
    try {
      await backend.entities.MonitoredAsset.create({
        symbol: sym, display_name: name, exchange: 'binance', market: 'crypto',
        is_active: true, timeframes_enabled: { '1h': true, '4h': true, '1d': true },
        smc_enabled: false,
        // Desligado por padrão desde 2026-08-20 (docs/known-risks.md item
        // 108) — A/B real (backtest.yml, 7 símbolos, 12 meses) mostrou que,
        // ligado, esse gate rejeitou 100% dos candidatos que sobraram do
        // filtro de regime (2.025/3.600 rejeições, 56%), zerando a cascata
        // RF nativa na amostra testada. Ligar continua possível manualmente
        // via AssetConfigPanel, só o default de cadastro mudou.
        smc_confirm_4h15m: false,
        // docs/known-risks.md item 137 — pedido do usuário: ao adicionar um
        // ativo que já tem sinal cruzado em outro lugar (ex. TradingView),
        // não esperar o próximo sinal ao vivo. scripts/run-backfill-check.mjs
        // (rodando após o scan agendado) pega qualquer MonitoredAsset
        // 'pending' e roda o motor REAL sobre os últimos 60 dias contra o
        // backend de produção — qualquer operação que a cascata RF nativa já
        // teria aberto nasce agora, rotulada source:'backfill'.
        backfill_check_status: 'pending',
      });
      onSuccess();
    } catch (err) {
      logError('AddAssetForm', `Falha ao adicionar ativo ${sym}`, { error: err.message });
      setError('Falha ao adicionar ativo — verifique sua conexão e tente de novo.');
    } finally {
      setSaving(false);
    }
  };

  // Qualquer troca de símbolo cancela a consulta pendente (ver validationRun) e solta o "validando" que ela segurava.
  const cancelPendingValidation = () => { validationRun.current += 1; setValidating(false); };

  const handleQuickAdd = (pair) => { cancelPendingValidation(); setSymbol(pair.symbol); setDisplayName(pair.name); setValidated(true); setError(''); };

  return (
    <div className="space-y-5">
      {/* Quick Add */}
      <div>
        <Label className="text-10px font-mono uppercase tracking-widest text-muted-foreground mb-2 block">Adicionar rápido</Label>
        <div className="flex flex-wrap gap-1.5">
          {POPULAR_PAIRS.map(pair => (
            <button key={pair.symbol} onClick={() => handleQuickAdd(pair)}
              className="text-10px font-mono px-2 py-1 rounded transition-all duration-200"
              style={{
                background: symbol === pair.symbol ? 'rgba(0,255,128,0.12)' : 'rgba(255,255,255,0.04)',
                border: symbol === pair.symbol ? '1px solid rgba(0,255,128,0.35)' : '1px solid rgba(255,255,255,0.07)',
                color: symbol === pair.symbol ? '#00ff80' : 'rgba(255,255,255,0.5)',
              }}
            ><TokenIcon symbol={pair.symbol} size={14} className="mr-1.5" />{pair.name}</button>
          ))}
        </div>
      </div>

      {/* Manual entry */}
      <div className="space-y-3">
        <div>
          <Label className="text-xs font-mono text-muted-foreground mb-1.5 block">Símbolo</Label>
          <div className="flex gap-2">
            <Input
              value={symbol}
              onChange={e => { cancelPendingValidation(); setSymbol(e.target.value); setValidated(false); setError(''); }}
              placeholder="BTCUSDT"
              className="font-mono text-sm"
              style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)' }}
            />
            <Button variant="outline" size="sm" onClick={handleValidate} disabled={validating || !symbol.trim()}
              className="shrink-0 font-mono text-xs"
              style={{ background: 'rgba(0,229,255,0.06)', border: '1px solid rgba(0,229,255,0.2)', color: 'rgba(0,229,255,0.8)' }}
            >
              {validating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Validar'}
            </Button>
          </div>
        </div>

        <div>
          <Label className="text-xs font-mono text-muted-foreground mb-1.5 block">Nome (opcional)</Label>
          <Input value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="BTC/USDT"
            className="font-mono text-sm"
            style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)' }}
          />
        </div>

        {error && (
          <div className="flex items-center gap-2 text-xs font-mono" style={{ color: '#ff1478' }}>
            <AlertCircle className="w-3.5 h-3.5" />{error}
          </div>
        )}
        {validated && (
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-xs font-mono" style={{ color: '#00ff80' }}>
              <CheckCircle2 className="w-3.5 h-3.5" />Símbolo válido na Binance
            </div>
            {/* Logo do token (11/11/2026): com logo na pasta, ele aparece; sem logo, o painel mostra a bolinha com a inicial. */}
            <div className="flex items-center gap-2 text-10px font-mono text-muted-foreground">
              <TokenIcon symbol={symbol} size={16} />
              {hasTokenLogo(symbol) ? 'Logo do token encontrado' : 'Token ainda sem logo no painel: aparece uma bolinha com a inicial'}
            </div>
          </div>
        )}

        <button onClick={handleSave} disabled={saving || !validated}
          className="w-full py-2.5 rounded-lg font-mono text-sm font-semibold transition-all duration-300 flex items-center justify-center gap-2 disabled:opacity-40"
          style={{
            background: 'linear-gradient(135deg, rgba(0,255,128,0.15), rgba(0,200,255,0.1))',
            border: '1px solid rgba(0,255,128,0.35)',
            color: '#00ff80',
            boxShadow: validated ? '0 0 20px rgba(0,255,128,0.1)' : 'none',
          }}
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
          {saving ? 'Adicionando...' : 'Adicionar Ativo'}
        </button>
      </div>
    </div>
  );
}