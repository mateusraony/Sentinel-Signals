/**
 * @vitest-environment jsdom
 *
 * Chip "Atualizado às HH:MM:SS" (docs/known-risks.md item 301): o horário da última leitura do banco, sempre visível, sem texto de modo.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import LastUpdateChip from './LastUpdateChip';
import { noteDbRead, resetDbReadClock } from '@/lib/dbReadClock';

const chip = () => document.querySelector('[data-last-update-chip]');
const horaDe = (ts) => new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

describe('LastUpdateChip', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-12T14:00:00Z'));
    resetDbReadClock();
  });
  afterEach(() => {
    cleanup();
    resetDbReadClock();
    vi.useRealTimers();
  });

  it('SEMPRE aparece; antes da primeira leitura diz "Aguardando dados" (não inventa horário)', () => {
    render(<LastUpdateChip />);
    expect(chip()).not.toBeNull();
    expect(chip().textContent).toBe('Aguardando dados');
  });

  it('está VISÍVEL de verdade (não escondido por atributo nem por classe)', () => {
    render(<LastUpdateChip />);
    expect(chip().hasAttribute('hidden')).toBe(false);
    expect(chip().className).not.toMatch(/(^|\s)(hidden|invisible|sr-only|opacity-0)(\s|$)/);
    expect(chip().getAttribute('style')).not.toMatch(/display:\s*none|visibility:\s*hidden/);
  });

  it('mostra o horário real da última leitura do banco, com segundos', () => {
    render(<LastUpdateChip />);
    act(() => { noteDbRead(Date.now()); });
    expect(chip().textContent).toBe(`Atualizado às ${horaDe(Date.now())}`);
  });

  it('o horário acompanha a próxima leitura (14:00 → 14:30)', () => {
    render(<LastUpdateChip />);
    act(() => { noteDbRead(Date.now()); });
    const primeiro = chip().textContent;
    act(() => { vi.advanceTimersByTime(30 * 60_000); });
    expect(chip().textContent).toBe(primeiro); // nenhuma leitura nova: o horário FICA parado (aba escondida/fechada)
    act(() => { noteDbRead(Date.now()); });
    expect(chip().textContent).toBe(`Atualizado às ${horaDe(Date.now())}`);
    expect(chip().textContent).not.toBe(primeiro);
  });

  it('não diz nada de modo/repouso: só o horário (a explicação fica na dica ao passar o mouse)', () => {
    render(<LastUpdateChip />);
    act(() => { noteDbRead(Date.now()); });
    expect(chip().textContent).not.toMatch(/repouso|ao vivo|parad|congelad|pausad|30 min/i);
    expect(chip().getAttribute('title')).toMatch(/30 min/);
    expect(chip().getAttribute('title')).toMatch(/segundo plano|fechada/);
  });

  it('um dia depois mostra a data junto, para não parecer de hoje', () => {
    render(<LastUpdateChip />);
    act(() => { noteDbRead(Date.now()); });
    act(() => { vi.advanceTimersByTime(26 * 60 * 60_000); }); // useNow atualiza a cada 30 s
    expect(chip().textContent).toMatch(/^Atualizado \d{2}\/\d{2} às \d{2}:\d{2}:\d{2}$/);
  });

  it('não é região viva (anunciaria o horário a cada leitura)', () => {
    render(<LastUpdateChip />);
    expect(chip().getAttribute('role')).toBeNull();
    expect(chip().getAttribute('aria-live')).toBeNull();
  });

  it('é fixo e sem quebra de linha (nada empurra a página); no celular fica acima da barra de navegação; no computador, ao lado da barra lateral', () => {
    render(<LastUpdateChip />);
    const c = chip().className;
    expect(c).toMatch(/\bfixed\b/);
    expect(c).toMatch(/\bwhitespace-nowrap\b/);
    expect(c).toMatch(/\bbottom-\[4\.5rem\]/);
    expect(c).toMatch(/\bmd:left-16\b/);
    expect(c).toMatch(/\bmd:bottom-3\b/);
    expect(c).not.toMatch(/\bright-/); // o canto inferior direito é do botão de Debug
  });
});

describe('trava: o chip está montado no layout do painel', () => {
  it('AppLayout renderiza <LastUpdateChip /> e não tem mais barra/faixa de repouso', () => {
    const layout = readFileSync(join(process.cwd(), 'src/components/layout/AppLayout.jsx'), 'utf8');
    expect(layout).toMatch(/import LastUpdateChip from '\.\/LastUpdateChip'/);
    expect(layout).toMatch(/<LastUpdateChip \/>/);
    expect(layout).not.toMatch(/LiveStatusBar|IdleRestBanner/);
  });
});
