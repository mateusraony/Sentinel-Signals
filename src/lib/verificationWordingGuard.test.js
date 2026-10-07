// Item 258 — guarda de texto. O aviso do Telegram dizia "aguardando sua revisão
// manual antes de virar operação" e a tela de Ajustes "precisa de confirmação
// manual antes de virar operação": ambos faziam parecer que marcar OK/Pular na
// aba Verificação aprova uma operação. Não aprova — a `VerificationTask` é só
// um lembrete (nada no motor lê o status dela). Este teste impede que a frase
// volte em qualquer texto visível ao usuário em `src/` (fora de testes).
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(process.cwd(), 'src');

function arquivosDeTexto(dir) {
  const out = [];
  for (const nome of readdirSync(dir)) {
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory()) { out.push(...arquivosDeTexto(caminho)); continue; }
    if (!/\.(js|jsx)$/.test(nome) || /\.test\.(js|jsx)$/.test(nome)) continue;
    out.push(caminho);
  }
  return out;
}

// Só texto que o usuário pode ler: comentários do código ficam de fora (eles
// podem citar a frase antiga justamente para explicar por que ela saiu).
function semComentarios(codigo) {
  return codigo.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const FRASES_PROIBIDAS = [
  /antes de virar operação/i,
  /aguardando sua revisão/i,
  /revisão manual/i,
  /confirmação manual/i,
  /Verificação Necessária/,
  /só a partir de sinais de 4 horas/i, // falso para a cascata SMC 1h→5m (Codex P2, PR #473)
];

describe('texto do usuário nunca sugere que a Verificação aprova uma operação (item 258)', () => {
  const arquivos = arquivosDeTexto(SRC);

  it('encontra os arquivos de src/ (sanidade do próprio teste)', () => {
    expect(arquivos.length).toBeGreaterThan(50);
  });

  it.each(FRASES_PROIBIDAS.map((re) => [String(re), re]))('nenhum arquivo contém %s', (_nome, re) => {
    const achados = arquivos.filter((f) => re.test(semComentarios(readFileSync(f, 'utf-8'))));
    expect(achados).toEqual([]);
  });
});
