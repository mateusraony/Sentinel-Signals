// Retenção do system_logs (docs/known-risks.md item 298; roadmap "Prioridades de hoje", linha 4: "`system_logs` cresce sem limite").
// Aqui só a LÓGICA (validação de entrada, simular × aplicar, lotes, travas de segurança) com um banco falso que anota cada consulta.
// O SQL em si é provado contra Postgres de verdade em `db/logsRetention.pg.test.js`.
import { describe, it, expect } from 'vitest';
import {
  RETENTION_DEFAULT_DAYS,
  RETENTION_MIN_DAYS,
  RETENTION_MAX_DAYS,
  BATCH_SIZE,
  MAX_BATCHES,
  parseRetentionDays,
  parseRetentionMode,
  cutoffFor,
  runLogsRetention,
  formatRetentionReport,
} from './logsRetention.mjs';

const DAY = 86400000;
const NOW = Date.parse('2026-11-11T12:00:00Z');
const CUTOFF_30 = new Date(NOW - 30 * DAY).toISOString();

/**
 * Banco falso: responde cada tipo de consulta pelo texto do SQL e guarda tudo o que recebeu.
 * `lotes` = quantas linhas cada DELETE em sequência "apaga" (o último valor se repete se faltar).
 */
function makeDb({ total = 100, semData = 0, aApagar = 40, porNivel = [{ level: 'info', n: 30 }, { level: 'error', n: 10 }],
  maisAntigo = new Date(NOW - 60 * DAY), maisRecente = new Date(NOW - 1000), lotes = [], totalDepois = 60 } = {}) {
  const calls = [];
  let i = 0;
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/^\s*DELETE\b/i.test(sql)) {
        const n = lotes[Math.min(i, lotes.length - 1)] ?? 0;
        i += 1;
        return { rowCount: n, rows: [] };
      }
      if (/GROUP BY/i.test(sql)) return { rows: porNivel };
      if (/FILTER/i.test(sql)) {
        return { rows: [{ total, sem_data: semData, a_apagar: aApagar, mais_antigo: maisAntigo, mais_recente: maisRecente }] };
      }
      return { rows: [{ total: totalDepois }] };
    },
  };
}
const deletes = (db) => db.calls.filter((c) => /^\s*DELETE\b/i.test(c.sql));

describe('parseRetentionDays', () => {
  it('vazio/ausente usa o padrão de 30 dias', () => {
    expect(RETENTION_DEFAULT_DAYS).toBe(30);
    for (const v of [undefined, null, '', '   ']) expect(parseRetentionDays(v)).toBe(30);
  });

  it('aceita número inteiro (texto ou número) dentro do intervalo', () => {
    expect(parseRetentionDays('30')).toBe(30);
    expect(parseRetentionDays(45)).toBe(45);
    expect(parseRetentionDays(' 14 ')).toBe(14);
    expect(parseRetentionDays(String(RETENTION_MIN_DAYS))).toBe(RETENTION_MIN_DAYS);
    expect(parseRetentionDays(String(RETENTION_MAX_DAYS))).toBe(RETENTION_MAX_DAYS);
  });

  it('RECUSA (não chuta um valor): abaixo do mínimo, acima do máximo, decimal, texto, notação científica', () => {
    for (const v of ['6', '0', '-5', '3651', '30.5', 'abc', '1e3', '30 dias', 'NaN', 'Infinity', 0, -1, NaN, Infinity]) {
      expect(() => parseRetentionDays(v), String(v)).toThrow(/dias/i);
    }
  });
});

describe('parseRetentionMode', () => {
  it('vazio = simular (nunca apaga por esquecimento)', () => {
    for (const v of [undefined, null, '', '  ']) expect(parseRetentionMode(v)).toBe('simular');
  });

  it('aceita só "simular" e "aplicar" (ignora maiúsculas e espaços)', () => {
    expect(parseRetentionMode('simular')).toBe('simular');
    expect(parseRetentionMode('aplicar')).toBe('aplicar');
    expect(parseRetentionMode(' APLICAR ')).toBe('aplicar');
  });

  it('qualquer outra coisa é recusada, nunca vira "aplicar"', () => {
    for (const v of ['apagar', 'sim', 'true', '1', 'apply', 'aplicar!', 'aplicar simular']) {
      expect(() => parseRetentionMode(v), v).toThrow(/modo/i);
    }
  });
});

describe('cutoffFor', () => {
  it('é "agora menos N dias", em ISO', () => {
    expect(cutoffFor(NOW, 30)).toBe(CUTOFF_30);
    expect(cutoffFor(NOW, 7)).toBe(new Date(NOW - 7 * DAY).toISOString());
  });

  it('recusa relógio ou dias inválidos (nunca devolve uma data no futuro)', () => {
    for (const bad of [NaN, Infinity, undefined, null, 'x']) expect(() => cutoffFor(bad, 30)).toThrow();
    expect(() => cutoffFor(NOW, 0)).toThrow();
    expect(() => cutoffFor(NOW, -3)).toThrow();
    expect(new Date(cutoffFor(NOW, 30)).getTime()).toBeLessThan(NOW);
  });
});

describe('runLogsRetention — entrada inválida', () => {
  it('dias ou modo inválidos falham ANTES de qualquer consulta ao banco', async () => {
    const db = makeDb();
    await expect(runLogsRetention({ db, mode: 'aplicar', days: '3', nowMs: NOW })).rejects.toThrow(/dias/i);
    await expect(runLogsRetention({ db, mode: 'apagar', days: '30', nowMs: NOW })).rejects.toThrow(/modo/i);
    expect(db.calls).toHaveLength(0);
  });
});

describe('runLogsRetention — simular', () => {
  it('conta o que seria apagado e NÃO emite nenhum DELETE', async () => {
    const db = makeDb({ aApagar: 40, lotes: [5000] });
    const r = await runLogsRetention({ db, mode: 'simular', days: '30', nowMs: NOW });
    expect(deletes(db)).toHaveLength(0);
    expect(r).toMatchObject({ mode: 'simular', days: 30, cutoff: CUTOFF_30, total: 100, aApagar: 40, apagados: 0, lotes: 0, pulado: null });
    expect(r.porNivel).toEqual({ info: 30, error: 10 });
  });

  it('o padrão (modo vazio) também só simula', async () => {
    const db = makeDb();
    const r = await runLogsRetention({ db, days: '30', nowMs: NOW });
    expect(r.mode).toBe('simular');
    expect(deletes(db)).toHaveLength(0);
  });
});

describe('runLogsRetention — aplicar', () => {
  it('apaga em lotes e para quando um lote vem menor que o tamanho (acabou)', async () => {
    const db = makeDb({ aApagar: 5, lotes: [2, 2, 1] });
    const r = await runLogsRetention({ db, mode: 'aplicar', days: '30', nowMs: NOW, batchSize: 2 });
    expect(deletes(db)).toHaveLength(3);
    for (const d of deletes(db)) expect(d.params).toEqual([CUTOFF_30, 2]);
    expect(r).toMatchObject({ apagados: 5, lotes: 3, restante: false, totalDepois: 60 });
  });

  it('para no teto de lotes e avisa que sobrou para a próxima execução', async () => {
    const db = makeDb({ aApagar: 100, lotes: [2] }); // todo lote vem cheio
    const r = await runLogsRetention({ db, mode: 'aplicar', days: '30', nowMs: NOW, batchSize: 2, maxBatches: 3 });
    expect(deletes(db)).toHaveLength(3);
    expect(r).toMatchObject({ apagados: 6, lotes: 3, restante: true });
  });

  it('lote exato que esvazia a fila e o próximo vem vazio: termina sem marcar "restante"', async () => {
    const db = makeDb({ aApagar: 4, lotes: [2, 2, 0] });
    const r = await runLogsRetention({ db, mode: 'aplicar', days: '30', nowMs: NOW, batchSize: 2, maxBatches: 10 });
    expect(r).toMatchObject({ apagados: 4, lotes: 3, restante: false });
  });

  it('usa os padrões do módulo quando não recebe tamanho nem teto', async () => {
    const db = makeDb({ aApagar: 3, lotes: [3] });
    await runLogsRetention({ db, mode: 'aplicar', days: '30', nowMs: NOW });
    expect(deletes(db)[0].params).toEqual([CUTOFF_30, BATCH_SIZE]);
    expect(BATCH_SIZE).toBeGreaterThanOrEqual(1000);
    expect(MAX_BATCHES).toBeGreaterThanOrEqual(10);
  });

  it('nada a apagar (todos os logs são recentes): não emite DELETE', async () => {
    const db = makeDb({ aApagar: 0, porNivel: [] });
    const r = await runLogsRetention({ db, mode: 'aplicar', days: '30', nowMs: NOW });
    expect(deletes(db)).toHaveLength(0);
    expect(r).toMatchObject({ pulado: 'nada_a_apagar', apagados: 0 });
  });
});

describe('runLogsRetention — travas de segurança', () => {
  it('SEM logs recentes (o mais novo é mais velho que o corte) não apaga NADA: preserva a evidência de uma queda', async () => {
    const db = makeDb({ aApagar: 100, total: 100, maisRecente: new Date(NOW - 45 * DAY) });
    const r = await runLogsRetention({ db, mode: 'aplicar', days: '30', nowMs: NOW });
    expect(deletes(db)).toHaveLength(0);
    expect(r).toMatchObject({ pulado: 'sem_logs_recentes', apagados: 0 });
  });

  it('o relógio errado (corte à frente de todos os logs) cai na mesma trava', async () => {
    const db = makeDb({ aApagar: 100, total: 100, maisRecente: new Date(NOW + 5 * DAY) });
    // relógio do executor 40 dias à frente: o corte passa do log mais novo → não apaga
    const r = await runLogsRetention({ db, mode: 'aplicar', days: '30', nowMs: NOW + 40 * DAY });
    expect(deletes(db)).toHaveLength(0);
    expect(r.pulado).toBe('sem_logs_recentes');
  });

  it('tabela vazia: nada a fazer, sem DELETE', async () => {
    const db = makeDb({ total: 0, aApagar: 0, maisAntigo: null, maisRecente: null, porNivel: [] });
    const r = await runLogsRetention({ db, mode: 'aplicar', days: '30', nowMs: NOW });
    expect(deletes(db)).toHaveLength(0);
    expect(r).toMatchObject({ pulado: 'tabela_vazia', total: 0 });
  });

  it('o SQL só toca system_logs e nunca lê o CONTEÚDO dos logs (nem mensagem, nem o JSON de dados)', async () => {
    const db = makeDb({ aApagar: 3, lotes: [3] });
    await runLogsRetention({ db, mode: 'aplicar', days: '30', nowMs: NOW });
    expect(db.calls.length).toBeGreaterThanOrEqual(3);
    for (const { sql } of db.calls) {
      expect(sql).toMatch(/\bsystem_logs\b/);
      expect(sql).not.toMatch(/\b(data|message|details)\b/i);
      expect(sql).not.toMatch(/\b(trade_operations|monitored_assets|asset_states|signal_events|price_alerts|users|strategy_config|scanner_locks)\b/i);
    }
    for (const { sql } of deletes(db)) {
      expect(sql).toMatch(/created_date\s*<\s*\$1/);
      expect(sql).toMatch(/LIMIT\s+\$2/i);
    }
  });

  it('o valor do corte vai como parâmetro (nunca concatenado no texto do SQL)', async () => {
    const db = makeDb({ aApagar: 1, lotes: [1] });
    await runLogsRetention({ db, mode: 'aplicar', days: '30', nowMs: NOW });
    for (const { sql } of db.calls) expect(sql).not.toContain('2026-');
  });
});

describe('formatRetentionReport', () => {
  it('simulação: diz com todas as letras que NADA foi apagado e mostra o que seria', async () => {
    const db = makeDb({ aApagar: 40 });
    const texto = formatRetentionReport(await runLogsRetention({ db, mode: 'simular', days: '30', nowMs: NOW }));
    expect(texto).toMatch(/simula/i);
    expect(texto).toMatch(/nada foi apagado/i);
    expect(texto).toContain('40');
    expect(texto).toContain('30 dias');
    expect(texto).toContain('error');
  });

  it('aplicação: mostra quantos foram apagados, em quantos lotes e quantos sobraram', async () => {
    const db = makeDb({ aApagar: 5, lotes: [2, 2, 1], totalDepois: 95 });
    const texto = formatRetentionReport(await runLogsRetention({ db, mode: 'aplicar', days: '30', nowMs: NOW, batchSize: 2 }));
    expect(texto).toMatch(/apagados?:?\s*\**\s*5/i);
    expect(texto).toContain('95');
    expect(texto).toMatch(/3 lote/i);
  });

  it('teto de lotes: avisa que a próxima execução continua', async () => {
    const db = makeDb({ aApagar: 100, lotes: [2] });
    const texto = formatRetentionReport(await runLogsRetention({ db, mode: 'aplicar', days: '30', nowMs: NOW, batchSize: 2, maxBatches: 2 }));
    expect(texto).toMatch(/próxima execução/i);
  });

  it('cada motivo de "pulado" tem texto próprio em português simples', async () => {
    const recentes = formatRetentionReport(await runLogsRetention({ db: makeDb({ maisRecente: new Date(NOW - 60 * DAY) }), mode: 'aplicar', days: '30', nowMs: NOW }));
    expect(recentes).toMatch(/nenhum log recente/i);
    expect(recentes).toMatch(/não apaguei nada/i);
    const vazia = formatRetentionReport(await runLogsRetention({ db: makeDb({ total: 0, aApagar: 0, maisAntigo: null, maisRecente: null, porNivel: [] }), days: '30', nowMs: NOW }));
    expect(vazia).toMatch(/vazia/i);
    const nada = formatRetentionReport(await runLogsRetention({ db: makeDb({ aApagar: 0, porNivel: [] }), days: '30', nowMs: NOW }));
    expect(nada).toMatch(/nada a apagar/i);
  });

  it('o relatório só tem números e datas: nenhum conteúdo de log (o repositório é público e o resumo do job também)', async () => {
    const db = makeDb({ aApagar: 40 });
    const texto = formatRetentionReport(await runLogsRetention({ db, mode: 'simular', days: '30', nowMs: NOW }));
    expect(texto).not.toMatch(/postgres(ql)?:\/\//i);
    expect(texto).not.toMatch(/DATABASE_URL|token|senha|password/i);
  });
});
