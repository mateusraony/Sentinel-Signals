import React, { useState, useEffect } from 'react';
import { getOwnerKey, setOwnerKey, isOwnerKeyConfigured } from '@/lib/ownerKey';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { KeyRound, X, CheckCircle } from 'lucide-react';

// Mesmo padrão visual/estrutural de TelegramSettings.jsx — reaproveitado de
// propósito para não introduzir um segundo estilo de modal só pra um campo.
export default function OwnerKeySettings({ open, onClose }) {
  const [key, setKey] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (open) {
      setKey(getOwnerKey());
      setSaved(false);
    }
  }, [open]);

  if (!open) return null;

  const save = () => {
    setOwnerKey(key.trim());
    setSaved(true);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 overflow-y-auto"
      style={{ background: 'rgba(0,0,0,0.8)' }}
      onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="w-full max-w-md my-auto rounded-2xl p-6 space-y-5"
        style={{ background: 'rgba(10,13,22,0.98)', border: '1px solid rgba(255,255,255,0.08)', backdropFilter: 'blur(20px)' }}>

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <KeyRound className="w-5 h-5" style={{ color: '#00e5ff' }} />
            <h2 className="font-bold text-foreground text-base">Chave de Acesso</h2>
            {isOwnerKeyConfigured() && (
              <span className="text-[9px] font-mono px-1.5 py-0.5 rounded"
                style={{ background: 'rgba(0,255,128,0.1)', color: '#00ff80', border: '1px solid rgba(0,255,128,0.2)' }}>
                ● CONFIGURADA
              </span>
            )}
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-white/[0.05]">
            <X className="w-4 h-4 text-muted-foreground" />
          </button>
        </div>

        <div className="rounded-xl p-3 space-y-1.5" style={{ background: 'rgba(0,229,255,0.05)', border: '1px solid rgba(0,229,255,0.1)' }}>
          <p className="text-[10px] font-mono font-bold" style={{ color: '#00e5ff' }}>O QUE É ISTO:</p>
          <p className="text-[10px] text-muted-foreground leading-relaxed">
            O backend (Render) agora exige esta chave em toda chamada, além do
            login automático — sem ela, mesmo com uma sessão válida, o painel
            não consegue ler/gravar ativos, sinais e operações. Cole aqui a
            mesma chave configurada como <code className="px-1 rounded" style={{ background: 'rgba(255,255,255,0.06)' }}>OWNER_ACCESS_KEY</code> no
            Render.
          </p>
          <p className="text-[9px] text-muted-foreground/70 leading-relaxed pt-1" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
            Fica salva só neste navegador (localStorage) — mesmo padrão já
            usado para o token do Telegram.
          </p>
        </div>

        <div>
          <label className="text-[10px] font-mono text-muted-foreground mb-1 block">CHAVE (OWNER_ACCESS_KEY)</label>
          <Input type="password" placeholder="cole a chave aqui" value={key}
            onChange={(e) => { setKey(e.target.value); setSaved(false); }}
            className="font-mono text-xs h-9"
            style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.8)' }} />
        </div>

        {saved && (
          <div className="flex items-center gap-2 text-xs font-mono px-3 py-2 rounded-lg"
            style={{ background: 'rgba(0,255,128,0.08)', color: '#00ff80', border: '1px solid rgba(0,255,128,0.2)' }}>
            <CheckCircle className="w-3.5 h-3.5" /> Chave salva neste navegador.
          </div>
        )}

        <div className="flex gap-2 pt-1">
          <Button size="sm" onClick={save} disabled={!key.trim()} className="flex-1 font-mono text-xs h-9"
            style={{ background: 'rgba(0,255,128,0.15)', color: '#00ff80', border: '1px solid rgba(0,255,128,0.3)' }}>
            💾 Salvar Chave
          </Button>
        </div>
      </div>
    </div>
  );
}
