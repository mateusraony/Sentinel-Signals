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
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { renderPage } from './__fixtures__/renderPage.jsx';
import PineScript from './PineScript.jsx';

const CUSTOM_CONFIG = {
  rng_per: 15, rng_qty: 2.1, minScore: 82,
  tp1R: 1.8, tp1QtyPercent: 50, trailAtrMult: 2.0,
  tier2Threshold: 0.6, tier3Threshold: 1.5,
  timeStopT1: 30, timeStopT2: 50, timeStopT3: 70,
};

vi.mock('@/lib/pineParser', async (importOriginal) => ({
  // As constantes reais (DEFAULTS etc.) alimentam o "O que o Sentinel lê do seu código" (src/lib/pineInputs.js).
  ...(await importOriginal()),
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

// 22/11/2026 — Pine Script refeita (estrutura + entendimento): o Editor mostra o que o Sentinel LÊ do código, a Sincronização lista o que é lido e o que
// não é (só vale no TradingView), cada linha diz se vem do Pine ou é regra fixa, e os Parâmetros por ativo dizem se o RF está igual ao Pine.
describe('PineScript — entendimento (22/11/2026)', () => {
  it('Editor: painel "Lido do seu código" com contagens do código atual; ao editar um valor, conta como diferente do padrão', async () => {
    renderPage(<PineScript />);
    const painel = await screen.findByRole('complementary', { name: 'O que o Sentinel lê do código' });
    expect(within(painel).getByText(/parâmetros que o Sentinel usa/)).toBeTruthy();
    expect(within(painel).getByText(/valem só no TradingView/)).toBeTruthy();
    expect(within(painel).getByText(/diferentes do padrão/).parentElement.textContent).toMatch(/^0 diferentes/);
    const editor = screen.getByRole('textbox', { name: 'Código Pine Script' });
    fireEvent.change(editor, { target: { value: editor.value.replace('rng_per = input.int(20,', 'rng_per = input.int(33,') } });
    await within(painel).findByText(/diferente do padrão/);
    expect(within(painel).getByText(/diferente do padrão/).parentElement.textContent).toMatch(/^1 diferente do padrão/);
  });

  it('Editor: código sem nenhum input avisa que o Sentinel usa os padrões', async () => {
    renderPage(<PineScript />);
    fireEvent.change(await screen.findByRole('textbox', { name: 'Código Pine Script' }), { target: { value: '// vazio' } });
    expect(await screen.findAllByText(/Nenhum parâmetro encontrado no código/)).toHaveLength(1);
  });

  it('Sincronização: tabela do que é lido (valor, padrão, onde vale) e lista do que o Sentinel NÃO lê', async () => {
    renderPage(<PineScript />);
    await openSyncTab();
    const tabela = await screen.findByRole('table');
    expect(within(tabela).getByText('Swing Period')).toBeTruthy();
    expect(within(tabela).getAllByText('RF de cada ativo ativo').length).toBe(2); // rng_per e rng_qty
    expect(within(tabela).getAllByText('Scan e painel').length).toBeGreaterThan(5);
    const resumo = screen.getByText(/configurações do Pine que o Sentinel não lê/);
    expect(resumo.closest('details').open).toBe(false);
    expect(within(resumo.closest('details')).getByText(/Webhook Secret/)).toBeTruthy(); // vale só no TradingView
  });

  it('Sincronização: "Só os diferentes do padrão" filtra a tabela (e diz quando não há nenhum)', async () => {
    renderPage(<PineScript />);
    const editor = await screen.findByRole('textbox', { name: 'Código Pine Script' });
    await openSyncTab();
    const filtro = await screen.findByRole('button', { name: /Só os diferentes do padrão \(0\)/ });
    const linhas = within(screen.getByRole('table')).getAllByRole('row').length;
    fireEvent.click(filtro);
    expect(screen.getByText('Nenhum parâmetro diferente do padrão.')).toBeTruthy();
    expect(filtro.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(filtro);
    expect(within(screen.getByRole('table')).getAllByRole('row').length).toBe(linhas);
    expect(editor).toBeTruthy();
  });

  it('Sincronização: com 2 valores editados, o filtro mostra só essas 2 linhas, marcadas', async () => {
    renderPage(<PineScript />);
    const editor = await screen.findByRole('textbox', { name: 'Código Pine Script' });
    fireEvent.change(editor, { target: { value: editor.value.replace('rng_per = input.int(20,', 'rng_per = input.int(33,').replace('minScore          = input.int(75,', 'minScore          = input.int(82,') } });
    await openSyncTab();
    fireEvent.click(await screen.findByRole('button', { name: /Só os diferentes do padrão \(2\)/ }));
    const corpo = within(screen.getByRole('table')).getAllByRole('row').slice(1);
    expect(corpo).toHaveLength(2);
    expect(within(corpo[0]).getByText('33')).toBeTruthy();
    expect(within(corpo[1]).getByText('82')).toBeTruthy();
    expect(within(corpo[0]).getByLabelText('diferente do padrão')).toBeTruthy();
  });

  it('Sincronização: cada linha de "Como o scan usa a estratégia" diz de onde vem (sem ✓ falso em tudo)', async () => {
    renderPage(<PineScript />);
    await openSyncTab();
    await screen.findByText(/Como o scan usa a estratégia/);
    expect(screen.getAllByText('vem do seu Pine').length).toBe(5);
    expect(screen.getAllByText('regra fixa do sistema').length).toBe(4);
  });

  it('Salvar mostra a última sincronização nesta sessão', async () => {
    renderPage(<PineScript />);
    expect(await screen.findByText('Ainda não salvou nesta sessão.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Salvar$/ }));
    expect(await screen.findByText(/Última sincronização nesta sessão: .* · 0 ativos com o RF igualado/)).toBeTruthy();
  });
});

describe('PineScript — Parâmetros por ativo (22/11/2026)', () => {
  const ATIVOS = [
    { id: 'a1', display_name: 'BTC', is_active: true, rf_period: 20, rf_multiplier: 3.5 },
    { id: 'a2', display_name: 'ETH', is_active: false, rf_period: 14, rf_multiplier: 3.0 },
    { id: 'a3', display_name: 'SOL', is_active: true, rf_period: 15, rf_multiplier: 2.1 },
  ];
  beforeEach(async () => { const { backend } = await import('@/api/entities'); backend.entities.MonitoredAsset.list.mockReset(); backend.entities.MonitoredAsset.list.mockResolvedValue([]); });
  const openParams = async () => fireEvent.click(await screen.findByRole('tab', { name: /Parâmetros Ativos/i }));

  it('diz, por ativo, se o RF está igual ao Pine e o que o Salvar faz (ativo iguala; inativo não mexe)', async () => {
    const { backend } = await import('@/api/entities');
    backend.entities.MonitoredAsset.list.mockResolvedValueOnce(ATIVOS);
    renderPage(<PineScript />);
    await openParams();
    expect(await screen.findByText(/o próximo Salvar iguala/)).toBeTruthy();
    expect(screen.getByText(/inativo, o Salvar não mexe/)).toBeTruthy();
    expect(screen.getByText('RF igual ao Pine')).toBeTruthy(); // SOL: 15 / 2.1 = Pine
    const resumo = screen.getByText('RF diferente do Pine').parentElement;
    expect(resumo.textContent).toContain('1'); // só BTC (ativo e diferente); ETH é inativo
  });

  it('carregando: contagens mostram "—", não "0", e não afirma "Nenhum ativo"', async () => {
    const { backend } = await import('@/api/entities');
    backend.entities.MonitoredAsset.list.mockImplementationOnce(() => new Promise(() => {}));
    renderPage(<PineScript />);
    await openParams();
    expect(await screen.findByRole('status', { name: 'Carregando ativos' })).toBeTruthy();
    expect(screen.getByText('Ativos').parentElement.textContent).toContain('—');
    expect(screen.queryByText('Nenhum ativo cadastrado.')).toBeNull();
  });

  it('erro ao carregar: mensagem com "tentar de novo" e contagens "—" (nunca "Nenhum ativo")', async () => {
    const { backend } = await import('@/api/entities');
    backend.entities.MonitoredAsset.list.mockRejectedValue(new Error('falhou'));
    renderPage(<PineScript />);
    await openParams();
    expect(await screen.findByText('Não foi possível carregar os ativos agora.', {}, { timeout: 4000 })).toBeTruthy();
    expect(screen.getByText('Ativos').parentElement.textContent).toContain('—');
    expect(screen.queryByText('Nenhum ativo cadastrado.')).toBeNull();
  });

  it('sem ativos cadastrados: estado vazio compacto', async () => {
    renderPage(<PineScript />);
    await openParams();
    expect(await screen.findByText('Nenhum ativo cadastrado.')).toBeTruthy();
  });
});
