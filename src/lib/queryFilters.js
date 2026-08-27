/**
 * Semântica compartilhada dos valores de filtro aceitos por
 * `backend.entities.<Nome>.filter()`.
 *
 * Os TRÊS backends chamam esta função para que um filtro signifique
 * exatamente a mesma coisa nos três — `src/api/entities.js` (Firestore no
 * browser), `scripts/adminEntities.js` (firebase-admin no cron) e
 * `src/lib/__fixtures__/fakeBackend.js` (fake em memória, usado pelos
 * testes E pelo backtest via `scripts/backtestEntities.js`). É o mesmo
 * motivo pelo qual `opTransition.js` já é compartilhado pelos três: o
 * `scanner.js` roda idêntico nos três ambientes, então uma divergência de
 * semântica aqui vira divergência de comportamento do motor.
 *
 * Formas aceitas:
 *
 *   { campo: valor }          → igualdade (`==`)
 *   { campo: [a, b] }         → Firestore `in` (máx. 30 valores)
 *   { campo: { gte: valor } } → range `>=` avaliado NO SERVIDOR
 *
 * O range existe para o caso do `docs/known-risks.md` item 133: consultas
 * que buscavam os N últimos documentos e descartavam pelo tempo no cliente
 * pagavam leitura por documento descartado, 312×/dia por ativo — a leitura
 * era o lado apertado da cota do plano Spark (82-88% dos 50k/dia).
 *
 * **Operador desconhecido LANÇA, nunca é ignorado.** Ignorar em silêncio
 * devolveria MAIS documentos que o pedido (perde a economia de cota sem
 * avisar); e traduzir `{ gte: x }` como igualdade devolveria ZERO
 * documentos, quebrando o chamador sem erro. Falha silenciosa em consulta
 * é exatamente a classe de bug que este projeto já pagou caro várias vezes
 * (itens 131/132) — aqui ela falha alto.
 */

/** Operadores de range suportados → operador do Firestore. */
export const RANGE_OPERATORS = Object.freeze({ gte: '>=' });

/**
 * Um valor de filtro é descritor de range quando é objeto simples (não
 * array, não null, não Date). `Date` fica de fora de propósito: o projeto
 * grava e compara `created_date` como string ISO, então uma Date aqui seria
 * quase certamente um engano do chamador — e cai no ramo de igualdade, que
 * não casaria com nada. Não é papel desta função adivinhar isso.
 */
function isPlainObject(value) {
  return (
    value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && !(value instanceof Date)
  );
}

/**
 * Classifica um valor de filtro numa das formas suportadas.
 *
 * @param {string} field - nome do campo (só para mensagem de erro)
 * @param {*} value - valor bruto vindo do objeto de filtros
 * @returns {{kind: 'skip'} | {kind: 'in', operand: any[]}
 *   | {kind: 'eq', operand: *} | {kind: 'range', operator: string, operand: *}}
 */
export function classifyFilter(field, value) {
  if (value === undefined) return { kind: 'skip' };
  if (Array.isArray(value)) return { kind: 'in', operand: value };
  if (!isPlainObject(value)) return { kind: 'eq', operand: value };

  const keys = Object.keys(value);
  const suportados = Object.keys(RANGE_OPERATORS).join(', ');

  if (keys.length !== 1) {
    throw new Error(
      `filter(${field}): descritor de range precisa de exatamente 1 operador, `
      + `recebeu ${keys.length} (${keys.join(', ') || 'nenhum'}). Suportados: ${suportados}.`,
    );
  }

  const [op] = keys;
  if (!Object.hasOwn(RANGE_OPERATORS, op)) {
    throw new Error(
      `filter(${field}): operador de range desconhecido '${op}'. Suportados: ${suportados}.`,
    );
  }

  const operand = value[op];
  if (operand === undefined) {
    throw new Error(`filter(${field}): operador '${op}' recebeu undefined.`);
  }

  return { kind: 'range', operator: RANGE_OPERATORS[op], operand };
}

/**
 * Avalia um filtro já classificado contra o valor de um documento — só o
 * backend em memória precisa disto (Firestore/admin traduzem para a query
 * nativa). Mantido aqui, ao lado de `classifyFilter`, para que a
 * comparação do fake NUNCA divirja do operador que os outros dois emitem.
 */
export function matchesFilter(field, value, docValue) {
  const parsed = classifyFilter(field, value);
  switch (parsed.kind) {
    case 'skip': return true;
    case 'in': return parsed.operand.includes(docValue);
    case 'eq': return docValue === parsed.operand;
    case 'range':
      // Um documento sem o campo nunca satisfaz um range — mesmo
      // comportamento do Firestore, que não indexa doc sem o campo e
      // portanto o omite do resultado de uma consulta de range.
      if (docValue === undefined || docValue === null) return false;
      return docValue >= parsed.operand;
    default:
      throw new Error(`filter(${field}): classificação inesperada.`);
  }
}
