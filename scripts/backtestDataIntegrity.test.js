// docs/known-risks.md item 260 — integridade das séries de candles do
// backtest. Funções puras: série sintética entra, lista de problemas sai.
import { describe, it, expect } from 'vitest';
import {
  timeframeToMs, validateCandleSeries, checkWindowCoverage, requiredTimeframes,
  describeIssue, warmupStartMs, MAX_TOLERATED_GAP_MS, FUTURES_ARCHIVE_LAG_MS, repairTruncatedCloseTimes,
  findTruncatedCandles, candleMatchesSubBars,
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

  // Review do Codex (PR #476): diretório reaproveitado/arquivo truncado é
  // indistinguível de símbolo recém-listado olhando só a série — por isso o
  // padrão é ERRO e a folga é declarada por quem baixou o dado.
  it('série que começa depois do início da janela é ERRO por padrão', () => {
    expect(types(checkWindowCoverage(s, { ...meta, fromMs: T0 - 2 * H, toMs: T0 + 48 * H })))
      .toEqual(['error:starts_after_window']);
  });

  it('com allowLateStart (dado recém-baixado: símbolo listado no meio da janela) vira AVISO', () => {
    expect(types(checkWindowCoverage(s, { ...meta, fromMs: T0 - 2 * H, toMs: T0 + 48 * H, allowLateStart: true })))
      .toEqual(['warning:starts_after_window']);
  });

  it('série que termina antes do fim da janela é ERRO por padrão, mesmo por pouco', () => {
    const lastClose = s[s.length - 1].closeTime;
    expect(types(checkWindowCoverage(s, { ...meta, fromMs: T0, toMs: lastClose + 2 * H })))
      .toEqual(['error:ends_before_window']);
  });

  it('com maxEndShortfallMs (Futures, arquivo diário não publicado) vira AVISO até o limite e ERRO acima', () => {
    const lastClose = s[s.length - 1].closeTime;
    const opts = { ...meta, fromMs: T0, maxEndShortfallMs: FUTURES_ARCHIVE_LAG_MS };
    expect(types(checkWindowCoverage(s, { ...opts, toMs: lastClose + FUTURES_ARCHIVE_LAG_MS })))
      .toEqual(['warning:ends_slightly_before_window']);
    expect(types(checkWindowCoverage(s, { ...opts, toMs: lastClose + FUTURES_ARCHIVE_LAG_MS + 1 })))
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

  it('Fibonacci 15m (item 267) exige o 15m mesmo com a confirmação 15m pulada', () => {
    expect(requiredTimeframes(asset(), { pineConfig: { skip15mConfirmationEnabled: true, fibEntryEnabled: true } }))
      .toEqual(['1h', '4h', '1d', '15m']);
  });

  it('alvo de Fibonacci (item 281) exige o 15m mesmo com a confirmação 15m pulada', () => {
    expect(requiredTimeframes(asset(), { pineConfig: { skip15mConfirmationEnabled: true, targetMode: 'fib_ext_15m' } }))
      .toEqual(['1h', '4h', '1d', '15m']);
    expect(requiredTimeframes(asset(), { pineConfig: { skip15mConfirmationEnabled: true, targetMode: 'swing_4h' } }))
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

// Item 281, 1ª execução do targets-test.yml: em 2021-08-13 a Binance parou e a
// vela em andamento saiu com closeTime no instante da parada (antes do fim
// normal), na mesma hora em todas as moedas — o validador recusava a janela W0.
describe('repairTruncatedCloseTimes — vela fechada cedo por parada da exchange', () => {
  const HALT = 50 * 60 * 1000; // parada 50 min depois da abertura da vela
  const halted = (n, intervalMs, at, { gapAfter = 0 } = {}) => {
    const s = series(n, intervalMs);
    s[at] = { ...s[at], closeTime: s[at].openTime + HALT };
    if (gapAfter) for (let i = at + 1; i < s.length; i++) s[i] = bar(s[i].openTime + gapAfter * intervalMs, intervalMs);
    return s;
  };
  // Prova cruzada: outro timeframe da mesma moeda parou no mesmo instante.
  const confirmed = { ...meta, isCorroborated: () => true };

  it('reproduz a falha: sem conserto, a vela encurtada é ERRO no validador', () => {
    expect(types(validateCandleSeries(halted(6, H, 2, { gapAfter: 2 }), meta))).toEqual(['error:close_time_mismatch', 'warning:gap']);
  });

  it('1h com parada confirmada + buraco: closeTime volta ao fim normal, sobra só AVISO', () => {
    const raw = halted(6, H, 2, { gapAfter: 2 });
    const { series: fixed, issues } = repairTruncatedCloseTimes(raw, confirmed);
    expect(fixed[2].closeTime).toBe(raw[2].openTime + H - 1);
    expect(raw[2].closeTime).toBe(raw[2].openTime + HALT); // não muta a entrada
    expect(types(issues)).toEqual(['warning:close_time_truncated_repaired']);
    expect(issues[0].samples[0]).toMatchObject({ closeTime: new Date(raw[2].openTime + HALT).toISOString() });
    expect(types(validateCandleSeries(fixed, meta))).toEqual(['warning:gap']);
  });

  // Review do Codex (PR #509, P1): isolamento sozinho não prova parada.
  it('sem prova cruzada NADA é consertado — vela parcial isolada continua ERRO', () => {
    const raw = halted(6, H, 2, { gapAfter: 2 });
    const { series: out, issues } = repairTruncatedCloseTimes(raw, meta);
    expect(out).toBe(raw);
    expect(issues).toEqual([]);
    const refused = repairTruncatedCloseTimes(raw, { ...meta, isCorroborated: () => false });
    expect(refused.series).toBe(raw);
  });

  it('4h sem buraco (a negociação voltou antes da vela seguinte) também é consertada com prova', () => {
    const m4 = { symbol: 'BTCUSDT', timeframe: '4h' };
    const { series: fixed, issues } = repairTruncatedCloseTimes(halted(6, 4 * H, 3), { ...m4, isCorroborated: () => true });
    expect(types(issues)).toEqual(['warning:close_time_truncated_repaired']);
    expect(validateCandleSeries(fixed, m4)).toEqual([]);
  });

  it('nunca adianta a vela: o closeTime consertado é >= o original (conservador, sem look-ahead)', () => {
    const raw = halted(6, H, 2, { gapAfter: 1 });
    const { series: fixed } = repairTruncatedCloseTimes(raw, confirmed);
    fixed.forEach((c, i) => expect(c.closeTime).toBeGreaterThanOrEqual(raw[i].closeTime));
  });

  it('série limpa volta como a MESMA referência (dado que já passava não muda um byte)', () => {
    const clean = series(10);
    const { series: out, issues } = repairTruncatedCloseTimes(clean, confirmed);
    expect(out).toBe(clean);
    expect(issues).toEqual([]);
  });

  it('arquivo inteiro com closeTime curto (de outro intervalo) não é candidato — continua ERRO', () => {
    const wrong = series(5).map((c) => ({ ...c, closeTime: c.openTime + 15 * 60 * 1000 - 1 }));
    expect(findTruncatedCandles(wrong, '1h')).toEqual([]);
    const { series: out } = repairTruncatedCloseTimes(wrong, confirmed);
    expect(out).toBe(wrong);
    expect(types(validateCandleSeries(out, meta))).toEqual(['error:close_time_mismatch']);
  });

  it('vela na ponta da série (sem uma das vizinhas) não é candidata', () => {
    expect(findTruncatedCandles(halted(4, H, 0), '1h')).toEqual([]);
    expect(findTruncatedCandles(halted(4, H, 3), '1h')).toEqual([]);
    expect(findTruncatedCandles(halted(4, H, 1), '1h')).toEqual([1]);
  });

  it('vela mais LONGA que o intervalo nunca é tocada (aí sim olharia o futuro)', () => {
    const s = series(5);
    s[2] = { ...s[2], closeTime: s[2].openTime + 2 * H - 1 };
    expect(repairTruncatedCloseTimes(s, confirmed).series).toBe(s);
  });

  it('vela seguinte começando dentro do intervalo não é tratada como parada', () => {
    const s = series(3);
    s[1] = { ...s[1], closeTime: s[1].openTime + HALT };
    s.splice(2, 0, bar(s[1].openTime + 30 * 60 * 1000));
    expect(repairTruncatedCloseTimes(s, confirmed).series).toBe(s);
  });

  it('describeIssue mostra o closeTime real da 1ª ocorrência (diagnóstico pelo log do runner)', () => {
    const s = series(5);
    s[2] = { ...s[2], closeTime: s[2].openTime + 2 * H - 1 };
    const [issue] = validateCandleSeries(s, meta).filter((i) => i.type === 'close_time_mismatch');
    expect(describeIssue(issue)).toContain(`closeTime ${new Date(s[2].closeTime).toISOString()}`);
  });
});

// Item 281, 2ª execução do targets-test.yml: em 2021-09-29 o 4h das 04:00 saiu
// com closeTime 06:59:59.999 (3 h) — o 1h e o 15m não têm vela encurtada ali,
// só buraco. A prova passa a ser o CONTEÚDO contra o agregado do timeframe menor.
describe('candleMatchesSubBars — prova por conteúdo (4h cortado às 07:00)', () => {
  const H4 = 4 * H;
  // 1h com valores distintos: o agregado de 0,1,2 é open 100 / high 104 / low 98 / close 103 / vol 30.
  const hourly = (n) => Array.from({ length: n }, (_, i) => bar(T0 + i * H, H, { open: 100 + i, high: 102 + i, low: 98 + i, close: 101 + i, volume: 10 }));
  const cut4h = (overrides = {}) => ({
    openTime: T0, closeTime: T0 + 3 * H - 1, open: 100, high: 104, low: 98, close: 103, volume: 30, ...overrides,
  });
  const m4 = { symbol: 'BTCUSDT', timeframe: '4h' };
  const around = (candle) => [bar(T0 - H4, H4), candle, bar(T0 + H4, H4)];

  it('reproduz a falha: sem prova nenhuma, o 4h de 3 h é ERRO (o que travou o W0)', () => {
    expect(types(validateCandleSeries(around(cut4h()), m4))).toEqual(['error:close_time_mismatch']);
  });

  it('1h de 07:00 ausente (parada): o agregado de 04, 05 e 06 bate', () => {
    expect(candleMatchesSubBars(cut4h(), hourly(3), H4)).toMatchObject({ ok: true, subBars: 3 });
  });

  // Review do Codex (PR #510, P1): se o 1h das 07:00 existe, o 4h cortado omite
  // negociação real; estender o closeTime o faria passar por completo.
  it('1h de 07:00 EXISTE: o 4h cortado NÃO é verificado (omitiria a negociação das 07:00)', () => {
    const r = candleMatchesSubBars(cut4h(), hourly(4), H4);
    expect(r).toMatchObject({ ok: false, subBars: 4 });
    expect(r.detail).toContain('agregado de 4 vela(s)');
  });

  it('conteúdo que não bate NÃO é verificado e o detalhe mostra os dois lados', () => {
    const r = candleMatchesSubBars(cut4h({ high: 110 }), hourly(3), H4);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('high 110');
    expect(r.detail).toContain('high 104');
  });

  it('sem velas menores no recorte, não há o que comparar — não verifica', () => {
    expect(candleMatchesSubBars(cut4h(), [], H4)).toMatchObject({ ok: false });
    expect(candleMatchesSubBars(cut4h(), [bar(T0 + 10 * H, H)], H4)).toMatchObject({ ok: false });
    expect(candleMatchesSubBars(cut4h(), null, H4)).toMatchObject({ ok: false });
  });

  it('tolerância: diferença de 1e-12 relativo passa; de 1e-3 não', () => {
    expect(candleMatchesSubBars(cut4h({ high: 104 * (1 + 1e-12) }), hourly(3), H4).ok).toBe(true);
    expect(candleMatchesSubBars(cut4h({ high: 104 * (1 + 1e-3) }), hourly(3), H4).ok).toBe(false);
    expect(candleMatchesSubBars(cut4h({ volume: 30 * (1 + 1e-3) }), hourly(3), H4).ok).toBe(false);
  });

  it('com a prova, repairTruncatedCloseTimes conserta e registra COMO foi provado', () => {
    const raw = around(cut4h());
    const proof = (c) => candleMatchesSubBars(c, hourly(3), H4);
    const { series: fixed, issues } = repairTruncatedCloseTimes(raw, { ...m4, isCorroborated: (c) => ({ ...proof(c), via: 'conteúdo = agregado de 1h' }) });
    expect(types(issues)).toEqual(['warning:close_time_truncated_repaired']);
    expect(issues[0].samples[0]).toMatchObject({ via: 'conteúdo = agregado de 1h' });
    expect(fixed[1].closeTime).toBe(T0 + H4 - 1);
    expect(validateCandleSeries(fixed, m4)).toEqual([]);
  });

  it('prova que falha vira aviso de DIAGNÓSTICO e a vela continua ERRO', () => {
    const raw = around(cut4h({ high: 110 }));
    const proof = (c) => candleMatchesSubBars(c, hourly(3), H4);
    const { series: out, issues } = repairTruncatedCloseTimes(raw, { ...m4, isCorroborated: proof });
    expect(out).toBe(raw);
    expect(types(issues)).toEqual(['warning:close_time_truncated_unverified']);
    expect(describeIssue(issues[0])).toContain('SEM prova');
    expect(describeIssue(issues[0])).toContain('high 110');
    expect(types(validateCandleSeries(out, m4))).toEqual(['error:close_time_mismatch']);
  });

  it('prova booleana sem detalhe (contrato antigo) não gera aviso de diagnóstico', () => {
    const raw = around(cut4h());
    expect(repairTruncatedCloseTimes(raw, { ...m4, isCorroborated: () => false }).issues).toEqual([]);
  });
});
