import React from 'react';
import { Link } from 'react-router-dom';
import AuroraBg from '@/components/layout/AuroraBg';

export default function PageNotFound() {
  return (
    <div className="min-h-screen bg-background relative flex items-center justify-center p-6">
      <AuroraBg />
      <div className="relative z-10 text-center">
        <p className="text-[11px] font-mono uppercase tracking-[0.3em] text-muted-foreground mb-4">404</p>
        <h1 className="text-6xl font-bold font-mono mb-3" style={{ color: '#00ff80', textShadow: '0 0 40px rgba(0,255,128,0.3)' }}>
          Not Found
        </h1>
        <p className="text-muted-foreground text-sm mb-8">Página não encontrada.</p>
        <Link to="/"
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg font-mono text-sm transition-all"
          style={{
            background: 'rgba(0,255,128,0.08)',
            border: '1px solid rgba(0,255,128,0.25)',
            color: '#00ff80',
          }}
        >
          ← Voltar ao Dashboard
        </Link>
      </div>
    </div>
  );
}