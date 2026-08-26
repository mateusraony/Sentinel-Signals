import { describe, it, expect } from 'vitest';
import {
  buildMonthlyUrl,
  buildDailyUrl,
  monthsInRange,
  daysInMonthRange,
  parseKlineCsv,
  dedupeAndFilterCandles,
  buildMonthlyFundingUrl,
  buildDailyFundingUrl,
  parseFundingCsv,
  snapFundingCalcTime,
  dedupeAndFilterFunding,
  MAX_ARCHIVE_BYTES,
  assertArchiveSizeWithinLimit,
} from './binanceArchive.js';

describe('buildMonthlyUrl/buildDailyUrl', () => {
  it('monta a URL mensal com mês preenchido com zero', () => {
    expect(buildMonthlyUrl('BTCUSDT', '1h', 2024, 7)).toBe(
      'https://data.binance.vision/data/futures/um/monthly/klines/BTCUSDT/1h/BTCUSDT-1h-2024-07.zip'
    );
  });

  it('monta a URL diária com dia e mês preenchidos com zero', () => {
    expect(buildDailyUrl('ETHUSDT', '4h', 2025, 3, 5)).toBe(
      'https://data.binance.vision/data/futures/um/daily/klines/ETHUSDT/4h/ETHUSDT-4h-2025-03-05.zip'
    );
  });
});

describe('monthsInRange', () => {
  it('um único mês quando o intervalo cabe todo nele', () => {
    const from = Date.UTC(2024, 6, 10); // 2024-07-10
    const to = Date.UTC(2024, 6, 20); // 2024-07-20
    expect(monthsInRange(from, to)).toEqual([{ year: 2024, month: 7 }]);
  });

  it('inclui os meses parciais nas duas pontas', () => {
    const from = Date.UTC(2024, 5, 25); // 2024-06-25
    const to = Date.UTC(2024, 7, 5); // 2024-08-05
    expect(monthsInRange(from, to)).toEqual([
      { year: 2024, month: 6 },
      { year: 2024, month: 7 },
      { year: 2024, month: 8 },
    ]);
  });

  it('atravessa virada de ano corretamente', () => {
    const from = Date.UTC(2024, 11, 20); // 2024-12-20
    const to = Date.UTC(2025, 0, 10); // 2025-01-10
    expect(monthsInRange(from, to)).toEqual([
      { year: 2024, month: 12 },
      { year: 2025, month: 1 },
    ]);
  });
});

describe('daysInMonthRange', () => {
  it('devolve só os dias que caem dentro do intervalo pedido', () => {
    const from = Date.UTC(2024, 6, 28); // 2024-07-28
    const to = Date.UTC(2024, 7, 3); // 2024-08-03 (mês seguinte)
    expect(daysInMonthRange(2024, 7, from, to)).toEqual([28, 29, 30, 31]);
  });

  it('mês inteiro quando o intervalo cobre tudo', () => {
    const from = Date.UTC(2024, 1, 1); // fevereiro (bissexto)
    const to = Date.UTC(2024, 2, 1);
    expect(daysInMonthRange(2024, 2, from, to)).toHaveLength(29);
  });
});

describe('parseKlineCsv', () => {
  const row = (openTime, closeTime) =>
    `${openTime},50000.00,50100.00,49900.00,50050.00,12.5,${closeTime},625000.00,100,6.0,300000.00,0`;

  it('parseia linhas sem cabeçalho (formato antigo)', () => {
    const csv = [row(1700000000000, 1700003599999), row(1700003600000, 1700007199999)].join('\n');
    const candles = parseKlineCsv(csv);
    expect(candles).toHaveLength(2);
    expect(candles[0]).toEqual({
      openTime: 1700000000000,
      open: 50000,
      high: 50100,
      low: 49900,
      close: 50050,
      volume: 12.5,
      closeTime: 1700003599999,
    });
  });

  it('pula a linha de cabeçalho quando presente (formato novo)', () => {
    const header = 'open_time,open,high,low,close,volume,close_time,quote_volume,count,taker_buy_volume,taker_buy_quote_volume,ignore';
    const csv = [header, row(1700000000000, 1700003599999)].join('\n');
    const candles = parseKlineCsv(csv);
    expect(candles).toHaveLength(1);
    expect(candles[0].openTime).toBe(1700000000000);
  });

  it('detecta e converte timestamps em microssegundos (arquivos 2025+) para milissegundos', () => {
    // Mesmo instante que 1700000000000ms, só que em µs (×1000).
    const csv = row(1700000000000000, 1700003599999000);
    const candles = parseKlineCsv(csv);
    expect(candles[0].openTime).toBe(1700000000000);
    expect(candles[0].closeTime).toBe(1700003599999);
  });

  it('ignora linhas em branco/malformadas sem quebrar o parse das válidas', () => {
    const csv = ['', row(1700000000000, 1700003599999), '   ', 'x,y'].join('\n');
    expect(parseKlineCsv(csv)).toHaveLength(1);
  });
});

describe('dedupeAndFilterCandles', () => {
  const make = (openTime, closeTime) => ({ openTime, open: 1, high: 1, low: 1, close: 1, volume: 1, closeTime });

  it('ordena por openTime', () => {
    const out = dedupeAndFilterCandles([make(300, 301), make(100, 101), make(200, 201)], 0, 1000, 10_000);
    expect(out.map((c) => c.openTime)).toEqual([100, 200, 300]);
  });

  it('deduplica por openTime (sobreposição mensal/diária), mantendo a última ocorrência', () => {
    const first = make(100, 101);
    const second = { ...make(100, 101), volume: 99 }; // mesma barra, fonte diferente
    const out = dedupeAndFilterCandles([first, second], 0, 1000, 10_000);
    expect(out).toHaveLength(1);
    expect(out[0].volume).toBe(99);
  });

  it('descarta candle fora de [fromMs, toMs)', () => {
    const out = dedupeAndFilterCandles([make(50, 51), make(100, 101), make(999, 1000)], 100, 999, 10_000);
    expect(out.map((c) => c.openTime)).toEqual([100]);
  });

  it('descarta candle ainda não fechado (closeTime no futuro)', () => {
    const out = dedupeAndFilterCandles([make(100, 20_000)], 0, 1_000_000, 10_000);
    expect(out).toHaveLength(0);
  });
});

// Item 125 (achado menor): downloadArchive() não checava o tamanho da
// resposta antes de bufferizar e passar pro AdmZip.
describe('assertArchiveSizeWithinLimit', () => {
  it('não lança para um tamanho normal (poucos MB, arquivo real)', () => {
    expect(() => assertArchiveSizeWithinLimit(5 * 1024 * 1024, 'BTCUSDT 1h 2024-07 (mensal)')).not.toThrow();
  });

  it('não lança exatamente no limite', () => {
    expect(() => assertArchiveSizeWithinLimit(MAX_ARCHIVE_BYTES, 'ctx')).not.toThrow();
  });

  it('lança acima do limite, com o contexto na mensagem', () => {
    expect(() => assertArchiveSizeWithinLimit(MAX_ARCHIVE_BYTES + 1, 'BTCUSDT 1h 2024-07 (mensal)'))
      .toThrow(/BTCUSDT 1h 2024-07 \(mensal\)/);
  });
});

// docs/known-risks.md item 131 — funding real. Este parser é a fronteira onde
// um erro corrompe silenciosamente 59% do custo medido do projeto, então os
// testes cobrem tanto o formato feliz quanto as formas de errar em silêncio.
describe('funding rate — URLs', () => {
  it('monta a URL mensal de fundingRate (sem componente de intervalo)', () => {
    expect(buildMonthlyFundingUrl('BTCUSDT', 2026, 7)).toBe(
      'https://data.binance.vision/data/futures/um/monthly/fundingRate/BTCUSDT/BTCUSDT-fundingRate-2026-07.zip'
    );
  });

  it('monta a URL diária de fundingRate', () => {
    expect(buildDailyFundingUrl('ETHUSDT', 2026, 8, 3)).toBe(
      'https://data.binance.vision/data/futures/um/daily/fundingRate/ETHUSDT/ETHUSDT-fundingRate-2026-08-03.zip'
    );
  });
});

describe('parseFundingCsv', () => {
  it('lê o formato publicado, com header', () => {
    const csv = [
      'calc_time,funding_interval_hours,last_funding_rate',
      '1767225600000,8,0.00010000',
      '1767254400000,8,-0.00005000',
    ].join('\n');
    expect(parseFundingCsv(csv)).toEqual([
      { calcTime: 1767225600000, intervalHours: 8, rate: 0.0001 },
      { calcTime: 1767254400000, intervalHours: 8, rate: -0.00005 },
    ]);
  });

  it('lê sem header, por posição documentada', () => {
    const rows = parseFundingCsv('1767225600000,8,0.0001');
    expect(rows).toHaveLength(1);
    expect(rows[0].rate).toBeCloseTo(0.0001, 9);
  });

  // A defesa central: se a Binance reordenar as colunas, resolver por NOME
  // mantém o resultado certo — resolver por posição daria um número plausível
  // e errado, que é o modo de falha caro aqui.
  it('resolve por NOME quando as colunas vêm em ordem diferente', () => {
    const csv = [
      'last_funding_rate,calc_time,funding_interval_hours',
      '0.0001,1767225600000,8',
    ].join('\n');
    expect(parseFundingCsv(csv)).toEqual([
      { calcTime: 1767225600000, intervalHours: 8, rate: 0.0001 },
    ]);
  });

  it('lança em header desconhecido em vez de adivinhar posição', () => {
    expect(() => parseFundingCsv('foo,bar,baz\n1,2,3')).toThrow(/header não reconhecido/);
  });

  it('lança em taxa implausível (sinal de coluna trocada)', () => {
    expect(() => parseFundingCsv('calc_time,funding_interval_hours,last_funding_rate\n1767225600000,8,1767225600000'))
      .toThrow(/implausível/);
  });

  it('normaliza timestamp em microssegundos como os klines', () => {
    const rows = parseFundingCsv('calc_time,funding_interval_hours,last_funding_rate\n1767225600000000,8,0.0001');
    expect(rows[0].calcTime).toBe(1767225600000);
  });

  it('intervalHours vira null quando a coluna não existe', () => {
    const rows = parseFundingCsv('calc_time,last_funding_rate\n1767225600000,0.0001');
    expect(rows[0].intervalHours).toBeNull();
    expect(rows[0].rate).toBeCloseTo(0.0001, 9);
  });

  it('devolve lista vazia para CSV vazio', () => {
    expect(parseFundingCsv('')).toEqual([]);
  });

  // Regressão do item 131 (Run #136): a Binance publica `calc_time` de 1 a
  // 24 ms DEPOIS da fronteira exata em 54,6% das liquidações. Como a janela
  // de cobrança de calcFundingCost é semiaberta `(entrada, saída]`, uma
  // operação que fecha EM CIMA da fronteira perdia justamente a liquidação
  // daquele instante — e caía inteira no fallback da constante. Foram 22 das
  // 24 operações contaminadas, todas a exatamente uma liquidação do esperado.
  it('ancora calc_time na fronteira quando a Binance carimba alguns ms depois', () => {
    const csv = [
      'calc_time,funding_interval_hours,last_funding_rate',
      '1785441600003,4,-0.00002057',
      '1785456000000,4,0.00001',
      '1785470400024,4,0.00002',
    ].join('\n');
    expect(parseFundingCsv(csv).map((r) => r.calcTime)).toEqual([
      1785441600000, 1785456000000, 1785470400000,
    ]);
  });

  it('ancorar não funde liquidações distintas (a cadência mínima real é horária)', () => {
    expect(snapFundingCalcTime(1785441600003)).toBe(1785441600000);
    expect(snapFundingCalcTime(1785441599976)).toBe(1785441600000);
    // Uma hora adiante continua uma liquidação separada.
    expect(snapFundingCalcTime(1785445200002)).toBe(1785445200000);
    expect(snapFundingCalcTime(Number.NaN)).toBeNaN();
  });
});

describe('dedupeAndFilterFunding', () => {
  it('ordena, deduplica e recorta para [from, to)', () => {
    const rows = [
      { calcTime: 300, rate: 0.3 },
      { calcTime: 100, rate: 0.1 },
      { calcTime: 300, rate: 0.3 },
      { calcTime: 500, rate: 0.5 },
    ];
    expect(dedupeAndFilterFunding(rows, 100, 500).map((r) => r.calcTime)).toEqual([100, 300]);
  });
});
