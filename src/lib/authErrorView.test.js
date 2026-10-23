import { describe, it, expect } from 'vitest';
import { authErrorFallbackProps } from './authErrorView.js';

describe('authErrorFallbackProps', () => {
  it('banco sem cota (db_quota) ganha título e texto próprios, não o "sem conexão" genérico', () => {
    const props = authErrorFallbackProps({ type: 'unknown', message: 'Banco de dados sem cota.', code: 'db_quota' });
    expect(props.title).toBe('Banco de dados sem cota');
    expect(props.message).toMatch(/limites/);
  });

  it('texto neutro: não promete renovação mensal nem culpa uma cota específica (achado do Codex)', () => {
    const { message } = authErrorFallbackProps({ code: 'db_quota' });
    expect(message).not.toMatch(/\bmês\b|mensal|renov/i);
    expect(message).toMatch(/computação, transferência ou espaço/);
  });

  it('qualquer outro erro de autenticação mantém a tela de sempre', () => {
    for (const err of [{ type: 'unknown', message: 'Failed to fetch' }, { code: 'auth/network-request-failed' }, null, undefined]) {
      expect(authErrorFallbackProps(err).title).toBe('Sem conexão com o servidor');
    }
  });
});
