/**
 * Catraca do `npm run typecheck` (docs/known-risks.md item 166, Fase 1).
 *
 * ## O problema que ela resolve
 *
 * O typecheck foi zerado em 2026-08-13 (Bloco 5 do roadmap; eram ~790 erros na
 * prática) e **voltou a divergir por não ter guarda no CI**: 16 erros medidos
 * em 2026-09-05, acumulados sem ninguém ver. O `CLAUDE.md` ainda afirmava "0
 * erros desde 2026-08-13" — a documentação envelheceu junto.
 *
 * ## Por que catraca e não "exigir zero"
 *
 * Este é um projeto JSX com `checkJs` best-effort, não TypeScript. Vários dos
 * erros restantes são atrito de tipagem de biblioteca (`title` num ícone
 * lucide, um campo a mais num objeto literal), não defeito de runtime. Exigir
 * zero forçaria ou uma rodada de correções fora de escopo, ou — muito pior —
 * a tentação de desligar o check, que é como ele chegou aqui.
 *
 * A catraca aceita o passivo atual e **impede que ele cresça**. Um erro NOVO
 * falha o CI; consertar erros antigos baixa o teto sozinho. É o mesmo espírito
 * do `no-undef` do item 157: o guard não precisa ser perfeito, precisa existir
 * e não ter buraco.
 *
 * Uso: `npm run typecheck:ratchet`. Para baixar o teto depois de corrigir,
 * rode com `--update` (ou ajuste `TETO` à mão) e comite a mudança.
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ARQUIVO = fileURLToPath(import.meta.url);

/**
 * Teto atual. **Só pode descer.**
 *
 * Medido em 2026-09-05, em `tradeMetrics.js`, `Assets.jsx`, `Trades.jsx` e
 * `scanner.js` — nenhum deles regressão de runtime, todos atrito de tipagem.
 */
const TETO = 16;

/** Conta as linhas `error TSxxxx` da saída do tsc. */
export function contarErros(saida) {
  return (String(saida ?? '').match(/error TS\d+:/g) ?? []).length;
}

/**
 * Erro de SINTAXE (códigos TS1xxx), que é um buraco na catraca e não um erro
 * de tipo a mais.
 *
 * Achado ao testar a própria catraca: um arquivo que o tsc não consegue
 * *parsear* aborta a análise e ele reporta UM erro em vez de todos — a
 * contagem DESPENCA e a catraca aprovaria alegremente um projeto quebrado.
 * Uma catraca que só olha o número tem exatamente o defeito que ela existe
 * para prevenir, então sintaxe reprova sempre, independente do teto.
 */
export function temErroDeSintaxe(saida) {
  return /error TS1\d{3}:/.test(String(saida ?? ''));
}

function rodarTypecheck() {
  try {
    // O tsc sai com código != 0 quando há erro — a saída é o que interessa.
    return execSync('npx tsc -p ./jsconfig.json', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    return `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
}

/**
 * O corpo só roda quando o arquivo é EXECUTADO, nunca quando é importado.
 *
 * Sem esta guarda, `import { contarErros }` num teste dispararia o tsc inteiro
 * e chamaria `process.exit` no meio da suíte — o arquivo de teste morria com
 * "no tests". É a mesma armadilha de acoplamento do item 158 (importar um
 * módulo que faz trabalho no carregamento), pela terceira vez neste projeto.
 */
function main() {
  const saida = rodarTypecheck();
  const erros = contarErros(saida);
  const atualizar = process.argv.includes('--update');

  console.log(`[typecheck] ${erros} erro(s) · teto ${TETO}`);

  if (temErroDeSintaxe(saida)) {
    console.error('\n❌ ERRO DE SINTAXE. O tsc parou de analisar, então a contagem acima está');
    console.error('truncada e não vale nada — corrija a sintaxe antes de olhar o teto.\n');
    console.error(saida);
    process.exit(1);
  }

  if (atualizar) {
    const src = readFileSync(ARQUIVO, 'utf8').replace(/^const TETO = \d+;$/m, `const TETO = ${erros};`);
    writeFileSync(ARQUIVO, src);
    console.log(`[typecheck] teto atualizado para ${erros} — comite esta mudança.`);
    process.exit(0);
  }

  if (erros > TETO) {
    console.error(`\n❌ O typecheck REGREDIU: ${erros} erros, teto é ${TETO}.`);
    console.error('Os erros novos estão abaixo. Corrija-os — o teto não sobe.\n');
    console.error(saida);
    process.exit(1);
  }

  if (erros < TETO) {
    console.log(`\n✅ Melhorou: ${TETO - erros} erro(s) a menos que o teto.`);
    console.log('Baixe o teto para travar o ganho: npm run typecheck:ratchet -- --update\n');
  }

  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
