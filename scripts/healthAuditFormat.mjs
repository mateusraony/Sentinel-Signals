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
export function agrupar(registros, agora = Date.now()) {
  const grupos = new Map();
  for (const r of registros ?? []) {
    const chave = `${r.module ?? '?'} · ${normalizarMensagem(r.message)}`;
    const g = grupos.get(chave) ?? {
      chave, total: 0, ativos: new Set(),
      // Quem gerou (cron/browser) e a classe do erro (item 252/253) — o que
      // responde "de onde veio?" sem abrir a tela Logs. Logs antigos não têm
      // os campos: o Set fica vazio e a coluna mostra "—".
      executores: new Set(), classes: new Set(),
      // true enquanto TODOS os registros do grupo foram deduplicados por
      // executor (details.dedup_scope) — pré-requisito de `soNavegador`.
      dedupPorExecutor: true,
      // Mesmos dois campos, só sobre o que ocorreu nas últimas
      // ACHADO_SISTEMICO_RECENCIA_HORAS (item 257): o aviso só olha esse
      // recorte, então a supressão "só navegador" também só pode olhar ele.
      executoresRecentes: new Set(), dedupPorExecutorRecente: true, temRecente: false,
      // Estado do navegador no momento de cada erro (item 255 gravou
      // `details.online`/`visibility`; item 257 passou a mostrar).
      contextoNavegador: { oculta: 0, visivel: 0, offline: 0, semDado: 0, total: 0 },
      primeiro: null, ultimo: null, exemplo: r.message,
    };
    g.total += 1;
    if (r.symbol) g.ativos.add(r.symbol);
    // Dois formatos reais: o erro de scan por ativo grava `executor` no nível
    // de cima (SystemLog.createUnique); os logs de lock/config passam por
    // logError/logWarn, cujo 3º argumento é persistido em `details`.
    const executor = r.executor ?? r.details?.executor;
    if (executor) g.executores.add(executor);
    if (r.details?.dedup_scope !== 'executor') g.dedupPorExecutor = false;
    if (r.details?.error_class) g.classes.add(r.details.error_class);
    const t = r.created_date;
    // Sem created_date não dá para provar que é antigo → conta como recente
    // (lado conservador: só pode manter o aviso, nunca suprimi-lo).
    if (!t || (agora - new Date(t).getTime()) <= ACHADO_SISTEMICO_RECENCIA_HORAS * 60 * 60 * 1000) {
      g.temRecente = true;
      if (executor) g.executoresRecentes.add(executor);
      if (r.details?.dedup_scope !== 'executor') g.dedupPorExecutorRecente = false;
    }
    if (executor === 'browser') {
      const c = g.contextoNavegador;
      const online = r.details?.online;
      const vis = r.details?.visibility;
      c.total += 1;
      if (online === false) c.offline += 1;
      if (vis === 'hidden') c.oculta += 1;
      else if (vis === 'visible') c.visivel += 1;
      if (online !== false && vis !== 'hidden' && vis !== 'visible') c.semDado += 1;
    }
    if (t) {
      if (!g.primeiro || t < g.primeiro) g.primeiro = t;
      if (!g.ultimo || t > g.ultimo) g.ultimo = t;
    }
    grupos.set(chave, g);
  }
  return [...grupos.values()].sort((a, b) => b.total - a.total);
}

/**
 * "browser · NETWORK" / "browser/cron · NETWORK/TIMEOUT" / "—". Mais de um
 * executor no mesmo grupo é informação por si só (o problema aparece nos dois
 * lados, o que aponta para a infraestrutura em comum, não para um deles).
 */
export function descreverOrigem(g) {
  const partes = [[...(g.executores ?? [])].sort().join('/'), [...(g.classes ?? [])].sort().join('/')].filter(Boolean);
  return partes.length ? partes.join(' · ') : '—';
}

/**
 * Grupo cujos registros vieram TODOS do navegador. O relógio de trading é o
 * cron (scan.yml); um erro que só o navegador teve não é falha do sistema —
 * é do painel aberto naquele aparelho (rede, aba em segundo plano, suspensão).
 * Sem `executor` ou sem `dedup_scope` (logs antigos, deduplicados sem olhar o
 * executor) ou com cron no meio, NÃO é "só navegador" e continua virando
 * achado como sempre.
 */
export function soNavegador(g) {
  // Decide pelas últimas 24h (item 257) — o mesmo recorte do aviso
  // (`ocorreuRecentemente`). Sem nenhum registro recente o grupo nem vira
  // achado; nesse caso o critério cai para a janela inteira, que é o
  // comportamento do item 255.
  const recorte = g.temRecente === true;
  const ex = [...((recorte ? g.executoresRecentes : g.executores) ?? [])];
  const dedup = recorte ? g.dedupPorExecutorRecente : g.dedupPorExecutor;
  // Sem dedup por executor (logs gravados antes do item 255) um `browser`
  // pode estar escondendo uma falha idêntica do cron — não dá para afirmar
  // "só navegador", então continua avisando.
  return dedup === true && ex.length > 0 && ex.every((e) => e === 'browser');
}

/** Nota para o corpo do relatório: explica por que um grupo não avisa. */
export function notaSoNavegador(g) {
  // "nas últimas 24h" porque `soNavegador` decide por esse recorte (item 257): o
  // grupo pode ter uma falha ANTIGA do cron, que a coluna Origem ainda mostra.
  return soNavegador(g) ? ' — **só navegador, o cron não falhou nas últimas 24h: listado, mas não gera aviso**' : '';
}

/** Sufixo para a mensagem de achado (Telegram): vazio quando não há origem. */
export function sufixoOrigem(g) {
  const o = descreverOrigem(g);
  return o === '—' ? '' : ` (origem: ${o})`;
}

/**
 * "aba oculta 3×, aba visível 1×, offline 2×, sem dado 8×" — o estado do
 * navegador nos erros do grupo (item 257). Só conta registros do navegador;
 * vazio quando não há nenhum. "sem dado" = log anterior ao item 255 (não
 * gravava `online`/`visibility`). Um registro pode somar em mais de uma
 * categoria (offline E aba oculta), então a soma pode passar do total.
 */
export function descreverContextoNavegador(g) {
  const c = g.contextoNavegador;
  if (!c || c.total === 0) return '';
  return [
    c.oculta && `aba oculta ${c.oculta}×`,
    c.visivel && `aba visível ${c.visivel}×`,
    c.offline && `offline ${c.offline}×`,
    c.semDado && `sem dado ${c.semDado}×`,
  ].filter(Boolean).join(', ');
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

// Corte de recência para VIRAR ACHADO (e disparar Telegram) — achado real,
// 2026-09-16: uma falha sistêmica (ex.: item 179, ON CONFLICT sem índice)
// corrigida às 16:33 UTC continuou gerando o MESMO alerta no Telegram em
// toda execução seguinte, porque `g.ultimo` (a ocorrência mais recente do
// grupo) seguia dentro da janela de LIMITE_LOGS/AMOSTRA_ERROS_JANELA_DIAS —
// um problema morto reaparecendo por dias até sair da janela sozinho. Só
// afeta o que vira ACHADO (e portanto o Telegram); o corpo do relatório
// continua listando o grupo inteiro, com "última há Xh" visível, pra quem
// abrir o relatório ver o histórico. Um problema REALMENTE ativo nunca é
// afetado: `g.ultimo` se renova a cada nova ocorrência, então continua
// dentro da janela enquanto continuar acontecendo.
export const ACHADO_SISTEMICO_RECENCIA_HORAS = 24;

export function ocorreuRecentemente(g, agora = Date.now()) {
  return (agora - new Date(g.ultimo).getTime()) <= ACHADO_SISTEMICO_RECENCIA_HORAS * 60 * 60 * 1000;
}
