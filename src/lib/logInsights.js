// Entender os logs sem ler 200 linhas cruas (tela Logs). Funções PURAS: entra a lista de SystemLog, sai texto/contagem — nada aqui toca banco,
// motor ou scanner. As regras de "o que é sério" seguem o que o projeto já documenta:
//  - agrupar "o mesmo problema em ativos/números diferentes" e contar EM QUANTOS ATIVOS ele aparece (scripts/healthAuditFormat.mjs, item 136/164);
//  - erro que SÓ o navegador teve não é falha do sistema: o relógio de trading é o scan agendado (cron, scan.yml) — itens 255/257;
//  - a explicação de cada mensagem só existe para mensagens que o código REALMENTE grava (grep de logError/logWarn/logInfo) — nunca inventada.
// Os limiares de `healthSummary` são regras DESTA TELA (um resumo para leitura), não do motor de trading.

/** Ativo e número viram marcador; o texto restante é a identidade do problema (mesma regra da auditoria de saúde). */
export function normalizeMessage(msg) {
  return String(msg ?? '')
    .replace(/\b[A-Z0-9]{2,12}USDT\b/g, '<ativo>')
    .replace(/\d[\d.,:_-]*/g, 'N')
    .trim()
    .slice(0, 140);
}

const executorOf = (log) => log?.executor ?? log?.details?.executor ?? null;

/**
 * Agrupa erros e avisos por (módulo + mensagem normalizada). Do mais grave ao menos, depois do mais frequente.
 * `onlyBrowser`: todos os registros do grupo vieram do navegador (e foram gravados com dedup por executor) — não é falha do scan agendado.
 * @param {Array<object>} logs
 * @param {{ now?: number, sinceHours?: number }} [opts]
 */
export function groupLogs(logs, { now = Date.now(), sinceHours = 24 } = {}) {
  const limit = now - sinceHours * 3600000;
  const groups = new Map();
  for (const log of logs ?? []) {
    if (log.level !== 'error' && log.level !== 'warn') continue;
    const t = new Date(log.created_date).getTime();
    if (Number.isFinite(t) && t < limit) continue;
    const key = `${log.module ?? '?'} · ${normalizeMessage(log.message)}`;
    const g = groups.get(key) ?? {
      key, module: log.module ?? '?', level: 'warn', total: 0, assets: new Set(), executors: new Set(), classes: new Set(),
      allDeduped: true, first: null, last: null, example: log,
    };
    g.total += 1;
    if (log.level === 'error') g.level = 'error';
    if (log.symbol) g.assets.add(log.symbol);
    const ex = executorOf(log);
    if (ex) g.executors.add(ex);
    if (log.details?.error_class) g.classes.add(log.details.error_class);
    if (log.details?.dedup_scope !== 'executor') g.allDeduped = false;
    if (Number.isFinite(t)) {
      if (g.first == null || t < g.first) g.first = t;
      if (g.last == null || t > g.last) { g.last = t; g.example = log; }
    }
    groups.set(key, g);
  }
  const list = [...groups.values()].map((g) => ({
    ...g,
    assets: [...g.assets].sort(),
    executors: [...g.executors].sort(),
    classes: [...g.classes].sort(),
    onlyBrowser: g.allDeduped && g.executors.size > 0 && [...g.executors].every((e) => e === 'browser'),
  }));
  return list.sort((a, b) => (a.level === b.level ? b.total - a.total : a.level === 'error' ? -1 : 1));
}

const CLASS_TEXT = {
  NETWORK: { meaning: 'A conexão falhou nesta tentativa (internet instável, aba em segundo plano ou serviço fora do ar).', action: 'Se vier só do navegador, o scan agendado (cron) não foi afetado. Observe se repete.' },
  TIMEOUT: { meaning: 'A resposta demorou mais que o limite de tempo.', action: 'Acontece de vez em quando; observe se repete.' },
  AUTH: { meaning: 'O servidor recusou a credencial (chave de acesso ou login vencido).', action: 'Confira a "Chave de Acesso do Backend" (ícone de chave, barra de cima).' },
  RATE_LIMIT: { meaning: 'Chamadas demais em pouco tempo; o serviço pediu para esperar.', action: 'Costuma passar sozinho; observe se repete.' },
  HTTP_5XX: { meaning: 'O servidor do outro lado respondeu com erro interno (5xx) — problema dele, geralmente passageiro.', action: 'Observe se repete.' },
  HTTP_4XX: { meaning: 'O pedido foi recusado (erro 4xx): algo no pedido ou na permissão.', action: 'Se repetir, avise com o texto do log.' },
  DATABASE: { meaning: 'Falha de conexão com o banco de dados (Postgres/Neon).', action: 'Se repetir, o painel pode não gravar nem ler dados — avise.' },
};

// Cada regra: como reconhecer o log, e o que ele significa. `tone`: normal (esperado) · attention (olhe se repetir) · problem (age).
/** @type {Array<{ test: (l: any) => boolean, tone: 'normal'|'attention'|'problem', meaning?: string|null, action?: string|null, fromClass?: boolean, build?: (l: any) => { meaning: string, action: string } }>} */
const RULES = [
  { test: (l) => /lock ocupado|outra execução já está em andamento/i.test(l.message), tone: 'normal', meaning: 'Outra execução já estava rodando, então esta pulou para não duplicar. É o comportamento esperado.', action: 'Nada a fazer.' },
  { test: (l) => /Falha ao adquirir lock/i.test(l.message), tone: 'attention', meaning: 'Não conseguiu reservar a "vez" de rodar o scan e seguiu sem a reserva — existe o risco de duas execuções ao mesmo tempo.', action: 'Se repetir, avise.' },
  { test: (l) => /Falha ao liberar lock/i.test(l.message), tone: 'attention', meaning: 'Não conseguiu devolver a reserva da vez. Ela expira sozinha, então o efeito prático é pequeno.', action: 'Só importa se repetir muito.' },
  { test: (l) => /Transição descartada pelo CAS/i.test(l.message), tone: 'normal', meaning: 'Duas execuções tentaram mudar a mesma operação ao mesmo tempo; a segunda foi descartada de propósito para não sobrescrever a primeira (proteção contra concorrência).', action: 'Nada a fazer.' },
  { test: (l) => /Falha ao enviar mensagem ao Telegram/i.test(l.message), tone: 'attention', meaning: 'O aviso não chegou ao Telegram (token ou chat incorretos, ou Telegram indisponível). O scan e as operações não são afetados.', action: 'Abra "Alertas Telegram" (barra de cima) e use Testar Envio.' },
  { test: (l) => /Sem cotação ao vivo/i.test(l.message), tone: 'normal', meaning: 'Sem preço ao vivo para este ativo agora; o painel usa o último preço do scan.', action: 'Nada a fazer.' },
  { test: (l) => /StrategyConfig não confirmado/i.test(l.message), tone: 'attention', meaning: 'Não foi possível confirmar a configuração da estratégia; por segurança o scan NÃO abre operação nova nessa passada (as já abertas continuam acompanhadas).', action: 'Se repetir, verifique o Postgres/Neon e avise.' },
  { test: (l) => /Falha ao ler strategyConfig do Postgres/i.test(l.message), tone: 'attention', meaning: 'Não leu a configuração salva no banco e usou a cópia local ou os valores padrão.', action: 'Se repetir, verifique o banco.' },
  { test: (l) => /operação criada MANUALMENTE|entrada (SMC )?criada/i.test(l.message), tone: 'normal', meaning: 'Uma operação nova foi aberta. É virtual: nenhuma ordem é enviada à corretora.', action: 'Veja em Trades.' },
  { test: (l) => /Ajustes finos salvos|Pine Script sincronizado/i.test(l.message), tone: 'normal', meaning: 'Você salvou parâmetros; valem a partir do próximo scan.', action: 'Nada a fazer.' },
  { test: (l) => l.module === 'errorBoundary' || /Erro de renderização/i.test(l.message), tone: 'attention', meaning: 'Uma tela do painel quebrou ao ser desenhada; o resto do painel segue funcionando.', action: 'Se repetir, use Copiar e envie o texto.' },
  { test: (l) => /Falha ao (salvar|invalidar|encerrar|adicionar|validar|limpar|simular)/i.test(l.message), tone: 'attention', meaning: 'Uma ação sua no painel não foi concluída.', action: 'Tente de novo; se repetir, verifique a conexão.' },
  { test: (l) => /\b451\b/.test(`${l.message} ${l.details?.error ?? ''}`), tone: 'attention', build: (l) => executorOf(l) === 'cron'
    ? { meaning: 'A Binance recusou o pedido (erro 451, bloqueio por região) no scan agendado — ele deveria usar o mercado à vista (Spot), que não é bloqueado.', action: 'Avise com este texto: o scan agendado não está conseguindo ler preços.' }
    : { meaning: 'A Binance recusa Futuros a partir de servidores nos EUA (erro 451). O scan agendado usa o mercado à vista (Spot) justamente por isso; o painel no navegador usa Futuros e pode falhar (limitação aceita).', action: 'Não afeta o scan agendado.' } },
  { test: (l) => /Failed to fetch|fetch failed/i.test(l.message) || l.details?.error_class === 'NETWORK', tone: 'attention', build: (l) => {
    const ex = executorOf(l);
    if (ex === 'cron') return { meaning: 'A conexão falhou durante o scan agendado (internet, Binance ou serviço fora do ar nessa passada).', action: 'Falha isolada passa sozinha na próxima passada; se vários ativos falharem seguidos, avise.' };
    if (ex === 'browser') return { meaning: 'A conexão falhou nesta aba do painel (internet instável ou aba em segundo plano).', action: 'Não afeta o scan agendado. Observe se repete.' };
    return { meaning: CLASS_TEXT.NETWORK.meaning, action: CLASS_TEXT.NETWORK.action };
  } },
  { test: (l) => Boolean(CLASS_TEXT[l.details?.error_class]), tone: 'attention', meaning: null, action: null, fromClass: true },
  { test: (l) => /Erro no scan de/i.test(l.message), tone: 'attention', meaning: 'O scan deste ativo falhou nesta passada; os outros ativos seguem.', action: 'O scan agendado é o relógio de trading: se persistir no mesmo ativo, ele não abre operações nele.' },
];

/**
 * Explicação em português simples de um registro, ou `null` quando a mensagem não é uma das que o código conhece (aí a tela não inventa nada).
 * @returns {{ tone: 'normal'|'attention'|'problem', meaning: string, action: string } | null}
 */
export function explainLog(log) {
  if (!log?.message) return null;
  for (const rule of RULES) {
    if (!rule.test(log)) continue;
    if (rule.build) return { tone: rule.tone, ...rule.build(log) };
    if (rule.fromClass) {
      const c = CLASS_TEXT[log.details.error_class];
      return { tone: 'attention', meaning: c.meaning, action: c.action };
    }
    return { tone: rule.tone, meaning: /** @type {string} */ (rule.meaning), action: /** @type {string} */ (rule.action) };
  }
  return null;
}

/**
 * Resumo de saúde em linguagem simples (últimas `sinceHours`). `unknown` quando não há dado (carregando ou falha de carga).
 *  - problem: erro do scan agendado (não "só navegador") em 3 ou mais ativos, ou falha ao reservar a vez de rodar o scan;
 *  - attention: qualquer outro erro/aviso que não seja "só navegador";
 *  - ok: o resto (inclusive erros que só o navegador teve — listados, mas sem alarme).
 */
export function healthSummary(logs, { now = Date.now(), sinceHours = 24, known = true } = {}) {
  if (!known) return { status: 'unknown', headline: 'Sem leitura dos logs agora', reasons: [], lastLogAt: null, groups: [] };
  const groups = groupLogs(logs, { now, sinceHours });
  const serious = groups.filter((g) => !g.onlyBrowser);
  const errors = serious.filter((g) => g.level === 'error');
  const errorAssets = new Set(errors.flatMap((g) => g.assets));
  const lockFailure = errors.some((g) => /Falha ao adquirir lock/i.test(g.example?.message ?? ''));
  const browserOnly = groups.filter((g) => g.onlyBrowser);
  const times = (logs ?? []).map((l) => new Date(l.created_date).getTime()).filter(Number.isFinite);
  const lastLogAt = times.length ? Math.max(...times) : null;

  const reasons = [];
  const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;
  if (errors.length) reasons.push(`${plural(errors.length, 'tipo de erro', 'tipos de erro')} do scan agendado ou do painel${errorAssets.size ? `, em ${plural(errorAssets.size, 'ativo', 'ativos')}` : ''}`);
  const warns = serious.filter((g) => g.level === 'warn');
  if (warns.length) reasons.push(`${plural(warns.length, 'tipo de aviso', 'tipos de aviso')} que merece${warns.length === 1 ? '' : 'm'} um olhar`);
  if (browserOnly.length) reasons.push(`${plural(browserOnly.length, 'tipo de erro', 'tipos de erro')} só do navegador — não afeta${browserOnly.length === 1 ? '' : 'm'} o scan agendado`);

  let status = 'ok';
  if (errorAssets.size >= 3 || lockFailure) status = 'problem';
  else if (errors.length || warns.length) status = 'attention';
  const headline = {
    ok: 'Tudo normal nas últimas 24 horas',
    attention: 'Atenção: há erros ou avisos nas últimas 24 horas',
    problem: 'Problema: o scan agendado registrou falhas importantes',
  }[status];
  return { status, headline, reasons, lastLogAt, groups };
}

/** 24 barras (1 por hora, da mais antiga à mais recente) com a contagem por nível — para ver QUANDO os problemas aconteceram. */
export function hourlyActivity(logs, { now = Date.now(), hours = 24 } = {}) {
  const hourMs = 3600000;
  const end = Math.floor(now / hourMs) * hourMs + hourMs; // fim da hora atual
  const buckets = Array.from({ length: hours }, (_, i) => ({ start: end - (hours - i) * hourMs, error: 0, warn: 0, info: 0, debug: 0 }));
  for (const log of logs ?? []) {
    const t = new Date(log.created_date).getTime();
    if (!Number.isFinite(t)) continue;
    const idx = Math.floor((t - (end - hours * hourMs)) / hourMs);
    if (idx < 0 || idx >= hours) continue;
    const b = buckets[idx];
    if (log.level === 'error') b.error += 1;
    else if (log.level === 'warn') b.warn += 1;
    else if (log.level === 'debug') b.debug += 1;
    else b.info += 1;
  }
  return buckets;
}

/** Legenda curta dos níveis e da origem — para quem não é desenvolvedor. */
export const LEVEL_HELP = Object.freeze([
  { label: 'ERR', text: 'algo falhou' },
  { label: 'WARN', text: 'estranho, mas o sistema seguiu' },
  { label: 'INFO', text: 'aconteceu normalmente' },
  { label: 'DBG', text: 'detalhe técnico' },
]);

export const EXECUTOR_HELP = Object.freeze({
  cron: 'scan agendado (GitHub Actions) — roda sozinho, sem precisar do navegador; é o relógio de trading',
  browser: 'esta aba do painel aberta no navegador',
});
