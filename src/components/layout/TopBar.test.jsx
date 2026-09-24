// @vitest-environment jsdom
//
// Achado A-6 do Raio-X de UI/UX (2ª sub-rodada, Grupo 1): os botões
// ícone-só "Alertas Telegram"/"Chave de Acesso do Backend" usavam
// `title=` nativo. Migrados pro Tooltip do Radix + `aria-label` (sem o
// aria-label, os botões perderiam o nome acessível por completo ao
// perder o title=). Componente sem teste dedicado antes — precisa dos
// mesmos mocks de `@/api/entities` que `GlobalSearch.jsx` (renderizado
// dentro de TopBar) já usa (item 169), mais `@/lib/scanner` (o botão de
// scan não é acionado neste teste, mas o módulo é pesado o bastante pra
// mockar em vez de deixar rodar de verdade).
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { makeTestQueryClient } from '@/pages/__fixtures__/renderPage.jsx';
import { TooltipProvider } from '@/components/ui/tooltip';
import TopBar from './TopBar.jsx';

vi.mock('@/api/entities', () => ({
  backend: {
    entities: {
      SignalEvent: { list: async () => [] },
      MonitoredAsset: { list: async () => [] },
      TradeOperation: { list: async () => [] },
    },
  },
}));
vi.mock('@/lib/scanner', () => ({ scanAllAssets: vi.fn() }));

afterEach(cleanup);

function renderTopBar() {
  const client = makeTestQueryClient();
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <MemoryRouter>
          <TopBar />
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe('TopBar — botões usam Tooltip em vez de title= nativo (achado A-6)', () => {
  it('REGRESSÃO: "Alertas Telegram"/"Chave de Acesso do Backend" não têm title= nativo, mantêm nome acessível', () => {
    renderTopBar();

    const telegramButton = screen.getByRole('button', { name: 'Alertas Telegram' });
    const ownerKeyButton = screen.getByRole('button', { name: 'Chave de Acesso do Backend' });
    expect(telegramButton.getAttribute('title')).toBeNull();
    expect(ownerKeyButton.getAttribute('title')).toBeNull();
  });
});
