import { describe, it, expect } from 'vitest';
import { normalizeMessage, groupLogs, explainLog, healthSummary, hourlyActivity, LEVEL_HELP, EXECUTOR_HELP } from './logInsights';

const NOW = new Date('2026-11-22T15:30:00Z').getTime();
const ago = (h) => new Date(NOW - h * 3600000).toISOString();
let seq = 0;
const log = (over) => ({ id: `l${++seq}`, level: 'error', module: 'scanner', message: 'Erro no scan de BTCUSDT: Failed to fetch', created_date: ago(1), ...over });

describe('normalizeMessage', () => {
  it('troca ativo e número por marcador (mesma regra da auditoria de saúde)', () => {
    expect(normalizeMessage('Erro no scan de BTCUSDT: timeout após 30s')).toBe('Erro no scan de <ativo>: timeout após Ns');
    expect(normalizeMessage('Erro no scan de ETHUSDT: timeout após 30s')).toBe(normalizeMessage('Erro no scan de BTCUSDT: timeout após 30s'));
  });
  it('aceita vazio/undefined', () => {
    expect(normalizeMessage(undefined)).toBe('');
  });
});

describe('groupLogs', () => {
  it('agrupa o mesmo problema em ativos diferentes e conta os ativos', () => {
    const g = groupLogs([
      log({ symbol: 'BTCUSDT', message: 'Erro no scan de BTCUSDT: Failed to fetch' }),
      log({ symbol: 'ETHUSDT', message: 'Erro no scan de ETHUSDT: Failed to fetch' }),
      log({ symbol: 'ETHUSDT', message: 'Erro no scan de ETHUSDT: Failed to fetch' }),
    ], { now: NOW });
    expect(g).toHaveLength(1);
    expect(g[0].total).toBe(3);
    expect(g[0].assets).toEqual(['BTCUSDT', 'ETHUSDT']);
  });
  it('ignora info/debug e registros com mais de 24h', () => {
    const g = groupLogs([log({ level: 'info' }), log({ level: 'debug' }), log({ created_date: ago(30) })], { now: NOW });
    expect(g).toEqual([]);
  });
  it('marca "só navegador" quando todos vieram do navegador com dedup por executor', () => {
    const g = groupLogs([
      log({ executor: 'browser', details: { dedup_scope: 'executor' } }),
      log({ executor: 'browser', details: { dedup_scope: 'executor' } }),
    ], { now: NOW });
    expect(g[0].onlyBrowser).toBe(true);
  });
  it('não marca "só navegador" se o cron também teve o erro', () => {
    const g = groupLogs([
      log({ executor: 'browser', details: { dedup_scope: 'executor' } }),
      log({ executor: 'cron', details: { dedup_scope: 'executor' } }),
    ], { now: NOW });
    expect(g[0].onlyBrowser).toBe(false);
  });
  it('não marca "só navegador" sem dedup por executor (não dá para afirmar)', () => {
    const g = groupLogs([log({ executor: 'browser' })], { now: NOW });
    expect(g[0].onlyBrowser).toBe(false);
  });
  it('ordena erro antes de aviso, depois pelo mais frequente', () => {
    const g = groupLogs([
      log({ level: 'warn', module: 'telegram', message: 'Falha ao enviar mensagem ao Telegram' }),
      log({ level: 'warn', module: 'telegram', message: 'Falha ao enviar mensagem ao Telegram' }),
      log({ message: 'Erro no scan de BTCUSDT: x' }),
    ], { now: NOW });
    expect(g[0].level).toBe('error');
    expect(g[1].level).toBe('warn');
  });
});

describe('explainLog', () => {
  it('lock ocupado é esperado', () => {
    const e = explainLog({ message: 'Scan completo ignorado — outra execução já está em andamento (lock ocupado)' });
    expect(e.tone).toBe('normal');
  });
  it('CAS descartado é esperado', () => {
    expect(explainLog({ message: 'Transição descartada pelo CAS: x' }).tone).toBe('normal');
  });
  it('Failed to fetch explica rede e diz que o cron pode não ter sido afetado', () => {
    const e = explainLog({ message: 'Erro no scan de BTCUSDT: Failed to fetch' });
    expect(e.tone).toBe('attention');
    expect(e.action).toMatch(/Observe se repete/);
  });
  it('rede: o texto muda conforme quem registrou (cron × navegador)', () => {
    const cron = explainLog({ message: 'Erro no scan de BTCUSDT: Failed to fetch', executor: 'cron' });
    const nav = explainLog({ message: 'Erro no scan de BTCUSDT: Failed to fetch', executor: 'browser' });
    expect(cron.meaning).toMatch(/scan agendado/);
    expect(nav.action).toMatch(/Não afeta o scan agendado/);
    expect(cron.meaning).not.toBe(nav.meaning);
  });
  it('451 no cron é problema de verdade; no navegador é limitação aceita', () => {
    expect(explainLog({ message: 'HTTP 451', executor: 'cron' }).action).toMatch(/Avise/);
    expect(explainLog({ message: 'HTTP 451', executor: 'browser' }).action).toMatch(/Não afeta/);
  });
  it('usa a classe do erro quando a mensagem não é conhecida', () => {
    expect(explainLog({ message: 'algo estranho', details: { error_class: 'RATE_LIMIT' } }).meaning).toMatch(/esperar/);
  });
  it('451 explica Binance Futuros × Spot', () => {
    expect(explainLog({ message: 'HTTP 451 Binance' }).meaning).toMatch(/Spot/);
  });
  it('mensagem desconhecida devolve null — nunca inventa', () => {
    expect(explainLog({ message: 'mensagem que ninguém conhece' })).toBeNull();
    expect(explainLog(null)).toBeNull();
  });
});

describe('healthSummary', () => {
  it('unknown quando não há leitura', () => {
    expect(healthSummary([], { now: NOW, known: false }).status).toBe('unknown');
  });
  it('ok sem erros nem avisos recentes', () => {
    const s = healthSummary([log({ level: 'info' })], { now: NOW });
    expect(s.status).toBe('ok');
    expect(s.headline).toMatch(/Tudo normal/);
  });
  it('ok (sem alarme) quando o erro é só do navegador, e diz isso nos motivos', () => {
    const s = healthSummary([log({ executor: 'browser', details: { dedup_scope: 'executor' } })], { now: NOW });
    expect(s.status).toBe('ok');
    expect(s.reasons.join(' ')).toMatch(/só do navegador/);
  });
  it('attention com 1 erro do scan agendado', () => {
    const s = healthSummary([log({ symbol: 'BTCUSDT', executor: 'cron', details: { dedup_scope: 'executor' } })], { now: NOW });
    expect(s.status).toBe('attention');
  });
  it('problem com erro em 3 ou mais ativos', () => {
    const s = healthSummary(['AAAUSDT', 'BBBUSDT', 'CCCUSDT'].map((symbol) => log({ symbol, executor: 'cron', details: { dedup_scope: 'executor' } })), { now: NOW });
    expect(s.status).toBe('problem');
  });
  it('problem com falha ao adquirir lock', () => {
    const s = healthSummary([log({ module: 'scanner', message: 'Falha ao adquirir lock do scan' })], { now: NOW });
    expect(s.status).toBe('problem');
  });
  it('erro antigo (>24h) não pesa', () => {
    expect(healthSummary([log({ created_date: ago(40) })], { now: NOW }).status).toBe('ok');
  });
  it('devolve o horário do último registro', () => {
    expect(healthSummary([log({ created_date: ago(3) }), log({ created_date: ago(1) })], { now: NOW }).lastLogAt).toBe(NOW - 3600000);
  });
});

describe('hourlyActivity', () => {
  it('devolve 24 baldes e conta por nível na hora certa', () => {
    const b = hourlyActivity([log({ created_date: ago(0.2) }), log({ level: 'warn', created_date: ago(0.2) }), log({ level: 'info', created_date: ago(5) })], { now: NOW });
    expect(b).toHaveLength(24);
    expect(b[23].error).toBe(1);
    expect(b[23].warn).toBe(1);
    expect(b.reduce((n, x) => n + x.info, 0)).toBe(1);
  });
  it('ignora o que está fora da janela', () => {
    const b = hourlyActivity([log({ created_date: ago(30) })], { now: NOW });
    expect(b.reduce((n, x) => n + x.error, 0)).toBe(0);
  });
});

describe('legendas', () => {
  it('cobrem os 4 níveis e os 2 executores', () => {
    expect(LEVEL_HELP.map((l) => l.label)).toEqual(['ERR', 'WARN', 'INFO', 'DBG']);
    expect(Object.keys(EXECUTOR_HELP)).toEqual(['cron', 'browser']);
  });
});
