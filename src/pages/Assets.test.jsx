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
import { screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { renderPage } from './__fixtures__/renderPage.jsx';
import Assets from './Assets.jsx';

const monitoredAssetListMock = vi.fn();
const monitoredAssetUpdateMock = vi.fn();
const monitoredAssetDeleteMock = vi.fn();
const assetStateDeleteManyMock = vi.fn();

vi.mock('@/api/entities', () => ({
  backend: {
    entities: {
      MonitoredAsset: {
        list: (...args) => monitoredAssetListMock(...args),
        update: (...args) => monitoredAssetUpdateMock(...args),
        delete: (...args) => monitoredAssetDeleteMock(...args),
      },
      AssetState: { list: async () => [], deleteMany: (...args) => assetStateDeleteManyMock(...args) },
      SignalEvent: { list: async () => [] },
      TradeOperation: { list: async () => [] },
    },
  },
}));

afterEach(() => {
  cleanup();
  monitoredAssetListMock.mockReset();
  monitoredAssetUpdateMock.mockReset();
  monitoredAssetDeleteMock.mockReset();
  assetStateDeleteManyMock.mockReset();
});

const OLD_70MIN = () => new Date(Date.now() - 70 * 60000).toISOString();
const RECENT_5MIN = () => new Date(Date.now() - 5 * 60000).toISOString();

describe('Assets — badge 📡 reflete o dead-man\'s-switch real (achado A-9, item 277)', () => {
  it('mostra atualizado, atrasado, falha e sem leitura corretamente por ativo, na mesma lista', async () => {
    monitoredAssetListMock.mockResolvedValue([
      { id: 'a1', symbol: 'BTCUSDT', display_name: 'BTC/USDT', is_active: true, last_scan_at: RECENT_5MIN() },
      { id: 'a2', symbol: 'ETHUSDT', display_name: 'ETH/USDT', is_active: true, last_scan_at: OLD_70MIN() },
      { id: 'a3', symbol: 'SOLUSDT', display_name: 'SOL/USDT', is_active: true, last_scan_at: RECENT_5MIN(), scan_error_since: OLD_70MIN() },
      { id: 'a4', symbol: 'XRPUSDT', display_name: 'XRP/USDT', is_active: true },
    ]);

    renderPage(<Assets />);

    await screen.findByText('BTC/USDT');
    screen.getByText('📡 Atualizado há 5 min');
    screen.getByText(/^📡 Atrasado/);
    screen.getByText(/^📡 Falha de leitura/);
    screen.getByText('📡 Sem leitura'); // nunca lido: antes aparecia "LIVE"
    expect(screen.queryByText('LIVE')).toBeNull();
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

// Achado da varredura pós-Raio-X (2026-09-27): o toggle ativo/inativo e o
// botão "Remover" não davam nenhum feedback visual durante a mutação —
// mesmo padrão já usado em Trades.jsx/Alerts.jsx (disabled={mutation.isPending}).
describe('Assets — toggle e "Remover" ficam desabilitados durante a mutação (achado pós-Raio-X)', () => {
  it('REGRESSÃO: o Switch fica disabled enquanto toggleMutation está pendente', async () => {
    monitoredAssetListMock.mockResolvedValue([
      { id: 'a1', symbol: 'BTCUSDT', display_name: 'BTC/USDT', is_active: true, last_scan_at: RECENT_5MIN() },
    ]);
    let resolveUpdate;
    monitoredAssetUpdateMock.mockImplementation(() => new Promise((res) => { resolveUpdate = res; }));

    renderPage(<Assets />);
    await screen.findByText('BTC/USDT');
    const toggle = screen.getByRole('switch');
    expect(toggle.getAttribute('aria-disabled')).not.toBe('true');

    fireEvent.click(toggle);
    await waitFor(() => expect(monitoredAssetUpdateMock).toHaveBeenCalled());
    expect(toggle.getAttribute('data-disabled')).toBe('');

    resolveUpdate({});
    await waitFor(() => expect(toggle.getAttribute('data-disabled')).toBeNull());
  });

  it('REGRESSÃO: o botão "Remover" fica disabled enquanto deleteMutation está pendente', async () => {
    monitoredAssetListMock.mockResolvedValue([
      { id: 'a1', symbol: 'BTCUSDT', display_name: 'BTC/USDT', is_active: true, last_scan_at: RECENT_5MIN() },
    ]);
    let resolveDelete;
    monitoredAssetDeleteMock.mockImplementation(() => new Promise((res) => { resolveDelete = res; }));
    assetStateDeleteManyMock.mockResolvedValue(undefined);

    const { container } = renderPage(<Assets />);
    await screen.findByText('BTC/USDT');
    const removeBtn = container.querySelector('button svg.lucide-trash2')?.closest('button');
    expect(removeBtn).not.toBeNull();

    fireEvent.click(removeBtn);
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByText('Remover'));
    await waitFor(() => expect(monitoredAssetDeleteMock).toHaveBeenCalledWith('a1'));
    expect(removeBtn.disabled).toBe(true);

    resolveDelete({});
    await waitFor(() => expect(removeBtn.disabled).toBe(false));
  });

  // Achado da varredura pós-Raio-X, Round 2 (2026-09-27): confirm() nativo
  // quebrava o tema escuro — migrado pro AlertDialog já existente e nunca
  // usado (src/components/ui/alert-dialog.jsx).
  it('REGRESSÃO: "Remover" abre AlertDialog explicando preservação de histórico; Cancelar não chama a mutação', async () => {
    monitoredAssetListMock.mockResolvedValue([
      { id: 'a1', symbol: 'BTCUSDT', display_name: 'BTC/USDT', is_active: true, last_scan_at: RECENT_5MIN() },
    ]);

    const { container } = renderPage(<Assets />);
    await screen.findByText('BTC/USDT');
    const removeBtn = container.querySelector('button svg.lucide-trash2')?.closest('button');

    fireEvent.click(removeBtn);
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/preservados/)).toBeTruthy();

    fireEvent.click(within(dialog).getByText('Cancelar'));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(monitoredAssetDeleteMock).not.toHaveBeenCalled();
  });
});

// 21/11/2026 — Ativos refeito (estrutura, não só cor): contagens numa linha, filtros em abas ligadas e cada ativo como linha de TABELA
// com colunas fixas (Ativo · Gráficos · Indicadores · Leitura e último scan · ações). Os textos e botões de sempre continuam lá.
describe('Assets — estrutura nova (21/11/2026)', () => {
  const ATIVOS = [
    { id: 'a1', symbol: 'BTCUSDT', display_name: 'BTC/USDT', is_active: true, last_scan_at: RECENT_5MIN() },
    { id: 'a2', symbol: 'ETHUSDT', display_name: 'ETH/USDT', is_active: false, last_scan_at: RECENT_5MIN(), scan_status: 'error', scan_error: 'falha simulada' },
  ];
  async function abrir(lista = ATIVOS) {
    monitoredAssetListMock.mockResolvedValue(lista);
    const r = renderPage(<Assets />);
    await screen.findByText('BTC/USDT');
    return r;
  }

  it('as contagens são uma linha só (Total · Ativos · Inativos · Erros), sem os 4 cartões com ícone', async () => {
    await abrir();
    const total = screen.getByText('Total');
    const linha = total.parentElement.parentElement;
    for (const rotulo of ['Total', 'Ativos', 'Inativos', 'Erros']) expect(within(linha).getAllByText(rotulo).length).toBeGreaterThan(0);
    expect(linha.querySelector('svg')).toBeNull();
    expect(within(total.parentElement).getByText('2')).toBeTruthy();
  });

  it('os filtros são abas ligadas dentro de um painel com a busca', async () => {
    await abrir();
    const todos = screen.getByRole('button', { name: 'Todos' });
    const inativos = screen.getByRole('button', { name: /Inativos/ });
    expect(todos.parentElement).toBe(inativos.parentElement);
    expect(todos.parentElement.className).toMatch(/rounded-md/);
    fireEvent.click(inativos);
    await waitFor(() => expect(screen.queryByText('BTC/USDT')).toBeNull());
    expect(screen.getByText('ETH/USDT')).toBeTruthy();
  });

  it('há um cabeçalho de colunas (tela larga) e cada ativo usa a mesma grade de colunas', async () => {
    const { container } = await abrir();
    const cab = screen.getByText('Leitura e último scan').parentElement;
    expect(cab.getAttribute('aria-hidden')).toBe('true');
    expect(cab.className).toMatch(/lg:grid-cols-\[/);
    const linhas = container.querySelectorAll('div[class*="lg:grid-cols-["]');
    // cabeçalho + 1 grade por ativo
    expect(linhas.length).toBe(1 + ATIVOS.length);
    const modelo = cab.className.match(/lg:grid-cols-\[[^\]]+\]/)[0];
    linhas.forEach((el) => expect(el.className).toContain(modelo));
  });

  it('o erro do último scan aparece inteiro (quebra a linha, em vez de cortar com reticências)', async () => {
    await abrir();
    const erro = screen.getByText(/falha simulada/);
    expect(erro.className).not.toMatch(/truncate/);
    expect(erro.className).toMatch(/break-words/);
  });
});
