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
 * ## Os três buracos de uma catraca ingênua (todos fechados aqui)
 *
 * Uma catraca que só compara números tem a mesma doença que ela previne. Os
 * três foram achados testando-a, não teorizando:
 *
 * 1. **Erro de sintaxe DERRUBA a contagem** — o tsc aborta e reporta 1 em vez
 *    de 17, abaixo do teto, aprovado.
 * 2. **Compilador que não roda vira "sem erros"** (Codex, PR #312). Config
 *    ilegível, `TS5023`/`TS5058`, `TS18003` (nenhum arquivo de entrada),
 *    processo morto por sinal, binário ausente: tudo dava 0 ou 1 erro,
 *    passava no teto, e o CI ficava verde **sem nenhum typecheck ter
 *    acontecido**. Verificado: com um `jsconfig.json` apontando para pasta
 *    inexistente, a versão anterior saía com código 0.
 * 3. **`--update` podia SUBIR o teto** (Codex, PR #312). O ramo de atualização
 *    rodava ANTES da checagem de regressão, então rodá-lo com 17 erros gravava
 *    `TETO = 17` e abençoava a regressão para sempre.
 *
 * Uso: `npm run typecheck:ratchet`. Depois de corrigir erros,
 * `npm run typecheck:ratchet -- --update` baixa o teto (e recusa subir).
 */
import { spawnSync } from 'node:child_process';
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

/** Códigos de saída que significam "o tsc rodou e reportou diagnósticos". */
const STATUS_NORMAIS = new Set([0, 1, 2]);

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
  return /error TS1\d{3}:(?!\d)/.test(String(saida ?? ''));
}

/**
 * O tsc chegou a CHECAR o projeto?
 *
 * Distingue "rodou e achou erros de tipo" (o caso normal, que o teto julga) de
 * "não rodou" — que nunca pode passar, porque contagem baixa aí não significa
 * qualidade, significa ausência de medição.
 *
 * @returns {{ rodou: boolean, motivo: string|null }}
 */
export function avaliarExecucao({ status, signal, saida, erroDeSpawn }) {
  if (erroDeSpawn) return { rodou: false, motivo: `o compilador não pôde ser executado (${erroDeSpawn})` };
  if (signal) return { rodou: false, motivo: `o compilador foi morto pelo sinal ${signal}` };
  if (!STATUS_NORMAIS.has(status)) return { rodou: false, motivo: `o compilador saiu com código inesperado ${status}` };
  // TS5xxx/TS6xxx = opção ou arquivo de configuração inválido. TS18003 = "No
  // inputs were found in config file", o mais traiçoeiro: UM erro, nenhum
  // arquivo checado.
  const config = String(saida ?? '').match(/error TS(5\d{3}|6\d{3}|18003):/);
  if (config) return { rodou: false, motivo: `erro de configuração do compilador (TS${config[1]})` };
  return { rodou: true, motivo: null };
}

function rodarTypecheck() {
  const r = spawnSync('npx', ['tsc', '-p', './jsconfig.json'], { encoding: 'utf8' });
  return {
    saida: `${r.stdout ?? ''}${r.stderr ?? ''}`,
    status: r.status,
    signal: r.signal,
    erroDeSpawn: r.error?.message ?? null,
  };
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
  const execucao = rodarTypecheck();
  const { saida } = execucao;
  const erros = contarErros(saida);
  const atualizar = process.argv.includes('--update');

  console.log(`[typecheck] ${erros} erro(s) · teto ${TETO}`);

  // ORDEM IMPORTA: "o compilador rodou?" vem antes de qualquer comparação com
  // o teto. Foi assim que a versão anterior deixava o CI verde com um
  // jsconfig.json quebrado.
  const { rodou, motivo } = avaliarExecucao(execucao);
  if (!rodou) {
    console.error(`\n❌ O TYPECHECK NÃO ACONTECEU: ${motivo}.`);
    console.error('A contagem acima não vale nada — nenhum arquivo foi checado.\n');
    console.error(saida);
    process.exit(1);
  }

  if (temErroDeSintaxe(saida)) {
    console.error('\n❌ ERRO DE SINTAXE. O tsc parou de analisar, então a contagem acima está');
    console.error('truncada e não vale nada — corrija a sintaxe antes de olhar o teto.\n');
    console.error(saida);
    process.exit(1);
  }

  if (atualizar) {
    if (erros > TETO) {
      console.error(`\n❌ --update recusado: ${erros} erros é MAIOR que o teto ${TETO}.`);
      console.error('O teto só desce. Subi-lo abençoaria a regressão em vez de corrigi-la.\n');
      console.error(saida);
      process.exit(1);
    }
    const src = readFileSync(ARQUIVO, 'utf8').replace(/^const TETO = \d+;$/m, `const TETO = ${erros};`);
    writeFileSync(ARQUIVO, src);
    console.log(`[typecheck] teto baixado para ${erros} — comite esta mudança.`);
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
