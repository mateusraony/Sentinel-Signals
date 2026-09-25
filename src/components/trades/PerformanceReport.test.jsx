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
