// @vitest-environment jsdom
//
// Achado A-1 do Raio-X de UI/UX (docs/claude/ui-audit-criticos.md): cada
// linha tinha `cursor-pointer` + `ChevronRight` sugerindo clique, mas sem
// `onClick` nenhum — falsa affordance. Este teste prova o fix: clicar numa
// linha chama `onSelectAsset` com o ativo correto (resolvido via
// `signal.asset_id`), e NÃO quebra/chama nada quando o ativo não é
// encontrado (removido, ou `assets` ainda não carregado).
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import RecentAlertsList from './RecentAlertsList.jsx';

afterEach(() => cleanup());

const SIGNAL = {
  id: 'sig1', asset_id: 'a1', symbol: 'BTCUSDT', timeframe: '4h',
  signal_type: 'BUY', source: 'range_filter', priority: 'high',
  reason: 'RF cruzou pra cima', created_date: new Date().toISOString(),
};
const ASSET = { id: 'a1', symbol: 'BTCUSDT', display_name: 'BTC/USDT' };

describe('RecentAlertsList — clique numa linha abre o ativo (achado A-1)', () => {
  it('chama onSelectAsset com o asset correto ao clicar numa linha com ativo resolvido', () => {
    const onSelectAsset = vi.fn();
    render(<RecentAlertsList signals={[SIGNAL]} assets={[ASSET]} onSelectAsset={onSelectAsset} />);
    fireEvent.click(screen.getByText('BTCUSDT'));
    expect(onSelectAsset).toHaveBeenCalledWith(ASSET);
  });

  it('não chama onSelectAsset (nem quebra) quando o ativo do sinal não está em assets', () => {
    const onSelectAsset = vi.fn();
    render(<RecentAlertsList signals={[SIGNAL]} assets={[]} onSelectAsset={onSelectAsset} />);
    expect(() => fireEvent.click(screen.getByText('BTCUSDT'))).not.toThrow();
    expect(onSelectAsset).not.toHaveBeenCalled();
  });

  it('não quebra quando onSelectAsset não é passado', () => {
    render(<RecentAlertsList signals={[SIGNAL]} assets={[ASSET]} />);
    expect(() => fireEvent.click(screen.getByText('BTCUSDT'))).not.toThrow();
  });
});
