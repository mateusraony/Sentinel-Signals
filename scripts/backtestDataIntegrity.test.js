// docs/known-risks.md item 260 — integridade das séries de candles do
// backtest. Funções puras: série sintética entra, lista de problemas sai.
import { describe, it, expect } from 'vitest';
import {
  timeframeToMs, validateCandleSeries, checkWindowCoverage, requiredTimeframes,
  describeIssue, warmupStartMs, MAX_TOLERATED_GAP_MS, MAX_TOLERATED_END_SHORTFALL_MS,
} from './backtestDataIntegrity.js';

const H = 60 * 60 * 1000;
const T0 = new Date('2026-01-01T00:00:00.000Z').getTime();

function bar(openTime, intervalMs = H, overrides = {}) {
  return { openTime, closeTime: openTime + intervalMs - 1, open: 100, high: 101, low: 99, close: 100.5, volume: 10, ...overrides };
}
function series(n, intervalMs = H, start = T0) {
  return Array.from({ length: n }, (_, i) => bar(start + i * intervalMs, intervalMs));
}
const meta = { symbol: 'BTCUSDT', timeframe: '1h' };
const types = (issues) => issues.map((i) => `${i.severity}:${i.type}`);

describe('timeframeToMs', () => {
  it('converte os intervalos da Binance usados no backtest', () => {
    expect(timeframeToMs('5m')).toBe(5 * 60 * 1000);
    expect(timeframeToMs('15m')).toBe(15 * 60 * 1000);
    expect(timeframeToMs('1h')).toBe(H);
    expect(timeframeToMs('4h')).toBe(4 * H);
    expect(timeframeToMs('1d')).toBe(24 * H);
  });

  it('devolve null para intervalo sem duração fixa ou desconhecido', () => {
    expect(timeframeToMs('1M')).toBeNull();
    expect(timeframeToMs('abc')).toBeNull();
  });
});

describe('validateCandleSeries', () => {
  it('série contínua, ordenada e válida não tem problema', () => {
    expect(validateCandleSeries(series(50), meta)).toEqual([]);
  });

  it('série vazia é erro (era o que o arquivo ausente virava em silêncio)', () => {
    expect(types(validateCandleSeries([], meta))).toEqual(['error:empty_series']);
  });

  it('conteúdo que não é lista é erro', () => {
    expect(types(validateCandleSeries({ candles: [] }, meta))).toEqual(['error:not_an_array']);
  });

  it('candle duplicado é erro — quebra a busca binária de sliceClosedAsOf', () => {
    const s = series(5);
    s.splice(3, 0, { ...s[2] });
    const issues = validateCandleSeries(s, meta);
    expect(types(issues)).toEqual(['error:duplicate']);
    expect(issues[0].samples[0].at).toBe(new Date(s[2].openTime).toISOString());
  });

  it('candle fora de ordem é erro', () => {
    const s = series(5);
    [s[1], s[2]] = [s[2], s[1]];
    expect(types(validateCandleSeries(s, meta))).toContain('error:not_sorted');
  });

  // Codex review (PR #475, P1): sliceClosedAsOf busca por closeTime.
  it('closeTime de outro intervalo é erro, mesmo com openTime em ordem', () => {
    const s = series(5);
    s[2] = { ...s[2], closeTime: s[2].openTime + 4 * H - 1 };
    // O close de 4h também passa o das velas seguintes — os dois erros são reais.
    expect(types(validateCandleSeries(s, meta))).toEqual(['error:close_time_mismatch', 'error:close_time_not_sorted']);
  });

  it('closeTime fora de ordem é erro, mesmo com openTime em ordem', () => {
    // Com intervalo conhecido isso já sai como close_time_mismatch (o close
    // teria de invadir a vela seguinte); a checagem de ordem é o que cobre
    // intervalo sem duração fixa ('1M'), onde o teto não pode ser calculado.
    const monthly = { symbol: 'BTCUSDT', timeframe: '1M' };
    const s = [
      bar(T0, 31 * 24 * H),
      { ...bar(T0 + 31 * 24 * H, 28 * 24 * H), closeTime: T0 + 31 * 24 * H + 1 },
    ];
    s[0] = { ...s[0], closeTime: T0 + 40 * 24 * H };
    expect(types(validateCandleSeries(s, monthly))).toEqual(['error:close_time_not_sorted']);
  });

  it('close que invade a vela seguinte é pego com intervalo conhecido', () => {
    const s = series(5);
    s[2] = { ...s[2], closeTime: s[3].closeTime };
    expect(types(validateCandleSeries(s, meta))).toEqual(['error:close_time_mismatch', 'error:close_time_not_sorted']);
  });

  // Revisão do pacote 1: o limite INFERIOR é o que causa look-ahead — com
  // closeTime cedo demais, sliceClosedAsOf expõe a vela inteira antes de ela
  // fechar.
  it('closeTime CEDO demais (ex.: de 15m num arquivo de 1h) é erro — look-ahead', () => {
    const s = series(5).map((c) => ({ ...c, closeTime: c.openTime + 15 * 60 * 1000 - 1 }));
    const issues = validateCandleSeries(s, meta);
    expect(types(issues)).toEqual(['error:close_time_mismatch']);
    expect(issues[0].count).toBe(5);
  });

  it('closeTime = openTime + intervalo exato (CSV em microssegundos arredondado) é aceito', () => {
    const s = series(5).map((c) => ({ ...c, closeTime: c.openTime + H }));
    expect(validateCandleSeries(s, meta)).toEqual([]);
  });

  it('candle desalinhado do intervalo é erro', () => {
    const s = series(3);
    s.push(bar(s[2].openTime + H + 30 * 60 * 1000));
    expect(types(validateCandleSeries(s, meta))).toEqual(['error:misaligned']);
  });

  it.each([
    ['preço NaN', { close: NaN }],
    ['preço zero', { low: 0 }],
    ['high abaixo do close', { high: 100, close: 100.5 }],
    ['low acima do open', { low: 100.2 }],
    ['volume negativo', { volume: -1 }],
    ['closeTime antes do openTime', { closeTime: T0 - 1 }],
  ])('barra inválida é erro: %s', (_, overrides) => {
    const s = series(3);
    s[0] = { ...s[0], ...overrides };
    expect(types(validateCandleSeries(s, meta))).toContain('error:invalid_bar');
  });

  it('buraco curto é só AVISO (pode ser parada real da exchange) e informa quantos candles faltam', () => {
    const s = [...series(3), ...series(3, H, T0 + 6 * H)]; // faltam as velas de 3h, 4h e 5h
    const issues = validateCandleSeries(s, meta);
    expect(types(issues)).toEqual(['warning:gap']);
    expect(issues[0].samples[0]).toMatchObject({ missingCandles: 3 });
  });

  it('buraco a partir do limite tolerado é ERRO — inclusive exatamente 24h (dia de arquivo pulado no download de Futures)', () => {
    const missing = MAX_TOLERATED_GAP_MS / H;
    const s = [...series(3), ...series(3, H, T0 + (3 + missing) * H)];
    expect(types(validateCandleSeries(s, meta))).toEqual(['error:gap_too_large']);
    const d = { symbol: 'BTCUSDT', timeframe: '1d' };
    const days = [bar(T0, 24 * H), bar(T0 + 2 * 24 * H, 24 * H)]; // 1 vela de 1d faltando
    expect(types(validateCandleSeries(days, d))).toEqual(['error:gap_too_large']);
  });

  it('buraco logo abaixo do limite ainda é aviso', () => {
    const missing = MAX_TOLERATED_GAP_MS / H - 1;
    const s = [...series(3), ...series(3, H, T0 + (3 + missing) * H)];
    expect(types(validateCandleSeries(s, meta))).toEqual(['warning:gap']);
  });

  it('conta todas as ocorrências, mas guarda no máximo 5 amostras', () => {
    const s = series(20);
    const doubled = s.flatMap((c) => [c, { ...c }]);
    const [issue] = validateCandleSeries(doubled, meta);
    expect(issue.count).toBe(20);
    expect(issue.samples).toHaveLength(5);
  });
});

describe('checkWindowCoverage', () => {
  const s = series(48); // T0 .. T0+47h, último closeTime = T0+48h-1

  it('série que cobre a janela não tem problema', () => {
    expect(checkWindowCoverage(s, { ...meta, fromMs: T0, toMs: T0 + 48 * H })).toEqual([]);
  });

  it('tolera até um intervalo de folga em cada ponta (alinhamento do download e candle em formação)', () => {
    expect(checkWindowCoverage(s, { ...meta, fromMs: T0 - H + 1, toMs: T0 + 49 * H - 1 })).toEqual([]);
  });

  it('série que começa depois do início da janela é só AVISO (símbolo listado no meio dela)', () => {
    expect(types(checkWindowCoverage(s, { ...meta, fromMs: T0 - 2 * H, toMs: T0 + 48 * H })))
      .toEqual(['warning:starts_after_window']);
  });

  it('série que termina pouco antes do fim (até o limite) é AVISO — arquivo diário ainda não publicado', () => {
    const lastClose = s[s.length - 1].closeTime;
    expect(types(checkWindowCoverage(s, { ...meta, fromMs: T0, toMs: lastClose + MAX_TOLERATED_END_SHORTFALL_MS })))
      .toEqual(['warning:ends_slightly_before_window']);
  });

  it('série que termina muito antes do fim da janela é ERRO', () => {
    const lastClose = s[s.length - 1].closeTime;
    expect(types(checkWindowCoverage(s, { ...meta, fromMs: T0, toMs: lastClose + MAX_TOLERATED_END_SHORTFALL_MS + 1 })))
      .toEqual(['error:ends_before_window']);
  });

  it('elemento que não é candle nas pontas não derruba a checagem (o erro já sai em validateCandleSeries)', () => {
    expect(() => checkWindowCoverage([null, ...s, null], { ...meta, fromMs: T0, toMs: T0 + 48 * H })).not.toThrow();
    expect(checkWindowCoverage([null, ...s, null], { ...meta, fromMs: T0, toMs: T0 + 48 * H })).toEqual([]);
  });

  it('dados além da janela (diretório reaproveitado) não são problema', () => {
    expect(checkWindowCoverage(s, { ...meta, fromMs: T0 + 10 * H, toMs: T0 + 20 * H })).toEqual([]);
  });

  it('série vazia não gera aviso de cobertura duplicado (o erro já vem de validateCandleSeries)', () => {
    expect(checkWindowCoverage([], { ...meta, fromMs: T0, toMs: T0 + H })).toEqual([]);
  });
});

describe('requiredTimeframes', () => {
  // Mesmo formato do makeAsset de run-backtest.mjs.
  const asset = (overrides = {}) => ({
    symbol: 'BTCUSDT', timeframes_enabled: { '1h': true, '4h': true, '1d': true }, smc_enabled: false, ...overrides,
  });

  it('timeframes ligados no ativo + 15m da confirmação RF', () => {
    expect(requiredTimeframes(asset(), { pineConfig: {} })).toEqual(['1h', '4h', '1d', '15m']);
  });

  it('derivado do ativo (revisão do pacote 1): timeframe ligado a mais entra, desligado sai — mesma regra `!== false` do scanAsset', () => {
    expect(requiredTimeframes(asset({ timeframes_enabled: { '1h': true, '4h': true, '1d': false, '2h': true } }), {}))
      .toEqual(['1h', '4h', '2h', '15m']);
  });

  it('sem timeframes_enabled cai no padrão do scanAsset (1h/4h/1d)', () => {
    expect(requiredTimeframes({ symbol: 'X' }, {})).toEqual(['1h', '4h', '1d', '15m']);
  });

  it('sem 15m quando a confirmação 15m está desligada', () => {
    expect(requiredTimeframes(asset(), { pineConfig: { skip15mConfirmationEnabled: true } }))
      .toEqual(['1h', '4h', '1d']);
  });

  it('5m só para ativo com a cascata SMC', () => {
    expect(requiredTimeframes(asset({ smc_enabled: true }), {})).toContain('5m');
    expect(requiredTimeframes(asset(), {})).not.toContain('5m');
  });
});

describe('warmupStartMs (--warmup-candles)', () => {
  it('recua N velas DO PRÓPRIO timeframe a partir do --from', () => {
    expect(warmupStartMs(T0, '1d', 500)).toBe(T0 - 500 * 24 * H);
    expect(warmupStartMs(T0, '5m', 500)).toBe(T0 - 500 * 5 * 60 * 1000);
  });

  it('0 velas = sem aquecimento (comportamento anterior)', () => {
    expect(warmupStartMs(T0, '4h', 0)).toBe(T0);
  });

  it('intervalo sem duração fixa não recua', () => {
    expect(warmupStartMs(T0, '1M', 500)).toBe(T0);
  });
});

describe('describeIssue', () => {
  it('elemento sem instante (null) não imprime "undefined" como 1ª ocorrência', () => {
    const [issue] = validateCandleSeries([...series(3), null], meta);
    expect(describeIssue(issue)).toBe('BTCUSDT 1h: candle com valor inválido (NaN, preço ≤ 0, high/low incoerente) (1x)');
  });

  it('gera uma linha legível com símbolo, timeframe, contagem e 1ª ocorrência', () => {
    const [issue] = validateCandleSeries([], meta);
    expect(describeIssue(issue)).toBe('BTCUSDT 1h: série vazia (1x)');
    const s = series(3);
    s.push({ ...s[2] });
    const [dup] = validateCandleSeries(s, meta);
    expect(describeIssue(dup)).toBe(`BTCUSDT 1h: candle duplicado (1x) — 1ª ocorrência em ${new Date(s[2].openTime).toISOString()}`);
  });
});
