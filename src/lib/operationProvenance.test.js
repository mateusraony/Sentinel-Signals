import { describe, it, expect } from 'vitest';
import { operationProvenance, splitByProvenance, provenanceExclusionText, MANUAL_EDIT_REASON, MANUAL_CLOSE_REASONS, PROVENANCE } from './operationProvenance.js';

// Item 278 (PR-C): a estatística ao vivo misturava entradas que o motor NÃO
// decidiu (simulação manual pelo painel, operação retroativa, operação
// encerrada à mão) com as do motor — a amostra media outra coisa.
describe('operationProvenance', () => {
  it('motor: sem marca de origem', () => {
    expect(operationProvenance({ source: 'range_filter' })).toBe(PROVENANCE.ENGINE);
    expect(operationProvenance({})).toBe(PROVENANCE.ENGINE);
    expect(operationProvenance(null)).toBe(PROVENANCE.ENGINE);
  });

  it('manual, retroativa e encerrada à mão', () => {
    expect(operationProvenance({ source: 'manual' })).toBe(PROVENANCE.MANUAL);
    expect(operationProvenance({ source: 'backfill' })).toBe(PROVENANCE.BACKFILL);
    expect(operationProvenance({ closed_reason: MANUAL_EDIT_REASON })).toBe(PROVENANCE.EDITED);
  });

  it('recuperada após pausa do banco (item 288): nova fica fora; antiga que o replay só encerrou continua contando', () => {
    expect(operationProvenance({ source: 'recovery', recovery_run_id: 'r1' })).toBe(PROVENANCE.RECOVERY);
    expect(operationProvenance({ source: 'range_filter', recovery_run_id: 'r1' })).toBe(PROVENANCE.ENGINE);
    const { engine, excluded } = splitByProvenance([{ id: 1, source: 'recovery' }, { id: 2, recovery_run_id: 'r1' }]);
    expect(engine.map((o) => o.id)).toEqual([2]);
    expect(excluded.recovery).toBe(1);
    expect(provenanceExclusionText(excluded)).toBe('Fora da conta: 1 recuperada após pausa');
  });

  it('precedência: manual > editada > retroativa', () => {
    expect(operationProvenance({ source: 'manual', closed_reason: MANUAL_EDIT_REASON })).toBe(PROVENANCE.MANUAL);
    expect(operationProvenance({ source: 'backfill', closed_reason: MANUAL_EDIT_REASON })).toBe(PROVENANCE.EDITED);
  });

  it('Encerrar e Invalidar pelo painel também contam como encerrada à mão', () => {
    expect(operationProvenance({ closed_reason: 'Encerrado manualmente' })).toBe(PROVENANCE.EDITED);
    expect(operationProvenance({ closed_reason: 'Invalidado manualmente' })).toBe(PROVENANCE.EDITED);
    expect(operationProvenance({ closed_reason: 'Time Stop' })).toBe(PROVENANCE.ENGINE);
    // Marca estruturada de Encerrar/Invalidar (decisionSnapshot.js), mesmo com texto diferente.
    expect(operationProvenance({ closed_reason: 'outro texto', decision_snapshot: { executor: 'manual' } })).toBe(PROVENANCE.EDITED);
    expect(operationProvenance({ decision_snapshot: { executor: 'cron' } })).toBe(PROVENANCE.ENGINE);
  });

  it('as marcas são os textos que Trades.jsx grava (fonte única importada lá)', () => {
    expect(MANUAL_CLOSE_REASONS).toEqual(['Alterado manualmente', 'Encerrado manualmente', 'Invalidado manualmente']);
  });
});

describe('splitByProvenance + provenanceExclusionText', () => {
  const ops = [
    { id: 1 }, { id: 2, source: 'manual' }, { id: 3, source: 'backfill' },
    { id: 4, closed_reason: MANUAL_EDIT_REASON }, { id: 5, source: 'manual' }, { id: 6 },
  ];

  it('separa as do motor e conta as que ficam fora', () => {
    const { engine, excluded } = splitByProvenance(ops);
    expect(engine.map(o => o.id)).toEqual([1, 6]);
    expect(excluded).toEqual({ manual: 2, backfill: 1, recovery: 0, edited: 1, total: 4 });
  });

  it('texto em português, só com o que existe', () => {
    expect(provenanceExclusionText(splitByProvenance(ops).excluded))
      .toBe('Fora da conta: 2 simulações manuais · 1 retroativa · 1 encerrada à mão');
    expect(provenanceExclusionText(splitByProvenance([{ source: 'manual' }]).excluded))
      .toBe('Fora da conta: 1 simulação manual');
    expect(provenanceExclusionText(splitByProvenance([{}]).excluded)).toBeNull();
  });

  it('lista vazia ou ausente', () => {
    expect(splitByProvenance([])).toEqual({ engine: [], excluded: { manual: 0, backfill: 0, recovery: 0, edited: 0, total: 0 } });
    expect(splitByProvenance(undefined).engine).toEqual([]);
  });
});
