// @vitest-environment jsdom
//
// Achado A-9 do Raio-X de UI/UX (docs/claude/ui-audit-criticos.md):
// Assets.jsx tinha sua PRÓPRIA cópia (idêntica a AssetCard.jsx) do cálculo
// `lastScanMs > 2h` pra decidir LIVE/STALE — threshold arbitrário e
// duplicado. Este teste prova a integração: a página agora usa
// `assetHealthcheckReason` (mesma função pura de AssetCard.jsx) e mostra o
// motivo certo por ativo. A lógica da função em si já é testada em
// `src/lib/assetHealthcheck.test.js` — aqui só confirmamos a integração/UI.
import React from 'react';
import { describe, it, vi, afterEach } from 'vitest';
import { screen, cleanup } from '@testing-library/react';
import { renderPage } from './__fixtures__/renderPage.jsx';
import Assets from './Assets.jsx';

const monitoredAssetListMock = vi.fn();

vi.mock('@/api/entities', () => ({
  backend: {
    entities: {
      MonitoredAsset: { list: (...args) => monitoredAssetListMock(...args) },
      AssetState: { list: async () => [] },
      SignalEvent: { list: async () => [] },
      TradeOperation: { list: async () => [] },
    },
  },
}));

afterEach(() => {
  cleanup();
  monitoredAssetListMock.mockReset();
});

const OLD_40MIN = () => new Date(Date.now() - 40 * 60000).toISOString();
const RECENT_5MIN = () => new Date(Date.now() - 5 * 60000).toISOString();

describe('Assets — badge LIVE/STALE reflete o dead-man\'s-switch real (achado A-9)', () => {
  it('mostra LIVE, STALE e ERRO corretamente por ativo, na mesma lista', async () => {
    monitoredAssetListMock.mockResolvedValue([
      { id: 'a1', symbol: 'BTCUSDT', display_name: 'BTC/USDT', is_active: true, last_scan_at: RECENT_5MIN() },
      { id: 'a2', symbol: 'ETHUSDT', display_name: 'ETH/USDT', is_active: true, last_scan_at: OLD_40MIN() },
      { id: 'a3', symbol: 'SOLUSDT', display_name: 'SOL/USDT', is_active: true, last_scan_at: RECENT_5MIN(), scan_error_since: OLD_40MIN() },
    ]);

    renderPage(<Assets />);

    await screen.findByText('BTC/USDT');
    screen.getByText('LIVE');
    screen.getByText('STALE');
    screen.getByText('ERRO');
  });
});
