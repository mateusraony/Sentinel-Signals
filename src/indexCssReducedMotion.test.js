// Achado M-5 do Raio-X de UI/UX (Média Prioridade): a animação
// `.signal-zone-pulse` (src/index.css, compartilhada por AssetCard.jsx e
// Assets.jsx) não respeitava `prefers-reduced-motion`. Lê o CSS-fonte em
// vez de renderizar um componente — index.css é uma folha de estilo
// global, não algo que jsdom aplica a partir de JSX (mesmo padrão já
// usado nos tripwires de src/lib, ex. rf1hCondTripwire.test.js).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('.signal-zone-pulse respeita prefers-reduced-motion (achado M-5)', () => {
  it('REGRESSÃO: src/index.css tem @media (prefers-reduced-motion: reduce) desligando a animação', () => {
    const css = readFileSync(resolve(__dirname, './index.css'), 'utf-8');
    const pulseIndex = css.indexOf('.signal-zone-pulse {');
    expect(pulseIndex).toBeGreaterThan(-1);
    const after = css.slice(pulseIndex, pulseIndex + 400);
    expect(after).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.signal-zone-pulse\s*\{\s*animation:\s*none;?\s*\}/);
  });
});
