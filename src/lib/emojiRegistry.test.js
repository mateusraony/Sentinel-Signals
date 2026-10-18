// Item 280 (PR-E3) — "1 emoji = 1 significado" varrendo o código de verdade.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { EMOJI_REGISTRY, findEmojiViolations } from './emojiRegistry.js';
import { NOTIFICATION_STAGES } from './notificationVocabulary.js';
import { stripComments } from './__fixtures__/stripComments.js';

const RAIZ = process.cwd();

function arquivos(dir) {
  const out = [];
  for (const nome of readdirSync(dir)) {
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory()) {
      if (!['__fixtures__', 'dist', 'node_modules'].includes(nome)) out.push(...arquivos(caminho));
      continue;
    }
    if (!/\.(js|jsx|mjs)$/.test(nome) || /\.test\.(js|jsx|mjs)$/.test(nome)) continue;
    out.push(caminho);
  }
  return out;
}

// src/** + scripts/** (canal 24h do Telegram, relatório diário, auditoria,
// backtest) + server/** (o webhook do TradingView manda no mesmo chat).
// scripts/dist é build gerado e gitignored.
const ALVOS = ['src', 'scripts', 'server'].flatMap(p => arquivos(join(RAIZ, p)))
  .map(c => relative(RAIZ, c).split('\\').join('/'))
  .filter(rel => rel !== 'src/lib/emojiRegistry.js'); // o próprio registro define os glifos

const violacoes = (rel, codigo) => findEmojiViolations(rel, stripComments(codigo, rel));

describe('registro de emojis', () => {
  it('cada estágio do ciclo de vida está no registro com o mesmo sentido', () => {
    for (const { emoji, label } of Object.values(NOTIFICATION_STAGES)) {
      expect(EMOJI_REGISTRY[emoji]?.meaning, emoji).toBe(label);
    }
  });

  it('todo glifo tem um sentido escrito', () => {
    for (const [glyph, rule] of Object.entries(EMOJI_REGISTRY)) {
      expect(typeof rule.meaning === 'string' && rule.meaning.length > 0, glyph).toBe(true);
    }
  });

  it('os arquivos donos de vocabulário existem (lista não apodrece)', () => {
    const donos = new Set(Object.values(EMOJI_REGISTRY).flatMap(r => r.files ?? []));
    for (const f of donos) expect(ALVOS, f).toContain(f);
  });
});

describe('varredura: nenhum glifo fora do sentido registrado', () => {
  it('src/**, scripts/** e server/**', () => {
    expect(ALVOS.length).toBeGreaterThan(200); // não-vacuidade
    expect(ALVOS).toContain('scripts/adminTelegram.js');
    expect(ALVOS).toContain('server/index.js');
    const achados = ALVOS.flatMap(rel => violacoes(rel, readFileSync(join(RAIZ, rel), 'utf8')));
    expect(achados).toEqual([]);
  });
});

// Prova do guard: reintroduz cada uso antigo e confirma que ele é pego.
describe('prova do guard (usos antigos voltando)', () => {
  const pega = (codigo, rel = 'src/components/X.jsx') => violacoes(rel, codigo).length > 0;

  it.each([
    ["const o = { id: 'be', label: '🔄 BE' };"],
    ["statusLabel = '⚡ Runner Ativo';"],
    ["const o = { text: '🚀 Runner ativo — 50% realizado' };"],
    ["const PRIORITY_LABEL = { high: '⚡ Alta' };"],
    ["const o = { id: 'signals', label: '⚡ Sinais' };"],
    ["const o = { id: 'low', label: '🟡 Baixa' };"],
    ["const o = { RANGE_FILTER: '🔵 RF', ATR_TRAILING: '🟡 ATR Trail' };"],
    ["const o = ['🛡️ BE', '#64748b'];"],
    ["const X = () => <span>📈 MFE</span>;"],
    ["const label = '🔥 Forte';"],
    ["const o = { id: 'entry', icon: '⏱️', label: 'Entrada em 15m após sinal 4h' };"],
    ["const o = { id: 'timestop', icon: '⏰', label: 'Time Stop por Tier' };"],
  ])('pega %s', (codigo) => {
    expect(pega(codigo)).toBe(true);
  });

  it.each([
    ["const o = { id: 'be', label: '🟡 BE' };"],
    ["const X = () => <span style={{ color: '#ffd166' }}>🟡 {be} BE</span>;"],
    ["statusLabel = '🏃 Runner Ativo';"],
    ["const PRIORITY_LABEL = { high: '⭐ Alta' };"],
    ["const t = `<i>⚡ Sentinel Signals</i>`;"],
    ["const t = `🧪 <b>Simulação manual</b> — entrada criada no painel`;"],
    ["const o = { id: 'sync', label: '🔄 Sincronização' };"],
    ["const o = { id: 'timestop', icon: '⏱️', label: 'Time Stop por Tier' };"],
    ["const t = `⏱ Situação: operação encerrada — prazo máximo sem atingir TP1 expirou.`;"],
    ["const t = '⭐ Prioridade alta';"],
    ["const o = { id: 'score', icon: '🧩', label: `Score 0–100 (minScore = ${cfg.minScore})` };"],
    ["// 🔥 em comentário não conta"],
    ["const X = () => <p>{/* 🚀 em comentário JSX não conta */}</p>;"],
  ])('aceita %s', (codigo) => {
    expect(pega(codigo)).toBe(false);
  });

  it('o seletor de variação não esconde o glifo (🛡 sem U+FE0F)', () => {
    expect(pega("const o = ['\u{1F6E1} BE', '#64748b'];")).toBe(true);
  });

  it('arquivo dono libera o glifo só nele', () => {
    expect(pega("const icon = pct > 0 ? '📈' : '📉';", 'src/lib/priceChange24h.js')).toBe(false);
    expect(pega("const icon = pct > 0 ? '📈' : '📉';", 'src/lib/outro.js')).toBe(true);
  });

  // 2ª revisão: a regra olha o texto ao lado do glifo, não a linha inteira —
  // a palavra certa em outro ponto da linha não salva o uso errado.
  it.each([
    ["const t = `✅ <b>Sentinel Signals conectado!</b>\\n⚡ <b>Prioridade mínima:</b> x\\n<i>⚡ Sistema de monitoramento ativo</i>`;"],
    ["const o = [{ id: 'be', label: '🟡 BE' }, { id: 'low', label: '🟡 Baixa' }];"],
    ["const o = [{ label: '🔄 Sincronização' }, { label: '🔄 BE' }];"],
    ["const X = () => <><p>⏱️ Time Stop</p><span>⏱️ {duration}</span></>;"],
    // 3ª revisão: ordem invertida, `\n` dentro da string e ícone isolado.
    ["const t = `⚡ <b>Prioridade mínima:</b> x\\n<i>⚡ Sentinel Signals</i>`;"],
    ["const t = '⚡ Prioridade mínima ⚡ Sentinel Signals';"],
    ["const o = [{ icon: '⏱️', label: 'Entrada' }, { icon: '⏱️', label: 'Time Stop' }];"],
    ["const o = [{ icon: '🔄', label: 'BE' }, { icon: '🔄', label: 'Sincronização' }];"],
    ["const X = () => <p><span>⏱️</span> Time Stop</p>;"],
    ["const X = () => <span>⏳ Aberto</span>;"],
  ])('linha com a palavra certa em outro lugar ainda é pega: %s', (codigo) => {
    expect(pega(codigo)).toBe(true);
  });

  // 1ª e 2ª revisões: comentário falso escondia código. O parser do TypeScript
  // sabe o que é comentário.
  it.each([
    ["// rota /api/backtest/*.\nconst x = { label: '🚀 Runner' };"],
    ["const u = a + '//'; const l = '🚀 Runner';"],
    ["const re = /\\/\\//; const l = '🚀 Runner';"],
    ["const p = `${base}//${q}`; const l = '🚀 Runner';"],
    ["const u = `${a ? `//${h}` : ''}`; const l = '🚀 Runner';"],
    ["if (ok) /\\/\\//.test(s); const l = '🚀';"],
    ["const glob = 'src/*.js'; const l = '🚀 Runner';\n// fim */"],
    ["const X = () => <p>Rota src/*.js</p>;\nconst l = '🚀';\n// */"],
    ["const X = () => <p>TP1 // TP2 🚀</p>;"],
    ["const X = () => <p>use ` aqui</p>;\nconst m = '🚀';"],
    // 3ª revisão: `//`/`/*` em texto JSX depois de um {expr} não é comentário.
    ["const X = () => <p>TP1 {a} // TP2 {b} 🚀</p>;"],
    ["const X = () => <p>{a} // 🚀 Runner</p>;"],
    ["const X = () => <a>/* 🚀 */</a>;"],
    ["const o = { label: '🔄 BE', onClick: async () => {} };"],
    ["const o = { text: '⭐ Ativo em alta' };"],
    ["const t = '⏱️ Prazo de entrada';"],
    ["const o = ['🛡️ BE (entrada)'];"],
  ])('não escapa: %s', (codigo) => {
    expect(pega(codigo)).toBe(true);
  });

  it('remover comentários preserva a numeração das linhas', () => {
    expect(stripComments('/* a\nb */\nx').split('\n')).toHaveLength(3);
    expect(stripComments('const X = () => <p>{/* a\nb */}</p>;\nx').split('\n')).toHaveLength(3);
  });
});
