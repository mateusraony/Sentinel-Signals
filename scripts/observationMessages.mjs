// Modo de observação sem banco, fase O2a (docs/known-risks.md item 299): os textos que o vigia manda no Telegram.
//
// Módulo PURO (sem import além da constante de tamanho do Telegram, sem relógio, sem rede): recebe números e textos, devolve HTML do Telegram
// (`parse_mode: HTML`). Quem envia é a O2b, pelo remetente SEM banco (`scripts/contextTelegram.mjs`).
//
// Cuidados:
//  - todo texto que vem do banco (símbolo) passa por `escapeHtml`; o lado (BUY/SELL) é de lista fechada; só as marcações do próprio template
//    (<b>, <i>) ficam: um `<` solto faria o Telegram recusar a mensagem inteira;
//  - dado ausente vira "—", nunca "undefined"/"NaN";
//  - sem link do painel: durante a queda o painel não tem dados, e o link levaria a uma tela vazia;
//  - horário em Brasília (UTC−3 fixo; o Brasil não tem horário de verão desde 2019), como o resto do canal;
//  - emojis só os já registrados em src/lib/emojiRegistry.js (🛑 stop, 🎯 TP1, 🏆 alvo final, ⚠️ aviso).

const MAX_LISTED_OPERATIONS = 20;

const FOOTER = '<i>⚡ Sentinel Signals — modo de observação (banco sem cota)</i>';

function escapeHtml(text) {
  return String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Mesma formatação de preço do canal normal (`fmtP` de src/lib/notificationTemplates.js; a igualdade é travada por teste). */
function fmtPrice(p) {
  if (!isNum(p)) return '—';
  if (p >= 10000) return p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (p >= 1) return p.toFixed(4);
  return p.toFixed(6);
}

/** "12/11 07:15" em Brasília (UTC−3), ou "—" se o instante for ilegível. */
export function formatBrasilia(ms) {
  if (!isNum(ms)) return '—';
  const d = new Date(ms - 3 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

const label = (symbol) => escapeHtml(String(symbol ?? '—').replace('USDT', '/USDT'));
const sideText = (side) => (side === 'BUY' || side === 'SELL' ? side : '—');

function timeframeOf(op) {
  const tf = op?.signal_timeframe || op?.timeframe;
  return typeof tf === 'string' && /^[0-9]{1,2}[mhdw]$/i.test(tf) ? tf.toUpperCase() : null;
}

function headerLine(op) {
  const tf = timeframeOf(op);
  return `<b>${label(op?.symbol)}</b> | ${sideText(op?.side)}${tf ? ` | ${tf}` : ''}`;
}

function whyLine(snapshotAtMs) {
  return `📝 Por que você recebe isto: o banco de dados está sem cota, então o painel não registra nada. Este aviso compara o retrato das operações de ${formatBrasilia(snapshotAtMs)} (Brasília) com as velas de 15 min da Binance (Spot). `
    + 'Nada foi fechado no painel: a operação continua "aberta" lá até o banco voltar.';
}

/**
 * O aviso de UM evento (stop, TP1, TP1 que fecha tudo, TP2).
 * @param {{ event: string, op: object, level: number, candleOpenMs: number, snapshotAtMs: number, ambiguous?: boolean, afterTp1?: boolean }} p
 * @returns {string|null} HTML do Telegram, ou null para evento desconhecido (não inventa texto)
 */
export function buildWatchAlert({ event, op, level, candleOpenMs, snapshotAtMs, ambiguous = false, afterTp1 = false } = {}) {
  const vela = `na vela de 15 min das ${formatBrasilia(candleOpenMs)} (Brasília)`;
  let head;
  let body;
  if (event === 'stop') {
    head = '🛑 <b>Stop atingido</b> — modo de observação';
    body = `O preço tocou o stop em $${fmtPrice(level)} ${vela}.\n📍 Entrada: $${fmtPrice(op?.entry_price)} → stop: $${fmtPrice(level)}`
      + (afterTp1 ? '\nComo o TP1 já tinha sido atingido, o stop estava protegido na entrada (ou melhor).' : '')
      + (ambiguous ? '\n⚠️ Na mesma vela o preço também tocou o alvo. O gráfico não diz qual veio primeiro; vale o stop (regra do sistema).' : '');
  } else if (event === 'tp1') {
    head = '🎯 <b>TP1 atingido</b> — modo de observação';
    body = `O preço tocou o TP1 em $${fmtPrice(level)} ${vela}.\n`
      + `Stop protegido: no preço de entrada ($${fmtPrice(op?.entry_price)}) ou melhor. O vigia NÃO acompanha o trailing depois do TP1: confira o stop à mão.\n`
      + (op?.tp2_cap_disabled === true ? '👉 Esta operação não tem TP2 fixo (sem alvo final).' : `👉 Próximo alvo (TP2): $${fmtPrice(op?.tp2)}.`);
  } else if (event === 'tp1_full') {
    head = '🎯 <b>TP1 atingido — posição encerrada 100%</b> — modo de observação';
    body = `O preço tocou o TP1 em $${fmtPrice(level)} ${vela}. Esta operação não tem runner: a posição inteira sai no TP1.\n📍 Entrada: $${fmtPrice(op?.entry_price)} → saída: $${fmtPrice(level)}`;
  } else if (event === 'tp2') {
    head = '🏆 <b>Alvo final (TP2) atingido</b> — modo de observação';
    body = `O preço tocou o alvo final em $${fmtPrice(level)} ${vela}.\n📍 Entrada: $${fmtPrice(op?.entry_price)} → saída: $${fmtPrice(level)}`;
  } else {
    return null;
  }
  return `${head}\n\n${headerLine(op)}\n\n${body}\n\n${whyLine(snapshotAtMs)}\n\n${FOOTER}`;
}

/**
 * O vigia ligou (1 mensagem por queda): o que vigia, a base, e o que NÃO vigia.
 * @param {{ operations: Array<{symbol:string, side:string}>, dropped?: number, snapshotAtMs: number }} p
 */
export function buildStartNotice({ operations, dropped = 0, snapshotAtMs } = {}) {
  const list = Array.isArray(operations) ? operations : [];
  const shown = list.slice(0, MAX_LISTED_OPERATIONS).map((o) => `${label(o?.symbol)} ${sideText(o?.side)}`);
  const rest = list.length - shown.length;
  const n = list.length;
  const fora = Number.isFinite(dropped) && dropped > 0 ? dropped : 0;
  return (
    '<b>Modo de observação ligado</b> — o banco está sem cota.\n\n'
    + `Vigiando ${n} ${n === 1 ? 'operação' : 'operações'}${shown.length ? `: ${shown.join(', ')}${rest > 0 ? ` e mais ${rest}` : ''}` : ''}.\n`
    + `Base: o retrato das operações de ${formatBrasilia(snapshotAtMs)} (Brasília), comparado com as velas de 15 min da Binance (Spot).\n\n`
    + 'O que é vigiado: stop, TP1 e TP2. NÃO é vigiado: Time Stop, Chop Exit, invalidação e o trailing depois do TP1.\n'
    + (fora > 0 ? `\n⚠️ ${fora} ${fora === 1 ? 'operação viva ficou' : 'operações vivas ficaram'} FORA do retrato: o vigia não as vê. Confira à mão.\n` : '')
    + `\n${FOOTER}`
  );
}

/** O retrato já era velho (mais de 2 h) quando a queda começou: o vigia não confia e não vigia. */
export function buildStaleNotice({ snapshotAtMs, startedAtMs } = {}) {
  return (
    '⚠️ <b>Modo de observação: NÃO está vigiando</b>\n\n'
    + `O último retrato das operações é de ${formatBrasilia(snapshotAtMs)} (Brasília), mais de 2 h antes de o banco cair (${formatBrasilia(startedAtMs)}). `
    + 'Um retrato assim pode ter operações que já mudaram; vigiar com ele poderia dar aviso falso ou perder um stop. '
    + 'A gravação do retrato (linha "retrato" do log do scan) provavelmente estava falhando ou desligada.\n\n'
    + '👉 Próximo passo: confira suas operações à mão enquanto o banco estiver fora.\n\n'
    + FOOTER
  );
}

/** Não existe retrato utilizável: o vigia não tem o que vigiar. */
export function buildNoSnapshotNotice({ startedAtMs } = {}) {
  return (
    '⚠️ <b>Modo de observação: NÃO está vigiando</b>\n\n'
    + `O banco caiu em ${formatBrasilia(startedAtMs)} (Brasília) e não há retrato utilizável das operações (nunca foi gravado, está ilegível ou é de uma versão que o vigia não conhece).\n\n`
    + '👉 Próximo passo: confira suas operações à mão enquanto o banco estiver fora.\n\n'
    + FOOTER
  );
}

/**
 * O banco voltou: fecha o episódio com a contagem de avisos e lembra que o que passou na pausa não é reprocessado sozinho.
 * @param {{ alertsSent: number, status: string, startedAtMs: number, endedAtMs: number }} p
 */
export function buildRecoveryNotice({ alertsSent, status, startedAtMs, endedAtMs } = {}) {
  const n = Number.isFinite(alertsSent) && alertsSent > 0 ? Math.floor(alertsSent) : 0;
  const vigiou = status === 'watching';
  const resumo = !vigiou
    ? 'Nesta queda o vigia ficou sem vigia (o retrato era velho demais ou não existia).'
    : n === 0
      ? 'Durante a queda o vigia não mandou nenhum aviso de stop ou alvo.'
      : `Durante a queda o vigia mandou ${n} ${n === 1 ? 'aviso' : 'avisos'} de stop/alvo.`;
  return (
    '<b>Banco voltou — fim do modo de observação</b>\n\n'
    + `Queda de ${formatBrasilia(startedAtMs)} até ${formatBrasilia(endedAtMs)} (Brasília). ${resumo}\n\n`
    + 'O scan voltou a rodar, mas ele só olha a vela atual: stops, alvos e entradas que aconteceram durante a pausa NÃO foram reprocessados sozinhos.\n\n'
    + '👉 Próximo passo: rode "Recuperação após pausa do banco" (Actions → Run workflow, campo "O que fazer" = teste-a-seco). Roteiro: docs/claude/recovery-runbook.md.\n\n'
    + FOOTER
  );
}
