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
import { render, screen, cleanup, fireEvent, waitFor, within, act } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { makeTestQueryClient } from '@/pages/__fixtures__/renderPage.jsx';
import { TooltipProvider } from '@/components/ui/tooltip';
import AssetCard, { getTp1Tooltip, getTp2Tooltip } from './AssetCard.jsx';

// fetchMarkPrice precisa ser controlável por teste (achado A-6, badge
// "Fund." só vira Tooltip focável quando fundingRate !== null) — mesmo
// padrão vi.hoisted já usado em src/hooks/useLivePrice.test.jsx.
const { fetchMarkPriceMock, fetch24hStatsMock } = vi.hoisted(() => ({ fetchMarkPriceMock: vi.fn(), fetch24hStatsMock: vi.fn() }));
vi.mock('@/lib/marketDataProvider', () => ({
  fetch24hStats: (...a) => fetch24hStatsMock(...a),
  fetchMarkPrice: fetchMarkPriceMock,
}));
vi.mock('@/lib/firebaseClient', () => ({ db: {}, auth: {}, rtdb: null, app: {} }));

// Round 2 pós-Raio-X (2026-09-27): activateMutation chama activateSignalManually
// direto (não backend.entities) — precisa de mock próprio pra espionar a
// chamada no teste do botão "Ativar" abaixo.
const { activateSignalManuallyMock } = vi.hoisted(() => ({ activateSignalManuallyMock: vi.fn() }));
vi.mock('@/lib/scanner', () => ({ activateSignalManually: activateSignalManuallyMock }));

// Item 278 (PR-C): antes de simular, o cartão confere se este aviso já foi
// simulado (id determinístico `trade_manual_<id>`), e os avisos saem por toast.
const { tradeOpGetMock, toastMock } = vi.hoisted(() => ({ tradeOpGetMock: vi.fn(), toastMock: vi.fn() }));
vi.mock('@/api/entities', () => ({ backend: { entities: { TradeOperation: { get: (...a) => tradeOpGetMock(...a) } } } }));
vi.mock('@/components/ui/use-toast', () => ({ toast: (...a) => toastMock(...a) }));

// Aviso que PODE virar operação e ainda está no prazo: Range Filter 4h recente.
const RF4H = (overrides = {}) => ({
  id: 'sig1', signal_type: 'BUY', source: 'range_filter', timeframe: '4h',
  created_date: new Date(Date.now() - 20 * 60000).toISOString(), ...overrides,
});

beforeEach(() => {
  fetchMarkPriceMock.mockReset();
  fetch24hStatsMock.mockReset();
  fetch24hStatsMock.mockResolvedValue(null);
  fetchMarkPriceMock.mockResolvedValue({ markPrice: null, lastFundingRate: null, nextFundingTime: null });
  activateSignalManuallyMock.mockReset();
  activateSignalManuallyMock.mockResolvedValue({ created: true });
  tradeOpGetMock.mockReset();
  tradeOpGetMock.mockResolvedValue(null);
  toastMock.mockReset();
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

// Item 280: ativo atrasado mostra o mesmo 📡 do badge, não "⚠️ STALE"
// (⚠️ é "Sinal Invalidado" no registro de emojis).
describe('AssetCard — status de dado atrasado usa 📡 (item 280)', () => {
  it('scan parado há 2h: "📡 Atrasado…" na linha de status, sem ⚠️ STALE', () => {
    const { container } = renderCard({
      asset: { id: 'a1', symbol: 'BTCUSDT', display_name: 'BTC/USDT', is_active: true, last_scan_at: new Date(Date.now() - 2 * 3600_000).toISOString() },
    });
    expect(screen.getAllByText(/📡 Atrasado/).length).toBeGreaterThan(0);
    expect(container.textContent).not.toMatch(/STALE|⚠️ Falha persistente/);
  });
});

// Item 280: runner é 🏃 no painel inteiro (⚡ ficou só para a marca).
describe('AssetCard — runner usa 🏃 (item 280)', () => {
  it('status e linha de runner com 🏃, sem ⚡', () => {
    const { container } = renderCard({
      asset: { id: 'a1', symbol: 'BTCUSDT', display_name: 'BTC/USDT', last_scan_at: new Date().toISOString() },
      tradeOp: { id: 'op1', status: 'RUNNER_ACTIVE', side: 'BUY', entry_price: 100, current_stop: 100, tp1: 110, tp2: 120, tp1_hit: true, runner_percent: 50 },
      expandAll: true,
    });
    screen.getByText('🏃 Runner Ativo');
    expect(container.textContent).not.toMatch(/⚡/);
  });
});

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
// 2h fixo (arbitrário, 4x maior que a cadência real de ~15min) em vez do
// dead-man's-switch oficial (`assetHealthcheckReason`, graceMs=60min (item 286)). Este
// teste prova que o badge agora reflete os 2 motivos reais da função —
// 'silent' (last_scan_at velho) e 'persistent_error' (scan_error_since
// velho, mais grave) — em vez do booleano cru de antes.
const OLD_70MIN = () => new Date(Date.now() - 70 * 60000).toISOString();
const RECENT_5MIN = () => new Date(Date.now() - 5 * 60000).toISOString();

// Item 277 (PR-B): o badge passou a 📡 (mesmos rótulos do drawer e do chip de
// saúde); "LIVE" verde fixo saiu de vez.
describe('AssetCard — badge 📡 reflete o dead-man\'s-switch real (achado A-9, item 277)', () => {
  it('📡 há N min quando last_scan_at é recente (< 60min)', () => {
    renderCard({ asset: { id: 'a1', symbol: 'BTCUSDT', display_name: 'BTC/USDT', last_scan_at: RECENT_5MIN() } });
    screen.getByText('📡 há 5 min');
    expect(screen.queryByText('LIVE')).toBeNull();
  });

  it('📡 Atrasado quando last_scan_at está velho (> 60min), motivo silent', () => {
    renderCard({ asset: { id: 'a1', symbol: 'BTCUSDT', display_name: 'BTC/USDT', last_scan_at: OLD_70MIN() } });
    screen.getByText('📡 Atrasado');
  });

  it('REGRESSÃO: ativo nunca lido (sem last_scan_at) mostra 📡 Sem leitura, nunca LIVE', () => {
    renderCard({ asset: { id: 'a1', symbol: 'BTCUSDT', display_name: 'BTC/USDT' } });
    screen.getByText('📡 Sem leitura');
    expect(screen.queryByText('LIVE')).toBeNull();
  });

  it('REGRESSÃO (review do PR-B): o badge envelhece com o relógio, sem nova prop', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    try {
      vi.setSystemTime(Date.parse('2026-10-17T12:00:00Z'));
      renderCard({ asset: { id: 'a1', symbol: 'BTCUSDT', display_name: 'BTC/USDT', last_scan_at: '2026-10-17T11:59:00Z' } });
      screen.getByText('📡 há 1 min');
      act(() => { vi.advanceTimersByTime(70 * 60000); });
      screen.getByText('📡 Atrasado');
    } finally {
      vi.useRealTimers();
    }
  });

  it('REGRESSÃO (review do PR-B): falha recente (< 60 min) também esconde o botão "Ativar"', () => {
    renderCard({
      asset: { id: 'a1', symbol: 'BTCUSDT', display_name: 'BTC/USDT', last_scan_at: RECENT_5MIN(), scan_status: 'error', scan_error_since: RECENT_5MIN() },
      latestSignal: RF4H(),
    });
    screen.getByText('📡 Falha');
    expect(screen.queryByText(/Simular entrada \(virtual\)/i)).toBeNull();
  });

  it('REGRESSÃO: sem leitura também esconde o botão "Ativar" (mesmo com sinal pendente)', () => {
    renderCard({ asset: { id: 'a1', symbol: 'BTCUSDT', display_name: 'BTC/USDT' }, latestSignal: RF4H() });
    expect(screen.queryByText(/Simular entrada \(virtual\)/i)).toBeNull();
  });

  it('ERRO (persistent_error) quando scan_error_since está velho — motivo mais grave que silent', () => {
    renderCard({
      asset: {
        id: 'a1', symbol: 'BTCUSDT', display_name: 'BTC/USDT',
        last_scan_at: RECENT_5MIN(), scan_error_since: OLD_70MIN(),
      },
    });
    screen.getByText('📡 Falha');
  });

  it('esconde o botão "Ativar" quando stale, mostra quando live (mesmo sinal pendente)', () => {
    const latestSignal = RF4H();

    const { unmount } = renderCard({
      asset: { id: 'a1', symbol: 'BTCUSDT', display_name: 'BTC/USDT', last_scan_at: OLD_70MIN() },
      latestSignal,
    });
    if (screen.queryByText(/Simular entrada \(virtual\)/i)) throw new Error('botão "Simular" não deveria aparecer com o ativo stale');
    unmount();

    renderCard({
      asset: { id: 'a1', symbol: 'BTCUSDT', display_name: 'BTC/USDT', last_scan_at: RECENT_5MIN() },
      latestSignal,
    });
    screen.getByText(/Simular entrada \(virtual\)/i);
  });
});

// Achado da varredura pós-Raio-X, Round 2 (2026-09-27): o botão "Ativar"
// usava window.confirm() nativo (quebra o tema escuro) — migrado pro
// AlertDialog já existente e nunca usado. Texto mantido igual.
describe('AssetCard — botão "Ativar" usa AlertDialog em vez de confirm() nativo (Round 2 pós-Raio-X)', () => {
  it('REGRESSÃO: abre diálogo com o texto da cascata; Cancelar não chama activateSignalManually; confirmar chama', async () => {
    const latestSignal = RF4H();
    renderCard({
      asset: { id: 'a1', symbol: 'BTCUSDT', display_name: 'BTC/USDT', last_scan_at: RECENT_5MIN() },
      latestSignal,
    });

    fireEvent.click(screen.getByText(/Simular entrada \(virtual\)/i));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/Nenhuma ordem é enviada à corretora/)).toBeTruthy();

    fireEvent.click(within(dialog).getByText('Cancelar'));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(activateSignalManuallyMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText(/Simular entrada \(virtual\)/i));
    const dialog2 = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog2).getByText('Simular COMPRA'));
    await waitFor(() => expect(activateSignalManuallyMock).toHaveBeenCalledWith(latestSignal, expect.objectContaining({ id: 'a1' })));
  });

  // Achado do Codex review no PR #442 (P1): o confirm() nativo bloqueava a
  // UI, então nada podia repintar entre o clique e a mutação. Com o
  // AlertDialog, o polling do Dashboard pode trocar `latestSignal` (ex.:
  // sinal oposto chegou) enquanto o diálogo está aberto — sem snapshot, a
  // confirmação ativaria o sinal NOVO, nunca revisado pelo usuário.
  it('REGRESSÃO (Codex): confirmar usa o sinal snapshotado na abertura, não um latestSignal mais novo chegado via polling', async () => {
    const originalSignal = RF4H({ id: 'sig-orig' });
    const newerSignal = RF4H({ id: 'sig-new', signal_type: 'SELL' });
    const asset = { id: 'a1', symbol: 'BTCUSDT', display_name: 'BTC/USDT', last_scan_at: RECENT_5MIN() };
    const client = makeTestQueryClient();
    const { rerender } = render(
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <AssetCard asset={asset} latestSignal={originalSignal} />
        </TooltipProvider>
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByText(/Simular entrada \(virtual\)/i));
    await screen.findByRole('alertdialog');

    rerender(
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <AssetCard asset={asset} latestSignal={newerSignal} />
        </TooltipProvider>
      </QueryClientProvider>,
    );

    const dialog = screen.getByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /^Simular /}));
    await waitFor(() => expect(activateSignalManuallyMock).toHaveBeenCalledWith(originalSignal, expect.objectContaining({ id: 'a1' })));
    expect(activateSignalManuallyMock).not.toHaveBeenCalledWith(newerSignal, expect.anything());
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

  // Auditoria do Telegram (2026-09-29), item 1.11 — `score = tradeOp?.score
  // || latestSignal?.context?.score || 0` mostrava "Confl.: 0" pra um card
  // sem nenhum sinal/operação com score real. Dashboard.jsx só passa sinais
  // `source === 'range_filter'` como `latestSignal` (achado durante a
  // implementação deste item — SMC/MACD/EMA/RSI nunca chegam aqui), então na
  // prática isso é um guard defensivo (context.score ausente/malformado),
  // não um caso hoje visivelmente alcançável por outra fonte.
  it('REGRESSÃO: sem sinal/operação com score real, o badge "Confl." não aparece (nunca mostra "Confl.: 0")', () => {
    renderCard({ latestSignal: { context: {} } }); // context.score ausente
    expect(screen.queryByText(/Confl\.:/)).toBeNull();
  });

  it('REGRESSÃO: badge "Fund." (funding rate) não tem title= nativo, vira gatilho focável', async () => {
    fetchMarkPriceMock.mockResolvedValue({ markPrice: 60000, lastFundingRate: 0.0001, nextFundingTime: null });
    // Achado A-15: Fund. mudou pra Camada 2 (atrás do toggle "Detalhes
    // técnicos") — precisa de expandAll pra aparecer sem simular clique.
    renderCard({ expandAll: true });
    const badge = await waitFor(() => {
      const el = screen.getByText(/Fund\.:/);
      expect(el.getAttribute('tabindex')).toBe('0');
      return el;
    });
    expect(badge.getAttribute('title')).toBeNull();
  });
});

// Achado A-15 do Raio-X de UI/UX: o card mostrava ~20+ blocos de
// informação de uma vez. TFTrendRow/Fund./IndicatorDots (legítimos, mas
// não essenciais pro primeiro olhar — nenhum é lido por outro componente)
// foram movidos pra Camada 2, atrás de um toggle "Detalhes técnicos",
// mesmo padrão de divulgação progressiva já validado em TradeCard.jsx
// (useState local + render condicional + prop `expandAll`).
describe('AssetCard — divulgação progressiva (achado A-15)', () => {
  it('Camada 2 (RF/MACD/EMA/RSI) fica ausente do DOM por padrão', () => {
    renderCard({
      states: [{ timeframe: '1h', rf_direction: 1, macd_histogram: 0.5, trend_ema: 'bullish', rsi_zone: 'neutral', rsi_value: 55, last_close: 60000 }],
    });
    expect(screen.queryByText('RF')).toBeNull();
    expect(screen.getByRole('button', { name: /detalhes técnicos/i }).getAttribute('aria-expanded')).toBe('false');
  });

  it('clicar em "Detalhes técnicos" revela a Camada 2 e alterna aria-expanded', () => {
    renderCard({
      states: [{ timeframe: '1h', rf_direction: 1, macd_histogram: 0.5, trend_ema: 'bullish', rsi_zone: 'neutral', rsi_value: 55, last_close: 60000 }],
    });
    const toggle = screen.getByRole('button', { name: /detalhes técnicos/i });
    fireEvent.click(toggle);
    expect(screen.getByText('RF')).toBeTruthy();
    expect(screen.getByRole('button', { name: /menos detalhes/i }).getAttribute('aria-expanded')).toBe('true');
  });

  it('clicar no toggle não dispara o onClick do card (mesma guarda já usada no TF Quick Switcher)', () => {
    const onClick = vi.fn();
    renderCard({ onClick });
    fireEvent.click(screen.getByRole('button', { name: /detalhes técnicos/i }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('prop expandAll força a Camada 2 aberta sem nenhum clique', () => {
    renderCard({
      expandAll: true,
      states: [{ timeframe: '1h', rf_direction: 1, macd_histogram: 0.5, trend_ema: 'bullish', rsi_zone: 'neutral', rsi_value: 55, last_close: 60000 }],
    });
    expect(screen.getByText('RF')).toBeTruthy();
    expect(screen.getByRole('button', { name: /menos detalhes/i }).getAttribute('aria-expanded')).toBe('true');
  });
});

describe('AssetCard — animações de flash respeitam prefers-reduced-motion (achado M-5)', () => {
  it('REGRESSÃO: .flash-buy/.flash-sell têm animation:none sob @media (prefers-reduced-motion: reduce)', () => {
    const { container } = renderCard({});
    const styleTag = container.querySelector('style');
    expect(styleTag).not.toBeNull();
    expect(styleTag.textContent).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(styleTag.textContent).toMatch(/\.flash-buy,\s*\.flash-sell\s*\{\s*animation:\s*none;?\s*\}/);
  });
});

// Achado M-17 do Raio-X de UI/UX (glossário de termos técnicos, item
// 229): RF/MACD/EMA/RSI no IndicatorDots e TP1/TP2 no grid de preços eram
// rótulos "nus" — sem tooltip nem texto explicando o termo. Padrão já
// usado no resto do arquivo (Tooltip/TooltipTrigger asChild/tabIndex={0}).
describe('AssetCard — indicadores RF/MACD/EMA/RSI e colunas TP1/TP2 têm tooltip explicando o termo (achado M-17)', () => {
  // Nota: o card inteiro já é role="button"/tabIndex={0} (achado A-8), então
  // `.closest('[tabindex="0"]')` sozinho encontraria o card mesmo sem o fix
  // (falso positivo) — `.closest('.cursor-help')` é o discriminador certo,
  // já que só o novo wrapper do achado M-17 usa essa classe (o card usa
  // `cursor-pointer`).
  it('REGRESSÃO: RF/MACD/EMA/RSI (IndicatorDots) são focáveis e têm tooltip próprio', () => {
    // Achado A-15: IndicatorDots mudou pra Camada 2 — precisa de
    // expandAll pra aparecer sem simular clique no toggle.
    renderCard({
      expandAll: true,
      states: [{ timeframe: '1h', rf_direction: 1, macd_histogram: 0.5, trend_ema: 'bullish', rsi_zone: 'neutral', rsi_value: 55, last_close: 60000 }],
    });
    const rf = screen.getByText('RF').closest('.cursor-help');
    const macd = screen.getByText('MACD').closest('.cursor-help');
    const ema = screen.getByText('EMA').closest('.cursor-help');
    const rsi = screen.getByText('RSI').closest('.cursor-help');
    expect(rf?.getAttribute('tabindex')).toBe('0');
    expect(macd?.getAttribute('tabindex')).toBe('0');
    expect(ema?.getAttribute('tabindex')).toBe('0');
    expect(rsi?.getAttribute('tabindex')).toBe('0');
  });

  it('REGRESSÃO: colunas TP1/TP2 do grid de preços são focáveis com tooltip; Entrada/Stop/Stop+ continuam sem tooltip', () => {
    renderCard({});
    const tp1 = screen.getByText('TP1').closest('.cursor-help');
    const tp2 = screen.getByText('TP2').closest('.cursor-help');
    expect(tp1?.getAttribute('tabindex')).toBe('0');
    expect(tp2?.getAttribute('tabindex')).toBe('0');
    // Entrada/Stop/Stop+ são autoexplicativos — não deveriam virar gatilho de tooltip.
    expect(screen.getByText('Entrada').closest('.cursor-help')).toBeNull();
    expect(screen.getByText('Stop+').closest('.cursor-help')).toBeNull();
  });

  // Achado do Codex review no PR #430: o texto de TP1/TP2 era estático e
  // sempre falava de um "runner" indo pro TP2 — falso quando a operação foi
  // criada com partial_percent:100 (fecha tudo no TP1, sem runner) ou
  // tp2_cap_disabled:true (TP2 nunca é usado, runner segue em trailing).
  // Testado direto contra a função pura exportada (`getTp1Tooltip`/
  // `getTp2Tooltip`), não via abrir o Tooltip do Radix por foco — esse
  // caminho provou ser lento/instável em jsdom neste arquivo (o card tem 3
  // `useQuery` ativos re-renderizando; tentativas com `fireEvent.focus` +
  // `findByText` chegaram a travar >30s num timeout de 5s). A cobertura de
  // que a COLUNA em si é focável/tem tooltip já existe no teste acima
  // ("colunas TP1/TP2 do grid de preços são focáveis") — este cobre só o
  // TEXTO, que é o que o achado do Codex mudou.
  const TP_OP_BASE = {
    id: 'op1', entry_price: 100, initial_stop: 90, tp1: 110, tp2: 120, current_stop: 95, status: 'SIGNAL_CONFIRMED',
  };

  it('REGRESSÃO: operação normal (com runner) mantém o texto original de TP1/TP2', () => {
    expect(getTp1Tooltip({ ...TP_OP_BASE })).toMatch(/o restante \(runner\) segue para o TP2/);
    expect(getTp2Tooltip({ ...TP_OP_BASE })).toMatch(/o que sobrou da posição \(runner\) depois do TP1/);
  });

  it('REGRESSÃO: sem operação ativa (op indefinida) usa o texto padrão, não quebra', () => {
    expect(getTp1Tooltip(undefined)).toMatch(/o restante \(runner\) segue para o TP2/);
    expect(getTp2Tooltip(undefined)).toMatch(/o que sobrou da posição \(runner\) depois do TP1/);
  });

  it('REGRESSÃO: partial_percent:100 (sem runner) — TP1 vira alvo único, TP2 vira "não aplicável"', () => {
    expect(getTp1Tooltip({ ...TP_OP_BASE, partial_percent: 100 })).toMatch(/Único alvo de lucro desta operação/);
    expect(getTp2Tooltip({ ...TP_OP_BASE, partial_percent: 100 })).toMatch(/Não aplicável nesta operação — a posição já foi fechada inteira no TP1/);
  });

  it('REGRESSÃO: tp2_cap_disabled:true — TP2 explica que o runner ignora o teto e segue em trailing', () => {
    expect(getTp1Tooltip({ ...TP_OP_BASE, tp2_cap_disabled: true })).toMatch(/o restante \(runner\) segue para o TP2/);
    expect(getTp2Tooltip({ ...TP_OP_BASE, tp2_cap_disabled: true })).toMatch(/o runner ignora este teto e segue em trailing/);
  });
});

// Refinamentos (seção E do Raio-X): o hint "detalhes →" só aparecia em
// :hover, que não existe em touch — mobile/tablet nunca viam a dica.
describe('AssetCard — hint "detalhes →" sempre visível, não só em :hover (Refinamentos)', () => {
  it('REGRESSÃO: a classe do hint não depende mais de hover:opacity-100/opacity-0', () => {
    renderCard({});
    const hint = screen.getByText('detalhes →');
    expect(hint.className).not.toMatch(/opacity-0/);
    expect(hint.className).not.toMatch(/hover:opacity-100/);
  });
});

// Item 278 (PR-C): "Ativar BUY agora" aparecia para qualquer aviso do Range
// Filter (1h/1d, ou já expirado) e soava como ordem real. Agora é uma
// simulação virtual, só para aviso que pode virar operação e ainda está no
// prazo, com diálogo honesto e avisos por toast (sem window.alert).
describe('AssetCard — 🧪 Simular entrada (virtual) (item 278)', () => {
  const ASSET = { id: 'a1', symbol: 'BTCUSDT', display_name: 'BTC/USDT', is_active: true, last_scan_at: RECENT_5MIN() };
  const simButton = () => screen.queryByRole('button', { name: /Simular entrada \(virtual\)/i });

  it('aparece só para Range Filter 4h ainda no prazo', () => {
    const cases = [
      [RF4H(), true],
      [RF4H({ timeframe: '1h' }), false],
      [RF4H({ timeframe: '1d' }), false],
      [RF4H({ created_date: new Date(Date.now() - 5 * 3600000).toISOString() }), false], // expirado
      [RF4H({ source: 'smc_structure', timeframe: '1h' }), false], // cascata própria, não 4h
    ];
    for (const [latestSignal, visible] of cases) {
      const { unmount } = renderCard({ asset: ASSET, latestSignal });
      expect(Boolean(simButton())).toBe(visible);
      unmount();
    }
  });

  it('diálogo diz que é virtual, que nenhuma ordem é enviada e que pula os filtros do motor', async () => {
    renderCard({ asset: ASSET, latestSignal: RF4H() });
    fireEvent.click(simButton());
    const dialog = await screen.findByRole('alertdialog');
    within(dialog).getByText('Iniciar simulação de COMPRA em BTC/USDT?');
    expect(dialog.textContent).toMatch(/operação virtual/);
    expect(dialog.textContent).toMatch(/Nenhuma ordem é enviada à corretora/);
    expect(dialog.textContent).toMatch(/pula os filtros do motor/);
    expect(dialog.textContent).toMatch(/fora da medição do motor/);
    // Review do PR-C: a simulação ocupa a vaga do ativo — o diálogo diz isso.
    expect(dialog.textContent).toMatch(/o motor não abre outra operação neste ativo/);
  });

  it('REGRESSÃO (review do PR-C): sem confirmar as operações ativas, o botão não aparece', () => {
    renderCard({ asset: ASSET, latestSignal: RF4H(), tradeOpsUnavailable: true });
    expect(simButton()).toBeNull();
  });

  it('REGRESSÃO (review do PR-C): aviso arquivado não oferece simulação', () => {
    renderCard({ asset: ASSET, latestSignal: RF4H({ is_dismissed: true }) });
    expect(simButton()).toBeNull();
  });

  it('REGRESSÃO (review do PR-C): o motor já abriu a operação deste aviso → não simula', async () => {
    tradeOpGetMock.mockImplementation(async (id) => (id === 'trade_dk1' ? { id, status: 'STOP_HIT' } : null));
    renderCard({ asset: ASSET, latestSignal: RF4H({ dedup_key: 'dk1' }) });
    fireEvent.click(simButton());
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByText('Simular COMPRA'));
    await waitFor(() => expect(toastMock).toHaveBeenCalled());
    expect(activateSignalManuallyMock).not.toHaveBeenCalled();
    expect(toastMock.mock.calls[0][0].description).toMatch(/motor já abriu/);
  });

  it('REGRESSÃO (review do PR-C): prazo vencido com o diálogo aberto → não simula', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.parse('2026-10-18T12:00:00Z'));
      const sig = RF4H({ created_date: '2026-10-18T08:30:00Z' }); // 3h30 de idade: ainda no prazo
      // last_scan_at relativo ao relógio falso (senão o cartão acha o dado atrasado).
      renderCard({ asset: { ...ASSET, last_scan_at: '2026-10-18T11:58:00Z' }, latestSignal: sig });
      fireEvent.click(simButton());
      const dialog = await screen.findByRole('alertdialog');
      vi.setSystemTime(Date.parse('2026-10-18T12:45:00Z')); // passou das 4h
      fireEvent.click(within(dialog).getByText('Simular COMPRA'));
      await waitFor(() => expect(toastMock).toHaveBeenCalled());
      expect(activateSignalManuallyMock).not.toHaveBeenCalled();
      expect(toastMock.mock.calls[0][0].description).toMatch(/prazo deste aviso terminou/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('aviso já simulado: não chama o motor e avisa por toast', async () => {
    tradeOpGetMock.mockImplementation(async (id) => (id === 'trade_manual_sig1' ? { id, status: 'STOP_HIT' } : null));
    renderCard({ asset: ASSET, latestSignal: RF4H() });
    fireEvent.click(simButton());
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByText('Simular COMPRA'));
    await waitFor(() => expect(toastMock).toHaveBeenCalled());
    expect(tradeOpGetMock).toHaveBeenCalledWith('trade_manual_sig1');
    expect(activateSignalManuallyMock).not.toHaveBeenCalled();
    expect(toastMock.mock.calls[0][0].description).toMatch(/já foi simulado/);
  });

  it('falha do motor vira toast, nunca window.alert', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    activateSignalManuallyMock.mockResolvedValue({ created: false, reason: 'no_4h_atr' });
    renderCard({ asset: ASSET, latestSignal: RF4H() });
    fireEvent.click(simButton());
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByText('Simular COMPRA'));
    await waitFor(() => expect(toastMock).toHaveBeenCalled());
    expect(toastMock.mock.calls[0][0]).toMatchObject({ variant: 'destructive' });
    expect(toastMock.mock.calls[0][0].description).toMatch(/ATR/);
    expect(alertSpy).not.toHaveBeenCalled();
    alertSpy.mockRestore();
  });

  it('sucesso: toast confirma que é virtual', async () => {
    renderCard({ asset: ASSET, latestSignal: RF4H() });
    fireEvent.click(simButton());
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByText('Simular COMPRA'));
    await waitFor(() => expect(toastMock).toHaveBeenCalled());
    expect(toastMock.mock.calls[0][0].description).toMatch(/nenhuma ordem/i);
  });
});


// Item 279 (PR-D): preço e variação de 24h vêm da MESMA resposta do ticker da
// Futures, com rótulo; o fechamento da vela aparece à parte, identificado.
describe('AssetCard — preço e "📈 +x% em 24h · Futures" do mesmo instante (item 279)', () => {
  const STATE_1H = { timeframe: '1h', last_close: 100, last_candle_time: '2026-10-18T12:00:00.000Z' };

  it('com ticker: preço do ticker, % rotulada e fechamento da vela à parte', async () => {
    fetch24hStatsMock.mockResolvedValue({ lastPrice: 102.5, priceChangePercent: 2.1, closeTime: Date.now() });
    renderCard({ asset: { id: 'a1', symbol: 'BTCUSDT', display_name: 'BTC/USDT' }, states: [STATE_1H] });
    await screen.findByText('📈 +2.10% em 24h · Futures');
    screen.getByText('$102.50');
    screen.getByText(/Fech\. 1h \$100/);
  });

  it('queda usa 📉', async () => {
    fetch24hStatsMock.mockResolvedValue({ lastPrice: 99, priceChangePercent: -0.5, closeTime: Date.now() });
    renderCard({ asset: { id: 'a1', symbol: 'BTCUSDT', display_name: 'BTC/USDT' }, states: [STATE_1H] });
    await screen.findByText('📉 -0.50% em 24h · Futures');
  });

  it('REGRESSÃO (review do PR-D): ticker velho não substitui o fechamento da vela', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    try {
      vi.setSystemTime(Date.parse('2026-10-18T12:00:00Z'));
      fetch24hStatsMock.mockResolvedValueOnce({ lastPrice: 102.5, priceChangePercent: 2.1, closeTime: Date.now() });
      // As buscas seguintes falham — o dado em cache fica de verdade velho.
      fetch24hStatsMock.mockRejectedValue(new Error('rede'));
      renderCard({ asset: { id: 'a1', symbol: 'BTCUSDT', display_name: 'BTC/USDT' }, states: [STATE_1H] });
      await vi.waitFor(() => screen.getByText('$102.50'));
      await act(async () => { vi.advanceTimersByTime(5 * 60_000); });
      await vi.waitFor(() => screen.getByText('% 24h desatualizado'));
      screen.getByText(/fech\. 1h/); // o preço agora é o fechamento da vela, marcado
      expect(screen.queryByText('$102.50')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ticker falhou: mostra o fechamento da vela e "% 24h indisponível" (nunca some, nunca NaN)', async () => {
    fetch24hStatsMock.mockRejectedValue(new Error('rede'));
    renderCard({ asset: { id: 'a1', symbol: 'BTCUSDT', display_name: 'BTC/USDT' }, states: [STATE_1H] });
    await screen.findByText('% 24h indisponível');
    screen.getByText(/fech\. 1h/);
    expect(screen.queryByText(/NaN/)).toBeNull();
  });
});
