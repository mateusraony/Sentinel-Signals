// @vitest-environment jsdom
//
// Achado M-6 do Raio-X de UI/UX (Média Prioridade): os 6 cards de métrica
// deste relatório (Trades.jsx) não tinham tooltip nenhum, diferente dos
// equivalentes em Backtest.jsx/MonthlyReport.jsx (SummaryCard, prop
// `tooltip` opcional). Só "Profit Factor" ganhou tooltip aqui — é o único
// com texto já validado nos 2 irmãos; os outros 5 não têm precedente.
// Componente não tinha teste dedicado antes.
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import PerformanceReport from './PerformanceReport.jsx';

afterEach(cleanup);

const CLOSED_TRADE = {
  id: 'op1', asset_id: 'a1', symbol: 'BTCUSDT', side: 'BUY',
  status: 'STOP_HIT', entry_price: 100, initial_stop: 90, current_stop: 90,
  tp1: 110, tp2: 120, exit_price: 90, closed_at: new Date().toISOString(),
  partial_percent: 50, created_date: new Date().toISOString(),
};

function renderReport(trades) {
  return render(
    <TooltipProvider>
      <PerformanceReport trades={trades} />
    </TooltipProvider>,
  );
}

// Round 4 da nova varredura pós-Raio-X (2026-09-27): Profit Factor ganhou
// uma 3ª cor distinta pro estado "Baixo" (antes dividia laranja com
// "Marginal") — teste de regressão confirmando as 3 cores/textos via
// profitFactorColor/profitFactorLabel (src/lib/metricColorRanges.js).
const TRADE_WIN = {
  id: 'opw', asset_id: 'a1', symbol: 'BTCUSDT', side: 'BUY',
  status: 'TP2_HIT', entry_price: 100, initial_stop: 90, current_stop: 90,
  tp1: 110, tp2: 120, exit_price: 112, closed_at: new Date().toISOString(),
  created_date: new Date().toISOString(),
};
const TRADE_LOSS = {
  id: 'opl', asset_id: 'a2', symbol: 'ETHUSDT', side: 'BUY',
  status: 'STOP_HIT', entry_price: 100, initial_stop: 90, current_stop: 90,
  tp1: 110, tp2: 120, exit_price: 90, closed_at: new Date().toISOString(),
  created_date: new Date().toISOString(),
};

describe('PerformanceReport — Profit Factor com 3 cores distintas (Round 4 pós-Raio-X)', () => {
  it('REGRESSÃO: pf~1.17 (Marginal) mostra "⚠ Marginal" em laranja, distinto do vermelho de "Baixo"', async () => {
    // Com custo/slippage padrão descontado (Fase 5), pf fica ~1.17 —
    // dentro de [1, 1.5) = Marginal de qualquer forma.
    renderReport([TRADE_WIN, TRADE_LOSS]);
    const pfValue = await screen.findByText('1.17');
    const marginalText = screen.getByText('⚠ Marginal');
    expect(marginalText).toBeTruthy();
    expect(pfValue.style.color).toBe('rgb(255, 159, 67)');
  });

  it('REGRESSÃO: pf abaixo de 1 mostra "✗ Baixo" em vermelho, não mais o mesmo laranja de Marginal', async () => {
    // 2 perdas, nenhum ganho → pf calculado só existe com grossProfit>0;
    // sem vitória e com perda, profitFactor é 0/grossLoss = 0 (< 1, Baixo).
    const TRADE_LOSS_2 = { ...TRADE_LOSS, id: 'opl2', symbol: 'SOLUSDT' };
    renderReport([TRADE_LOSS, TRADE_LOSS_2]);
    const pfValue = await screen.findByText('0.00');
    const baixoText = screen.getByText('✗ Baixo');
    expect(baixoText).toBeTruthy();
    expect(pfValue.style.color).toBe('rgb(255, 20, 120)');
  });
});

describe('PerformanceReport — tooltip no card Profit Factor (achado M-6)', () => {
  it('REGRESSÃO: "Profit Factor" vira gatilho de Tooltip (texto reaproveitado de Backtest.jsx)', async () => {
    renderReport([CLOSED_TRADE]);
    const trigger = await screen.findByRole('button', { name: 'Profit Factor' });
    expect(trigger.className).toMatch(/cursor-help/);
  });

  it('os outros 5 cards continuam sem tooltip (escopo contido, não é botão)', async () => {
    renderReport([CLOSED_TRADE]);
    await screen.findByRole('button', { name: 'Profit Factor' });
    for (const label of ['PnL Acumulado', 'Taxa de Acerto', 'Drawdown Máx', 'Ganho Médio', 'Perda Média']) {
      expect(screen.queryByRole('button', { name: label })).toBeNull();
      expect(screen.getByText(label).tagName).toBe('SPAN');
    }
  });
});
