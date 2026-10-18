import { describe, it, expect } from 'vitest';
import {
  SIGNAL_PHASE, REASON_KIND, REJECTION_COPY, CONFIRMATION_WINDOW_MS,
  classifySignal, isConfirmationEligible, phaseCopy, rejectionCopy,
  reasonIcon, formatTimeLeft, priorityLabel,
} from './signalStatus';

const NOW = Date.parse('2026-09-05T12:00:00.000Z');
const sig = (over = {}) => ({ source: 'range_filter', timeframe: '4h', signal_type: 'BUY', created_date: '2026-09-05T10:00:00.000Z', ...over });

describe('classifySignal', () => {
  it('4h dentro da janela está esperando confirmação', () => {
    const r = classifySignal(sig(), NOW);
    expect(r.phase).toBe(SIGNAL_PHASE.WAITING);
    expect(r.msLeft).toBe(2 * 60 * 60 * 1000);
  });

  it('4h fora da janela expirou', () => {
    expect(classifySignal(sig({ created_date: '2026-09-05T07:00:00.000Z' }), NOW).phase).toBe(SIGNAL_PHASE.EXPIRED);
  });

  it('expired_logged vence o relógio', () => {
    expect(classifySignal(sig({ expired_logged: true }), NOW).phase).toBe(SIGNAL_PHASE.EXPIRED);
  });

  it('Range Filter 1h/1d é sempre informativo e nunca expira', () => {
    for (const tf of ['1h', '1d', '15m']) {
      const r = classifySignal(sig({ timeframe: tf, source: 'range_filter', created_date: '2020-01-01T00:00:00.000Z' }), NOW);
      expect(r.phase).toBe(SIGNAL_PHASE.INFO);
      expect(r.msLeft).toBeNull();
    }
  });

  // Item 276 (decisão do usuário sobre o item 258): "quais sinais viram
  // operação" depende da FONTE, não só do timeframe. Espelha o motor:
  // scanner.js só leva ao motor de entrada o Range Filter de 4h (cascata
  // 4h→15m) e o SMC de 1h (cascata 1h→5m, que só é emitido em ativo com
  // smc_enabled). MACD/EMA/RSI gravam SignalEvent em 4h, mas nunca abrem
  // operação.
  it.each([
    ['range_filter', '4h', true],
    [undefined, '4h', false], // sem `source`: o motor exige source === 'range_filter' (scanner.js 1ª passada e retry)
    ['smc_structure', '1h', true],
    ['range_filter', '1h', false],
    ['range_filter', '1d', false],
    ['smc_structure', '4h', false],
    ['macd', '4h', false],
    ['ema_cross', '4h', false],
    ['rsi', '4h', false],
    ['macd', '1h', false],
  ])('tabela-verdade: fonte %s em %s → pode virar operação = %s', (source, timeframe, esperado) => {
    expect(isConfirmationEligible({ source, timeframe })).toBe(esperado);
    const phase = classifySignal(sig({ source, timeframe }), NOW).phase;
    expect(phase === SIGNAL_PHASE.INFO).toBe(!esperado);
  });

  it('trend_reversed do SMC nunca cita a linha de 4 horas, em nenhuma variante', () => {
    const variantes = [undefined, ...Object.keys(REJECTION_COPY.trend_reversed.by ?? {})];
    for (const detalhe of variantes) {
      for (const lado of ['BUY', 'SELL']) {
        const { detail } = rejectionCopy({ source: 'smc_structure', timeframe: '1h', signal_type: lado,
          last_rejection_reason: 'trend_reversed', last_rejection_detail: detalhe });
        expect(detail, `${detalhe}/${lado}`).not.toMatch(/4 horas/);
      }
    }
  });

  it('smc_enabled "verdadeiro" não booleano conta como ligado (igual ao `if` do motor)', () => {
    expect(isConfirmationEligible({ source: 'smc_structure', timeframe: '1h' }, { smc_enabled: 1 })).toBe(true);
    expect(isConfirmationEligible({ source: 'smc_structure', timeframe: '1h' }, { smc_enabled: 0 })).toBe(false);
  });

  it('o guard semântico reconhece a afirmação antiga (prova de que não é vácuo)', () => {
    const re = /(^|[\s(—-])(só|apenas|somente)(?=[\s,])[^.]*?\b4 ?h(oras)?(?![a-z])/i;
    expect(re.test('O app só abre operação a partir dos avisos do gráfico de 4 horas.')).toBe(true);
    expect(re.test('Só os avisos de 4h viram operação.')).toBe(true);
    expect(re.test('Isto é só uma observação de mercado — nunca vira operação.')).toBe(false);
  });

  it('SMC 1h com o ativo conhecido e a cascata desligada não é elegível (o motor reconfere o flag)', () => {
    expect(isConfirmationEligible({ source: 'smc_structure', timeframe: '1h' }, { smc_enabled: false })).toBe(false);
    expect(isConfirmationEligible({ source: 'smc_structure', timeframe: '1h' }, { smc_enabled: true })).toBe(true);
    expect(isConfirmationEligible({ source: 'smc_structure', timeframe: '1h' }, null)).toBe(true);
    // NULL/ausente no ativo conhecido = o motor não processa SMC (`if (asset.smc_enabled)`)
    expect(isConfirmationEligible({ source: 'smc_structure', timeframe: '1h' }, { smc_enabled: null })).toBe(false);
    expect(isConfirmationEligible({ source: 'smc_structure', timeframe: '1h' }, {})).toBe(false);
    expect(classifySignal(sig({ source: 'smc_structure', timeframe: '1h' }), NOW, { smc_enabled: false }).phase).toBe(SIGNAL_PHASE.INFO);
    // is_active NULL também fica fora do scan (o motor filtra is_active: true)
    expect(isConfirmationEligible({ source: 'range_filter', timeframe: '4h' }, { is_active: null })).toBe(false);
    // ativo inativo não é escaneado: nada dele confirma
    expect(isConfirmationEligible({ source: 'range_filter', timeframe: '4h' }, { is_active: false })).toBe(false);
    expect(isConfirmationEligible({ source: 'smc_structure', timeframe: '1h' }, { is_active: false, smc_enabled: true })).toBe(false);
    // timeframe desligado no ativo: o motor nem busca esse timeframe
    expect(isConfirmationEligible({ source: 'range_filter', timeframe: '4h' }, { timeframes_enabled: { '4h': false } })).toBe(false);
    expect(isConfirmationEligible({ source: 'smc_structure', timeframe: '1h' }, { smc_enabled: true, timeframes_enabled: { '1h': false } })).toBe(false);
    expect(isConfirmationEligible({ source: 'range_filter', timeframe: '4h' }, { timeframes_enabled: { '1h': false } })).toBe(true);
    // a cascata RF não depende do flag SMC
    expect(isConfirmationEligible({ source: 'range_filter', timeframe: '4h' }, { smc_enabled: false })).toBe(true);
  });

  it('SMC 1h segue a mesma janela de 4h da cascata: dentro espera, fora expira', () => {
    expect(classifySignal(sig({ source: 'smc_structure', timeframe: '1h' }), NOW).phase).toBe(SIGNAL_PHASE.WAITING);
    expect(classifySignal(sig({ source: 'smc_structure', timeframe: '1h', created_date: '2026-09-05T07:00:00.000Z' }), NOW).phase)
      .toBe(SIGNAL_PHASE.EXPIRED);
  });

  it('data inválida não vira "expirado" por acidente', () => {
    expect(classifySignal(sig({ created_date: 'lixo' }), NOW).phase).toBe(SIGNAL_PHASE.WAITING);
  });

  it('a janela é a mesma do motor (4h)', () => {
    expect(CONFIRMATION_WINDOW_MS).toBe(4 * 60 * 60 * 1000);
    expect(isConfirmationEligible({ source: 'range_filter', timeframe: '4h' })).toBe(true);
  });
});

describe('phaseCopy', () => {
  it('toda fase diz explicitamente que o usuário não precisa agir', () => {
    for (const phase of Object.values(SIGNAL_PHASE)) {
      const copy = phaseCopy(phase);
      expect(copy.badge).toBeTruthy();
      expect(copy.reassurance).toMatch(/não precisa fazer nada|perdeu nada|pode ignorar/i);
    }
  });

  // Guard semântico (item 276): o texto antigo dizia "O app só abre operação a
  // partir dos avisos do gráfico de 4 horas" — falso para a cascata SMC 1h→5m
  // e passou pela regex de verificationWordingGuard por paráfrase. Aqui a
  // regra é sobre o SIGNIFICADO: o texto de "só informação" não pode afirmar
  // exclusividade do 4h sem citar a outra cascata que existe.
  it('texto de "só informação" não afirma que só o 4h abre operação (SMC 1h também abre)', () => {
    const { reassurance } = phaseCopy(SIGNAL_PHASE.INFO);
    // Sem \b depois de "só": em JS o \b é só ASCII, e "ó" seguido de espaço não
    // forma fronteira — a 1ª versão desta regex nunca casava "só" (review).
    const afirmaSo4h = /(^|[\s(—-])(só|apenas|somente)(?=[\s,])[^.]*?\b4 ?h(oras)?(?![a-z])/i.test(reassurance);
    if (afirmaSo4h) expect(reassurance).toMatch(/SMC/);
    expect(reassurance).not.toMatch(/a partir dos avisos do gráfico de 4 horas\./i);
  });

  it('fase desconhecida degrada sem quebrar', () => {
    expect(phaseCopy('inexistente').badge).toBeTruthy();
  });

  // Item 280: "Já passou" usava ✓, que lê como "deu certo". O prazo acabou sem
  // operação — mesmo evento que o Telegram chama de 🚫 Sinal Cancelado.
  it('aviso que já passou usa 🚫 (cancelado), não ✓', () => {
    expect(phaseCopy(SIGNAL_PHASE.EXPIRED).icon).toBe('🚫');
  });
});

describe('rejectionCopy', () => {
  it('toda chave conhecida termina resolvendo "e eu, faço o quê?"', () => {
    for (const key of Object.keys(REJECTION_COPY)) {
      const copy = rejectionCopy({ last_rejection_reason: key, signal_type: 'BUY' });
      expect(copy.detail).toMatch(/Nada a fazer\.$/);
      expect(copy.chip.length).toBeLessThanOrEqual(28);
      expect(Object.values(REASON_KIND)).toContain(copy.kind);
    }
  });

  // item 163 — as variantes por detalhe são o texto que o usuário lê na
  // maioria das vezes (regime_rejected e confirmation_15m_not_aligned são os
  // dois motivos mais frequentes em produção). Elas precisam obedecer às
  // MESMAS regras da frase-base, senão a correção do item 163 reabre
  // exatamente o buraco que o item 156 fechou.
  it('toda variante por detalhe também resolve "e eu, faço o quê?"', () => {
    for (const [key, entry] of Object.entries(REJECTION_COPY)) {
      for (const detalhe of Object.keys(entry.by ?? {})) {
        for (const lado of ['BUY', 'SELL']) {
          const copy = rejectionCopy({ last_rejection_reason: key, last_rejection_detail: detalhe, signal_type: lado });
          expect(copy.detail, `${key}/${detalhe}/${lado}`).toMatch(/Nada a fazer\.$/);
          expect(copy.chip.length, `${key}/${detalhe}/${lado}: "${copy.chip}"`).toBeLessThanOrEqual(28);
          expect(Object.values(REASON_KIND)).toContain(copy.kind);
        }
      }
    }
  });

  it('a variante diz algo DIFERENTE da frase-base — senão o detalhe não serviu para nada', () => {
    const base = rejectionCopy({ last_rejection_reason: 'regime_rejected', signal_type: 'BUY' });
    for (const detalhe of ['adx', 'chop', 'adx_chop']) {
      const variante = rejectionCopy({ last_rejection_reason: 'regime_rejected', last_rejection_detail: detalhe, signal_type: 'BUY' });
      expect(variante.detail).not.toBe(base.detail);
    }
    // "o pavio perdeu força" era literalmente o exemplo do usuário do que ele
    // queria saber: o texto do ADX precisa falar de FORÇA do movimento.
    expect(rejectionCopy({ last_rejection_reason: 'regime_rejected', last_rejection_detail: 'adx' }).detail)
      .toMatch(/fraco|for[çc]a/i);
    expect(rejectionCopy({ last_rejection_reason: 'regime_rejected', last_rejection_detail: 'chop' }).detail)
      .toMatch(/de lado|faixa/i);
  });

  it('detalhe desconhecido cai na frase-base completa, nunca em texto vazio', () => {
    const copy = rejectionCopy({ last_rejection_reason: 'regime_rejected', last_rejection_detail: 'detalhe_do_futuro', signal_type: 'BUY' });
    expect(copy.detail).toBe(rejectionCopy({ last_rejection_reason: 'regime_rejected', signal_type: 'BUY' }).detail);
  });

  it('nenhum texto novo vaza jargão do motor', () => {
    // Borda de palavra que ENXERGA ACENTO. `\b` sozinho não serve: `\w` é só
    // [A-Za-z0-9_], então `\batr\b` casa dentro de "voltar atrás" (o `á` conta
    // como borda) e `\bema\b` casaria em "d-ema-is". Os dois já deram falso
    // positivo aqui — a lista proíbe o NOME TÉCNICO do indicador, não pedaços
    // de palavras comuns em português.
    const LETRA = 'A-Za-z0-9_À-ÖØ-öø-ÿ';
    const jargao = new RegExp(
      `Range Filter|(?<![${LETRA}])(timeframe|ADX|Choppiness|SMC|MACD|EMA|RSI|ATR|candle|gate|minRR|OTE|retest|displacement)(?![${LETRA}])`,
      'i',
    );
    for (const [key, entry] of Object.entries(REJECTION_COPY)) {
      for (const detalhe of [undefined, ...Object.keys(entry.by ?? {})]) {
        const { chip, detail } = rejectionCopy({ last_rejection_reason: key, last_rejection_detail: detalhe, signal_type: 'BUY' });
        expect(`${chip} ${detail}`, `${key}/${detalhe}`).not.toMatch(jargao);
      }
    }
  });

  it('o chip de zona desfavorável acompanha a direção do aviso', () => {
    const buy = rejectionCopy({ last_rejection_reason: 'ote_zone_unfavorable', signal_type: 'BUY' });
    const sell = rejectionCopy({ last_rejection_reason: 'ote_zone_unfavorable', signal_type: 'SELL' });
    expect(buy.chip).toMatch(/subiu/);
    expect(sell.chip).toMatch(/caiu/);
  });

  it('sem motivo registrado, explica que o app acabou de receber o aviso', () => {
    const copy = rejectionCopy({ signal_type: 'BUY' });
    expect(copy.chip).toBe('Checando agora');
    expect(copy.detail).toMatch(/Nada a fazer\.$/);
  });

  // docs/known-risks.md item 175 — achado a partir de print real do usuário:
  // um sinal já EXPIRADO sem `last_rejection_reason` (ex.: rejeitado na 1ª
  // passada, nunca reavaliado pelo laço de retry que grava o campo) mostrava
  // a MESMA frase de sinal "recém-chegado" que "refaz a conta a cada 5
  // minutos" — direta contradição com o badge "Já passou" ao lado, sem
  // nenhum motivo real explicado.
  it('sem motivo registrado E sinal EXPIRADO, não finge que ainda está sendo checado', () => {
    const copy = rejectionCopy({ signal_type: 'BUY' }, SIGNAL_PHASE.EXPIRED);
    expect(copy.chip).not.toBe('Checando agora');
    expect(copy.detail).not.toMatch(/rec[ée]m-chegado|a cada 5 minutos/i);
    expect(copy.detail).toMatch(/Nada a fazer\.$/);
    expect(copy.kind).toBe(REASON_KIND.APP);
  });

  // Achado do Codex (review do PR #502): aviso que não vira operação (fase
  // INFO) sem motivo salvo herdava a frase de "recém-chegado, refaz a conta a
  // cada 5 minutos" — o motor nunca avalia entrada para ele.
  it('sem motivo registrado E fase INFO, não promete checagem de entrada', () => {
    const copy = rejectionCopy({ signal_type: 'BUY' }, SIGNAL_PHASE.INFO);
    expect(copy.chip).not.toBe('Checando agora');
    expect(copy.detail).not.toMatch(/rec[ée]m-chegado|a cada 5 minutos|abrir uma opera/i);
    expect(copy.detail).toMatch(/não vira operação/);
    expect(copy.detail).toMatch(/Nada a fazer\.$/);
    expect(copy.kind).toBe(REASON_KIND.INFO);
    expect(copy.icon).toBe('ℹ️');
  });

  it('chave desconhecida não vira tela vazia nem código cru sem contexto', () => {
    const copy = rejectionCopy({ last_rejection_reason: 'motivo_inventado', signal_type: 'BUY' });
    expect(copy.detail).toContain('motivo_inventado');
    expect(copy.detail).toMatch(/Nada a fazer\.$/);
    expect(copy.kind).toBe(REASON_KIND.APP);
  });

  it('cada família tem um ícone distinto', () => {
    const icons = Object.values(REASON_KIND).map(reasonIcon);
    expect(new Set(icons).size).toBe(icons.length);
  });
});

describe('formatTimeLeft', () => {
  it('encurta a contagem', () => {
    expect(formatTimeLeft(107 * 60_000)).toBe('1h47');
    expect(formatTimeLeft(9 * 60_000)).toBe('9min');
    expect(formatTimeLeft(60 * 60_000)).toBe('1h00');
  });

  it('devolve null quando não há prazo', () => {
    for (const bad of [0, -1, null, undefined, NaN]) expect(formatTimeLeft(bad)).toBeNull();
  });
});

// Auditoria do Telegram, Fase 4 (2026-10-02) — fonte única extraída de 3
// lugares que repetiam o mesmo rótulo (SignalAlertBanner.jsx, Alerts.jsx's
// PRIORITY_CONFIG, e implicitamente StrengthBadge.jsx, não tocado).
describe('priorityLabel', () => {
  it('traduz high/medium/low pro rótulo em português', () => {
    expect(priorityLabel('high')).toBe('⭐ Alta'); // item 280: ⚡ é só a marca
    expect(priorityLabel('medium')).toBe('Média');
    expect(priorityLabel('low')).toBe('Baixa');
  });

  it('prioridade desconhecida/ausente cai no fallback "Baixa", nunca undefined', () => {
    expect(priorityLabel('algo_novo')).toBe('Baixa');
    expect(priorityLabel(undefined)).toBe('Baixa');
  });
});
