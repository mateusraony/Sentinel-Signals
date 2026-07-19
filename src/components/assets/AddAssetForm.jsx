import React, { useState } from 'react';
import { backend } from '@/api/entities';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2, AlertCircle, CheckCircle2, Zap } from 'lucide-react';
import { validateSymbol } from '@/lib/marketDataProvider';

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

  const handleValidate = async () => {
    if (!symbol.trim()) return;
    setValidating(true);
    setError('');
    setValidated(false);
    const isValid = await validateSymbol(symbol.toUpperCase().trim());
    if (isValid) setValidated(true);
    else setError(`"${symbol}" não encontrado na Binance`);
    setValidating(false);
  };

  const handleSave = async () => {
    setSaving(true);
    setError('');
    const sym = symbol.toUpperCase().trim();
    const name = displayName.trim() || sym.replace('USDT', '/USDT');
    await backend.entities.MonitoredAsset.create({
      symbol: sym, display_name: name, exchange: 'binance', market: 'crypto',
      is_active: true, timeframes_enabled: { '1h': true, '4h': true, '1d': true },
      smc_enabled: true,
    });
    setSaving(false);
    onSuccess();
  };

  const handleQuickAdd = (pair) => { setSymbol(pair.symbol); setDisplayName(pair.name); setValidated(true); setError(''); };

  return (
    <div className="space-y-5">
      {/* Quick Add */}
      <div>
        <Label className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground mb-2 block">Adicionar rápido</Label>
        <div className="flex flex-wrap gap-1.5">
          {POPULAR_PAIRS.map(pair => (
            <button key={pair.symbol} onClick={() => handleQuickAdd(pair)}
              className="text-[10px] font-mono px-2 py-1 rounded transition-all duration-200"
              style={{
                background: symbol === pair.symbol ? 'rgba(0,255,128,0.12)' : 'rgba(255,255,255,0.04)',
                border: symbol === pair.symbol ? '1px solid rgba(0,255,128,0.35)' : '1px solid rgba(255,255,255,0.07)',
                color: symbol === pair.symbol ? '#00ff80' : 'rgba(255,255,255,0.5)',
              }}
            >{pair.name}</button>
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
              onChange={e => { setSymbol(e.target.value); setValidated(false); setError(''); }}
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
          <div className="flex items-center gap-2 text-xs font-mono" style={{ color: '#00ff80' }}>
            <CheckCircle2 className="w-3.5 h-3.5" />Símbolo válido na Binance
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