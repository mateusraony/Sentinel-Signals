import React, { useState } from 'react';
import { BellRing, X, AlertCircle } from 'lucide-react';
import { isTelegramConfigured } from '@/lib/telegram';
import TelegramSettings from '@/components/settings/TelegramSettings';

export default function TelegramStatusBanner() {
  const [showSettings, setShowSettings] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const active = isTelegramConfigured();

  if (active) {
    return (
      <>
        <TelegramSettings open={showSettings} onClose={() => setShowSettings(false)} />
        <div className="flex items-center justify-between gap-3 rounded-xl px-4 py-2.5"
          style={{ background: 'rgba(0,229,255,0.06)', border: '1px solid rgba(0,229,255,0.15)' }}>
          <div className="flex items-center gap-2">
            <BellRing className="w-3.5 h-3.5" style={{ color: '#00e5ff' }} />
            <span className="text-[11px] font-mono" style={{ color: '#00e5ff' }}>
              Telegram ativo — alertas de compra/venda e operações enviados automaticamente
            </span>
          </div>
          <button onClick={() => setShowSettings(true)}
            className="text-[10px] font-mono px-2.5 py-1 rounded-lg transition-all hover:opacity-80"
            style={{ background: 'rgba(0,229,255,0.08)', border: '1px solid rgba(0,229,255,0.2)', color: '#00e5ff' }}>
            Configurar
          </button>
        </div>
      </>
    );
  }

  if (dismissed) {
    return (
      <>
        <TelegramSettings open={showSettings} onClose={() => setShowSettings(false)} />
        <button onClick={() => setShowSettings(true)}
          className="flex items-center gap-1.5 text-[10px] font-mono text-muted-foreground hover:text-foreground transition-colors">
          <BellRing className="w-3 h-3" />
          Configurar Telegram
        </button>
      </>
    );
  }

  return (
    <>
      <TelegramSettings open={showSettings} onClose={() => setShowSettings(false)} />
      <div className="flex items-center justify-between gap-3 rounded-xl px-4 py-3"
        style={{ background: 'rgba(255,159,67,0.08)', border: '1px solid rgba(255,159,67,0.2)' }}>
        <div className="flex items-center gap-2.5">
          <AlertCircle className="w-4 h-4 shrink-0" style={{ color: '#ff9f43' }} />
          <div>
            <span className="text-[11px] font-mono font-semibold" style={{ color: '#ff9f43' }}>
              Telegram não configurado
            </span>
            <span className="text-[10px] font-mono text-muted-foreground ml-2">
              Receba alertas instantâneos de compra/venda e operações confirmadas
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button onClick={() => setShowSettings(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-mono font-semibold transition-all hover:opacity-80"
            style={{ background: 'rgba(0,229,255,0.1)', border: '1px solid rgba(0,229,255,0.25)', color: '#00e5ff' }}>
            <BellRing className="w-3 h-3" />Configurar agora
          </button>
          <button onClick={() => setDismissed(true)} className="p-1 rounded hover:bg-white/[0.05]">
            <X className="w-3.5 h-3.5 text-muted-foreground" />
          </button>
        </div>
      </div>
    </>
  );
}