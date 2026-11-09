// @vitest-environment jsdom
// Aviso "por que o Dashboard não carregou" (item 6, correção de 08/11/2026).
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import LoadFailureBanner from './LoadFailureBanner.jsx';

afterEach(cleanup);

const CHAVE = { code: 'no_key', title: 'Falta a chave de acesso neste navegador', hint: 'Cole o valor de OWNER_ACCESS_KEY.', needsKey: true };
const REDE = { code: 'sem_resposta', title: 'O servidor não respondeu', hint: 'Espere um pouco.', needsKey: false };

describe('LoadFailureBanner', () => {
  it('sem causa não mostra nada', () => {
    const { container } = render(<LoadFailureBanner cause={null} onPasteKey={() => {}} onRetry={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it('causa de chave: título, o que fazer, e os dois botões chamam o que devem', () => {
    const onPasteKey = vi.fn();
    const onRetry = vi.fn();
    render(<LoadFailureBanner cause={CHAVE} onPasteKey={onPasteKey} onRetry={onRetry} />);
    const alerta = screen.getByRole('alert');
    expect(alerta.textContent).toMatch(/Falta a chave de acesso neste navegador/);
    expect(alerta.textContent).toMatch(/OWNER_ACCESS_KEY/);
    fireEvent.click(screen.getByRole('button', { name: /Colar a chave/ }));
    expect(onPasteKey).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: /Tentar de novo/ }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('causa que não é de chave: só "Tentar de novo", sem botão de colar a chave', () => {
    render(<LoadFailureBanner cause={REDE} onPasteKey={() => {}} onRetry={() => {}} />);
    expect(screen.getByRole('alert').textContent).toMatch(/O servidor não respondeu/);
    expect(screen.queryByRole('button', { name: /Colar a chave/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Tentar de novo/ })).toBeTruthy();
  });
});
