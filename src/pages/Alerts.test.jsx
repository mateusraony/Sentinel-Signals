// @vitest-environment jsdom
//
// Achado A-7 do Raio-X de UI/UX (varredura fresca, docs/known-risks.md item
// 214, 2ª sub-rodada): o filtro "Buscar símbolo..." usava `outline-none` sem
// substituto visível de foco — mesmo achado/fix já aplicado em
// TriggerBacktestPanel.jsx (1ª sub-rodada). Página não tinha teste
// dedicado antes.
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, cleanup } from '@testing-library/react';
import { renderPage, makeFakeBackendModule } from './__fixtures__/renderPage.jsx';
import Alerts from './Alerts.jsx';

vi.mock('@/api/entities', () => makeFakeBackendModule({ populated: false }));

afterEach(cleanup);

describe('Alerts — filtro "Buscar símbolo..." tem foco visível (achado A-7)', () => {
  it('REGRESSÃO: input tem focus-visible:ring', async () => {
    renderPage(<Alerts />);
    const search = await screen.findByPlaceholderText('Buscar símbolo...');
    expect(search.className).toMatch(/focus-visible:ring-1 focus-visible:ring-ring/);
  });
});
