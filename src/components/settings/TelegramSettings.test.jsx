// @vitest-environment jsdom
//
// Achado A-7 do Raio-X de UI/UX (varredura fresca, docs/known-risks.md item
// 214, 5ª sub-rodada): era um modal caseiro (2 <div> fixos) sem
// role="dialog"/aria-modal, sem focus-trap nem Escape. Migrado pro Dialog do
// Radix (mesmo componente já usado em Trades.jsx, achado A-12) — o corpo
// (instruções + campos + filtros avançados) ganhou um wrapper
// max-h-[70vh]/overflow-y-auto interno (mesmo padrão de
// AssetConfigPanel.jsx), já que com os filtros avançados abertos o conteúdo
// facilmente passa da altura da viewport e o DialogContent do Radix não
// trata isso sozinho. Componente não tinha teste dedicado antes.
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import TelegramSettings from './TelegramSettings.jsx';
import { getTelegramFilters } from '@/lib/telegram';

// telegram.js importa @/lib/firebaseClient de forma transitiva (usado só
// pelas funções notify*/setTelegramFilters, não exercitadas aqui) — sem o
// mock, initializeAuth quebra em ambiente de teste por falta de config real.
vi.mock('@/lib/firebaseClient', () => ({ db: {}, auth: {}, rtdb: null, app: {} }));

afterEach(() => {
  cleanup();
  localStorage.clear();
});

// Achado M-17 (item 230): MultiToggle passou a usar Tooltip do Radix, que
// exige um TooltipProvider ancestor (em produção vem de App.jsx) — sem ele
// aqui, o Radix lança "Tooltip must be used within TooltipProvider".
function renderModal(props) {
  return render(
    <TooltipProvider>
      <TelegramSettings open onClose={vi.fn()} {...props} />
    </TooltipProvider>,
  );
}

describe('TelegramSettings — modal acessível via Radix Dialog (achado A-7)', () => {
  it('REGRESSÃO: tem role="dialog" (era um <div> fixo sem semântica de modal)', async () => {
    renderModal();
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  it('REGRESSÃO: Escape fecha o modal (focus-trap/Escape vêm de graça do Radix)', async () => {
    const onClose = vi.fn();
    renderModal({ onClose });
    const dialog = await screen.findByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('não renderiza nada quando open=false', () => {
    renderModal({ open: false });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('REGRESSÃO: "Filtros Avançados" expandido ainda deixa o corpo dentro de um wrapper rolável', async () => {
    renderModal();
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByText(/Filtros Avançados de Notificação/));
    await screen.findByText(/TIMEFRAMES A MONITORAR/);
    const scrollArea = screen.getByText(/TIMEFRAMES A MONITORAR/).closest('.overflow-y-auto');
    expect(scrollArea).not.toBeNull();
  });
});

// Achado M-17 do Raio-X de UI/UX (docs/known-risks.md item 230): as opções
// RF/SMC/MACD/RSI/EMA Cross de "Origem do sinal" eram siglas "nuas" — sem
// tooltip explicando o termo. Fix em MultiToggle.jsx (campo `tooltip`
// opcional por opção), reusado aqui e em AssetConfigPanel.jsx.
describe('TelegramSettings — badges de "Origem do sinal" têm tooltip explicando o termo (achado M-17)', () => {
  it('REGRESSÃO: RF/SMC/MACD/EMA Cross/RSI são focáveis (têm tooltip); TF/BUY/SELL continuam sem', async () => {
    renderModal();
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByText(/Filtros Avançados de Notificação/));
    await screen.findByText(/ORIGEM DO SINAL/);

    for (const label of ['RF', 'SMC', 'MACD', 'EMA Cross', 'RSI']) {
      const btn = screen.getByText(label).closest('button');
      expect(btn?.getAttribute('tabindex')).toBe('0');
    }
    // Timeframes (1H/4H/1D) e tipos de sinal (BUY/SELL) não são termos do
    // glossário — não deveriam ganhar o wrapper de tooltip.
    expect(screen.getByText('1H').closest('button')?.getAttribute('tabindex')).toBeNull();
  });
});

// Auditoria do Telegram (2026-09-29), item 1.1/1.8 — verification_task_created
// já vinha ligado por padrão em DEFAULT_FILTERS.events (src/lib/telegram.js),
// mas não tinha toggle visível nesta tela: o usuário não conseguia ver nem
// desligar um evento que o motor já disparava. Este teste-guarda garante que
// TODO evento presente em DEFAULT_FILTERS.events tem um rótulo reconhecível
// renderizado em EVENT_OPTIONS — se um evento novo for adicionado só do lado
// do motor (telegram.js) sem entrada correspondente aqui, ele falha, em vez
// de o bug ficar invisível até alguém notar manualmente.
describe('TelegramSettings — todo evento de DEFAULT_FILTERS.events tem um toggle visível (Auditoria do Telegram, item 1.1/1.8)', () => {
  const EXPECTED_LABELS = {
    signal_detected: 'Novo sinal detectado',
    entry_confirmed: 'Entrada confirmada',
    tp1_hit: 'TP1 atingido',
    tp2_hit: 'TP2 atingido',
    stop_hit: 'Stop atingido',
    invalidated: 'Sinal invalidado',
    time_stop: 'Time Stop',
    chop_exit: 'Chop Exit',
    verification_task_created: 'Tarefa de verificação criada',
  };

  it('renderiza um toggle com rótulo reconhecível para cada evento ligado por padrão', async () => {
    renderModal();
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByText(/Filtros Avançados de Notificação/));
    await screen.findByText(/EVENTOS PARA NOTIFICAR/);

    const filters = getTelegramFilters();
    expect(filters.events.length).toBeGreaterThan(0);
    for (const eventId of filters.events) {
      const label = EXPECTED_LABELS[eventId];
      expect(
        label,
        `evento "${eventId}" está em DEFAULT_FILTERS.events (src/lib/telegram.js) mas não tem rótulo esperado neste teste — adicione-o a EXPECTED_LABELS e confirme que existe uma entrada correspondente em EVENT_OPTIONS (TelegramSettings.jsx)`
      ).toBeTruthy();
      expect(screen.getByText(new RegExp(label))).toBeTruthy();
    }
  });
});
