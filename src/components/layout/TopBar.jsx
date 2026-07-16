import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Loader2, Clock, Radar, BellRing } from 'lucide-react';
import { scanAllAssets } from '@/lib/scanner';
import { useQueryClient } from '@tanstack/react-query';
import { cn } from '@/lib/utils';
import { isTelegramConfigured } from '@/lib/telegram';
import TelegramSettings from '@/components/settings/TelegramSettings';
import GlobalSearch from './GlobalSearch';
import { toast } from '@/components/ui/use-toast';

export default function TopBar() {
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState('');
  const [lastScan, setLastScan] = useState(null);
  const [showTelegram, setShowTelegram] = useState(false);
  const queryClient = useQueryClient();
  const telegramActive = isTelegramConfigured();

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
      <header className="h-14 flex items-center justify-between px-4 lg:px-6 sticky top-0 z-30"
        style={{ background: 'rgba(8,10,18,0.7)', backdropFilter: 'blur(20px)', borderBottom: '1px solid rgba(255,255,255,0.05)' }}
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
                    background: '#00ff80',
                    opacity: 0.7,
                    animation: `bar-wave 0.9s ease-in-out infinite`,
                    animationDelay: `${i * 0.15}s`,
                    boxShadow: '0 0 6px rgba(0,255,128,0.5)',
                  }}
                />
              ))}
            </div>
            <span className="text-xs font-mono" style={{ color: 'rgba(0,255,128,0.8)' }}>{progress}</span>
          </div>
        )}
      </div>

      {/* Right */}
      <div className="flex items-center gap-3">
        {lastScan && !scanning && (
          <span className="hidden sm:flex items-center gap-1.5 text-[11px] font-mono text-muted-foreground">
            <Clock className="w-3 h-3" />
            {lastScan.toLocaleTimeString()}
          </span>
        )}
        <button onClick={() => setShowTelegram(true)}
          className="flex items-center justify-center w-8 h-8 rounded-lg transition-all"
          title="Alertas Telegram"
          style={telegramActive
            ? { background: 'rgba(0,229,255,0.1)', border: '1px solid rgba(0,229,255,0.3)' }
            : { background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}>
          <BellRing className="w-3.5 h-3.5" style={{ color: telegramActive ? '#00e5ff' : 'rgba(255,255,255,0.35)' }} />
        </button>

        <Button
          onClick={handleScan}
          disabled={scanning}
          size="sm"
          className={cn(
            "relative font-mono text-xs h-8 px-4 transition-all duration-300",
            !scanning && "btn-scan-pulse"
          )}
          style={{
            background: scanning
              ? 'rgba(0,255,128,0.1)'
              : 'linear-gradient(135deg, rgba(0,255,128,0.15), rgba(0,200,255,0.1))',
            border: `1px solid ${scanning ? 'rgba(0,255,128,0.2)' : 'rgba(0,255,128,0.4)'}`,
            color: '#00ff80',
            boxShadow: scanning ? 'none' : '0 0 20px rgba(0,255,128,0.1)',
          }}
        >
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