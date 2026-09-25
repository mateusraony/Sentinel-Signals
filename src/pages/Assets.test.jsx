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
import { describe, it, expect, vi, afterEach } from 'vitest';
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

// Achado A-6 do Raio-X de UI/UX (7ª sub-rodada): o badge "backfill
// pendente" usava title= nativo. Migrado pro Tooltip do Radix
// (TooltipTrigger asChild + tabIndex={0} novo, já que o <span> não é
// focável por padrão).
describe('Assets — badge "backfill pendente" usa Tooltip em vez de title= nativo (achado A-6)', () => {
  it('REGRESSÃO: não tem title= nativo, vira gatilho focável', async () => {
    monitoredAssetListMock.mockResolvedValue([
      { id: 'a1', symbol: 'BTCUSDT', display_name: 'BTC/USDT', is_active: true, last_scan_at: RECENT_5MIN(), backfill_check_status: 'pending' },
    ]);

    renderPage(<Assets />);

    await screen.findByText('BTC/USDT');
    const badge = screen.getByText(/backfill pendente/).closest('[tabindex="0"]');
    expect(badge).not.toBeNull();
    expect(badge.getAttribute('title')).toBeNull();
  });
});

// Achado A-6 (último item pendente) + A-7 do Raio-X de UI/UX (varredura
// fresca, docs/known-risks.md item 214, 4ª sub-rodada): os 3 ícones de
// status de scan (XCircle/CheckCircle2/MinusCircle) eram ícone-só, com
// `title=` nativo E sem nenhum wrapper focável — corrigir de verdade exigia
// primeiro A-7 (foco de teclado) resolvido, por isso ficaram pendentes até
// agora. Migrados pro mesmo padrão Tooltip+tabIndex já usado no badge
// "backfill pendente" (acima, no mesmo arquivo).
describe('Assets — ícones de status de scan usam Tooltip em vez de title= nativo (achados A-6/A-7)', () => {
  it('REGRESSÃO: ícone de erro (XCircle) não tem title= nativo, vira gatilho focável', async () => {
    monitoredAssetListMock.mockResolvedValue([
      { id: 'a1', symbol: 'BTCUSDT', display_name: 'BTC/USDT', is_active: true, last_scan_at: RECENT_5MIN(), scan_status: 'error' },
    ]);
    const { container } = renderPage(<Assets />);

    await screen.findByText('BTC/USDT');
    const icon = container.querySelector('.text-rose-400');
    const trigger = icon.closest('[tabindex="0"]');
    expect(trigger).not.toBeNull();
    expect(icon.getAttribute('title')).toBeNull();
  });

  it('REGRESSÃO: ícone de sucesso (CheckCircle2) não tem title= nativo, vira gatilho focável', async () => {
    monitoredAssetListMock.mockResolvedValue([
      { id: 'a1', symbol: 'BTCUSDT', display_name: 'BTC/USDT', is_active: true, last_scan_at: RECENT_5MIN(), scan_status: 'success' },
    ]);
    const { container } = renderPage(<Assets />);

    await screen.findByText('BTC/USDT');
    const icon = container.querySelector('.text-emerald-400');
    const trigger = icon.closest('[tabindex="0"]');
    expect(trigger).not.toBeNull();
    expect(icon.getAttribute('title')).toBeNull();
  });

  it('REGRESSÃO: ícone "ainda não escaneado" (MinusCircle) não tem title= nativo, vira gatilho focável', async () => {
    monitoredAssetListMock.mockResolvedValue([
      { id: 'a1', symbol: 'BTCUSDT', display_name: 'BTC/USDT', is_active: true, last_scan_at: RECENT_5MIN(), scan_status: 'idle' },
    ]);
    const { container } = renderPage(<Assets />);

    await screen.findByText('BTC/USDT');
    const trigger = container.querySelector('[tabindex="0"]');
    expect(trigger).not.toBeNull();
    expect(trigger.querySelector('svg').getAttribute('title')).toBeNull();
  });
});
