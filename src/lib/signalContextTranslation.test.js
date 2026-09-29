// Auditoria do Telegram (2026-09-29), Fase 2 item 2.8 — traduz
// SignalEvent.context em linhas humanas, antes do JSON bruto na página
// Alertas. Campo ausente/desconhecido é OMITIDO, nunca vira "0" ou texto
// inventado (mesma regra do resto do plano) — ver docs/schema-reference/
// SignalEvent.jsonc pro shape real de `context`.
import { describe, it, expect } from 'vitest';
import { translateSignalContext } from './signalContextTranslation';

describe('translateSignalContext', () => {
  it('context vazio/ausente devolve lista vazia, nunca lança', () => {
    expect(translateSignalContext(null)).toEqual([]);
    expect(translateSignalContext(undefined)).toEqual([]);
    expect(translateSignalContext({})).toEqual([]);
  });

  it('traduz direções (RF/1h/4h/1d) com seta e sem inventar valor pra campo ausente', () => {
    const rows = translateSignalContext({ rf_direction: 1, tf_4h_direction: -1 });
    expect(rows).toContainEqual({ label: 'Range Filter', value: 'comprador', direction: 1 });
    expect(rows).toContainEqual({ label: 'Tendência 4h', value: 'baixa', direction: -1 });
    expect(rows.find((r) => r.label === 'Tendência 1h')).toBeUndefined();
    expect(rows.find((r) => r.label === 'Tendência 1d')).toBeUndefined();
  });

  it('RSI inclui a zona (sobrecompra/sobrevenda/neutra) usando os mesmos limiares 70/30 já usados em Assets.jsx', () => {
    expect(translateSignalContext({ rsi: 75 })).toContainEqual({ label: 'RSI', value: '75 — sobrecompra' });
    expect(translateSignalContext({ rsi: 25 })).toContainEqual({ label: 'RSI', value: '25 — sobrevenda' });
    expect(translateSignalContext({ rsi: 50 })).toContainEqual({ label: 'RSI', value: '50 — zona neutra' });
  });

  it('MACD positivo/negativo com direção pra seta', () => {
    expect(translateSignalContext({ macd_histogram: 0.5 })).toContainEqual({ label: 'MACD', value: 'positivo', direction: 1 });
    expect(translateSignalContext({ macd_histogram: -0.5 })).toContainEqual({ label: 'MACD', value: 'negativo', direction: -1 });
  });

  it('campos só de SMC (structure_type/pd_zone) aparecem quando presentes', () => {
    const rows = translateSignalContext({ structure_type: 'BOS', pd_zone: 'discount' });
    expect(rows).toContainEqual({ label: 'Estrutura', value: 'rompimento de estrutura (BOS)' });
    expect(rows).toContainEqual({ label: 'Zona', value: 'discount' });
  });

  it('score não entra na tradução — já tem card próprio no modal (item 1.2)', () => {
    const rows = translateSignalContext({ score: 88 });
    expect(rows.find((r) => r.label === 'Score')).toBeUndefined();
  });
});
