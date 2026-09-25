// @vitest-environment jsdom
//
// Achado A-2 do Raio-X de UI/UX (docs/claude/ui-audit-criticos.md):
// `candleOpen` subtraía 1h fixo de `last_candle_time` (que é o FECHAMENTO
// do candle) pra estimar a ABERTURA — correto só pro timeframe 1h. Pra 4h/
// 1d, mostrava uma janela de candle errada (ex.: um candle 4h aparecia
// como se tivesse durado só 1h). Este teste prova o fix: a duração
// subtraída agora depende do timeframe do estado exibido.
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { makeTestQueryClient } from '@/pages/__fixtures__/renderPage.jsx';
import { TooltipProvider } from '@/components/ui/tooltip';
import AssetCard from './AssetCard.jsx';

// fetchMarkPrice precisa ser controlável por teste (achado A-6, badge
// "Fund." só vira Tooltip focável quando fundingRate !== null) — mesmo
// padrão vi.hoisted já usado em src/hooks/useLivePrice.test.jsx.
const { fetchMarkPriceMock } = vi.hoisted(() => ({ fetchMarkPriceMock: vi.fn() }));
vi.mock('@/lib/marketDataProvider', () => ({
  fetch24hStats: async () => null,
  fetchMarkPrice: fetchMarkPriceMock,
}));
vi.mock('@/lib/firebaseClient', () => ({ db: {}, auth: {}, rtdb: null, app: {} }));

beforeEach(() => {
  fetchMarkPriceMock.mockReset();
  fetchMarkPriceMock.mockResolvedValue({ markPrice: null, lastFundingRate: null, nextFundingTime: null });
});
afterEach(() => cleanup());

function renderCard(props) {
  const client = makeTestQueryClient();
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <AssetCard asset={{ id: 'a1', symbol: 'BTCUSDT', display_name: 'BTC/USDT' }} {...props} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

// Fechamento em horário redondo (UTC) pra tornar a subtração fácil de
// conferir de cabeça depois de aplicar utcOffset(-3) (BRT).
const CLOSE_4H_UTC = '2026-09-24T16:00:00.000Z'; // 13:00 BRT

describe('AssetCard — horário de abertura do candle (achado A-2)', () => {
  it('candle 4h: abertura é fechamento - 4h, não - 1h', () => {
    renderCard({
      states: [{ timeframe: '4h', last_candle_time: CLOSE_4H_UTC, last_close: 60000 }],
    });
    // Fechamento 13:00 BRT, candle 4h -> abertura 09:00 BRT.
    screen.getByText(/09:00 → 13:00 BRT/);
  });

  it('candle 1h: continua correto (abertura = fechamento - 1h)', () => {
    renderCard({
      states: [{ timeframe: '1h', last_candle_time: CLOSE_4H_UTC, last_close: 60000 }],
    });
    screen.getByText(/12:00 → 13:00 BRT/);
  });

  it('candle 1d: abertura é fechamento - 24h', () => {
    renderCard({
      states: [{ timeframe: '1d', last_candle_time: CLOSE_4H_UTC, last_close: 60000 }],
    });
    // Fechamento 24/09 13:00 BRT, candle 1d -> abertura 23/09 13:00 BRT.
    screen.getByText(/23\/09 13:00 → 13:00 BRT/);
  });
});

// Achado A-9 do Raio-X de UI/UX: o badge LIVE/STALE usava um threshold de
// 2h fixo (arbitrário, 24x maior que a cadência real de ~5min) em vez do
// dead-man's-switch oficial (`assetHealthcheckReason`, graceMs=30min). Este
// teste prova que o badge agora reflete os 2 motivos reais da função —
// 'silent' (last_scan_at velho) e 'persistent_error' (scan_error_since
// velho, mais grave) — em vez do booleano cru de antes.
const OLD_40MIN = () => new Date(Date.now() - 40 * 60000).toISOString();
const RECENT_5MIN = () => new Date(Date.now() - 5 * 60000).toISOString();

describe('AssetCard — badge LIVE/STALE reflete o dead-man\'s-switch real (achado A-9)', () => {
  it('LIVE quando last_scan_at é recente (< 30min)', () => {
    renderCard({ asset: { id: 'a1', symbol: 'BTCUSDT', display_name: 'BTC/USDT', last_scan_at: RECENT_5MIN() } });
    screen.getByText('LIVE');
  });

  it('STALE quando last_scan_at está velho (> 30min), motivo silent', () => {
    renderCard({ asset: { id: 'a1', symbol: 'BTCUSDT', display_name: 'BTC/USDT', last_scan_at: OLD_40MIN() } });
    screen.getByText('STALE');
  });

  it('ERRO (persistent_error) quando scan_error_since está velho — motivo mais grave que silent', () => {
    renderCard({
      asset: {
        id: 'a1', symbol: 'BTCUSDT', display_name: 'BTC/USDT',
        last_scan_at: RECENT_5MIN(), scan_error_since: OLD_40MIN(),
      },
    });
    screen.getByText('ERRO');
  });

  it('esconde o botão "Ativar" quando stale, mostra quando live (mesmo sinal pendente)', () => {
    const latestSignal = { id: 'sig1', signal_type: 'BUY' };

    const { unmount } = renderCard({
      asset: { id: 'a1', symbol: 'BTCUSDT', display_name: 'BTC/USDT', last_scan_at: OLD_40MIN() },
      latestSignal,
    });
    if (screen.queryByText(/Ativar BUY agora/i)) throw new Error('botão "Ativar" não deveria aparecer com o ativo stale');
    unmount();

    renderCard({
      asset: { id: 'a1', symbol: 'BTCUSDT', display_name: 'BTC/USDT', last_scan_at: RECENT_5MIN() },
      latestSignal,
    });
    screen.getByText(/Ativar BUY agora/i);
  });
});

// Achado A-8 do Raio-X de UI/UX: o card só abria por clique de mouse — sem
// `tabIndex`, `role="button"` nem `onKeyDown`, um usuário só-teclado não
// conseguia focar nem ativar o card. Este teste prova o fix, incluindo o
// caso de atenção que a investigação achou: Enter/Espaço disparado num
// botão FILHO (ex. TF Quick Switcher) não pode duplicar a ação do card.
describe('AssetCard — suporte a teclado (achado A-8)', () => {
  it('tem role="button" e tabIndex={0} pra navegação só-teclado', () => {
    const { container } = renderCard({});
    const card = container.querySelector('[role="button"]');
    expect(card).toBeTruthy();
    expect(card.tabIndex).toBe(0);
  });

  it('Enter no card (foco no próprio card) chama onClick', () => {
    const onClick = vi.fn();
    const { container } = renderCard({ onClick });
    const card = container.querySelector('[role="button"]');
    fireEvent.keyDown(card, { key: 'Enter' });
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('Espaço no card chama onClick', () => {
    const onClick = vi.fn();
    const { container } = renderCard({ onClick });
    const card = container.querySelector('[role="button"]');
    fireEvent.keyDown(card, { key: ' ' });
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('Enter num botão filho (TF Quick Switcher) NÃO duplica a ação do card', () => {
    const onClick = vi.fn();
    renderCard({
      onClick,
      states: [
        { timeframe: '1h', last_close: 60000 },
        { timeframe: '4h', last_close: 60000 },
      ],
    });
    const tfButton = screen.getByRole('button', { name: '4H' });
    fireEvent.keyDown(tfButton, { key: 'Enter' });
    expect(onClick).not.toHaveBeenCalled();
  });
});

// Achado A-6 do Raio-X de UI/UX (6ª sub-rodada): 3 ocorrências de title=
// nativo em AssetCard.jsx (badge "OP?", "Confl.", "Fund.") — todas em
// elemento não focável com texto visível, migradas pro Tooltip do Radix
// (TooltipTrigger asChild + tabIndex={0} novo). O card inteiro já é
// role="button"/tabIndex={0} (achado A-8) com botões filhos reais (TF
// Quick Switcher, testado acima) — precedente já confirmado de que
// elemento focável aninhado dentro do card não duplica a ação dele
// (guarda `e.target !== e.currentTarget` no onKeyDown do card).
describe('AssetCard — badges usam Tooltip em vez de title= nativo (achado A-6)', () => {
  it('REGRESSÃO: badge "Confl." não tem title= nativo, vira gatilho focável', () => {
    renderCard({ latestSignal: { context: { score: 85 } } });
    const badge = screen.getByText(/Confl\.:/);
    expect(badge.getAttribute('title')).toBeNull();
    expect(badge.getAttribute('tabindex')).toBe('0');
  });

  it('REGRESSÃO: badge "OP?" (operações não confirmadas) não tem title= nativo, vira gatilho focável', () => {
    renderCard({ tradeOpsUnavailable: true });
    const badge = screen.getByText('OP?').closest('[tabindex="0"]');
    expect(badge).not.toBeNull();
    expect(badge.getAttribute('title')).toBeNull();
  });

  it('REGRESSÃO: badge "Fund." (funding rate) não tem title= nativo, vira gatilho focável', async () => {
    fetchMarkPriceMock.mockResolvedValue({ markPrice: 60000, lastFundingRate: 0.0001, nextFundingTime: null });
    renderCard({});
    const badge = await waitFor(() => {
      const el = screen.getByText(/Fund\.:/);
      expect(el.getAttribute('tabindex')).toBe('0');
      return el;
    });
    expect(badge.getAttribute('title')).toBeNull();
  });
});
