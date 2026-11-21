import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Loader2, Clock, Radar, BellRing, KeyRound } from 'lucide-react';
import { scanAllAssets } from '@/lib/scanner';
import { useQueryClient } from '@tanstack/react-query';
import { isTelegramConfigured } from '@/lib/telegram';
import { isOwnerKeyConfigured } from '@/lib/ownerKey';
import TelegramSettings from '@/components/settings/TelegramSettings';
import OwnerKeySettings from '@/components/settings/OwnerKeySettings';
import GlobalSearch from './GlobalSearch';
import { toast } from '@/components/ui/use-toast';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';

export default function TopBar() {
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState('');
  const [lastScan, setLastScan] = useState(null);
  const [showTelegram, setShowTelegram] = useState(false);
  const [showOwnerKey, setShowOwnerKey] = useState(false);
  const queryClient = useQueryClient();
  const telegramActive = isTelegramConfigured();
  const ownerKeyActive = isOwnerKeyConfigured();

  const handleScan = async () => {
    setScanning(true);
    setProgress('Iniciando scan...');
    try {
      const result = await scanAllAssets((current, total, symbol) => {
        setProgress(`${symbol} (${current}/${total})`);
      });
      // scanAllAssets skips entirely (no assets touched, onProgress never
      // called) when the 'full-scan' lock is already held — typically the
      // GitHub Actions cron running the same 5-min job concurrently. Without
      // this check the button looked like it "finished" instantly with
      // nothing to show for it, with no way to tell that apart from a
      // genuine (if unlikely) sub-second scan.
      if (result?.skipped) {
        toast({
          title: 'Scan não executado',
          description: 'Outra varredura já estava em andamento (provavelmente o cron agendado). Tente de novo em alguns instantes.',
        });
      } else {
        const failed = result?.results?.filter((r) => !r.success).length || 0;
        setLastScan(new Date());
        toast({
          title: 'Scan concluído',
          description: failed > 0
            ? `${result.total} ativo(s) verificados, ${failed} com erro — veja o Debug Log.`
            : `${result?.total ?? 0} ativo(s) verificados com sucesso.`,
          variant: failed > 0 ? 'destructive' : 'default',
        });
      }
      queryClient.invalidateQueries();
    } catch (err) {
      console.error('Scan error:', err);
      toast({
        title: 'Erro no scan',
        description: err.message || 'Falha inesperada — veja o console/Debug Log.',
        variant: 'destructive',
      });
    } finally {
      setScanning(false);
      setProgress('');
    }
  };

  return (
    <>
      <TelegramSettings open={showTelegram} onClose={() => setShowTelegram(false)} />
      <OwnerKeySettings open={showOwnerKey} onClose={() => setShowOwnerKey(false)} />
      <header className="h-14 flex items-center justify-between px-4 lg:px-6 sticky top-0 z-30"
        style={{ background: 'rgba(20,19,17,0.7)', borderBottom: '1px solid rgba(255,255,255,0.05)' }}
      >
      {/* Left */}
      <div className="flex items-center gap-3">
        {/* Global Search */}
        <GlobalSearch />
        {scanning && (
          <div className="flex items-center gap-2">
            <div className="flex gap-0.5">
              {[0,1,2].map(i => (
                <span key={i} className="block w-1 rounded-full"
                  style={{
                    height: 16,
                    background: '#5db586',
                    opacity: 0.7,
                    animation: `bar-wave 0.9s ease-in-out infinite`,
                    animationDelay: `${i * 0.15}s`,
                    boxShadow: 'none',
                  }}
                />
              ))}
            </div>
            <span className="text-xs font-mono" style={{ color: 'rgba(93,181,134,0.8)' }}>{progress}</span>
          </div>
        )}
      </div>

      {/* Right */}
      <div className="flex items-center gap-3">
        {lastScan && !scanning && (
          <span className="hidden sm:flex items-center gap-1.5 text-11px font-mono text-muted-foreground">
            <Clock className="w-3 h-3" />
            {lastScan.toLocaleTimeString()}
          </span>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <button onClick={() => setShowTelegram(true)}
              aria-label="Alertas Telegram"
              className="flex items-center justify-center w-8 h-8 rounded-lg transition-all"
              style={telegramActive
                ? { background: 'rgba(141,180,226,0.1)', border: '1px solid rgba(141,180,226,0.3)' }
                : { background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}>
              <BellRing className="w-3.5 h-3.5" style={{ color: telegramActive ? '#8db4e2' : 'rgba(255,255,255,0.55)' }} />
            </button>
          </TooltipTrigger>
          <TooltipContent className="max-w-[260px] text-10px font-mono normal-case tracking-normal leading-relaxed">
            Alertas Telegram
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <button onClick={() => setShowOwnerKey(true)}
              aria-label="Chave de Acesso do Backend"
              className="flex items-center justify-center w-8 h-8 rounded-lg transition-all"
              style={ownerKeyActive
                ? { background: 'rgba(141,180,226,0.1)', border: '1px solid rgba(141,180,226,0.3)' }
                : { background: 'rgba(224,106,91,0.08)', border: '1px solid rgba(224,106,91,0.25)' }}>
              <KeyRound className="w-3.5 h-3.5" style={{ color: ownerKeyActive ? '#8db4e2' : '#e06a5b' }} />
            </button>
          </TooltipTrigger>
          <TooltipContent className="max-w-[260px] text-10px font-mono normal-case tracking-normal leading-relaxed">
            Chave de Acesso do Backend
          </TooltipContent>
        </Tooltip>

        <Button
          onClick={handleScan}
          disabled={scanning}
          size="sm"
          className="relative font-mono text-xs h-8 px-4 transition-all duration-300"
          style={{
            background: scanning ? 'rgba(141,180,226,0.08)' : 'rgba(141,180,226,0.14)',
            border: `1px solid ${scanning ? 'rgba(141,180,226,0.2)' : 'rgba(141,180,226,0.4)'}`,
            color: '#8db4e2',
          }}        >
          {scanning
            ? <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" />
            : <Radar className="w-3.5 h-3.5 mr-2" />
          }
          {scanning ? 'Scanning...' : 'Scan'}
        </Button>
      </div>

      <style>{`
        @keyframes bar-wave {
          0%, 100% { transform: scaleY(0.4); }
          50% { transform: scaleY(1); }
        }
      `}</style>
    </header>
    </>
  );
}