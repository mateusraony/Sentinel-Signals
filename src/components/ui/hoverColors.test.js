// Guarda das cores de "passar o mouse" / dica (item 305): o usuário não conseguia ler a dica (verde-neon) nem o item de menu
// (rosa-choque + branco). Estes testes leem os arquivos de verdade: se alguém trouxer a cor viva de volta, falham.
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

const css = readFileSync(new URL('../../index.css', import.meta.url), 'utf8');
const tooltipSrc = readFileSync(new URL('./tooltip.jsx', import.meta.url), 'utf8');

/** `--nome: H S% L%;` do primeiro bloco (:root) → { h, s, l } ou null. */
function token(name) {
  const m = css.match(new RegExp(`--${name}:\\s*(\\d+(?:\\.\\d+)?)\\s+(\\d+(?:\\.\\d+)?)%\\s+(\\d+(?:\\.\\d+)?)%`));
  return m ? { h: Number(m[1]), s: Number(m[2]), l: Number(m[3]) } : null;
}

/** HSL (0-360, 0-100, 0-100) → luminância relativa WCAG. */
function luminance({ h, s, l }) {
  const S = s / 100; const L = l / 100;
  const a = S * Math.min(L, 1 - L);
  const f = (n) => { const k = (n + h / 30) % 12; return L - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(f(0)) + 0.7152 * lin(f(8)) + 0.0722 * lin(f(4));
}
const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

describe('cores de passar o mouse (hover/foco/selecionado) — item 305', () => {
  it('`--accent` (fundo do hover de menus, listas, botões outline/ghost, toggles) é suave: pouca saturação e escuro', () => {
    const accent = token('accent');
    expect(accent).not.toBeNull();
    expect(accent.s).toBeLessThanOrEqual(40); // o rosa-choque era 100%
    expect(accent.l).toBeLessThanOrEqual(30);
    expect(accent.l).toBeGreaterThanOrEqual(12); // ainda se destaca do fundo do menu (popover ~6%)
  });

  it('texto sobre o hover tem contraste de leitura (≥ 7:1, bem acima do mínimo AA de 4,5:1)', () => {
    const accent = token('accent');
    const fg = token('accent-foreground');
    expect(contrast(accent, fg)).toBeGreaterThanOrEqual(7);
  });

  it('a dica (tooltip) tem superfície suave e texto legível (≥ 7:1)', () => {
    const bg = token('surface-raised');
    const fg = token('surface-raised-foreground');
    expect(bg).not.toBeNull();
    expect(bg.s).toBeLessThanOrEqual(40);
    expect(bg.l).toBeLessThanOrEqual(30);
    expect(contrast(bg, fg)).toBeGreaterThanOrEqual(7);
  });

  it('o componente de dica não volta a usar o verde-neon (`bg-primary`) nem rosa (`bg-accent` vivo) de fundo', () => {
    expect(tooltipSrc).not.toMatch(/\bbg-primary\b/);
    expect(tooltipSrc).not.toMatch(/\bbg-destructive\b/);
    expect(tooltipSrc).toMatch(/--surface-raised/);
  });

  it('a calculadora de contraste está certa (preto×branco = 21; mesmo tom = 1)', () => {
    expect(contrast({ h: 0, s: 0, l: 0 }, { h: 0, s: 0, l: 100 })).toBeCloseTo(21, 0);
    expect(contrast({ h: 200, s: 30, l: 40 }, { h: 200, s: 30, l: 40 })).toBeCloseTo(1, 5);
  });
});
