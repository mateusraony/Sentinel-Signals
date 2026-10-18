// Item 277 (PR-B) — guardas de vocabulário do painel (src/components, src/pages).
// 1) "🔥 Forte / ⚡ Moderado / 〰 Fraco" e "🔥 Score N/100" soavam como chance de
//    acerto; o painel passou a usar o 🧩 "regras alinhadas" (`agreementLabel`
//    em src/lib/ruleAgreement.js). 🔥/〰 não podem voltar.
// 2) O TradeCard mostrava "🔴 LIVE" lendo `op.data_status`, que o motor grava
//    sempre como 'LIVE' (scanner.js, criação da operação) — o badge nunca
//    mudava. Frescor vem de `assetDataQuality`; o painel não lê esse campo.
// 3) Item 279 (PR-D): 📈/📉 são só movimento de preço e vêm de um lugar
//    (`describeChange24h`, src/lib/priceChange24h.js). O painel não escreve o
//    glifo à mão (MFE/MAE viraram ⬆️/⬇️; o filtro MTF do Pine virou 🧭 — 🕐 já é "horário").
// O registro completo "1 emoji = 1 significado" chega no PR-E3.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const PASTAS = ['components', 'pages'].map(p => join(process.cwd(), 'src', p));

function arquivos(dir) {
  const out = [];
  for (const nome of readdirSync(dir)) {
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory()) { if (nome !== '__fixtures__') out.push(...arquivos(caminho)); continue; }
    if (!/\.(js|jsx)$/.test(nome) || /\.test\.(js|jsx)$/.test(nome)) continue;
    out.push(caminho);
  }
  return out;
}

// Comentários podem citar o rótulo antigo para explicar a troca.
function semComentarios(codigo) {
  return codigo
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const PROIBIDOS = [/🔥/u, /〰/u];
const LE_DATA_STATUS_DA_OP = /\bop\??\.data_status\b/;

function achados(arquivosLista) {
  const out = [];
  for (const caminho of arquivosLista) {
    const texto = semComentarios(readFileSync(caminho, 'utf8'));
    for (const re of PROIBIDOS) if (re.test(texto)) out.push(`${caminho}: ${re}`);
  }
  return out;
}

describe('guarda: 🔥/〰 não voltam como rótulo de força no painel', () => {
  it('nenhum arquivo do painel usa 🔥 ou 〰 fora de comentário', () => {
    const lista = PASTAS.flatMap(arquivos);
    expect(lista.length).toBeGreaterThan(20); // não-vacuidade: achou os arquivos
    expect(achados(lista)).toEqual([]);
  });

  it('pega o rótulo antigo se ele voltar (prova do guard)', () => {
    const texto = semComentarios(`const label = pct >= 85 ? '🔥 Forte' : '〰 Fraco'; // 🔥 em comentário não conta`);
    expect(PROIBIDOS.every(re => re.test(texto))).toBe(true);
    expect(PROIBIDOS.some(re => re.test(semComentarios('// só 🔥 em comentário')))).toBe(false);
  });
});

describe('guarda: o painel não lê op.data_status (constante LIVE no motor)', () => {
  it('nenhum arquivo do painel lê op.data_status', () => {
    const lista = PASTAS.flatMap(arquivos);
    const leitores = lista.filter(c => LE_DATA_STATUS_DA_OP.test(semComentarios(readFileSync(c, 'utf8'))));
    expect(leitores).toEqual([]);
  });

  it('pega a leitura antiga se ela voltar (prova do guard)', () => {
    expect(LE_DATA_STATUS_DA_OP.test('const dataStatus = DATA_STATUS[op.data_status] || DATA_STATUS.LIVE;')).toBe(true);
    expect(LE_DATA_STATUS_DA_OP.test('op?.data_status')).toBe(true);
    expect(LE_DATA_STATUS_DA_OP.test('snapshot.data_status')).toBe(false);
  });
});

describe('guarda: 📈/📉 só via describeChange24h (item 279)', () => {
  it('nenhum arquivo do painel escreve 📈/📉 à mão', () => {
    const lista = PASTAS.flatMap(arquivos);
    const comGlifo = lista.filter(c => /📈|📉/u.test(semComentarios(readFileSync(c, 'utf8'))));
    expect(comGlifo).toEqual([]);
  });

  it('pega o uso antigo se ele voltar (prova do guard)', () => {
    expect(/📈|📉/u.test(semComentarios('<span>📈 MFE</span>'))).toBe(true);
    expect(/📈|📉/u.test(semComentarios('// 📈 em comentário'))).toBe(false);
  });
});
