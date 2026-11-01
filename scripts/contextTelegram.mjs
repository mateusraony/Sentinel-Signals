// Contexto de Mercado — Fase 4a (docs/known-risks.md item 285, addendum 12): remetente de Telegram SEM banco.
//
// Por que existe: o canal do Sentinel (scripts/adminTelegram.js) importa o adaptador do banco e, quando o envio falha,
// grava um registro de log no Postgres — um workflow de contexto que o usasse acordaria o Neon, cuja cota de computação
// é justamente o problema do projeto (itens 282/283). Este módulo faz UMA coisa: um POST ao Telegram. Nenhum banco,
// nenhum motor, nenhum log persistente.
//
// Segurança: o token só entra por `env` e só vai na URL da requisição. O resultado devolve apenas um CÓDIGO curto
// (`sem_credenciais`, `http_401`, `rede`, `prazo`...) — nunca a URL, nunca o texto do erro (uma mensagem de erro de rede
// pode citar a URL com o token). Travado por scripts/contextTelegram.test.js.
export const TELEGRAM_MAX_CHARS = 4096;
export const SEND_TIMEOUT_MS = 15000;

/**
 * @param {{ text: string, env?: Record<string,string|undefined>, fetchImpl?: Function, timeoutMs?: number }} p
 * @returns {Promise<{ ok: true } | { ok: false, reason: string }>}
 */
export async function sendTelegram({ text, env = {}, fetchImpl = globalThis.fetch, timeoutMs = SEND_TIMEOUT_MS } = {}) {
  const token = String(env.TELEGRAM_BOT_TOKEN ?? '').trim();
  const chatId = String(env.TELEGRAM_CHAT_ID ?? '').trim();
  if (!token || !chatId) return { ok: false, reason: 'sem_credenciais' };
  const body = String(text ?? '');
  if (!body.trim()) return { ok: false, reason: 'texto_vazio' };
  // Cortar no meio de uma tag HTML faria o Telegram recusar a mensagem inteira; as mensagens do Contexto são curtas
  // por construção, então um texto longo demais é recusado (honesto) em vez de cortado (quebrado).
  if (body.length > TELEGRAM_MAX_CHARS) return { ok: false, reason: 'texto_longo' };
  if (typeof fetchImpl !== 'function') return { ok: false, reason: 'rede' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: body, parse_mode: 'HTML', disable_web_page_preview: true }),
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, reason: `http_${res.status}` };
    return { ok: true };
  } catch (error) {
    // De propósito não olhamos `error.message`: pode conter a URL (com o token).
    return { ok: false, reason: error?.name === 'AbortError' ? 'prazo' : 'rede' };
  } finally {
    clearTimeout(timer);
  }
}

/** Texto em português para o relatório, a partir do código de `sendTelegram`. */
export function describeSendFailure(reason) {
  const r = String(reason ?? '');
  if (r === 'sem_credenciais') return 'faltam os segredos TELEGRAM_BOT_TOKEN e/ou TELEGRAM_CHAT_ID (ou o envio não estava marcado)';
  if (r === 'texto_vazio') return 'a mensagem ficou vazia';
  if (r === 'texto_longo') return 'a mensagem passou do limite de 4.096 caracteres do Telegram';
  if (r === 'http_401' || r === 'http_404') return 'o Telegram recusou o token (confira TELEGRAM_BOT_TOKEN)';
  if (r === 'http_400') return 'o Telegram recusou a mensagem ou o chat (confira TELEGRAM_CHAT_ID e se o robô já recebeu uma mensagem sua)';
  if (r === 'http_403') return 'o Telegram bloqueou o envio (o robô foi removido ou bloqueado no chat)';
  if (r === 'http_429') return 'limite de envios do Telegram (tente de novo daqui a pouco)';
  if (r.startsWith('http_')) return `o Telegram respondeu com erro (${r.slice(5)})`;
  if (r === 'prazo') return 'o Telegram não respondeu a tempo (15 s)';
  if (r === 'rede') return 'falha de rede ao falar com o Telegram';
  return 'falha desconhecida';
}
