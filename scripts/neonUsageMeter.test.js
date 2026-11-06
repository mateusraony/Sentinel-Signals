// Item 294 — a conta do medidor de uso do Neon (parte pura). Números calculados à mão:
// scan a cada 15 min, 1 min de duração + 5 min de ociosidade = 6 min acordado a cada 15 (40%); 96 execuções = 9,6 h = 2,4 CU-h (x 0,25 CU).
// O que se prova: o período de cobrança, que janelas sobrepostas contam uma vez só, o teto por execução, a projeção, a calibração,
// os níveis nas fronteiras exatas (60% / 80% / projeção ≥ 100) e que a mensagem é neutra, sem emoji e diz o que fica de fora.
import { describe, it, expect } from 'vitest';
import {
  WARN_RATIO, CRIT_RATIO, MAX_RUN_MIN, RECENT_WINDOWS_H, MIN_HOURS_FOR_PROJECTION, MORNING_BEFORE_UTC_HOUR,
  billingPeriod, toIntervals, awakeMs, parseBaseline, levelOf, summarize, shouldSend, buildMessage,
} from './neonUsageMeter.mjs';

const MIN = 60000;
const H = 3600000;
const T0 = Date.UTC(2026, 10, 1); // 01/11/2026 00:00 UTC
/** `count` execuções, uma a cada `everyMin`, cada uma com `durMin` de duração. */
const scanRuns = (startMs, count, everyMin, durMin = 1) => Array.from({ length: count }, (_, i) => ({
  startMs: startMs + i * everyMin * MIN, endMs: startMs + i * everyMin * MIN + durMin * MIN,
}));

describe('constantes (a mensagem e o orçamento dependem delas)', () => {
  it('avisa em 60% e 80% (mais cedo que 70/90 porque a conta é um mínimo), teto de 60 min por execução, ritmo de 24 h e 72 h, resumo da manhã', () => {
    expect([WARN_RATIO, CRIT_RATIO, MAX_RUN_MIN, RECENT_WINDOWS_H, MIN_HOURS_FOR_PROJECTION, MORNING_BEFORE_UTC_HOUR]).toEqual([0.6, 0.8, 60, [24, 72], 24, 18]);
  });
});

describe('billingPeriod — o período de cobrança', () => {
  it('padrão: do dia 1 deste mês ao dia 1 do próximo (UTC)', () => {
    const p = billingPeriod(Date.UTC(2026, 10, 5, 12));
    expect([p.startMs, p.endMs]).toEqual([Date.UTC(2026, 10, 1), Date.UTC(2026, 11, 1)]);
  });

  it('o instante exato da virada já pertence ao período novo', () => {
    expect(billingPeriod(T0).startMs).toBe(T0);
    expect(billingPeriod(T0 - 1).startMs).toBe(Date.UTC(2026, 9, 1));
  });

  it('dia de cobrança diferente: antes do dia, vale o período que começou no mês anterior (inclusive na virada do ano)', () => {
    const a = billingPeriod(Date.UTC(2026, 10, 5), 10);
    expect([a.startMs, a.endMs]).toEqual([Date.UTC(2026, 9, 10), Date.UTC(2026, 10, 10)]);
    const b = billingPeriod(Date.UTC(2027, 0, 5), 10);
    expect([b.startMs, b.endMs]).toEqual([Date.UTC(2026, 11, 10), Date.UTC(2027, 0, 10)]);
    const c = billingPeriod(Date.UTC(2027, 0, 15), 1);
    expect([c.startMs, c.endMs]).toEqual([Date.UTC(2027, 0, 1), Date.UTC(2027, 1, 1)]);
  });

  it('dia inválido (0, 29, texto, decimal) cai no dia 1', () => {
    for (const d of [0, 29, 'x', 1.5, null, undefined, -3]) expect(billingPeriod(Date.UTC(2026, 10, 5), d).startMs, String(d)).toBe(T0);
  });
});

describe('toIntervals e awakeMs — o tempo em que o banco ficou acordado', () => {
  it('cada execução vale duração + 5 min de ociosidade', () => {
    expect(toIntervals([{ startMs: T0, endMs: T0 + MIN }], { nowMs: T0 + H })).toEqual([[T0, T0 + 6 * MIN]]);
  });

  it('execução longa conta só até o teto (60 min) + ociosidade', () => {
    const [[a, b]] = toIntervals([{ startMs: T0, endMs: T0 + 3 * H }], { nowMs: T0 + 4 * H });
    expect(b - a).toBe(65 * MIN);
  });

  it('em andamento (sem fim) vale até agora; fim antes do início e início inválido são ignorados', () => {
    expect(toIntervals([{ startMs: T0, endMs: null }], { nowMs: T0 + 10 * MIN })).toEqual([[T0, T0 + 15 * MIN]]);
    expect(toIntervals([{ startMs: T0, endMs: T0 - 1 }, { startMs: NaN, endMs: 1 }, null, {}], { nowMs: T0 + H })).toEqual([]);
    expect(toIntervals(null, { nowMs: T0 })).toEqual([]);
  });

  it('janelas que se sobrepõem ou se encostam contam UMA vez só', () => {
    expect(awakeMs([[0, 6 * MIN], [3 * MIN, 9 * MIN]], 0, H)).toBe(9 * MIN);
    expect(awakeMs([[0, 6 * MIN], [6 * MIN, 12 * MIN]], 0, H)).toBe(12 * MIN);
    expect(awakeMs([[0, 6 * MIN], [10 * MIN, 16 * MIN]], 0, H)).toBe(12 * MIN); // separadas: somam
    expect(awakeMs([[0, 10 * MIN], [2 * MIN, 4 * MIN], [8 * MIN, 12 * MIN]], 0, H)).toBe(12 * MIN); // uma janela dentro da outra não encurta a união
  });

  it('o recorte [de, até] vale; o que está fora não entra; vazio dá zero', () => {
    expect(awakeMs([[0, 10 * MIN]], 4 * MIN, 8 * MIN)).toBe(4 * MIN);
    expect(awakeMs([[0, 10 * MIN]], 20 * MIN, 30 * MIN)).toBe(0);
    expect(awakeMs([], 0, H)).toBe(0);
  });
});

describe('summarize — a conta do mês', () => {
  it('scan a cada 15 min por 24 h: 40% acordado = 9,6 h = 2,4 CU-h', () => {
    const s = summarize({ runs: scanRuns(T0, 96, 15), nowMs: T0 + 24 * H });
    expect(s.usedCu).toBeCloseTo(2.4, 9);
    expect(s.ratio).toBeCloseTo(0.024, 9);
    expect(s.level).toBe('ok');
    expect(s.limit).toBe(100);
    expect(s.periodStartMs).toBe(T0);
  });

  it('scan a cada 5 min: o banco nunca dorme (24 h acordado = 6 CU-h por dia) — o estouro real de outubro', () => {
    const s = summarize({ runs: scanRuns(T0, 288, 5), nowMs: T0 + 24 * H });
    expect(s.usedCu).toBeCloseTo(6, 9);
    expect(s.recentShare).toBeCloseTo(1, 9);
    expect(s.projectedCu).toBeCloseTo(6 + 696 * 0.25, 6); // 180: passa do limite
    expect(s.level).toBe('atencao'); // projeção ≥ 100 já é ATENÇÃO, mesmo com 6% usado
  });

  it('projeção pelo ritmo das últimas 72 h: 3 dias a 15 min → o mês fecha em 72 CU-h; cada hora de painel aberto soma 0,15', () => {
    const s = summarize({ runs: scanRuns(T0, 288, 15), nowMs: T0 + 72 * H });
    expect(s.usedCu).toBeCloseTo(7.2, 9);
    expect(s.recentShare).toBeCloseTo(0.4, 9);
    expect(s.projectedCu).toBeCloseTo(72, 6);
    expect(s.panelHourCu).toBeCloseTo(0.15, 9);
    expect(s.level).toBe('ok');
  });

  it('com menos de 24 h de dados não projeta (nem inventa o custo do painel)', () => {
    const s = summarize({ runs: scanRuns(T0, 92, 15), nowMs: T0 + 23 * H });
    expect(s.recentShare).toBeNull();
    expect(s.projectedCu).toBeNull();
    expect(s.panelHourCu).toBeNull();
  });

  it('o ritmo recente é o MAIOR entre as últimas 24 h e 72 h: aumento aparece na hora, queda só aos poucos', () => {
    // Antes: 2 dias a cada 15 min (40%); no último dia a cada 5 min (100%) → 24 h = 1,0; 72 h = (48 x 0,4 + 24 x 1) / 72 = 0,6 → vale 1,0.
    const subiu = summarize({ runs: [...scanRuns(T0, 192, 15), ...scanRuns(T0 + 48 * H, 288, 5)], nowMs: T0 + 72 * H });
    expect(subiu.recentShare).toBeCloseTo(1, 6);
    // 2 dias a cada 5 min (100%) e depois 1 dia a cada 15 min (40%) → 24 h = 0,4; 72 h = (48 x 1 + 24 x 0,4) / 72 = 0,8 → vale 0,8.
    const caiu = summarize({ runs: [...scanRuns(T0, 576, 5), ...scanRuns(T0 + 48 * H, 96, 15)], nowMs: T0 + 72 * H });
    expect(caiu.recentShare).toBeCloseTo(0.8, 6);
    // O dia a dia estável não muda nada: 3 dias a cada 15 min → 0,4 nas duas janelas.
    expect(summarize({ runs: scanRuns(T0, 288, 15), nowMs: T0 + 72 * H }).recentShare).toBeCloseTo(0.4, 6);
  });

  it('REGRESSÃO (achado com dado real): scan religado há 1 dia depois de dias desligado não subestima o mês', () => {
    // 3 dias sem nada e depois 1 dia a cada 15 min (40%): olhando só as 72 h daria 0,1; o certo é olhar também o último dia.
    const s = summarize({ runs: scanRuns(T0 + 72 * H, 96, 15), nowMs: T0 + 96 * H });
    expect(s.recentShare).toBeCloseTo(0.4, 6);
    expect(s.usedCu).toBeCloseTo(2.4, 6);
    expect(s.projectedCu).toBeCloseTo(2.4 + (720 - 96) * 0.4 * 0.25, 6); // 64,8
  });

  it('calibração: soma o valor do console e só o que vem DEPOIS dele; baseline fora do período ou no futuro é ignorada', () => {
    const runs = scanRuns(T0, 384, 15); // 4 dias
    const now = T0 + 96 * H;
    const com = summarize({ runs, nowMs: now, baseline: { cuHours: 50, atMs: T0 + 72 * H } });
    expect(com.usedCu).toBeCloseTo(50 + 24 * 0.4 * 0.25, 6); // 52,4
    expect(com.calibratedAtMs).toBe(T0 + 72 * H);
    const sem = summarize({ runs, nowMs: now }).usedCu;
    for (const atMs of [T0 - H, now + H]) {
      const s = summarize({ runs, nowMs: now, baseline: { cuHours: 50, atMs } });
      expect(s.usedCu, String(atMs)).toBeCloseTo(sem, 9);
      expect(s.calibratedAtMs).toBeNull();
    }
    expect(summarize({ runs, nowMs: now, baseline: { cuHours: -1, atMs: T0 + H } }).calibratedAtMs).toBeNull();
  });

  it('sem nenhuma execução: zero usado, nível OK, sem quebrar', () => {
    const s = summarize({ runs: [], nowMs: T0 + 10 * H });
    expect(s.usedCu).toBe(0);
    expect(s.level).toBe('ok');
  });
});

describe('parseBaseline — as variáveis do repositório', () => {
  it('aceita número com ponto ou vírgula e data ISO', () => {
    expect(parseBaseline({ NEON_BASELINE_CU_HOURS: '50,5', NEON_BASELINE_AT: '2026-11-06T12:00:00Z' })).toEqual({ cuHours: 50.5, atMs: Date.UTC(2026, 10, 6, 12) });
    expect(parseBaseline({ NEON_BASELINE_CU_HOURS: '0', NEON_BASELINE_AT: '2026-11-06' })?.cuHours).toBe(0);
  });

  it('faltando um dos dois, vazio, negativo, texto ou data inválida: null (a medição segue sem calibração)', () => {
    for (const env of [
      {}, { NEON_BASELINE_CU_HOURS: '50' }, { NEON_BASELINE_AT: '2026-11-06' },
      { NEON_BASELINE_CU_HOURS: '', NEON_BASELINE_AT: '2026-11-06' }, { NEON_BASELINE_CU_HOURS: '  ', NEON_BASELINE_AT: '2026-11-06' },
      { NEON_BASELINE_CU_HOURS: '-5', NEON_BASELINE_AT: '2026-11-06' }, { NEON_BASELINE_CU_HOURS: 'muito', NEON_BASELINE_AT: '2026-11-06' },
      { NEON_BASELINE_CU_HOURS: '50', NEON_BASELINE_AT: 'ontem' },
    ]) expect(parseBaseline(env), JSON.stringify(env)).toBeNull();
  });
});

describe('levelOf — as fronteiras exatas', () => {
  it('OK abaixo de 60; ATENÇÃO de 60 a 79,99; CRÍTICO a partir de 80', () => {
    expect(levelOf({ usedCu: 59.99, projectedCu: null })).toBe('ok');
    expect(levelOf({ usedCu: 60, projectedCu: null })).toBe('atencao');
    expect(levelOf({ usedCu: 79.99, projectedCu: null })).toBe('atencao');
    expect(levelOf({ usedCu: 80, projectedCu: null })).toBe('critico');
    expect(levelOf({ usedCu: 150, projectedCu: null })).toBe('critico');
  });

  it('projeção do mês ≥ 100 já é ATENÇÃO; 99,9 não; CRÍTICO ganha da projeção', () => {
    expect(levelOf({ usedCu: 10, projectedCu: 99.9 })).toBe('ok');
    expect(levelOf({ usedCu: 10, projectedCu: 100 })).toBe('atencao');
    expect(levelOf({ usedCu: 85, projectedCu: 200 })).toBe('critico');
  });

  it('respeita um limite diferente de 100', () => {
    expect(levelOf({ usedCu: 30, projectedCu: null, limit: 50 })).toBe('atencao');
    expect(levelOf({ usedCu: 40, projectedCu: null, limit: 50 })).toBe('critico');
  });
});

describe('shouldSend — quando avisar', () => {
  const at = (h) => Date.UTC(2026, 10, 5, h, 17);

  it('manual: sempre (o botão "Enviar" foi marcado de propósito)', () => {
    for (const level of ['ok', 'atencao', 'critico']) expect(shouldSend({ level, nowMs: at(23), trigger: 'manual' }), level).toBe(true);
  });

  it('agendado de manhã: sempre (o resumo diário prova que o medidor está vivo)', () => {
    for (const level of ['ok', 'atencao', 'critico']) expect(shouldSend({ level, nowMs: at(11), trigger: 'schedule' }), level).toBe(true);
  });

  it('agendado à noite: só se o nível não for OK; a fronteira é 18h UTC', () => {
    expect(shouldSend({ level: 'ok', nowMs: at(23), trigger: 'schedule' })).toBe(false);
    expect(shouldSend({ level: 'atencao', nowMs: at(23), trigger: 'schedule' })).toBe(true);
    expect(shouldSend({ level: 'critico', nowMs: at(23), trigger: 'schedule' })).toBe(true);
    expect(shouldSend({ level: 'ok', nowMs: at(17), trigger: 'schedule' })).toBe(true);
    expect(shouldSend({ level: 'ok', nowMs: at(18), trigger: 'schedule' })).toBe(false);
  });
});

describe('buildMessage — o texto do Telegram', () => {
  const base = () => summarize({ runs: scanRuns(T0, 288, 15), nowMs: T0 + 72 * H });
  const fake = (over) => ({ ...base(), ...over });
  const semTagsFixas = (t) => t.replace(/<\/?b>/g, '');

  it('nível OK: números em português, projeção, período, o que fica de fora e nenhuma recomendação', () => {
    const t = buildMessage(base());
    expect(t).toContain('<b>Neon: uso de computação do mês (estimado)</b>');
    expect(t).toContain('Situação: <b>OK</b>');
    expect(t).toContain('Usado até agora: 7,2 de 100,0 CU-h (7%)');
    expect(t).toContain('o mês termina com cerca de 72,0 CU-h');
    expect(t).toContain('No ritmo recente');
    expect(t).toContain('Período: 01/11 a 01/12 (horário UTC).');
    expect(t).toMatch(/É um mínimo/);
    expect(t).toContain('cada hora com ele aberto soma cerca de 0,15 CU-h');
    expect(t).not.toMatch(/Para gastar menos|Perto do limite/);
  });

  it('ATENÇÃO e CRÍTICO trazem a recomendação certa', () => {
    expect(buildMessage(fake({ level: 'atencao', usedCu: 65, ratio: 0.65 }))).toMatch(/Situação: <b>ATENÇÃO<\/b>[\s\S]*feche as abas do painel/);
    const c = buildMessage(fake({ level: 'critico', usedCu: 85, ratio: 0.85 }));
    expect(c).toContain('Situação: <b>CRÍTICO</b>');
    expect(c).toMatch(/Perto do limite: se a cota acabar, o scan e o painel param/);
  });

  it('sem dados para projetar: diz isso em vez de inventar número', () => {
    const t = buildMessage(fake({ projectedCu: null, panelHourCu: null, recentShare: null }));
    expect(t).toContain('Ainda sem dados suficientes para projetar o fim do mês.');
    expect(t).toContain('Não inclui o painel aberto: ele mantém o banco acordado.');
    expect(t).not.toMatch(/termina com cerca de/);
  });

  it('calibrado: avisa que o ponto de partida é o valor do console', () => {
    const t = buildMessage(fake({ calibratedAtMs: Date.UTC(2026, 10, 6) }));
    expect(t).toContain('Calibrado com o valor do console do Neon de 06/11');
    expect(t).not.toMatch(/É um mínimo/);
  });

  it('sem emoji, curto, sem HTML além das duas marcas fixas e sem nada que pareça segredo', () => {
    for (const level of ['ok', 'atencao', 'critico']) {
      const t = buildMessage(fake({ level }));
      expect(/\p{Extended_Pictographic}/u.test(t), level).toBe(false);
      expect(t.length, level).toBeLessThan(1200);
      expect(semTagsFixas(t), level).not.toMatch(/[<>&]/);
      expect(t, level).not.toMatch(/https?:|token|bot\d|chat_id/i);
    }
  });

  it('neutro: nada de previsão de mercado nem de ordem', () => {
    expect(buildMessage(base())).not.toMatch(/compra|venda|vai subir|vai cair|probabilidade/i);
  });
});
