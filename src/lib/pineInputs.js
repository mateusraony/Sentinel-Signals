// Lê o código Pine do editor e diz, em linguagem de gente, O QUE O SENTINEL ENXERGA dele (tela Pine Script, aba Sincronização).
// Função PURA: nada de banco, scan ou localStorage. A regra de "o que é lido" ESPELHA `parsePineScript` (src/lib/pineParser.js): só entram
// `nome = input.int|float|bool|string(...)` cujo nome está em DEFAULTS; qualquer outro `input.*` (cores, fonte, timeframe, data, segredo do
// webhook, modos como "Modo de saída do runner"...) nunca chega ao Sentinel — vale só dentro do TradingView. O teste de paridade em
// pineInputs.test.js garante que os valores aqui batem com o `parsePineScript`; se o parser mudar, ele falha.
import { DEFAULTS, SYNCED_STRATEGY_KEYS, NON_PINE_SYNCED_KEYS } from './pineParser';

/** Divide uma lista de argumentos nas vírgulas de nível 0 (respeita parênteses, colchetes e aspas). */
function splitTopLevel(str) {
  const parts = [];
  let depth = 0; let quote = null; let cur = '';
  for (const ch of str) {
    if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '(' || ch === '[') depth++;
    if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

/** Acha o ")" que fecha o "(" em `start` (índice do "("). */
function findClose(code, start) {
  let depth = 0; let quote = null;
  for (let i = start; i < code.length; i++) {
    const ch = code[i];
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '(') depth++;
    if (ch === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

const unquote = (s) => s.replace(/^["']|["']$/g, '');

/** Mesma leitura de valor do parsePineScript (defval nomeado tem prioridade; senão o 1º argumento posicional). */
function readValue(type, argsStr) {
  const namedMatch = argsStr.match(/defval\s*=\s*([^,]+)/);
  const firstArg = argsStr.split(',')[0]?.trim();
  const firstArgIsNamed = firstArg ? /^\w+\s*=/.test(firstArg) : true;
  const rawValue = (namedMatch ? namedMatch[1] : (firstArgIsNamed ? undefined : firstArg))?.trim();
  if (rawValue === undefined) return { ok: false };
  if (type === 'int' || type === 'float') {
    let v = parseFloat(rawValue);
    if (Number.isNaN(v)) return { ok: false };
    if (type === 'int') v = Math.round(v);
    return { ok: true, value: v };
  }
  if (type === 'bool') return { ok: true, value: rawValue === 'true' };
  if (type === 'string') return { ok: true, value: rawValue.replace(/^["']|["']$/g, '') };
  return { ok: false };
}

/** Título (rótulo que o próprio Pine dá ao input) e grupo. */
function readLabel(argsStr, groupVars) {
  const parts = splitTopLevel(argsStr);
  let title = null; let group = null;
  parts.forEach((p, i) => {
    const named = p.match(/^(\w+)\s*=\s*([\s\S]*)$/);
    if (named) {
      if (named[1] === 'title') title = unquote(named[2].trim());
      if (named[1] === 'group') { const v = named[2].trim(); group = /^["']/.test(v) ? unquote(v) : (groupVars[v] ?? null); }
    } else if (i > 0 && title == null && /^["']/.test(p)) {
      title = unquote(p); // 1º texto posicional DEPOIS do valor padrão = título
    }
  });
  return { title, group };
}

/**
 * @param {string} code
 * @returns {{ items: Array<object>, read: Array<object>, ignored: Array<object>, changed: number }}
 *   read: { name, type, title, group, value, defaultValue, isDefault, destination: 'ativos'|'scan'|'local' }
 *   ignored: { name, type, title, group }
 */
export function analyzePineInputs(code) {
  if (!code) return { items: [], read: [], ignored: [], changed: 0 };
  const groupVars = {};
  for (const m of code.matchAll(/^\s*(\w+)\s*=\s*"([^"]*)"\s*$/gm)) groupVars[m[1]] = m[2];

  // O que o parser enxerga: exatamente a mesma regex dele.
  const parserHits = new Map();
  const parserRe = /(\w+)\s*=\s*input\.(int|float|bool|string)\s*\(([^)]*)\)/g;
  let pm;
  while ((pm = parserRe.exec(code)) !== null) {
    const r = readValue(pm[2], pm[3]);
    if (r.ok && pm[1] in DEFAULTS) parserHits.set(pm[1], r.value); // último vence, como no parser
  }

  const items = []; const read = []; const ignored = [];
  const declRe = /(\w+)\s*=\s*input\.(\w+)\s*\(/g;
  let dm;
  while ((dm = declRe.exec(code)) !== null) {
    const open = dm.index + dm[0].length - 1;
    const close = findClose(code, open);
    if (close < 0) continue;
    const argsStr = code.slice(open + 1, close);
    const { title, group } = readLabel(argsStr, groupVars);
    const name = dm[1]; const type = dm[2];
    if (parserHits.has(name) && ['int', 'float', 'bool', 'string'].includes(type)) {
      const value = parserHits.get(name);
      const destination = (name === 'rng_per' || name === 'rng_qty') ? 'ativos'
        : (SYNCED_STRATEGY_KEYS.includes(name) && !NON_PINE_SYNCED_KEYS.has(name)) ? 'scan' : 'local';
      const item = { name, type, title: title ?? name, group, value, defaultValue: DEFAULTS[name], isDefault: value === DEFAULTS[name], destination };
      if (!read.some((r) => r.name === name)) { read.push(item); items.push(item); }
    } else {
      const item = { name, type, title: title ?? name, group };
      ignored.push(item); items.push(item);
    }
  }
  return { items, read, ignored, changed: read.filter((r) => !r.isDefault).length };
}

export const DESTINATION_LABEL = Object.freeze({
  ativos: 'RF de cada ativo ativo',
  scan: 'Scan e painel',
  local: 'Só neste navegador',
});
