// @vitest-environment jsdom
//
// Achado da varredura pós-Raio-X (2026-09-27): o toggle de "Detalhes" de
// uma tool call usava ChevronRight (colapsado) → ChevronDown (expandido) —
// direção invertida em relação ao resto do app (AssetCard.jsx, TradeCard.jsx,
// SignalChecklist.jsx, TradeHistory.jsx usam ChevronDown → ChevronUp).
// Componente não tinha teste dedicado antes.
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import MessageBubble from './MessageBubble.jsx';

afterEach(cleanup);

const MESSAGE_COM_TOOL_CALL = {
  role: 'assistant',
  content: '',
  tool_calls: [
    { name: 'buscar_dados', status: 'completed', results: '{"ok":true}' },
  ],
};

describe('MessageBubble — toggle de tool call usa ChevronDown/ChevronUp (achado pós-Raio-X)', () => {
  it('REGRESSÃO: ícone colapsado é ChevronDown (lucide-chevron-down), não ChevronRight', () => {
    render(<MessageBubble message={MESSAGE_COM_TOOL_CALL} />);
    const toggle = screen.getByRole('button', { name: /buscar_dados/ });
    expect(toggle.querySelector('svg').getAttribute('class')).toMatch(/lucide-chevron-down/);
    expect(toggle.querySelector('svg').getAttribute('class')).not.toMatch(/lucide-chevron-right/);
  });

  it('REGRESSÃO: ao expandir, o ícone vira ChevronUp (lucide-chevron-up), mesmo padrão do resto do app', () => {
    render(<MessageBubble message={MESSAGE_COM_TOOL_CALL} />);
    const toggle = screen.getByRole('button', { name: /buscar_dados/ });
    fireEvent.click(toggle);
    expect(toggle.querySelector('svg').getAttribute('class')).toMatch(/lucide-chevron-up/);
  });
});
