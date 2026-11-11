// Visual do cartão de resultado (addendum 20 do item 285): geometria e frases PURAS. Contas à mão; o vocabulário nunca vira "bom/ruim" nem previsão.
import { describe, it, expect } from 'vitest';
import {
  compareBars, deltaText, resultSummary, summaryText, monthLabel, altWindowText, gapExplanation, sparkGeometry, markerAt, horizonStatus, sizeFraction, maxAbsMove, gaugeBars, seriesExtremes, nearestPoint, hasPercentValues, sourceLine,
} from './resultVisual';

const MIN = 60 * 1000;
const close = (a, b, d = 6) => expect(a).toBeCloseTo(b, d);

describe('compareBars — anterior × atual na MESMA escala', () => {
  it('tudo positivo: o zero fica na esquerda e a barra maior ocupa a trilha menos a folga de 10% (contas à mão)', () => {
    const b = compareBars('+0,6%', '+0,3%');
    close(b.zero, 0);
    // escala 0 → 0,6 + 10% de folga = 0,66: anterior = 0,6/0,66 = 90,909…%, atual = 0,3/0,66 = 45,454…%
    close(b.previous.width, (0.6 / 0.66) * 100);
    close(b.actual.width, (0.3 / 0.66) * 100);
    expect(b.previous.left).toBe(0);
    expect(b.actual.left).toBe(0);
  });

  it('com valor negativo o zero aparece no meio da trilha e a barra negativa vai para a esquerda dele', () => {
    const b = compareBars('+0,3% m/m', '-0,3%');
    // lo = -0,3 - 10% de 0,6 = -0,36 ; hi = 0,3 + 0,06 = 0,36 → zero em 50%
    close(b.zero, 50);
    close(b.previous.left, 50);
    close(b.previous.width, (0.3 / 0.72) * 100);
    close(b.actual.width, (0.3 / 0.72) * 100);
    close(b.actual.left, 50 - (0.3 / 0.72) * 100);
  });

  it('valor muito pequeno não some (mínimo de 1,5%) e zero fica sem barra; sem número em um lado = null só nele', () => {
    const b = compareBars('+10,0%', '+0,0%');
    expect(b.actual.width).toBe(0);
    const c = compareBars('+10,0%', '+0,01%');
    expect(c.actual.width).toBeGreaterThanOrEqual(1.5);
    const d = compareBars('+0,6%', null);
    expect(d.actual).toBeNull();
    expect(d.previous.width).toBeGreaterThan(0);
    expect(compareBars(null, 'lixo')).toBeNull();
  });

  it('vagas (Payroll): a mesma conta em milhares', () => {
    const b = compareBars('+29 mil', '+165 mil');
    close(b.previous.width, (29 / 181.5) * 100);
    close(b.actual.width, (165 / 181.5) * 100);
  });
});

describe('deltaText — quanto mudou, em palavras', () => {
  it('percentual: pontos a mais / a menos, vírgula, singular até 1 ponto', () => {
    expect(deltaText('+0,6%', '+0,4%')).toBe('0,2 ponto a menos');
    expect(deltaText('+3,0%', '+4,0%')).toBe('1,0 ponto a mais');
    expect(deltaText('+3,0%', '+4,5%')).toBe('1,5 pontos a mais');
    expect(deltaText('-0,2%', '+0,5%')).toBe('0,7 ponto a mais');
  });
  it('vagas: milhares com ponto de milhar', () => {
    expect(deltaText('+29 mil', '+165 mil')).toBe('136 mil a mais');
    expect(deltaText('+1.234 mil', '+34 mil')).toBe('1.200 mil a menos');
  });
  it('sem mudança ou sem número: null', () => {
    expect(deltaText('+0,6%', '+0,6%')).toBeNull();
    expect(deltaText(null, '+0,6%')).toBeNull();
    expect(deltaText('+0,6%', 'lixo')).toBeNull();
  });
});

describe('lacuna oficial — frases do cartão (addendum 22)', () => {
  const yoyGap = { key: 'yoy', label: 'Em 12 meses', previous: '+3,7%', actual: null, revised: null, direction: null, gap: 'paralisacao_2025', gapMonth: '2025-10', alt: { pct: '+3,9%', from: '2025-11', to: '2026-10', months: 11 } };
  const mes = { key: 'mom', label: 'No mês', previous: '+0,6%', actual: '+0,4%', revised: null, direction: 'abaixo' };

  it('monthLabel: "AAAA-MM" em português curto; formato errado vira null', () => {
    expect(monthLabel('2025-10')).toBe('out/2025');
    expect(monthLabel('2026-01')).toBe('jan/2026');
    expect(monthLabel('2026-12')).toBe('dez/2026');
    for (const ruim of [null, undefined, 5, '', '2026-13', '2026-1', 'out/2025', '2026-10 <b>']) expect(monthLabel(ruim), JSON.stringify(ruim)).toBeNull();
  });

  it('a medida com lacuna diz POR QUÊ (nunca "indisponível" nem "aguardando")', () => {
    const s = resultSummary([mes, yoyGap], true);
    expect(s.map((x) => x.kind)).toEqual(['compare', 'gap']);
    expect(summaryText(s[1])).toBe('Em 12 meses: sem número oficial neste mês. O BLS não divulgou o índice de out/2025 (paralisação do governo dos EUA).');
    expect(summaryText(s[1])).not.toMatch(/indispon|aguardando/);
    const generico = resultSummary([{ ...yoyGap, gap: 'nao_divulgado' }], true)[0];
    expect(summaryText(generico)).toBe('Em 12 meses: sem número oficial neste mês. O BLS não divulgou o índice de out/2025.');
    const semMes = resultSummary([{ ...yoyGap, gapMonth: null }], true)[0];
    expect(summaryText(semMes)).toBe('Em 12 meses: sem número oficial neste mês. O BLS não divulgou o índice do mês usado na comparação (paralisação do governo dos EUA).');
  });

  it('sem lacuna registrada, a medida sem número continua "indisponível" (como antes)', () => {
    const { gap, gapMonth, alt, ...semGap } = yoyGap; // eslint-disable-line no-unused-vars
    expect(resultSummary([semGap], true)[0].kind).toBe('unavailable');
  });

  it('antes do número oficial a frase de espera vence, mesmo com lacuna', () => {
    expect(resultSummary([mes, yoyGap], false)).toEqual([{ key: 'wait', kind: 'wait' }]);
  });

  it('altWindowText: título e texto da janela; dado ruim = null', () => {
    expect(altWindowText(yoyGap.alt)).toEqual({ title: 'desde nov/2025 (11 meses)', body: 'de nov/2025 até out/2026, só com índices que o BLS publicou (sem ajuste sazonal).' });
    for (const ruim of [null, undefined, {}, { from: '2025-11', to: '2026-10' }, { from: 'x', to: '2026-10', months: 11 }]) expect(altWindowText(ruim)).toBeNull();
  });

  it('gapExplanation: o que o BLS não publicou, o que isso impede, "nada foi estimado" e a ressalva da janela', () => {
    expect(gapExplanation(yoyGap)).toEqual([
      'O BLS não coletou os preços de out/2025 por causa da paralisação do governo dos EUA e nunca publicou esse índice.',
      'Sem ele, o BLS também não divulga a variação em 12 meses de out/2026. Nada foi estimado.',
      'A janela alternativa é só uma referência: tem 11 meses e não se compara com os +3,7% de 12 meses da divulgação anterior.',
    ]);
    expect(gapExplanation({ ...yoyGap, gap: 'nao_divulgado', alt: null })).toEqual([
      'O BLS não publicou o índice de out/2025.',
      'Sem ele, o BLS também não divulga a variação em 12 meses de out/2026. Nada foi estimado.',
    ]);
    // sem o mês-base e sem anterior: nada de mês inventado
    const g = gapExplanation({ ...yoyGap, gapMonth: null, previous: null });
    expect(g[0]).toBe('O BLS não coletou os preços do mês usado na comparação por causa da paralisação do governo dos EUA e nunca publicou esse índice.');
    expect(g[1]).toBe('Sem ele, o BLS também não divulga a variação em 12 meses. Nada foi estimado.');
    expect(g[2]).toBe('A janela alternativa é só uma referência: tem 11 meses e não se compara com o número oficial de 12 meses.');
  });

  it('o vocabulário continua neutro: nenhuma frase fala de previsão, compra/venda, bom/ruim nem "acima/abaixo" da janela', () => {
    const todas = [
      ...resultSummary([mes, yoyGap], true).map(summaryText),
      ...gapExplanation(yoyGap), ...gapExplanation({ ...yoyGap, gap: 'nao_divulgado' }),
      altWindowText(yoyGap.alt).title, altWindowText(yoyGap.alt).body,
    ].join(' ');
    expect(todas).not.toMatch(/probabilidade|vai subir|vai cair|\bcompra|\bvenda|proje[cç]|previs[aã]o|\bbom\b|\bruim\b|melhor|pior|forte|fraco|estimativa|aproxima/i);
    expect(altWindowText(yoyGap.alt).title + altWindowText(yoyGap.alt).body).not.toMatch(/acima|abaixo/);
  });
});

describe('resultSummary / summaryText — frases simples e neutras', () => {
  const mes = { key: 'mom', label: 'No mês', previous: '+0,6%', actual: '+0,4%', revised: null, direction: 'abaixo' };
  const ano = { key: 'yoy', label: 'Em 12 meses', previous: '+3,7%', actual: null, revised: null, direction: null };

  it('antes do número oficial: uma frase de espera, sem número inventado', () => {
    const s = resultSummary([mes, ano], false);
    expect(s).toEqual([{ key: 'wait', kind: 'wait' }]);
    expect(summaryText(s[0])).toMatch(/ainda não publicou/);
  });

  it('com o número: compara com a divulgação anterior; a medida sem número diz "indisponível" (nunca "aguardando")', () => {
    const s = resultSummary([mes, ano], true);
    expect(s.map((x) => x.kind)).toEqual(['compare', 'unavailable']);
    expect(summaryText(s[0])).toBe('No mês: +0,4%, abaixo dos +0,6% da divulgação anterior.');
    expect(summaryText(s[1])).toBe('Em 12 meses: indisponível desta vez, não deu para calcular com os dados do BLS.');
    expect(summaryText(s[1])).not.toMatch(/aguardando/);
  });

  it('igual, acima, sem anterior e com anterior revisado', () => {
    const igual = resultSummary([{ ...mes, actual: '+0,6%', direction: 'igual' }], true)[0];
    expect(summaryText(igual)).toBe('No mês: +0,6%, igual ao da divulgação anterior (+0,6%).');
    const acima = resultSummary([{ ...mes, actual: '+0,9%', direction: 'acima' }], true)[0];
    expect(summaryText(acima)).toBe('No mês: +0,9%, acima dos +0,6% da divulgação anterior.');
    const sozinho = resultSummary([{ ...mes, previous: null, direction: null }], true)[0];
    expect(sozinho.kind).toBe('alone');
    expect(summaryText(sozinho)).toBe('No mês: +0,4%.');
    const rev = resultSummary([{ ...mes, revised: '+0,5%' }], true)[0];
    expect(summaryText(rev)).toBe('No mês: +0,4%, abaixo dos +0,6% da divulgação anterior. O anterior foi revisado para +0,5%.');
  });

  it('o vocabulário nunca vira "bom/ruim", compra/venda, probabilidade ou previsão', () => {
    const todas = [mes, ano, { ...mes, direction: 'acima' }, { ...mes, direction: 'igual' }]
      .flatMap((r) => [true, false].flatMap((o) => resultSummary([r], o).map(summaryText))).join(' ');
    expect(todas).not.toMatch(/probabilidade|vai subir|vai cair|\bcompra|\bvenda|proje[cç]|previs[aã]o|\bbom\b|\bruim\b|melhor|pior|forte|fraco/i);
  });

  it('lista vazia ou inválida: nada', () => {
    expect(resultSummary([], true)).toEqual([]);
    expect(resultSummary(null, true)).toEqual([]);
  });
});

describe('sparkGeometry — o minigráfico do BTC', () => {
  const serie = [{ m: 0, pct: 0 }, { m: 5, pct: -0.59 }, { m: 30, pct: -0.89 }];

  it('eixo X fixo de 0 a 60 min; eixo Y do menor ao maior valor com o zero dentro e 12% de folga (contas à mão)', () => {
    const g = sparkGeometry(serie, { width: 300, height: 112, pad: 10 });
    expect(g.maxAbs).toBeCloseTo(0.89, 10);
    // só caiu: lo0 = -0,89, hi0 = 0, span = 0,89 → lo = -0,89 - 0,1068 = -0,9968 e hi = 0,1068 (total 1,1036); altura útil 92
    const total = 0.89 * 1.24;
    const yOf = (v) => 10 + ((0.89 * 0.12 - v) / total) * 92;
    expect(g.zeroY).toBeCloseTo(Math.round(yOf(0) * 10) / 10, 6); // ≈ 18,9: o zero fica perto do TOPO (a linha usa a altura toda)
    const p5 = markerAt(g, 5);
    expect(p5.x).toBe(10 + Math.round((5 / 60) * 280 * 10) / 10); // 33,3
    expect(p5.y).toBeCloseTo(Math.round(yOf(-0.59) * 10) / 10, 6);
    expect(markerAt(g, 30).y).toBeCloseTo(Math.round(yOf(-0.89) * 10) / 10, 6);
    expect(markerAt(g, 30).y).toBeLessThan(112 - 10); // o ponto mais baixo cabe dentro do desenho
    expect(markerAt(g, 30).x).toBe(150); // 10 + 0,5 * 280
    expect(g.points[0].x).toBe(10);
  });

  it('movimento PEQUENO não vira montanha: o eixo vale no mínimo 0,3% (+12% de folga), não só a folga (achado do Codex, PR #557)', () => {
    const g = sparkGeometry([{ m: 0, pct: 0 }, { m: 5, pct: 0.1 }], { width: 300, height: 112, pad: 10 });
    // só subiu 0,1%: faltam 0,2 para o mínimo de 0,3, repartidos dos dois lados (-0,1 a +0,2); folga de 12% de 0,3 = 0,036 → eixo de -0,136 a +0,236
    const total = 0.3 * 1.24;
    const altura = 112 - 20;
    expect(g.zeroY - g.points[1].y).toBeCloseTo((0.1 / total) * altura, 0); // ≈ 24,7 px de 92: um quarto da altura, não 58%
    expect(g.zeroY - g.points[1].y).toBeLessThan(altura * 0.35);
    // a folga é REPARTIDA dos dois lados: o zero fica em (0,236 / 0,372) da altura contada do topo, não colado na base nem no topo
    expect(g.zeroY).toBeCloseTo(10 + (0.236 / total) * altura, 0); // ≈ 68,4
    // o movimento oposto, do mesmo tamanho, ocupa o mesmo espaço
    const baixo = sparkGeometry([{ m: 0, pct: 0 }, { m: 5, pct: -0.1 }], { width: 300, height: 112, pad: 10 });
    expect(baixo.points[1].y - baixo.zeroY).toBeCloseTo(g.zeroY - g.points[1].y, 0);
    // um movimento que já passa de 0,3% não muda de escala
    const grande = sparkGeometry([{ m: 0, pct: 0 }, { m: 5, pct: 0.6 }], { width: 300, height: 112, pad: 10 });
    expect(grande.zeroY - grande.points[1].y).toBeCloseTo((0.6 / (0.6 * 1.24)) * altura, 0);
  });

  it('só subiu: o zero fica perto da BASE; subiu e caiu: o zero fica no meio do desenho', () => {
    const sobe = sparkGeometry([{ m: 0, pct: 0 }, { m: 5, pct: 0.6 }]);
    expect(sobe.zeroY).toBeGreaterThan(sobe.points[1].y);
    expect(sobe.zeroY).toBeGreaterThan(56);
    const duplo = sparkGeometry([{ m: 0, pct: 0 }, { m: 5, pct: 0.5 }, { m: 10, pct: -0.5 }]);
    expect(duplo.zeroY).toBeCloseTo(56, 0);
  });

  it('o caminho começa em M, tem um L por ponto e a área fecha no zero', () => {
    const g = sparkGeometry(serie);
    expect(g.line.startsWith(`M10 ${g.zeroY}`)).toBe(true); // o 1º ponto é a referência (0%), exatamente na linha do zero
    expect(g.line.match(/L/g)).toHaveLength(2);
    expect(g.area.endsWith('Z')).toBe(true);
    expect(g.area).toContain(`L${markerAt(g, 30).x} ${g.zeroY}`);
  });

  it('escala mínima de 0,3% (movimento minúsculo não vira montanha) e minutos fora de 0–60 ou NaN são ignorados', () => {
    const g = sparkGeometry([{ m: 0, pct: 0 }, { m: 5, pct: 0.01 }, { m: 99, pct: 9 }, { m: 3, pct: NaN }]);
    expect(g.maxAbs).toBe(0.3);
    expect(g.points).toHaveLength(2);
  });

  it('menos de 2 pontos: null (a tela não desenha gráfico)', () => {
    expect(sparkGeometry([{ m: 0, pct: 0 }])).toBeNull();
    expect(sparkGeometry([])).toBeNull();
    expect(sparkGeometry(null)).toBeNull();
    expect(markerAt(null, 5)).toBeNull();
    expect(markerAt(sparkGeometry(serie), 60)).toBeNull(); // o minuto 60 ainda não existe
  });
});

describe('horizonStatus / sizeFraction / maxAbsMove', () => {
  const T0 = 1_000_000_000;
  it('horizonte fechado, em andamento (quanto falta e que fração já passou) e exatamente no fecho', () => {
    expect(horizonStatus(30, T0, T0 + 30 * MIN)).toEqual({ closed: true, remainingMin: 0, fraction: 1 });
    expect(horizonStatus(30, T0, T0 + 45 * MIN).closed).toBe(true);
    const meio = horizonStatus(60, T0, T0 + 45 * MIN);
    expect(meio.closed).toBe(false);
    expect(meio.remainingMin).toBe(15);
    expect(meio.fraction).toBeCloseTo(0.75, 10);
    expect(horizonStatus(60, T0, T0 + 45 * MIN + 1).remainingMin).toBe(15); // arredonda para cima
    expect(horizonStatus(5, T0, T0 + 4 * MIN + 30 * 1000).remainingMin).toBe(1);
    expect(horizonStatus(5, T0, T0 - MIN).fraction).toBe(0); // antes de começar: nunca negativo
  });

  it('tamanho do movimento é o módulo (a barra não tem direção) e respeita o mínimo de escala', () => {
    expect(sizeFraction(-0.5, 1)).toBeCloseTo(0.5, 10);
    expect(sizeFraction(0.5, 1)).toBeCloseTo(0.5, 10);
    expect(sizeFraction(0.15, 0.1)).toBeCloseTo(0.5, 10); // escala mínima 0,3
    expect(sizeFraction(2, 1)).toBe(1);
    expect(sizeFraction(null, 1)).toBe(0);
    expect(sizeFraction(NaN, 1)).toBe(0);
  });

  it('o maior movimento entre os horizontes com número (mínimo 0,3)', () => {
    expect(maxAbsMove({ 5: -0.59, 30: -0.89, 60: null })).toBeCloseTo(0.89, 10);
    expect(maxAbsMove({ 5: 0.01, 30: null, 60: null })).toBe(0.3);
    expect(maxAbsMove(null)).toBe(0.3);
  });
});

describe('gaugeBars — "nas divulgações × dia normal"', () => {
  it('mesma escala com 15% de folga (contas à mão)', () => {
    const g = gaugeBars('0,65%', '0,22%');
    close(g.value, 0.65 / (0.65 * 1.15));
    close(g.normal, 0.22 / (0.65 * 1.15));
  });
  it('sem número em um lado: null', () => {
    expect(gaugeBars('lixo', '0,22%')).toBeNull();
    expect(gaugeBars('0,65%', null)).toBeNull();
  });
});

describe('seriesExtremes — mínimo, máximo e último do BTC depois da divulgação', () => {
  const serie = [{ m: 0, pct: 0 }, { m: 3, pct: -0.12 }, { m: 5, pct: -0.59 }, { m: 30, pct: -0.89 }, { m: 31, pct: -0.7 }];

  it('ignora a referência (minuto 0); o máximo pode ser negativo (o BTC só caiu) e o último é o minuto mais recente', () => {
    const e = seriesExtremes(serie);
    expect(e.min).toEqual({ m: 30, pct: -0.89 });
    expect(e.max).toEqual({ m: 3, pct: -0.12 });
    expect(e.last).toEqual({ m: 31, pct: -0.7 });
  });

  it('empate fica no primeiro minuto; um minuto só serve de mínimo, máximo e último', () => {
    const e = seriesExtremes([{ m: 0, pct: 0 }, { m: 2, pct: 0.3 }, { m: 4, pct: 0.3 }, { m: 6, pct: -0.2 }, { m: 8, pct: -0.2 }]);
    expect(e.max.m).toBe(2);
    expect(e.min.m).toBe(6);
    const um = seriesExtremes([{ m: 0, pct: 0 }, { m: 1, pct: 0.05 }]);
    expect(um.min).toEqual(um.max);
    expect(um.last).toEqual(um.min);
  });

  it('sem nenhum minuto fechado (só a referência), vazio ou inválido: null', () => {
    expect(seriesExtremes([{ m: 0, pct: 0 }])).toBeNull();
    expect(seriesExtremes([])).toBeNull();
    expect(seriesExtremes(null)).toBeNull();
    expect(seriesExtremes([{ m: 1, pct: NaN }])).toBeNull();
  });
});

// Dica do minigráfico (11/11/2026): o usuário passou o mouse no gráfico e nada aparecia.
describe('nearestPoint — o ponto do minigráfico que o ponteiro "pega"', () => {
  const g = sparkGeometry([{ m: 0, pct: 0 }, { m: 5, pct: -0.59 }, { m: 30, pct: -0.89 }, { m: 60, pct: -0.2 }], { width: 300, height: 112, pad: 10 });

  it('devolve o ponto mais perto na horizontal (x do desenho: 0 min = 10, 30 min = 150, 60 min = 290)', () => {
    expect(nearestPoint(g, 150).m).toBe(30);
    expect(nearestPoint(g, 140).m).toBe(30);
    expect(nearestPoint(g, 33).m).toBe(5);
    expect(nearestPoint(g, 12).m).toBe(0);
  });

  it('fora do desenho cai no primeiro ou no último ponto; no meio entre dois, em qualquer um dos dois', () => {
    expect(nearestPoint(g, -50).m).toBe(0);
    expect(nearestPoint(g, 999).m).toBe(60);
    expect([5, 30]).toContain(nearestPoint(g, (33.3 + 150) / 2).m);
  });

  it('devolve o próprio ponto da geometria (com x, y, minuto e variação)', () => {
    const p = nearestPoint(g, 150);
    expect(p).toBe(g.points.find((q) => q.m === 30));
    expect(p.pct).toBe(-0.89);
  });

  it('sem geometria, sem pontos ou posição inválida: null', () => {
    expect(nearestPoint(null, 10)).toBeNull();
    expect(nearestPoint({ points: [] }, 10)).toBeNull();
    expect(nearestPoint(g, NaN)).toBeNull();
    expect(nearestPoint(g, undefined)).toBeNull();
  });
});

describe('hasPercentValues — o cartão tem números em %? (Payroll é "mil", sem casa decimal)', () => {
  it('CPI e PPI (texto com %) sim; Payroll, vazio e valores inválidos não', () => {
    expect(hasPercentValues({ previous: '+0,6% m/m · +3,7% a/a' })).toBe(true);
    expect(hasPercentValues({ actual: '+0,4% m/m' })).toBe(true);
    expect(hasPercentValues({ revised: '+0,5%' })).toBe(true);
    expect(hasPercentValues({ previous: '+29 mil', actual: '+165 mil' })).toBe(false);
    expect(hasPercentValues({})).toBe(false);
    expect(hasPercentValues(null)).toBe(false);
    expect(hasPercentValues({ previous: 5, actual: null })).toBe(false);
  });
});

describe('sourceLine — a fonte e as casas decimais em UMA linha curta', () => {
  it('só diz "1 casa decimal" quando há número em % e só diz "BTC (2 casas)" quando há painel do BTC', () => {
    expect(sourceLine({ source: 'BLS', percent: false, btc: false })).toBe('BLS');
    expect(sourceLine({ source: 'BLS', percent: true, btc: false })).toBe('BLS (1 casa decimal, como divulgado)');
    expect(sourceLine({ source: 'BLS', percent: true, btc: true })).toBe('BLS (1 casa decimal, como divulgado) · BTC: Binance (2 casas)');
    expect(sourceLine({ source: 'BLS', percent: false, btc: true })).toBe('BLS · BTC: Binance (2 casas)');
  });

  it('sem fonte: só o BTC, ou nada', () => {
    expect(sourceLine({ btc: true })).toBe('BTC: Binance (2 casas)');
    expect(sourceLine({})).toBe('');
    expect(sourceLine()).toBe('');
  });
});
