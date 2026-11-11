// Logo do token em todo o sistema (11/11/2026, pedido do usuário): trava os pontos onde o nome do token aparece. Se alguém tirar o ícone de um deles (ou criar o
// componente e esquecer de usá-lo), este teste avisa. Lê os arquivos como texto, sem renderizar.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const PONTOS = [
  ['src/components/dashboard/MarketResultCard.jsx', 2], // título "O BTC depois da divulgação" no cartão de resultado e na lista
  ['src/components/dashboard/AssetCard.jsx', 1],
  ['src/components/dashboard/TradeCard.jsx', 1],
  ['src/components/dashboard/AssetDrawer.jsx', 1],
  ['src/components/dashboard/SignalToast.jsx', 1],
  ['src/components/dashboard/SignalAlertBanner.jsx', 1],
  ['src/components/dashboard/RecentAlertsList.jsx', 1],
  ['src/components/dashboard/VerificationWidget.jsx', 1],
  ['src/components/layout/TickerBar.jsx', 1],
  ['src/components/layout/GlobalSearch.jsx', 1],
  ['src/pages/Assets.jsx', 1],
  ['src/pages/TradeHistory.jsx', 1],
  ['src/pages/Trades.jsx', 4],
  ['src/pages/Alerts.jsx', 1],
  ['src/pages/Verification.jsx', 1],
];

describe('TokenIcon — presente em todos os pontos onde o nome do token aparece', () => {
  for (const [arquivo, vezes] of PONTOS) {
    it(`${arquivo}: importa o componente e o usa ${vezes}x`, () => {
      const texto = readFileSync(arquivo, 'utf8');
      expect(texto).toMatch(/import TokenIcon from '@\/components\/TokenIcon';/);
      expect((texto.match(/<TokenIcon\b/g) ?? []).length).toBe(vezes);
    });
  }

  it('o emoji de moeda 🪙 (que algumas telas desenham como uma lua) não é mais usado no painel', () => {
    for (const [arquivo] of PONTOS) expect(readFileSync(arquivo, 'utf8'), arquivo).not.toContain('🪙');
  });
});
