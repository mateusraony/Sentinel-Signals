// Modo de observação sem banco, fase O1 (item 299): a orquestração que grava o retrato ao fim de um scan.
// Provas que importam: (1) SEM a URL do RTDB não há efeito nenhum, nem uma consulta a mais ao Postgres; (2) nada aqui pode derrubar o scan
// (nunca lança); (3) o que sai para o log (que é PÚBLICO) é só contagem e código, nunca a mensagem crua de um erro.
import { describe, it, expect, vi } from 'vitest';
import { publishObservationSnapshot, describePublishResult } from './observationPublish.mjs';

const NOW = Date.parse('2026-11-11T12:00:00Z');
const OP = { id: 'op-1', asset_id: 'a1', symbol: 'BTCUSDT', side: 'BUY', status: 'SIGNAL_CONFIRMED', entry_price: 100, initial_stop: 95, current_stop: 95, tp1: 107.5, tp2: 115 };
const ASSET = { id: 'a1', symbol: 'BTCUSDT', display_name: 'BTC/USDT', is_active: true };

function setup({ ops = [OP], filters = { sources: ['cron'] }, opsErro = null, filtrosErro = null, writeErro = null, writeResultado = { ok: true } } = {}) {
  const backend = {
    entities: {
      TradeOperation: { filter: vi.fn(async () => { if (opsErro) throw opsErro; return ops; }) },
      TelegramFilters: { get: vi.fn(async () => { if (filtrosErro) throw filtrosErro; return filters; }) },
    },
  };
  const store = { write: vi.fn(async () => { if (writeErro) throw writeErro; return writeResultado; }) };
  return { backend, store };
}
const rodar = (s, extra = {}) => publishObservationSnapshot({
  env: { OBSERVATION_DATABASE_URL: 'https://exemplo-default-rtdb.firebaseio.com' }, backend: s.backend, store: s.store, assets: [ASSET], nowMs: NOW, scanId: 'scan-1', ...extra,
});

describe('publishObservationSnapshot — desligado por padrão', () => {
  it.each([[undefined], [''], ['   ']])('sem URL (%j): não lê o banco, não grava e diz por quê', async (url) => {
    const s = setup();
    const r = await rodar(s, { env: { OBSERVATION_DATABASE_URL: url } });
    expect(r).toMatchObject({ ok: false, skipped: 'sem_url' });
    expect(s.backend.entities.TradeOperation.filter).not.toHaveBeenCalled();
    expect(s.backend.entities.TelegramFilters.get).not.toHaveBeenCalled();
    expect(s.store.write).not.toHaveBeenCalled();
  });

  it('a variável do FIREBASE_DATABASE_URL (marcadores de alerta) NÃO liga o retrato: são chaves diferentes de propósito', async () => {
    const s = setup();
    const r = await publishObservationSnapshot({ env: { FIREBASE_DATABASE_URL: 'https://x.firebaseio.com' }, backend: s.backend, store: s.store, assets: [ASSET], nowMs: NOW });
    expect(r.skipped).toBe('sem_url');
    expect(s.store.write).not.toHaveBeenCalled();
  });
});

describe('publishObservationSnapshot — caminho feliz', () => {
  it('lê só as operações VIVAS (filtro por situação) e os filtros do Telegram, e grava UM retrato', async () => {
    const s = setup();
    const r = await rodar(s);
    expect(s.backend.entities.TradeOperation.filter).toHaveBeenCalledTimes(1);
    expect(s.backend.entities.TradeOperation.filter).toHaveBeenCalledWith({ status: ['SIGNAL_CONFIRMED', 'RUNNER_ACTIVE'] });
    expect(s.backend.entities.TelegramFilters.get).toHaveBeenCalledWith('current');
    expect(s.store.write).toHaveBeenCalledTimes(1);
    const gravado = s.store.write.mock.calls[0][0];
    expect(gravado).toMatchObject({ version: 1, snapshot_at: '2026-11-11T12:00:00.000Z', scan_id: 'scan-1', telegram_filters: { sources: ['cron'] } });
    expect(gravado.operations.map((o) => o.id)).toEqual(['op-1']);
    expect(r).toMatchObject({ ok: true, operations: 1, assets: 1, dropped: 0 });
    expect(r.bytes).toBeGreaterThan(0);
  });

  it('sem operações vivas AINDA grava (o carimbo de frescor precisa avançar: retrato vazio e novo ≠ retrato velho)', async () => {
    const s = setup({ ops: [] });
    const r = await rodar(s);
    expect(s.store.write).toHaveBeenCalledTimes(1);
    expect(s.store.write.mock.calls[0][0].operations).toEqual([]);
    expect(r).toMatchObject({ ok: true, operations: 0 });
  });

  it('falha ao ler os filtros do Telegram NÃO impede o retrato (vai com filtros nulos)', async () => {
    const s = setup({ filtrosErro: new Error('banco caiu no meio') });
    const r = await rodar(s);
    expect(r.ok).toBe(true);
    expect(s.store.write.mock.calls[0][0].telegram_filters).toBeNull();
  });
});

describe('publishObservationSnapshot — falhas (nunca lança, nunca vaza)', () => {
  it('falha ao ler as operações: não grava (um retrato sem operações enganaria o vigia) e devolve só o código', async () => {
    const s = setup({ opsErro: Object.assign(new Error('connect ECONNREFUSED postgresql://u:SENHA-SECRETA@ep-x.neon.tech/db'), { code: 'ECONNREFUSED' }) });
    const r = await rodar(s);
    expect(r).toMatchObject({ ok: false, erro: 'ECONNREFUSED' });
    expect(s.store.write).not.toHaveBeenCalled();
    expect(JSON.stringify(r)).not.toContain('SENHA-SECRETA');
    expect(JSON.stringify(r)).not.toContain('neon.tech');
  });

  it('falha ao gravar no RTDB: devolve só o código, sem a mensagem', async () => {
    const s = setup({ writeErro: Object.assign(new Error('PERMISSION_DENIED em https://projeto.firebaseio.com com token abc123'), { code: 'PERMISSION_DENIED' }) });
    const r = await rodar(s);
    expect(r).toMatchObject({ ok: false, erro: 'PERMISSION_DENIED' });
    expect(JSON.stringify(r)).not.toContain('abc123');
    expect(JSON.stringify(r)).not.toContain('firebaseio');
  });

  it('erro sem código usa o nome do erro; mensagem nunca aparece', async () => {
    const s = setup({ writeErro: new TypeError('segredo-na-mensagem') });
    const r = await rodar(s);
    expect(r.erro).toBe('TypeError');
    expect(JSON.stringify(r)).not.toContain('segredo-na-mensagem');
  });

  it('timeout do armazenamento vira o código "timeout"', async () => {
    const s = setup({ writeErro: new Error('Timeout: observationSnapshot não retornou em 10000ms (ver docs/known-risks.md itens 142 e 162).') });
    expect((await rodar(s)).erro).toBe('timeout');
  });

  it('retrato recusado (muitas operações) não chega ao armazenamento', async () => {
    const muitas = Array.from({ length: 101 }, (_, i) => ({ ...OP, id: `op-${i}` }));
    const s = setup({ ops: muitas });
    const r = await rodar(s);
    expect(r).toMatchObject({ ok: false, reason: 'muitas_operacoes' });
    expect(s.store.write).not.toHaveBeenCalled();
  });

  it('NUNCA lança, nem com dependências quebradas', async () => {
    await expect(publishObservationSnapshot({ env: { OBSERVATION_DATABASE_URL: 'https://x' }, backend: undefined, store: undefined, assets: undefined, nowMs: NOW })).resolves.toMatchObject({ ok: false });
    await expect(publishObservationSnapshot({ env: undefined })).resolves.toMatchObject({ ok: false, skipped: 'sem_url' });
    await expect(publishObservationSnapshot()).resolves.toMatchObject({ ok: false });
  });

  it('a leitura do banco tem prazo: banco travado não prende o scan', async () => {
    const s = setup();
    s.backend.entities.TradeOperation.filter = vi.fn(() => new Promise(() => {})); // nunca responde
    const r = await rodar(s, { readTimeoutMs: 20 });
    expect(r).toMatchObject({ ok: false, erro: 'timeout' });
    expect(s.store.write).not.toHaveBeenCalled();
  });
});

describe('describePublishResult — a linha do log público (só contagem e código)', () => {
  it('cada resultado vira UMA linha curta em português, sem nada além de números e códigos', () => {
    expect(describePublishResult({ ok: true, operations: 3, assets: 10, dropped: 0, bytes: 2048 })).toMatch(/^\[scan\] retrato: gravado · ops=3 ativos=10 .*2,0 KB/);
    expect(describePublishResult({ ok: true, operations: 3, assets: 10, dropped: 2, bytes: 2048 })).toContain('descartadas=2');
    expect(describePublishResult({ ok: false, skipped: 'sem_url' })).toMatch(/desligado/);
    expect(describePublishResult({ ok: false, skipped: 'banco_com_falha' })).toMatch(/banco com falha/);
    expect(describePublishResult({ ok: false, erro: 'ECONNREFUSED' })).toBe('[scan] retrato: não gravado (ECONNREFUSED)');
    expect(describePublishResult({ ok: false, reason: 'muitas_operacoes' })).toContain('muitas_operacoes');
  });

  it('regras publicadas do RTDB abertas: linha EXPLÍCITA (é condição de segurança, não um erro qualquer) e só o código', () => {
    const linha = describePublishResult({ ok: false, erro: 'regras_abertas' });
    expect(linha).toMatch(/RECUSADO/);
    expect(linha).toContain('regras_abertas');
    expect(linha).toMatch(/nada foi gravado/i);
    const outra = describePublishResult({ ok: false, erro: 'regras_nao_verificadas' });
    expect(outra).toMatch(/não gravado/);
    expect(outra).toContain('regras_nao_verificadas');
  });

  it('um código estranho (com texto livre) não passa para o log', () => {
    expect(describePublishResult({ ok: false, erro: 'postgres://u:SENHA@host/db' })).not.toContain('SENHA');
    expect(describePublishResult({ ok: false, erro: 'x'.repeat(300) }).length).toBeLessThan(120);
    expect(describePublishResult(undefined)).toMatch(/não gravado/);
  });
});
