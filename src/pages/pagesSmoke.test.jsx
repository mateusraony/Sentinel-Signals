/**
 * @vitest-environment jsdom
 *
 * Smoke test de TODA página (docs/known-risks.md item 166, Fase 1).
 *
 * A pergunta que ele responde é uma só: **a página renderiza sem explodir?**
 *
 * Motivo concreto: no item 157 uma variável indefinida (`showInfoSignals`)
 * chegou em produção e derrubou `/trades` inteira. `npm run lint`,
 * `npm test` e `npm run build` passaram VERDES — o build do Vite não faz
 * análise de escopo, e não existia um único teste que renderizasse a página.
 * O `no-undef` fechou aquele caso; este arquivo fecha a classe.
 *
 * Cobertura medida antes deste arquivo: **0,0%** em `src/pages`,
 * `src/components` e `src/hooks` — 63 arquivos, 2.439 linhas, zero linhas
 * executadas.
 *
 * ## As três escolhas que fazem isto valer a pena
 *
 * **1. Dados vazios.** É o estado que mais quebra na vida real (primeiro
 * carregamento, filtro sem resultado) e o que ninguém testa à mão — exercita
 * todo `.map`, `[0]`, `.reduce` e divisão por `length`.
 *
 * **2. Dados presentes.** A primeira versão deste arquivo só tinha a variante
 * vazia, e um teste de reintrodução PROVOU que ela não pegava o bug do item
 * 157: `MonitoringCard` só renderiza quando existe sinal, então o caminho
 * quebrado nunca era exercitado — o mesmo ponto cego que deixou o bug chegar
 * em produção, repetido com outra roupa. Com as duas variantes, a
 * reintrodução falha 2 testes. Medido, não suposto.
 *
 * **3. Falha explícita em erro de console.** Renderizar sem lançar não basta:
 * o React captura muita coisa e segue em frente com um `console.error`. Sem
 * esta trava, uma página meio quebrada passaria verde.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderPage } from './__fixtures__/renderPage.jsx';

// Um mock só cobre TODO o acesso a dados — o dividendo do adaptador `backend`
// (`.claude/rules/frontend-ui.md`). Uma página que importe Firestore direto
// quebra aqui, que é a informação certa.
// DUAS variantes do mesmo mock, trocadas por `vi.hoisted` + um sinalizador de
// módulo. Ver o bloco "As duas escolhas" acima: sozinha, a vazia deixa passar
// a classe de bug do item 157 — provado por reintrodução.
const estado = vi.hoisted(() => ({ populated: false }));
vi.mock('@/api/entities', async () => {
  const { makeFakeBackendModule } = await import('./__fixtures__/renderPage.jsx');
  return { get backend() { return makeFakeBackendModule({ populated: estado.populated }).backend; } };
});
vi.mock('@/api/rtdbEntities', async () => {
  const { makeFakeBackendModule } = await import('./__fixtures__/renderPage.jsx');
  return { get rtdbEntities() { return makeFakeBackendModule({ populated: estado.populated }).backend.entities; } };
});
vi.mock('@/lib/firebaseClient', () => ({ db: {}, auth: {}, rtdb: null, app: {} }));
vi.mock('@/lib/AuthContext', () => ({
  AuthProvider: ({ children }) => children,
  useAuth: () => ({ user: { uid: 'teste' }, role: 'admin', loading: false }),
}));
// Rede: nenhuma página pode depender da Binance para renderizar.
vi.mock('@/lib/marketDataProvider', () => ({
  fetchCandles: async () => [],
  fetchCurrentPrice: async () => null,
  fetch24hStats: async () => null,
  MARKET_SOURCE: 'spot',
  DATA_EXCHANGE: 'binance',
  EXECUTOR: 'browser',
}));

const PAGINAS = [
  ['Dashboard', () => import('./Dashboard.jsx')],
  ['Trades', () => import('./Trades.jsx')],
  ['TradeHistory', () => import('./TradeHistory.jsx')],
  ['Assets', () => import('./Assets.jsx')],
  ['Alerts', () => import('./Alerts.jsx')],
  ['Logs', () => import('./Logs.jsx')],
  ['Settings', () => import('./Settings.jsx')],
  ['Verification', () => import('./Verification.jsx')],
  ['MonthlyReport', () => import('./MonthlyReport.jsx')],
  ['PineScript', () => import('./PineScript.jsx')],
  ['Backtest', () => import('./Backtest.jsx')],
  ['StrategyReviewer', () => import('./StrategyReviewer.jsx')],
  ['Login', () => import('./Login.jsx')],
];

let erros;
let spyErro;

beforeEach(() => {
  erros = [];
  spyErro = vi.spyOn(console, 'error').mockImplementation((...args) => { erros.push(args.join(' ')); });
  // jsdom não implementa matchMedia nem ResizeObserver, e vários componentes
  // (shadcn/recharts) contam com eles. Ausência aqui produziria uma falha que
  // não diz nada sobre a página.
  window.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
});

afterEach(() => {
  spyErro?.mockRestore();
  vi.clearAllMocks();
});

describe.each([
  ['vazio', false],
  ['com dados', true],
])('smoke de renderização — %s', (rotulo, populated) => {
  beforeEach(() => { estado.populated = populated; });

  it.each(PAGINAS)(`%s renderiza sem lançar (${rotulo})`, async (nome, importar) => {
    const mod = await importar();
    const Pagina = mod.default ?? mod[nome];
    expect(Pagina, `${nome} não exporta um componente`).toBeTypeOf('function');

    expect(() => renderPage(<Pagina />)).not.toThrow();
  });

  it.each(PAGINAS)(`%s não registra erro de console (${rotulo})`, async (nome, importar) => {
    const mod = await importar();
    const Pagina = mod.default ?? mod[nome];
    renderPage(<Pagina />);
    // Espera o efeito das queries assentar — sem isso, a página é julgada
    // ainda em "carregando", que é o caminho MENOS interessante.
    await new Promise((r) => setTimeout(r, 0));

    // React engole erro de render e segue com console.error — sem esta trava,
    // uma página meio quebrada passaria verde.
    const relevantes = erros.filter((e) => !/not wrapped in act|useLayoutEffect does nothing on the server/i.test(e));
    expect(relevantes, `${nome} logou erro:\n${relevantes.join('\n---\n')}`).toEqual([]);
  });
});
