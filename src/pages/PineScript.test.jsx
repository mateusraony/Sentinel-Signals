// @vitest-environment jsdom
//
// Achado A-4 do Raio-X de UI/UX (docs/claude/ui-audit-criticos.md): a aba
// "Sincronização" mostrava números LITERAIS chumbados na criação do
// arquivo ("padrão 20 / 3.5", "mínimo 75 para entrar", TP1 "* 1.5", Time
// Stop "48/64/96") — nunca lia `parsedConfig`, o mesmo state que a aba
// "Editor" já usa corretamente. Editar e salvar o Pine Script atualizava o
// Editor mas a Sincronização ficava presa aos valores originais pra
// sempre. Este teste prova o fix: com um `parsedConfig` diferente do
// default, a aba Sincronização mostra os valores CUSTOM, não os antigos.
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { renderPage } from './__fixtures__/renderPage.jsx';
import PineScript from './PineScript.jsx';

const CUSTOM_CONFIG = {
  rng_per: 15, rng_qty: 2.1, minScore: 82,
  tp1R: 1.8, tp1QtyPercent: 50, trailAtrMult: 2.0,
  tier2Threshold: 0.6, tier3Threshold: 1.5,
  timeStopT1: 30, timeStopT2: 50, timeStopT3: 70,
};

vi.mock('@/lib/pineParser', () => ({
  getLocalPineConfig: () => CUSTOM_CONFIG,
  getPineConfig: async () => CUSTOM_CONFIG,
  savePineConfig: vi.fn(() => CUSTOM_CONFIG),
  syncPineToAssets: vi.fn(async () => 0),
}));

vi.mock('@/api/entities', () => ({
  backend: { entities: { MonitoredAsset: { list: vi.fn(async () => []) } } },
}));

afterEach(() => cleanup());

async function openSyncTab() {
  fireEvent.click(await screen.findByRole('tab', { name: /Sincronização/i }));
}

describe('PineScript — aba Sincronização reflete parsedConfig (achado A-4)', () => {
  it('mostra os valores custom, não os hardcoded originais', async () => {
    renderPage(<PineScript />);
    await openSyncTab();

    await screen.findByText(/padrão 15 \/ 2\.1/);
    screen.getByText(/TP1 em 1\.8R \+ Runner/);
    screen.getByText(/\* 1\.8 \| Runner/);
    screen.getByText(/T1: 30 candles \| T2: 50 candles \| T3: 70 candles/);
    expect(screen.getAllByText(/82/).length).toBeGreaterThan(0);

    // Os valores hardcoded originais não podem mais aparecer.
    expect(screen.queryByText(/padrão 20 \/ 3\.5/)).toBeNull();
    expect(screen.queryByText(/mínimo 75 para entrar/)).toBeNull();
    expect(screen.queryByText(/\* 1\.5 \| Runner/)).toBeNull();
    expect(screen.queryByText(/T1: 48 candles \| T2: 64 candles \| T3: 96 candles/)).toBeNull();
  });

  it('prosa do fluxo 4h→15m usa minScore dinâmico, não 75 fixo', async () => {
    renderPage(<PineScript />);
    await openSyncTab();

    await screen.findByText(/score ≥ 82/);
    expect(screen.queryByText(/score ≥ 75/)).toBeNull();
  });
});

// Achado M-12 do Raio-X de UI/UX (Média Prioridade): Settings.jsx e
// PineScript.jsx editam os mesmos parâmetros (rng_per, minScore, ATR
// mult, TP1R etc.) sem nenhum aviso cruzado visível — só um comentário
// de código mencionava a duplicidade. Este teste prova o link novo no
// aviso "Sincronização automática ativa" (aba Editor, sempre visível).
describe('PineScript — aviso de sincronização linka pra Ajuste Fino (achado M-12)', () => {
  it('REGRESSÃO: o aviso "Sincronização automática ativa" tem um link pra /settings', async () => {
    renderPage(<PineScript />);
    const link = await screen.findByRole('link', { name: 'Ajuste Fino' });
    expect(link.getAttribute('href')).toBe('/settings');
  });
});

// Achado da varredura pós-Raio-X (2026-09-27): o badge de erro de
// auto-sync mostrava "Erro sync" — abreviação/jargão que quebrava o
// próprio padrão do badge (as outras 3 frases são completas, em
// português: "Sincronizando...", "✓ Auto-sync OK", "Auto-sync ativo").
describe('PineScript — badge de erro de auto-sync com texto completo (achado pós-Raio-X)', () => {
  it('REGRESSÃO: badge mostra "Erro na sincronização", não mais "Erro sync"', async () => {
    const { syncPineToAssets } = await import('@/lib/pineParser');
    syncPineToAssets.mockRejectedValueOnce(new Error('network'));
    renderPage(<PineScript />);

    fireEvent.click(await screen.findByRole('button', { name: /^Salvar$/ }));
    await screen.findByText('Erro na sincronização');
    expect(screen.queryByText('Erro sync')).toBeNull();
  });
});

// Achado da varredura pós-Raio-X, Round 2 (2026-09-27): "Restaurar v13.2"
// usava confirm() nativo (quebra o tema escuro) — migrado pro AlertDialog
// já existente e nunca usado.
describe('PineScript — "Restaurar v13.2" usa AlertDialog em vez de confirm() nativo (Round 2 pós-Raio-X)', () => {
  it('REGRESSÃO: Cancelar não reseta o código; confirmar restaura o padrão e grava no localStorage', async () => {
    renderPage(<PineScript />);
    const editor = await screen.findByRole('textbox');
    fireEvent.change(editor, { target: { value: '// edição do usuário' } });
    expect(editor.value).toBe('// edição do usuário');

    fireEvent.click(screen.getByRole('button', { name: /Restaurar v13.2/i }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/sobrescrever as edições/)).toBeTruthy();

    fireEvent.click(within(dialog).getByText('Cancelar'));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(editor.value).toBe('// edição do usuário');

    fireEvent.click(screen.getByRole('button', { name: /Restaurar v13.2/i }));
    const dialog2 = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog2).getByText('Restaurar'));
    await waitFor(() => expect(editor.value).not.toBe('// edição do usuário'));
    expect(localStorage.getItem('pine_script_code_v12')).toBe(editor.value);
  });
});
