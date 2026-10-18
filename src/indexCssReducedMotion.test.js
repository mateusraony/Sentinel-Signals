// Achado M-5 do Raio-X de UI/UX (Média Prioridade): a animação
// `.signal-zone-pulse` (src/index.css, usada por AssetCard.jsx e Assets.jsx)
// não respeitava `prefers-reduced-motion`.
//
// Item 277 (PR-B): a pulsação foi REMOVIDA — ela sinalizava "sinal iminente"
// quando o preço só estava perto da linha do Range Filter. O teste passa a
// garantir que ela não volte; se alguém reintroduzir a classe, a exigência
// original de M-5 (desligar a animação com reduced-motion) volta a valer.
// Lê o CSS-fonte em vez de renderizar — index.css é folha de estilo global.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(resolve(__dirname, rel), 'utf-8');

describe('.signal-zone-pulse (achado M-5, removida no item 277)', () => {
  it('nenhum componente usa mais a pulsação de proximidade', () => {
    expect(read('./components/dashboard/AssetCard.jsx')).not.toMatch(/signal-zone-pulse/);
    expect(read('./pages/Assets.jsx')).not.toMatch(/signal-zone-pulse/);
  });

  it('se a classe voltar ao CSS, precisa respeitar prefers-reduced-motion', () => {
    const css = read('./index.css');
    const pulseIndex = css.indexOf('.signal-zone-pulse {');
    if (pulseIndex === -1) return; // removida (item 277)
    const after = css.slice(pulseIndex, pulseIndex + 400);
    expect(after).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.signal-zone-pulse\s*\{\s*animation:\s*none;?\s*\}/);
  });
});
