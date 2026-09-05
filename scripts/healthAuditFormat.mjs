/**
 * A parte PURA da auditoria de saúde (item 164): agrupar e formatar.
 *
 * Vive separada de `health-audit.mjs` de propósito. Aquele importa
 * `adminEntities.js`, que faz `initializeApp()` no carregamento do módulo —
 * então qualquer teste que o importasse quebraria sem credencial. É o mesmo
 * acoplamento que já mordeu neste repositório (item 158: importar `rtdb` de
 * `adminEntities.js` dentro de `adminTelegram.js` derrubou 17 testes de uma
 * vez com `SyntaxError: "undefined" is not valid JSON`).
 *
 * Aqui não há I/O nenhum: entra registro, sai texto. Testável sem mock.
 */

/**
 * Agrupa mensagens que são "o mesmo problema em ativos/números diferentes".
 *
 * É o que transforma 200 linhas de log em "3 problemas distintos". Sem isso o
 * relatório é tão ilegível quanto o log cru — e um relatório que ninguém lê é
 * exatamente o estado que a auditoria existe para consertar.
 *
 * Ativo e número viram marcador; o texto restante é a identidade do problema.
 */
export function normalizarMensagem(msg) {
  return String(msg ?? '')
    .replace(/\b[A-Z0-9]{2,12}USDT\b/g, '<ativo>')
    .replace(/\d[\d.,:_-]*/g, 'N')
    .trim()
    .slice(0, 140);
}

/**
 * Agrupa por (módulo + mensagem normalizada), do mais frequente ao menos.
 *
 * `ativos` é um Set porque a pergunta que importa não é "quantas vezes",
 * é **em quantos ativos diferentes** — um erro que aparece em muitos ativos ao
 * mesmo tempo é falha sistêmica, não azar de um símbolo (item 136).
 */
export function agrupar(registros) {
  const grupos = new Map();
  for (const r of registros ?? []) {
    const chave = `${r.module ?? '?'} · ${normalizarMensagem(r.message)}`;
    const g = grupos.get(chave) ?? {
      chave, total: 0, ativos: new Set(),
      primeiro: null, ultimo: null, exemplo: r.message,
    };
    g.total += 1;
    if (r.symbol) g.ativos.add(r.symbol);
    const t = r.created_date;
    if (t) {
      if (!g.primeiro || t < g.primeiro) g.primeiro = t;
      if (!g.ultimo || t > g.ultimo) g.ultimo = t;
    }
    grupos.set(chave, g);
  }
  return [...grupos.values()].sort((a, b) => b.total - a.total);
}

/** "há 3h" / "há 2.1d" — o relatório é lido por humano, não por parser. */
export function haQuantoTempo(iso, agora = Date.now()) {
  if (!iso) return '?';
  const ms = agora - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '?';
  const h = ms / 3_600_000;
  if (h < 1) return `há ${Math.max(1, Math.round(ms / 60_000))}min`;
  if (h < 48) return `há ${h.toFixed(0)}h`;
  return `há ${(h / 24).toFixed(1)}d`;
}

/** Escapa `|` para não quebrar a tabela Markdown do resumo do job. */
export function celula(texto) {
  return String(texto ?? '').replace(/\|/g, '\\|');
}
