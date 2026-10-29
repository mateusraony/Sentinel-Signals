import { describe, it, expect } from 'vitest';
import { assetDataQuality, qualityBadge, summarizeDataHealth, healthChip, formatAge } from './assetDataQuality.js';

// Item 277 (PR-B): o cartão do ativo mostrava "LIVE" verde fixo sempre que o
// healthcheck não acusava problema — inclusive num ativo que NUNCA foi lido
// (sem last_scan_at). Fonte única do status de frescor para card, drawer,
// lista de Ativos e o chip de saúde global.
const NOW = Date.parse('2026-10-17T12:00:00Z');
const minAgo = (m) => new Date(NOW - m * 60000).toISOString();

describe('assetDataQuality', () => {
  it('lido há pouco: ok, com idade em minutos', () => {
    expect(assetDataQuality({ is_active: true, last_scan_at: minAgo(3) }, NOW)).toEqual({ status: 'ok', reason: null, ageMin: 3 });
  });

  it('nunca lido (sem last_scan_at): sem leitura — nunca "ok"', () => {
    expect(assetDataQuality({ is_active: true }, NOW).status).toBe('unknown');
    expect(assetDataQuality({ is_active: true, last_scan_at: null }, NOW).ageMin).toBeNull();
  });

  it('parado além da tolerância do healthcheck (60 min): atrasado', () => {
    const q = assetDataQuality({ is_active: true, last_scan_at: minAgo(90) }, NOW);
    expect(q).toEqual({ status: 'stale', reason: 'silent', ageMin: 90 });
  });

  it('erro persistente vence o atraso', () => {
    const q = assetDataQuality({ is_active: true, last_scan_at: minAgo(90), scan_error_since: minAgo(80) }, NOW);
    expect(q.status).toBe('error');
    expect(q.reason).toBe('persistent_error');
  });

  it('REGRESSÃO (review do PR-B): falha recente (< 60 min) não aparece como atualizado', () => {
    const recente = { is_active: true, last_scan_at: minAgo(0), scan_status: 'error', scan_error_since: minAgo(5) };
    const q = assetDataQuality(recente, NOW);
    expect(q.status).toBe('error');
    expect(q.reason).toBeNull(); // o healthcheck do cron ainda espera os 60 min
    expect(qualityBadge(q).label).toBe('📡 Falha de leitura (último scan agora)');
    expect(summarizeDataHealth([recente], NOW).problemCount).toBe(1);
  });

  it('ativo desligado: desligado, mesmo com leitura antiga', () => {
    expect(assetDataQuality({ is_active: false, last_scan_at: minAgo(500) }, NOW).status).toBe('inactive');
  });

  it('sem ativo ou sem relógio: sem leitura', () => {
    expect(assetDataQuality(null, NOW).status).toBe('unknown');
    expect(assetDataQuality({ is_active: true, last_scan_at: minAgo(3) }, NaN).status).toBe('unknown');
    // Sem relógio explícito não há como julgar frescor (fail-closed, igual ao presenter).
    expect(assetDataQuality({ is_active: true, last_scan_at: minAgo(3) }).status).toBe('unknown');
  });

  it('relógio do navegador atrás do scan não gera idade negativa', () => {
    expect(assetDataQuality({ is_active: true, last_scan_at: minAgo(-2) }, NOW).ageMin).toBe(0);
  });
});

describe('formatAge (review do PR-B: nada de "20160 min")', () => {
  it('minutos, horas e dias', () => {
    expect(formatAge(5)).toBe('5 min');
    expect(formatAge(59)).toBe('59 min');
    expect(formatAge(60)).toBe('1 h');
    expect(formatAge(47 * 60 + 59)).toBe('47 h');
    expect(formatAge(48 * 60)).toBe('2 dias');
    expect(formatAge(20160)).toBe('14 dias');
    expect(qualityBadge({ status: 'inactive', ageMin: 20160 }).label).toBe('📡 Desligado (último scan há 14 dias)');
    expect(qualityBadge({ status: 'stale', ageMin: 1440 }).label).toBe('📡 Atrasado (24 h sem leitura)');
  });
});

describe('qualityBadge', () => {
  it('todo rótulo começa com 📡 e nenhum diz LIVE', () => {
    for (const status of ['ok', 'stale', 'error', 'inactive', 'unknown']) {
      const b = qualityBadge({ status, ageMin: 5 });
      expect(b.label.startsWith('📡 ')).toBe(true);
      expect(b.short.startsWith('📡 ')).toBe(true);
      expect(`${b.label} ${b.short}`).not.toMatch(/LIVE/);
      expect(b.color).toMatch(/^#/);
    }
  });

  it('textos por status', () => {
    expect(qualityBadge({ status: 'ok', ageMin: 5 }).label).toBe('📡 Atualizado há 5 min');
    expect(qualityBadge({ status: 'ok', ageMin: 0 }).label).toBe('📡 Atualizado agora');
    expect(qualityBadge({ status: 'stale', ageMin: 45 }).label).toBe('📡 Atrasado (45 min sem leitura)');
    expect(qualityBadge({ status: 'error' }).label).toBe('📡 Falha de leitura');
    // Com idade: diz se o scan ainda roda (e falha) ou se parou de vez.
    expect(qualityBadge({ status: 'error', ageMin: 2 }).label).toBe('📡 Falha de leitura (último scan há 2 min)');
    expect(qualityBadge({ status: 'inactive' }).label).toBe('📡 Desligado');
    expect(qualityBadge({ status: 'inactive', ageMin: 120 }).label).toBe('📡 Desligado (último scan há 2 h)');
    expect(qualityBadge({ status: 'unknown' }).label).toBe('📡 Sem leitura');
  });

  it('status desconhecido cai em "sem leitura"', () => {
    expect(qualityBadge({ status: 'inventado' }).label).toBe('📡 Sem leitura');
    expect(qualityBadge(null).label).toBe('📡 Sem leitura');
  });
});

describe('summarizeDataHealth + healthChip (chip de saúde global, item 277)', () => {
  const ok = (m) => ({ is_active: true, last_scan_at: minAgo(m) });
  it('todos em dia: último scan mais recente e "tudo em dia"', () => {
    const s = summarizeDataHealth([ok(7), ok(3)], NOW);
    expect(s).toEqual({ status: 'ok', activeCount: 2, problemCount: 0, lastScanAgeMin: 3 });
    expect(healthChip(s).label).toBe('📡 Último scan há 3 min · tudo em dia');
  });

  it('1 e N ativos com problema (atrasado, falha ou sem leitura contam)', () => {
    const um = summarizeDataHealth([ok(3), ok(90)], NOW);
    expect(healthChip(um).label).toBe('📡 Último scan há 3 min · 1 ativo com problema');
    const tres = summarizeDataHealth([ok(3), ok(90), { is_active: true }, { is_active: true, last_scan_at: minAgo(3), scan_error_since: minAgo(40) }], NOW);
    expect(tres.problemCount).toBe(3);
    expect(healthChip(tres).label).toBe('📡 Último scan há 3 min · 3 ativos com problema');
    expect(tres.status).toBe('warn');
  });

  it('ativos desligados não contam', () => {
    const s = summarizeDataHealth([ok(2), { is_active: false }], NOW);
    expect(s.activeCount).toBe(1);
    expect(s.problemCount).toBe(0);
  });

  it('nenhum ativo ligado e nenhuma leitura', () => {
    expect(healthChip(summarizeDataHealth([], NOW)).label).toBe('📡 Nenhum ativo ligado');
    expect(healthChip(summarizeDataHealth([{ is_active: true }], NOW)).label).toBe('📡 Sem leitura ainda · 1 ativo com problema');
  });

  it('carregando e erro: nunca afirma "tudo em dia" (fail-closed)', () => {
    const s = summarizeDataHealth([ok(3)], NOW);
    expect(healthChip(s, { loading: true }).label).toBe('📡 Verificando…');
    expect(healthChip(s, { error: true }).label).toBe('📡 Saúde indisponível');
    expect(healthChip(null).label).toBe('📡 Verificando…');
  });

  it('scan agora', () => {
    expect(healthChip(summarizeDataHealth([ok(0)], NOW)).label).toBe('📡 Último scan agora · tudo em dia');
  });
});
