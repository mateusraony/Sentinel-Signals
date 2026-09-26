// @vitest-environment jsdom
//
// Refinamentos (seção E do Raio-X de UI/UX): o texto do placeholder
// mencionava "backend"/"API" — jargão técnico sem necessidade, já que a
// tela não expõe nenhuma configuração desses termos ao usuário. Não muda a
// decisão de manter o Strategy Reviewer pausado, só a redação. Página não
// tinha teste dedicado antes.
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import StrategyReviewer from './StrategyReviewer.jsx';

afterEach(cleanup);

describe('StrategyReviewer — texto sem jargão de "backend"/"API" (Refinamentos)', () => {
  it('REGRESSÃO: o texto não menciona backend/API, mas ainda explica a pausa', () => {
    render(<StrategyReviewer />);
    const text = screen.getByText(/temporariamente pausado/i).textContent;
    expect(text).not.toMatch(/backend/i);
    expect(text).not.toMatch(/\bAPI\b/);
    expect(text).toMatch(/infraestrutura de segurança/i);
  });
});
