// CLI da retenção do system_logs (item 298): lê o ambiente, abre a conexão, imprime o relatório e devolve o código de saída.
// A lógica de apagar está em db/logsRetention.mjs (testes próprios); aqui só se prova o que o CLI faz em volta: padrões seguros,
// recusa de entrada ruim, e que NENHUMA mensagem de erro leva endereço/senha do banco para o log (o repositório é público).
import { describe, it, expect, vi } from 'vitest';
import { main } from './logs-retention.mjs';

const DAY = 86400000;
const NOW = Date.parse('2026-11-11T12:00:00Z');

function makeDb({ aApagar = 40, lote = 40, falhaEm = null } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql) {
      calls.push(sql);
      if (falhaEm && falhaEm.test(sql)) throw falhaEm.erro;
      if (/^\s*DELETE\b/i.test(sql)) return { rowCount: lote, rows: [] };
      if (/GROUP BY/i.test(sql)) return { rows: [{ level: 'info', n: aApagar }] };
      if (/FILTER/i.test(sql)) {
        return { rows: [{ total: 100, sem_data: 0, a_apagar: aApagar, mais_antigo: new Date(NOW - 60 * DAY), mais_recente: new Date(NOW - 1000) }] };
      }
      return { rows: [{ total: 60 }] };
    },
  };
}

async function rodar({ env = {}, db = makeDb() } = {}) {
  const saida = [];
  const erros = [];
  const closeDb = vi.fn(async () => {});
  const getDb = vi.fn(() => db);
  const code = await main({
    env: { DATABASE_URL: 'postgres://x', ...env },
    getDb, closeDb, nowMs: NOW,
    log: (t) => saida.push(String(t)),
    logError: (t) => erros.push(String(t)),
  });
  return { code, saida: saida.join('\n'), erros: erros.join('\n'), db, getDb, closeDb };
}
const deletes = (db) => db.calls.filter((s) => /^\s*DELETE\b/i.test(s));

describe('logs-retention CLI — padrões seguros', () => {
  it('sem nenhuma variável de modo: SIMULA (não apaga), sai com 0 e mostra o relatório', async () => {
    const r = await rodar();
    expect(r.code).toBe(0);
    expect(deletes(r.db)).toHaveLength(0);
    expect(r.saida).toMatch(/simula/i);
    expect(r.saida).toMatch(/nada foi apagado/i);
    expect(r.saida).toContain('30 dias');
  });

  it('RETENCAO_MODO=aplicar apaga e mostra quantos', async () => {
    const r = await rodar({ env: { RETENCAO_MODO: 'aplicar' } });
    expect(r.code).toBe(0);
    expect(deletes(r.db).length).toBeGreaterThanOrEqual(1);
    expect(r.saida).toMatch(/apagados:?\s*\**\s*40/i);
  });

  it('RETENCAO_DIAS muda o corte', async () => {
    const r = await rodar({ env: { RETENCAO_DIAS: '14' } });
    expect(r.saida).toContain('14 dias');
  });

  it('sempre fecha a conexão ao terminar', async () => {
    const r = await rodar();
    expect(r.closeDb).toHaveBeenCalledTimes(1);
  });
});

describe('logs-retention CLI — entrada ruim', () => {
  it('dias inválidos: sai com 1, explica em português e não consulta o banco', async () => {
    const r = await rodar({ env: { RETENCAO_DIAS: '3' } });
    expect(r.code).toBe(1);
    expect(r.erros).toMatch(/dias/i);
    expect(r.db.calls).toHaveLength(0);
    expect(r.closeDb).toHaveBeenCalledTimes(1);
  });

  it('modo desconhecido ("apagar") nunca vira aplicar: sai com 1 e não apaga', async () => {
    const r = await rodar({ env: { RETENCAO_MODO: 'apagar' } });
    expect(r.code).toBe(1);
    expect(r.erros).toMatch(/modo/i);
    expect(deletes(r.db)).toHaveLength(0);
  });

  it('sem DATABASE_URL: sai com 1 e nem tenta abrir conexão', async () => {
    const saida = [];
    const erros = [];
    const getDb = vi.fn();
    const code = await main({ env: {}, getDb, closeDb: vi.fn(), nowMs: NOW, log: (t) => saida.push(t), logError: (t) => erros.push(t) });
    expect(code).toBe(1);
    expect(erros.join('\n')).toMatch(/DATABASE_URL/);
    expect(getDb).not.toHaveBeenCalled();
  });
});

describe('logs-retention CLI — falha do banco', () => {
  it('REGRESSÃO de segurança: endereço e senha do banco que vierem na mensagem NÃO vão para o log (repositório público)', async () => {
    const erro = Object.assign(
      new Error('connect ECONNREFUSED postgresql://neondb_owner:S3CR3T-senha@ep-quiet-sea-123.us-east-2.aws.neon.tech/neondb'),
      { code: 'ECONNREFUSED' }
    );
    const db = makeDb({ falhaEm: Object.assign(/FILTER/i, { erro }) });
    const r = await rodar({ db, env: { RETENCAO_MODO: 'aplicar' } });
    const tudo = `${r.saida}\n${r.erros}`;
    expect(r.code).toBe(1);
    expect(tudo).not.toContain('S3CR3T');
    expect(tudo).not.toContain('neon.tech');
    expect(tudo).not.toContain('ep-quiet-sea');
    expect(tudo).toContain('ECONNREFUSED');
    expect(r.closeDb).toHaveBeenCalledTimes(1);
  });

  it('cota do Neon esgotada é dita em português simples, sem despejar a mensagem crua', async () => {
    const erro = Object.assign(new Error('Your account or project has exceeded the quota. Upgrade your plan to increase limits.'), { code: '53000' });
    const db = makeDb({ falhaEm: Object.assign(/FILTER/i, { erro }) });
    const r = await rodar({ db });
    expect(r.code).toBe(1);
    expect(r.erros).toMatch(/sem cota/i);
    expect(r.erros).not.toMatch(/Upgrade your plan/);
  });

  it('erro sem código: mostra só o nome do erro, nunca a mensagem', async () => {
    const db = makeDb({ falhaEm: Object.assign(/FILTER/i, { erro: new Error('segredo-na-mensagem') }) });
    const r = await rodar({ db });
    expect(r.code).toBe(1);
    expect(`${r.saida}\n${r.erros}`).not.toContain('segredo-na-mensagem');
  });

  it('falha no meio dos lotes: sai com 1 e fecha a conexão', async () => {
    const db = makeDb({ falhaEm: Object.assign(/^\s*DELETE/i, { erro: Object.assign(new Error('x'), { code: '57014' }) }) });
    const r = await rodar({ db, env: { RETENCAO_MODO: 'aplicar' } });
    expect(r.code).toBe(1);
    expect(r.erros).toContain('57014');
    expect(r.closeDb).toHaveBeenCalledTimes(1);
  });
});
