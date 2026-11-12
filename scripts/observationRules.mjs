// Modo de observação sem banco (docs/known-risks.md item 299): análise PURA das regras do Realtime Database (RTDB).
//
// O retrato do estado guarda entrada, stop e alvos de operações reais no nó `observation/snapshot`. As regras do RTDB do projeto liberam leitura e escrita
// para `auth != null`, e a autenticação do painel é ANÔNIMA por decisão do usuário (qualquer visitante "está logado"). Um nó SEM regra é NEGADO por padrão
// (só o Admin SDK, que ignora as regras, acessa); é isso que o retrato precisa. Esta análise diz se um conjunto de regras abre esse nó, de três jeitos:
// um `.read`/`.write` na raiz (as regras CASCATEIAM), um curinga `$x` de 1º nível (casa com "observation") ou uma regra no próprio nó ou em qualquer
// descendente dele.
//
// É usada em DOIS lugares, com a mesma lógica: (1) o teste scripts/databaseRulesTripwire.test.js confere o arquivo `database.rules.json` do repositório;
// (2) scripts/observationStore.mjs confere as regras PUBLICADAS no console do Firebase (que podem divergir do arquivo: o deploy das regras é manual)
// ANTES de cada primeira gravação do processo, e se recusa a gravar quando elas expõem o nó.
//
// Módulo PURO (sem import): recebe o texto JSON ou o objeto já lido.

/** Raiz do nó do retrato e do livro de avisos (item 299). Fica FORA de toda regra: negado por padrão. */
export const NO_OBSERVACAO = 'observation';

/** `.read`/`.write` só é "fechado" se for exatamente `false`; qualquer outra expressão (true, "auth != null", "true"…) abre. */
const fechado = (v) => v === undefined || v === false;

/**
 * Percorre `no` e TODOS os descendentes (inclusive curingas `$x` mais fundo) e acusa cada `.read`/`.write` que não seja exatamente `false`.
 * @param {unknown} no regra do nó (objeto)
 * @param {string} caminho nome do nó para a mensagem
 * @param {string} rotulo prefixo legível do problema
 * @returns {string[]}
 */
function regrasAbertasAbaixo(no, caminho, rotulo) {
  const p = [];
  if (!no || typeof no !== 'object') return p;
  for (const campo of ['.read', '.write']) {
    if (!fechado(no[campo])) p.push(`${rotulo}: "${caminho}" com "${campo}" aberto`);
  }
  for (const [k, filho] of Object.entries(no)) {
    if (k.startsWith('.') || !filho || typeof filho !== 'object') continue;
    p.push(...regrasAbertasAbaixo(filho, `${caminho}/${k}`, rotulo));
  }
  return p;
}

/**
 * Problemas nas regras do RTDB que expõem (ou poderiam expor) o nó do retrato. Lista vazia = o nó está fechado.
 * @param {string | { rules?: object }} entrada o texto de `database.rules.json` ou o objeto `{ rules }` já lido
 * @returns {string[]}
 */
export function problemasDasRegrasDoRtdb(entrada) {
  let regras;
  if (typeof entrada === 'string') {
    try {
      regras = JSON.parse(entrada)?.rules;
    } catch {
      return ['as regras não são um JSON válido'];
    }
  } else {
    regras = entrada?.rules;
  }
  if (!regras || typeof regras !== 'object') return ['sem o objeto "rules"'];
  const p = [];
  // 1) As regras CASCATEIAM: um `.read`/`.write` na raiz vale para todos os filhos, inclusive o retrato.
  if (!fechado(regras['.read'])) p.push('raiz com ".read" aberto: vale para todos os nós, inclusive o do retrato');
  if (!fechado(regras['.write'])) p.push('raiz com ".write" aberto: vale para todos os nós, inclusive o do retrato');
  // 2) Curinga no 1º nível (`$qualquer`) casa com "observation": qualquer regra aberta em QUALQUER profundidade sob ele pode alcançar o retrato.
  for (const [chave, no] of Object.entries(regras)) {
    if (chave.startsWith('$')) p.push(...regrasAbertasAbaixo(no, chave, `curinga "${chave}" alcança "${NO_OBSERVACAO}"`));
  }
  // 3) O próprio nó: não precisa existir (negado por padrão); se existir, tudo abaixo dele (em qualquer profundidade) só pode ser explicitamente fechado.
  const noObs = regras[NO_OBSERVACAO];
  if (noObs !== undefined) {
    if (!noObs || typeof noObs !== 'object') p.push(`o nó "${NO_OBSERVACAO}" tem regra que não é um objeto`);
    else p.push(...regrasAbertasAbaixo(noObs, NO_OBSERVACAO, `"${NO_OBSERVACAO}"`));
  }
  return p;
}
