// Item 6 (correção de 08/11/2026): "por que o Dashboard não carregou". O que importa: a falta da chave (403 sem chave salva) e a chave errada (403 com chave
// salva) são distinguidas, o banco sem cota NÃO duplica o aviso que já existe, e o que não se sabe explicar devolve null (a tela fica como sempre foi).
import { describe, it, expect } from 'vitest';
import { loadFailureCause } from './loadFailure';

const err = (message, extra = {}) => Object.assign(new Error(message), extra);
const code = (e, opts) => loadFailureCause(e, opts)?.code ?? null;

describe('chave de acesso (o caso do celular)', () => {
  it('403 sem chave salva neste navegador = "falta a chave", com botão para colar', () => {
    const c = loadFailureCause(err('Chave de acesso ausente ou inválida.', { status: 403 }), { ownerKeyConfigured: false });
    expect(c.code).toBe('no_key');
    expect(c.needsKey).toBe(true);
    expect(c.title).toBe('Falta a chave de acesso neste navegador');
    expect(c.hint).toMatch(/OWNER_ACCESS_KEY/);
  });
  it('403 COM chave salva = "a chave salva não é aceita" (foi trocada no Render)', () => {
    const c = loadFailureCause(err('Chave de acesso ausente ou inválida.', { status: 403 }), { ownerKeyConfigured: true });
    expect(c.code).toBe('bad_key');
    expect(c.needsKey).toBe(true);
    expect(c.title).toBe('A chave salva neste navegador não é aceita pelo servidor');
  });
  it('só a mensagem (sem status) também é reconhecida; sem opção, assume que NÃO há chave', () => {
    expect(code(err('Chave de acesso ausente ou inválida.'))).toBe('no_key');
    expect(code(err('Chave de acesso ausente ou inválida.'), { ownerKeyConfigured: true })).toBe('bad_key');
  });
});

describe('outras causas', () => {
  it('login: 401 e "Não autenticado." e erros do Firebase Auth', () => {
    expect(code(err('Invalid or expired token.', { status: 401 }))).toBe('login');
    expect(code(err('Não autenticado.'))).toBe('login');
    expect(code(err('x', { code: 'auth/user-token-expired' }))).toBe('login');
  });
  it('servidor sem resposta: rede, tempo esgotado e falha de rede do Firebase', () => {
    expect(code(err('Failed to fetch'))).toBe('sem_resposta');
    expect(code(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe('sem_resposta');
    expect(code(err('x', { status: 504 }))).toBe('sem_resposta');
    expect(code(err('x', { code: 'auth/network-request-failed' }))).toBe('sem_resposta');
  });
  it('erro do servidor (5xx) e endereço do servidor não configurado', () => {
    expect(code(err('Request failed with status 500', { status: 500 }))).toBe('erro_servidor');
    expect(code(err('Request failed with status 502', { status: 502 }))).toBe('erro_servidor');
    expect(code(err('VITE_BACKEND_URL não configurado.'))).toBe('sem_endereco');
  });
  it('banco sem cota (503 db_quota) devolve null: o aviso próprio dele já existe', () => {
    expect(loadFailureCause(err('quota', { status: 503, code: 'db_quota' }))).toBeNull();
  });
  it('o que não se sabe explicar devolve null (tela como sempre foi)', () => {
    expect(loadFailureCause(err('Request failed with status 400', { status: 400 }))).toBeNull();
    expect(loadFailureCause(err('algo estranho'))).toBeNull();
    for (const x of [null, undefined, 'texto', 42]) expect(loadFailureCause(x)).toBeNull();
  });
});

describe('textos', () => {
  it('toda causa tem título e o que fazer, em português simples e sem emoji; só as de chave pedem a chave', () => {
    const casos = [
      err('Chave de acesso ausente ou inválida.', { status: 403 }), err('t', { status: 401 }), err('Failed to fetch'),
      err('x', { status: 500 }), err('VITE_BACKEND_URL não configurado.'),
    ];
    for (const e of casos) {
      for (const k of [false, true]) {
        const c = loadFailureCause(e, { ownerKeyConfigured: k });
        expect(c.title.length).toBeGreaterThan(10);
        expect(c.hint.length).toBeGreaterThan(20);
        expect(/\p{Extended_Pictographic}/u.test(`${c.title}${c.hint}`)).toBe(false);
        expect(c.needsKey).toBe(['no_key', 'bad_key'].includes(c.code));
      }
    }
  });
});
