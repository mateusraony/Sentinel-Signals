// Realtime Database FALSO para os testes do modo de observação (item 299, O2b). Não é um mock de chamadas: guarda uma ÁRVORE e se comporta como o RTDB
// de verdade nos pontos que já causaram (ou quase causaram) defeito:
//   - NÃO guarda `null`/`undefined`, objeto vazio nem vetor vazio (um episódio com `snapshot_at: null` volta sem o campo; `operations: []` volta sem a chave);
//   - recusa chave com `. $ # [ ] /` dentro de um segmento e segmento vazio (o erro real do RTDB) — por isso o `update` com caminhos "a/b/c" só aceita
//     segmentos já codificados;
//   - `set`/`update`/`get` devolvem cópias, nunca referências (mexer no objeto devolvido não altera o banco).
// `rules` simula o que está PUBLICADO (getRulesJSON); `fail` injeta erro por operação+caminho.

const INVALID_SEGMENT = /[.$#[\]/]/;

function prune(value) {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) {
    const items = value.map(prune);
    return items.length === 0 || items.every((i) => i === undefined) ? undefined : items.map((i) => (i === undefined ? null : i));
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const p = prune(v);
      if (p !== undefined) out[k] = p;
    }
    return Object.keys(out).length === 0 ? undefined : out;
  }
  return value;
}

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function segments(path) {
  const segs = String(path).split('/');
  for (const s of segs) {
    if (s.length === 0 || INVALID_SEGMENT.test(s)) throw Object.assign(new Error(`Invalid path segment: ${JSON.stringify(s)}`), { code: 'caminho_invalido' });
  }
  return segs;
}

export function createFakeRtdb({ rules = { rules: {} }, initial = {}, fail = {} } = {}) {
  let root = prune(initial) ?? {};
  const calls = [];

  const getAt = (segs) => {
    let node = root;
    for (const s of segs) {
      if (node === null || typeof node !== 'object' || !(s in node)) return undefined;
      node = node[s];
    }
    return node;
  };

  const setAt = (segs, value) => {
    const pruned = prune(value);
    if (segs.length === 0) { root = pruned ?? {}; return; }
    let node = root;
    for (let i = 0; i < segs.length - 1; i += 1) {
      const s = segs[i];
      if (node[s] === null || typeof node[s] !== 'object' || Array.isArray(node[s])) node[s] = {};
      node = node[s];
    }
    const last = segs[segs.length - 1];
    if (pruned === undefined) delete node[last];
    else node[last] = pruned;
    // limpa pais que ficaram vazios (o RTDB não guarda nó vazio)
    const clean = (parent, depth) => {
      if (depth >= segs.length - 1) return;
      const child = parent[segs[depth]];
      if (child && typeof child === 'object') {
        clean(child, depth + 1);
        if (Object.keys(child).length === 0) delete parent[segs[depth]];
      }
    };
    clean(root, 0);
  };

  const maybeFail = (op, path) => {
    const f = fail[`${op}:${path}`] ?? fail[op];
    if (f) throw (typeof f === 'function' ? f() : f);
  };

  const db = {
    getRulesJSON: async () => {
      calls.push({ op: 'rules' });
      maybeFail('rules', '');
      return clone(rules);
    },
    ref(path) {
      const segs = segments(path);
      return {
        async get() {
          calls.push({ op: 'get', path });
          maybeFail('get', path);
          const v = clone(getAt(segs));
          return { exists: () => v !== undefined, val: () => (v === undefined ? null : v) };
        },
        async set(value) {
          calls.push({ op: 'set', path });
          maybeFail('set', path);
          setAt(segs, clone(value));
        },
        async update(updates) {
          calls.push({ op: 'update', path, keys: Object.keys(updates ?? {}) });
          maybeFail('update', path);
          // valida TODOS os caminhos antes de aplicar (o RTDB também recusa o update inteiro)
          const parsed = Object.entries(updates ?? {}).map(([k, v]) => [[...segs, ...segments(k)], clone(v)]);
          for (const [s, v] of parsed) setAt(s, v);
        },
      };
    },
  };

  return {
    db,
    calls,
    /** Leitura direta da árvore, para os testes conferirem o que ficou gravado. */
    read: (path) => clone(getAt(segments(path))),
    /** Escreve direto (monta o cenário do teste) passando pela mesma poda do banco real. */
    seed: (path, value) => setAt(segments(path), clone(value)),
    rulesCalls: () => calls.filter((c) => c.op === 'rules').length,
    writes: () => calls.filter((c) => c.op === 'set' || c.op === 'update'),
  };
}

/** Um `firebase-admin` falso que devolve esse banco (mesma forma que scripts/observationStore.mjs espera). */
export function createFakeFirebase(rtdb, { apps = [] } = {}) {
  const app = { name: 'observation' };
  return {
    getApps: () => apps,
    initializeApp: () => app,
    cert: (j) => ({ __cert: j }),
    getDatabaseWithUrl: () => rtdb.db,
    app,
  };
}

/** Regras PUBLICADAS "seguras": o nó observation não tem regra (negado por padrão); o resto segue `auth != null`, como no projeto. */
export const REGRAS_SEGURAS = {
  rules: {
    assetStates: { '.read': 'auth != null', '.write': 'auth != null' },
    systemAlerts: { '.read': 'auth != null', '.write': 'auth != null' },
  },
};

/** Regras PUBLICADAS que expõem tudo (projeto novo em "modo de teste"). */
export const REGRAS_ABERTAS = { rules: { '.read': true, '.write': true } };
