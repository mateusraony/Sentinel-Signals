// docs/known-risks.md item 162 — o alerta "Cota do Firestore esgotada" era
// disparado por QUALQUER timeout, porque a própria mensagem de timeout
// carregava a palavra RESOURCE_EXHAUSTED como HIPÓTESE e o detector casava
// com ela. Aconteceu ao vivo em 2026-09-05.
import { describe, it, expect } from 'vitest';
import {
  classifyFailure, describeStep, formatStepDuration,
  isFirestoreQuotaExhausted, isMissingIndex, parseStepTimeout,
} from './failureClassification.mjs';

// A mensagem EXATA que chegou no Telegram do usuário em 2026-09-05, com a
// prosa de hipótese que o scanTimeout.mjs anexava na época.
const MENSAGEM_REAL_DO_INCIDENTE =
  'Timeout: checkOneAsset:LDOUSDT não retornou em 300000ms — provável travamento em retry de '
  + 'RESOURCE_EXHAUSTED do Firestore (ver docs/known-risks.md item 142).';

describe('isFirestoreQuotaExhausted', () => {
  it('regressão do incidente: a hipótese anexada ao timeout NÃO é cota esgotada', () => {
    expect(isFirestoreQuotaExhausted(MENSAGEM_REAL_DO_INCIDENTE)).toBe(false);
  });

  it('reconhece a assinatura real do erro do Firestore', () => {
    expect(isFirestoreQuotaExhausted('8 RESOURCE_EXHAUSTED: Quota exceeded.')).toBe(true);
    expect(isFirestoreQuotaExhausted('Error: Quota exceeded.')).toBe(true);
    expect(isFirestoreQuotaExhausted('quota exceeded')).toBe(true);
  });

  it('um timeout CAUSADO por cota traz a assinatura real junto e continua sendo cota', () => {
    expect(isFirestoreQuotaExhausted(
      'Timeout: scanAllAssets não retornou em 90000ms\nCaused by: 8 RESOURCE_EXHAUSTED: Quota exceeded.'
    )).toBe(true);
  });

  it('não confunde texto solto nem entrada vazia', () => {
    expect(isFirestoreQuotaExhausted('Failed to fetch')).toBe(false);
    expect(isFirestoreQuotaExhausted(null)).toBe(false);
    expect(isFirestoreQuotaExhausted(undefined)).toBe(false);
    expect(isFirestoreQuotaExhausted('')).toBe(false);
  });
});

describe('parseStepTimeout', () => {
  it('extrai qual etapa travou e por quanto tempo', () => {
    expect(parseStepTimeout('Timeout: checkOneAsset:LDOUSDT não retornou em 300000ms'))
      .toEqual({ step: 'checkOneAsset:LDOUSDT', ms: 300000 });
    expect(parseStepTimeout(MENSAGEM_REAL_DO_INCIDENTE))
      .toEqual({ step: 'checkOneAsset:LDOUSDT', ms: 300000 });
  });

  it('devolve null para o que não é timeout de etapa', () => {
    expect(parseStepTimeout('8 RESOURCE_EXHAUSTED: Quota exceeded.')).toBeNull();
    expect(parseStepTimeout(null)).toBeNull();
  });
});

describe('classifyFailure', () => {
  it('regressão do incidente: o alerta que o usuário recebeu era um TIMEOUT, não cota', () => {
    expect(classifyFailure(MENSAGEM_REAL_DO_INCIDENTE))
      .toEqual({ kind: 'timeout', step: 'checkOneAsset:LDOUSDT', ms: 300000 });
  });

  it('cota real vence o timeout — um travamento POR cota é reportado como cota', () => {
    const msg = 'Timeout: scanAllAssets não retornou em 90000ms\nCaused by: 8 RESOURCE_EXHAUSTED';
    expect(classifyFailure(msg)).toEqual({ kind: 'quota', step: 'scanAllAssets', ms: null });
  });

  it('qualquer outra falha não vira nem cota nem timeout', () => {
    expect(classifyFailure('Failed to fetch')).toEqual({ kind: 'other', step: null, ms: null });
  });
});

describe('describeStep', () => {
  it('traduz a etapa para português simples, com o ativo quando houver', () => {
    expect(describeStep('checkOneAsset:LDOUSDT')).toBe('a checagem retroativa do LDOUSDT');
    expect(describeStep('scanAllAssets')).toBe('a varredura dos ativos');
    expect(describeStep('priceCheckActiveOps')).toBe('a checagem de preço das operações abertas');
  });

  it('nunca devolve vazio para uma etapa desconhecida ou ausente', () => {
    expect(describeStep('etapaNova')).toBe('etapaNova');
    expect(describeStep(null)).toBe('uma etapa do sistema');
  });
});

describe('formatStepDuration', () => {
  it('usa segundos abaixo de um minuto e não arredonda 90s para 1min', () => {
    expect(formatStepDuration(45_000)).toBe('45s');
    expect(formatStepDuration(90_000)).toBe('1.5min');
    expect(formatStepDuration(300_000)).toBe('5min');
    expect(formatStepDuration(null)).toBeNull();
  });
});

describe('isMissingIndex (item 165)', () => {
  // A mensagem REAL que a auditoria devolveu na primeira execução em produção.
  const REAL = '9 FAILED_PRECONDITION: The query requires an index. You can create it here: '
    + 'https://console.firebase.google.com/v1/r/project/sentinel-signals/firestore/indexes?create_composite=Cl';

  it('reconhece índice composto faltando', () => {
    expect(isMissingIndex(REAL)).toBe(true);
    expect(classifyFailure(REAL).kind).toBe('missing_index');
  });

  it('NÃO confunde índice faltando com cota esgotada — foi esse chute que motivou o item', () => {
    expect(isFirestoreQuotaExhausted(REAL)).toBe(false);
    expect(isMissingIndex('8 RESOURCE_EXHAUSTED: Quota exceeded.')).toBe(false);
    expect(classifyFailure('8 RESOURCE_EXHAUSTED: Quota exceeded.').kind).toBe('quota');
  });

  it('timeout continua vencendo índice — a etapa travada é a informação mais útil', () => {
    expect(classifyFailure('Timeout: scanAllAssets não retornou em 90000ms').kind).toBe('timeout');
  });
});
