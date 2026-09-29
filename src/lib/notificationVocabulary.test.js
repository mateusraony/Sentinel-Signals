// Auditoria do Telegram (2026-09-29), Fase 2 item 2.1 — vocabulário único do
// ciclo de vida. Teste de guarda: todo estágio referenciado pelos templates
// de telegram.js/adminTelegram.js precisa existir aqui, com emoji e rótulo
// não vazios — um "template órfão" (id que não bate com nenhuma chave) seria
// exatamente o tipo de divergência silenciosa que este arquivo existe pra
// eliminar.
import { describe, it, expect } from 'vitest';
import { NOTIFICATION_STAGES, stageHeader } from './notificationVocabulary';

// IDs realmente usados em src/lib/telegram.js (e espelhados em
// scripts/adminTelegram.js) — mantenha esta lista em sincronia se um
// template novo passar a citar um estágio novo.
const STAGE_IDS_USADOS_NOS_TEMPLATES = [
  'SIGNAL_DETECTED', 'VERIFICATION_NEEDED', 'AWAITING_ENTRY', 'ENTRY_CONFIRMED',
  'TP1_HIT', 'RUNNER_ACTIVE', 'TP2_HIT', 'STOP_LOSS', 'STOP_BREAKEVEN',
  'STOP_LOCKED_PROFIT', 'INVALIDATED', 'TIME_STOP', 'CHOP_EXIT',
];

describe('NOTIFICATION_STAGES — todo estágio usado pelos templates existe com emoji+rótulo', () => {
  it.each(STAGE_IDS_USADOS_NOS_TEMPLATES)('%s tem emoji e label não vazios', (id) => {
    const stage = NOTIFICATION_STAGES[id];
    expect(stage, `estágio "${id}" ausente de NOTIFICATION_STAGES`).toBeTruthy();
    expect(stage.emoji).toBeTruthy();
    expect(stage.label).toBeTruthy();
  });

  it('1 emoji não é reaproveitado por 2 estágios diferentes (regra do vocabulário)', () => {
    const emojis = Object.values(NOTIFICATION_STAGES).map((s) => s.emoji);
    expect(new Set(emojis).size).toBe(emojis.length);
  });
});

describe('stageHeader', () => {
  it('monta "emoji label" pronto pra cabeçalho', () => {
    expect(stageHeader('SIGNAL_DETECTED')).toBe('🔔 Sinal Detectado');
  });

  it('id desconhecido devolve string vazia, nunca lança', () => {
    expect(stageHeader('nao_existe')).toBe('');
  });
});
