// docs/known-risks.md item 164 — a auditoria só presta se o relatório for
// legível. Sem agrupamento ela devolve o log cru com outro nome, e um
// relatório que ninguém lê é exatamente o estado que ela existe para consertar.
import { describe, it, expect } from 'vitest';
import { agrupar, celula, haQuantoTempo, normalizarMensagem } from './healthAuditFormat.mjs';

describe('normalizarMensagem', () => {
  it('junta o mesmo problema em ativos diferentes', () => {
    expect(normalizarMensagem('BTCUSDT falhou ao buscar candles'))
      .toBe(normalizarMensagem('LDOUSDT falhou ao buscar candles'));
  });

  it('junta o mesmo problema com números diferentes', () => {
    expect(normalizarMensagem('Timeout: não retornou em 90000ms'))
      .toBe(normalizarMensagem('Timeout: não retornou em 300000ms'));
  });

  it('NÃO junta problemas realmente diferentes', () => {
    expect(normalizarMensagem('BTCUSDT falhou ao buscar candles'))
      .not.toBe(normalizarMensagem('BTCUSDT falhou ao gravar operação'));
  });

  it('degrada sem lançar', () => {
    expect(normalizarMensagem(null)).toBe('');
    expect(normalizarMensagem(undefined)).toBe('');
  });
});

describe('agrupar', () => {
  const log = (over = {}) => ({ module: 'scanner', message: 'BTCUSDT falhou', created_date: '2026-09-05T10:00:00.000Z', ...over });

  it('conta ocorrências e ordena do mais frequente ao menos', () => {
    const grupos = agrupar([
      log(), log({ symbol: 'ETHUSDT', message: 'ETHUSDT falhou' }),
      log({ module: 'alerts', message: 'outra coisa' }),
    ]);
    expect(grupos[0].total).toBe(2);
    expect(grupos[1].total).toBe(1);
  });

  it('conta ATIVOS DISTINTOS — é isso que separa falha sistêmica de azar de um símbolo', () => {
    // A assinatura do item 136: o mesmo erro em muitos ativos ao mesmo tempo.
    const grupos = agrupar([
      log({ symbol: 'BTCUSDT', message: 'BTCUSDT falhou' }),
      log({ symbol: 'ETHUSDT', message: 'ETHUSDT falhou' }),
      log({ symbol: 'LDOUSDT', message: 'LDOUSDT falhou' }),
    ]);
    expect(grupos).toHaveLength(1);
    expect(grupos[0].ativos.size).toBe(3);
  });

  it('o mesmo ativo repetindo NÃO infla a contagem de ativos', () => {
    const grupos = agrupar([
      log({ symbol: 'BTCUSDT' }), log({ symbol: 'BTCUSDT' }), log({ symbol: 'BTCUSDT' }),
    ]);
    expect(grupos[0].total).toBe(3);
    expect(grupos[0].ativos.size).toBe(1); // 1 ativo — não é sistêmico
  });

  it('guarda a janela de tempo do grupo', () => {
    const grupos = agrupar([
      log({ created_date: '2026-09-05T10:00:00.000Z' }),
      log({ created_date: '2026-09-05T08:00:00.000Z' }),
    ]);
    expect(grupos[0].primeiro).toBe('2026-09-05T08:00:00.000Z');
    expect(grupos[0].ultimo).toBe('2026-09-05T10:00:00.000Z');
  });

  it('degrada sem lançar em entrada vazia ou malformada', () => {
    expect(agrupar([])).toEqual([]);
    expect(agrupar(null)).toEqual([]);
    expect(agrupar([{}])).toHaveLength(1);
  });
});

describe('haQuantoTempo', () => {
  const AGORA = Date.parse('2026-09-05T12:00:00.000Z');

  it('usa minuto, hora e dia conforme a distância', () => {
    expect(haQuantoTempo('2026-09-05T11:30:00.000Z', AGORA)).toBe('há 30min');
    expect(haQuantoTempo('2026-09-05T09:00:00.000Z', AGORA)).toBe('há 3h');
    expect(haQuantoTempo('2026-09-01T12:00:00.000Z', AGORA)).toBe('há 4.0d');
  });

  it('não devolve "há 0min" para algo que acabou de acontecer', () => {
    expect(haQuantoTempo('2026-09-05T11:59:59.000Z', AGORA)).toBe('há 1min');
  });

  it('data ausente, inválida ou no futuro não vira texto sem sentido', () => {
    expect(haQuantoTempo(null, AGORA)).toBe('?');
    expect(haQuantoTempo('lixo', AGORA)).toBe('?');
    expect(haQuantoTempo('2026-09-06T00:00:00.000Z', AGORA)).toBe('?');
  });
});

describe('celula', () => {
  it('escapa | para não quebrar a tabela do relatório', () => {
    expect(celula('a | b')).toBe('a \\| b');
    expect(celula(null)).toBe('');
  });
});
