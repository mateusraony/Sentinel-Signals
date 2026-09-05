/**
 * Harness de smoke test de página (docs/known-risks.md item 166, Fase 1).
 *
 * ## Por que isto existe
 *
 * A cobertura medida pela primeira vez neste projeto deu **0,0% em
 * `src/pages`, `src/components` e `src/hooks`** — 63 arquivos, 2.439 linhas,
 * nenhuma linha jamais executada por um teste. O motor está entre 86% e 99%.
 *
 * O custo disso já foi cobrado: no item 157 uma variável indefinida chegou em
 * produção e quebrou `/trades` inteira. `lint`, `test` e `build` passaram
 * verdes — o build do Vite não faz análise de escopo, e não havia UM teste que
 * renderizasse a página. O `no-undef` fechou aquele caso específico; isto
 * fecha a CLASSE: qualquer erro que só aparece quando o componente roda.
 *
 * ## O que este harness assume, e por quê é barato
 *
 * Uma página só precisa de mock em UM lugar: `@/api/entities`. É o dividendo
 * do adaptador (`.claude/rules/frontend-ui.md` — "dados via TanStack Query e o
 * adaptador `backend`, nunca Firestore direto no componente"). Se um dia uma
 * página furar essa regra e importar `firebase/firestore` direto, o teste dela
 * quebra aqui — o que é a informação certa, não um incômodo.
 *
 * **Não é teste de comportamento.** Só responde "renderiza sem explodir com
 * dados vazios?". Asserção de conteúdo é outro tipo de teste, por página, e
 * vale a pena só onde a lógica de exibição for de fato complicada.
 */
import React from 'react';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { TooltipProvider } from '@/components/ui/tooltip';

/**
 * Um `QueryClient` novo por teste, sem retry e sem cache.
 *
 * `retry: false` é o que impede um erro de query de virar timeout de teste; um
 * cliente NOVO por teste é o que impede um teste de enxergar o cache do
 * anterior e passar por acidente.
 */
export function makeTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
}

/** Envolve nos MESMOS provedores que `App.jsx` usa de verdade. */
export function renderPage(ui, { route = '/' } = {}) {
  const client = makeTestQueryClient();
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

const AGORA = '2026-09-05T12:00:00.000Z';
const HA_2H = '2026-09-05T10:00:00.000Z';

/**
 * Uma linha plausível por entidade.
 *
 * **Isto não é enfeite — é o que dá valor ao smoke test.** A primeira versão
 * deste harness só devolvia `[]`, e um teste de reintrodução provou que ela
 * NÃO pegava o bug do item 157: `MonitoringCard` só renderiza quando existe
 * sinal, então o caminho quebrado nunca era exercitado. Era exatamente o
 * motivo de o bug ter chegado em produção — e o teste repetia o mesmo ponto
 * cego com outra roupa.
 *
 * Os campos são mínimos mas realistas (schemas em `docs/schema-reference/`):
 * o suficiente para o componente percorrer o caminho de exibição de verdade.
 */
export const LINHAS_EXEMPLO = {
  MonitoredAsset: [{
    id: 'a1', symbol: 'BTCUSDT', is_active: true, smc_enabled: false,
    rf_period: 20, rf_multiplier: 3.5, created_date: HA_2H,
  }],
  AssetState: [{
    id: 's1', asset_id: 'a1', symbol: 'BTCUSDT', timeframe: '4h',
    rf_direction: 1, rf_value: 60000, last_price: 61000, last_scan_at: AGORA,
    rsi: 55, adx: 28, chop: 40, tier: 'T2', created_date: HA_2H,
  }],
  SignalEvent: [{
    id: 'e1', asset_id: 'a1', symbol: 'BTCUSDT', timeframe: '4h',
    signal_type: 'BUY', source: 'range_filter', dedup_key: 'e1',
    price_at_signal: 60000, candle_time: HA_2H, created_date: HA_2H,
    notified: true, context: { score: 75, rf_value: 60000 },
    // Cobre o caminho do item 163 (motivo + detalhe + horário da recusa).
    last_rejection_reason: 'regime_rejected',
    last_rejection_detail: 'chop',
    last_rejection_at: HA_2H,
  }],
  TradeOperation: [{
    id: 'op1', asset_id: 'a1', symbol: 'BTCUSDT', side: 'BUY',
    status: 'RUNNER_ACTIVE', entry_price: 60000, initial_stop: 59000,
    current_stop: 60500, tp1: 61000, tp2: 62000, tp1_hit: true,
    tp1_hit_at: HA_2H, tp1_hit_real_time: HA_2H, partial_percent: 50,
    cascade: '4h_15m', tier: 'T2', created_date: HA_2H,
    candle_close_time: HA_2H, entry_candle_time_15m: HA_2H,
  }, {
    id: 'op2', asset_id: 'a1', symbol: 'ETHUSDT', side: 'SELL',
    status: 'STOP_HIT', entry_price: 3000, initial_stop: 3100,
    current_stop: 3100, tp1: 2900, tp2: 2800, exit_price: 3100,
    stop_hit_at: AGORA, stop_hit_real_time: AGORA, closed_at: AGORA,
    partial_percent: 50, cascade: '4h_15m', created_date: HA_2H,
  }],
  PriceAlert: [{ id: 'p1', asset_id: 'a1', symbol: 'BTCUSDT', target_price: 65000, direction: 'above', is_active: true, created_date: HA_2H }],
  SystemLog: [{ id: 'l1', level: 'error', module: 'scanner', message: 'BTCUSDT falhou', symbol: 'BTCUSDT', created_date: HA_2H }],
  User: [{ id: 'u1', role: 'admin' }],
  StrategyConfig: [{ id: 'current', tp1R: 1.5, tp2R: 3 }],
  TelegramFilters: [{ id: 'current', sources: ['range_filter'] }],
  VerificationTask: [{ id: 'v1', asset_id: 'a1', symbol: 'BTCUSDT', timeframe: '4h', status: 'pending', priority: 'high', created_date: HA_2H }],
};

/**
 * O adaptador `backend` inteiro, em memória.
 *
 * `{ populated: false }` (padrão) devolve tudo vazio — **a lista vazia é o
 * estado que mais quebra na prática** (primeiro carregamento, filtro sem
 * resultado, usuário novo) e o que ninguém testa à mão: exercita todo `.map`,
 * `[0]`, `.reduce` e divisão por `length`.
 *
 * `{ populated: true }` devolve `LINHAS_EXEMPLO` — o caminho de exibição de
 * verdade. **As duas variantes são necessárias**: sozinha, a vazia deixa
 * passar exatamente a classe de bug do item 157.
 */
export function makeFakeBackendModule({ populated = false } = {}) {
  const entidade = (nome) => {
    const linhas = populated ? (LINHAS_EXEMPLO[nome] ?? []) : [];
    return {
      list: async () => linhas,
      filter: async () => linhas,
      get: async () => linhas[0] ?? null,
      create: async (d) => ({ id: 'fake', ...d }),
      update: async (id, d) => ({ id, ...d }),
      delete: async () => undefined,
      bulkCreate: async () => [],
      deleteMany: async () => [],
      createUnique: async () => null,
    };
  };
  const nomes = Object.keys(LINHAS_EXEMPLO);
  return {
    backend: {
      entities: Object.fromEntries(nomes.map((n) => [n, entidade(n)])),
      agents: { invoke: async () => ({}) },
      locks: { acquireScanLock: async () => true, releaseScanLock: async () => undefined },
      tradeOps: {
        createTradeOpIfNoneActive: async () => ({ created: false, doc: null }),
        clearActiveOp: async () => undefined,
        transitionTradeOp: async () => ({ applied: false, patch: {} }),
      },
      quota: { getAndResetOpCounts: () => ({ reads: 0, writes: 0 }) },
    },
  };
}
