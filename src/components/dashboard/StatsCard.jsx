import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';

function AnimatedNumber({ value }) {
  const [display, setDisplay] = useState(0);
  /** @type {React.MutableRefObject<number|undefined>} */
  const frameRef = useRef();

  useEffect(() => {
    const target = Number(value) || 0;
    let start = 0;
    const duration = 800;
    const startTime = performance.now();

    const animate = (now) => {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplay(Math.round(start + (target - start) * eased));
      if (progress < 1) frameRef.current = requestAnimationFrame(animate);
    };
    frameRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frameRef.current);
  }, [value]);

  return <span>{display}</span>;
}

// error=true: falha de query sem cache por trás deste número — bypassa o
// AnimatedNumber de propósito (achado da varredura sistemática, item 196:
// AnimatedNumber coage `value` via `Number(value) || 0`, então um sentinel
// tipo '—' animaria pra 0 do mesmo jeito, reproduzindo o falso "0" que este
// prop existe pra evitar).
export default function StatsCard({ icon: Icon, label, value, color, glowColor, error = false }) {
  return (
    <div className="glass-card rounded-xl p-4 relative overflow-hidden group hover:scale-[1.02] transition-transform duration-300">
      {/* Subtle gradient bg */}
      <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500 rounded-xl"
        style={{ background: `radial-gradient(circle at top left, ${glowColor || 'rgba(0,255,128,0.04)'}, transparent 70%)` }}
      />
      <div className="relative flex items-start justify-between">
        <div>
          <p className="text-xs font-mono text-muted-foreground uppercase tracking-wider mb-1">{label}</p>
          {error ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <p className="text-2xl font-bold font-mono flex items-center gap-1.5 cursor-help" tabIndex={0} style={{ color: 'rgba(255,255,255,0.35)' }}>
                  <AlertTriangle className="w-4 h-4" style={{ color: '#ff9f43' }} />—
                </p>
              </TooltipTrigger>
              <TooltipContent className="max-w-[260px] text-[10px] font-mono normal-case tracking-normal leading-relaxed">
                Não foi possível confirmar este número agora — falha ao atualizar.
              </TooltipContent>
            </Tooltip>
          ) : (
            <p className="text-3xl font-bold font-mono number-glow" style={{ color: color || '#fff' }}>
              <AnimatedNumber value={value} />
            </p>
          )}
        </div>
        <div className="w-10 h-10 rounded-xl flex items-center justify-center"
          style={{ background: `${glowColor || 'rgba(0,255,128,0.1)'}`, border: `1px solid ${glowColor ? glowColor.replace('0.1', '0.3') : 'rgba(0,255,128,0.3)'}` }}
        >
          <Icon className="w-5 h-5" style={{ color: color || '#00ff80', filter: `drop-shadow(0 0 4px ${color || '#00ff80'})` }} />
        </div>
      </div>
    </div>
  );
}