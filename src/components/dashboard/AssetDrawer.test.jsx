// @vitest-environment jsdom
//
// Refinamentos (seção E do Raio-X de UI/UX): a lista "Sinais Recentes" tinha
// campos sem rótulo — timeframe, motivo (reason) e horário relativo
// apareciam nus, sem indicar o que representavam (BUY/SELL e "Confl." já
// eram autoexplicativos, por isso ficaram de fora). Componente não tinha
// teste dedicado antes.
import React from 'react';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, within, act } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { makeTestQueryClient } from '@/pages/__fixtures__/renderPage.jsx';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import AssetDrawer from './AssetDrawer.jsx';

vi.mock('@/lib/firebaseClient', () => ({ db: {}, auth: {}, rtdb: null, app: {} }));

const ASSET = { id: 'a1', symbol: 'BTCUSDT', display_name: 'BTC/USDT', exchange: 'binance' };

const SIGNAL = {
  id: 'sig1', asset_id: 'a1', signal_type: 'BUY', timeframe: '4h',
  price_at_signal: 65000, reason: 'Confluência de RF + estrutura SMC',
  created_date: '2026-09-26T10:00:00.000Z',
};

afterEach(() => cleanup());

function renderDrawer(props) {
  const client = makeTestQueryClient();
  return render(
    <QueryClientProvider client={client}>
      <AssetDrawer
        asset={ASSET}
        signals={[SIGNAL]}
        tradeOps={[]}
        onClose={() => {}}
        {...props}
      />
    </QueryClientProvider>,
  );
}

describe('AssetDrawer — "Sinais Recentes" tem rótulos inline (Refinamentos)', () => {
  it('REGRESSÃO: timeframe, motivo e horário aparecem rotulados, não nus', async () => {
    renderDrawer({});

    await screen.findByText('BTC/USDT');
    expect(screen.getByText('TF')).toBeTruthy();
    expect(screen.getByText(/Motivo:/)).toBeTruthy();
    expect(screen.getByText(/Quando:/)).toBeTruthy();
    // O conteúdo original continua presente, só ganhou o prefixo.
    expect(screen.getByText('4H')).toBeTruthy();
    expect(screen.getByText(/Confluência de RF \+ estrutura SMC/)).toBeTruthy();
  });
});

// Achado da varredura pós-Raio-X, Round 3 (2026-09-27): "Nenhuma operação
// registrada."/"Nenhum sinal registrado." não diziam quando algo apareceria
// — beco sem saída (é uma gaveta por-ativo, sem filtro pra limpar nem outra
// tela pra linkar, então a ação certa é reassurance textual).
describe('AssetDrawer — empty states de Operações/Sinais explicam quando algo vai aparecer (Round 3 pós-Raio-X)', () => {
  it('REGRESSÃO: sem operações, mostra reassurance em vez de só "Nenhuma operação registrada."', async () => {
    renderDrawer({ signals: [], tradeOps: [] });
    await screen.findByText('BTC/USDT');
    expect(screen.getByText(/Nenhuma operação registrada ainda — abre aqui quando o motor confirmar um sinal/)).toBeTruthy();
  });

  it('REGRESSÃO: sem sinais, mostra reassurance em vez de só "Nenhum sinal registrado."', async () => {
    renderDrawer({ signals: [], tradeOps: [] });
    await screen.findByText('BTC/USDT');
    expect(screen.getByText(/Nenhum sinal registrado ainda — aparece aqui quando o scan encontrar uma oportunidade/)).toBeTruthy();
  });
});

// Fase 1, passo 2 (docs/known-risks.md item 256): N1 do Decision Card — estado,
// níveis, ação e frescor REAL no lugar do "LIVE" verde fixo. Tudo vem do
// presenter (`decisionCardPresenter.js`); o drawer não busca nem recalcula nada.
const NOW = Date.parse('2026-10-03T18:00:00.000Z');
const MIN = 60 * 1000;
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

const FRESH_ASSET = { ...ASSET, is_active: true, last_scan_at: iso(5 * MIN) };
const STATE_4H = {
  asset_id: 'a1', timeframe: '4h', last_close: 68200, last_candle_time: '2026-10-03T16:00:00.000Z',
  rf_direction: 1, rsi_zone: 'neutral', macd_histogram: 0.5, trend_ema: 'bullish',
};
const FRESH_SIGNAL = {
  ...SIGNAL, source: 'range_filter', created_date: iso(30 * MIN), context: { score: 82, reasons: [] },
};
const ACTIVE_OP = {
  id: 'op1', asset_id: 'a1', side: 'BUY', timeframe: '15m', signal_timeframe: '4h',
  status: 'RUNNER_ACTIVE', entry_price: 100, initial_stop: 95, current_stop: 100,
  tp1: 105, tp2: 110, rr_at_entry: 1.5, score: 82, created_date: iso(2 * 60 * MIN),
};

function renderN1(props) {
  return renderDrawer({ asset: FRESH_ASSET, signals: [FRESH_SIGNAL], assetStates: [STATE_4H], now: NOW, ...props });
}
const summary = () => within(screen.getByRole('region', { name: 'Resumo da decisão' }));

describe('AssetDrawer N1 — frescor real no lugar do "LIVE" fixo', () => {
  it('REGRESSÃO: ativo sem leitura nunca aparece como LIVE', async () => {
    renderN1({ asset: ASSET });
    await screen.findByText('BTC/USDT');
    expect(screen.getByText('SEM LEITURA')).toBeTruthy();
    expect(screen.queryByText('LIVE')).toBeNull();
  });

  it('ativo com scan recente = LIVE + idade do scan', async () => {
    renderN1();
    await screen.findByText('BTC/USDT');
    expect(screen.getByText('LIVE')).toBeTruthy();
    expect(screen.getByText(/scan há 5 min/)).toBeTruthy();
  });

  it('REGRESSÃO: ativo parado há 45 min = STALE (e não LIVE)', async () => {
    renderN1({ asset: { ...FRESH_ASSET, last_scan_at: iso(45 * MIN) } });
    await screen.findByText('BTC/USDT');
    expect(screen.getByText('STALE')).toBeTruthy();
    expect(screen.queryByText('LIVE')).toBeNull();
  });

  it('erro persistente de leitura = ERRO', async () => {
    renderN1({ asset: { ...FRESH_ASSET, scan_error_since: iso(40 * MIN) } });
    await screen.findByText('BTC/USDT');
    expect(screen.getByText('ERRO')).toBeTruthy();
  });
});

describe('AssetDrawer N1 — sinal sem operação', () => {
  it('mostra o estado derivado, último fechamento, "níveis não definidos" e o score com a ressalva', async () => {
    renderN1();
    await screen.findByText('BTC/USDT');
    const s = summary();
    expect(s.getByText('Aguardando confirmação · BUY')).toBeTruthy();
    expect(s.getByText(/\$68,200\.00/)).toBeTruthy();
    expect(s.getByText(/candle 03\/10 13:00 BRT/)).toBeTruthy();
    expect(s.getByText(/Níveis: ainda não definidos/)).toBeTruthy();
    expect(s.getByText(/Score técnico 82\/100/)).toBeTruthy();
    expect(s.getByText(/não é probabilidade/)).toBeTruthy();
  });

  it('evento informativo (MACD 4h) nunca é "aguardando confirmação"', async () => {
    renderN1({ signals: [{ ...FRESH_SIGNAL, source: 'macd' }] });
    await screen.findByText('BTC/USDT');
    expect(summary().getByText('Só informação · BUY')).toBeTruthy();
    expect(summary().queryByText(/Aguardando/)).toBeNull();
  });

  it('sem sinal nem operação: estado "none" explícito', async () => {
    renderN1({ signals: [], tradeOps: [] });
    await screen.findByText('BTC/USDT');
    expect(summary().getByText('Sem sinal nem operação registrados')).toBeTruthy();
  });

  it('estados do ativo indisponíveis: nunca inventa o último fechamento', async () => {
    renderN1({ assetStates: [], statesUnavailable: true });
    await screen.findByText('BTC/USDT');
    expect(summary().getByText(/Último fechamento: não foi possível carregar agora\./)).toBeTruthy();
  });

  it('sem AssetState (e sem erro): "indisponível", nunca 0', async () => {
    renderN1({ assetStates: [] });
    await screen.findByText('BTC/USDT');
    expect(summary().getByText('Último fechamento: indisponível.')).toBeTruthy();
  });
});

describe('AssetDrawer N1 — operação ativa', () => {
  it('mostra estado, stop (com a postura), entrada, TP1, TP2 e R:R gravados', async () => {
    renderN1({ tradeOps: [ACTIVE_OP] });
    await screen.findByText('BTC/USDT');
    const s = summary();
    expect(s.getByText('Runner ativo (TP1 atingido)')).toBeTruthy();
    for (const label of ['Stop', 'Entrada', 'TP1', 'TP2', 'R:R']) expect(s.getByText(label)).toBeTruthy();
    expect(s.getByText('breakeven')).toBeTruthy();
    expect(s.getByText('1 : 1.5')).toBeTruthy();
    expect(s.getByText('$110.00')).toBeTruthy();
    expect(s.queryByText(/Níveis: ainda não definidos/)).toBeNull();
  });

  it('operação sem TP2 e sem R:R: "—", nunca 0', async () => {
    renderN1({ tradeOps: [{ ...ACTIVE_OP, tp2: undefined, rr_at_entry: undefined }] });
    await screen.findByText('BTC/USDT');
    expect(summary().getAllByText('—').length).toBe(2);
  });
});

describe('AssetDrawer N1 — erro de carregamento é fail-closed (itens 193-196)', () => {
  it('REGRESSÃO: operações indisponíveis + sinal existente NÃO afirma "aguardando confirmação"', async () => {
    renderN1({ tradeOpsUnavailable: true });
    await screen.findByText('BTC/USDT');
    expect(summary().getByText(/Não foi possível carregar as operações agora — por isso/)).toBeTruthy();
    expect(summary().queryByText(/Aguardando/)).toBeNull();
    expect(summary().queryByText(/Score técnico/)).toBeNull();
  });

  it('sinais indisponíveis e nenhuma operação: não afirma "sem sinal"', async () => {
    renderN1({ signals: [], tradeOps: [], signalsUnavailable: true });
    await screen.findByText('BTC/USDT');
    expect(summary().getByText(/Não foi possível carregar os sinais agora — por isso/)).toBeTruthy();
    expect(summary().queryByText('Sem sinal nem operação registrados')).toBeNull();
  });
});

describe('AssetDrawer N1 — layout e pureza', () => {
  it('largura: tela cheia no celular e sm:max-w-md no desktop (antes max-w-sm)', async () => {
    renderN1();
    await screen.findByText('BTC/USDT');
    const cls = screen.getByRole('dialog').className;
    expect(cls).toMatch(/\bw-full\b/);
    expect(cls).toMatch(/sm:max-w-md/);
    expect(cls).not.toMatch(/sm:max-w-sm/);
  });

  it('o drawer não busca dado nem calcula: só props + presenter (sem useQuery/entidades/funding)', () => {
    const src = readFileSync(join(process.cwd(), 'src/components/dashboard/AssetDrawer.jsx'), 'utf8');
    expect(src).not.toMatch(/useQuery|useFundingRate|@\/api\/entities|fetch\(/);
    expect(src).toMatch(/buildDecisionCard/);
  });
});

describe('AssetDrawer — relógio próprio (Codex #461: badge não pode congelar em LIVE)', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it('REGRESSÃO: sem mudar nenhuma prop, o badge passa de LIVE para STALE com o tempo', () => {
    // Sem `now` injetado: o drawer usa o próprio relógio.
    renderDrawer({ asset: FRESH_ASSET, signals: [FRESH_SIGNAL], assetStates: [STATE_4H] });
    expect(screen.getByText('LIVE')).toBeTruthy();
    act(() => { vi.advanceTimersByTime(31 * MIN); });
    expect(screen.getByText('STALE')).toBeTruthy();
    expect(screen.queryByText('LIVE')).toBeNull();
  });

  // React Query/Radix também agendam timers: conta só os intervalos de 30 s do drawer.
  const tickIntervals = (spy) => spy.mock.calls.filter(([, ms]) => ms === 30 * 1000).length;

  it('o intervalo de 30 s é criado e limpo no desmonte', () => {
    const setSpy = vi.spyOn(globalThis, 'setInterval');
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    const { unmount } = renderDrawer({ asset: FRESH_ASSET, signals: [FRESH_SIGNAL], assetStates: [STATE_4H] });
    expect(tickIntervals(setSpy)).toBe(1);
    const id = setSpy.mock.results.find((_, k) => setSpy.mock.calls[k][1] === 30 * 1000).value;
    unmount();
    expect(clearSpy).toHaveBeenCalledWith(id);
  });

  it('com `now` injetado não cria intervalo', () => {
    const setSpy = vi.spyOn(globalThis, 'setInterval');
    renderDrawer({ asset: FRESH_ASSET, signals: [FRESH_SIGNAL], assetStates: [STATE_4H], now: NOW });
    expect(tickIntervals(setSpy)).toBe(0);
  });

  it('operações carregando: mensagem discreta, nunca "Aguardando confirmação"', () => {
    renderDrawer({ asset: FRESH_ASSET, signals: [FRESH_SIGNAL], assetStates: [STATE_4H], now: NOW, tradeOpsLoading: true });
    expect(summary().getByRole('status').textContent).toBe('Carregando operações…');
    expect(summary().queryByText(/Aguardando/)).toBeNull();
  });
});
