const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

initializeApp();
const db = getFirestore();

const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');

const SYSTEM_PROMPT = `Você é o Strategy Reviewer, um assistente que ajuda o operador do Sentinel Signals a revisar a disciplina e a qualidade de execução da própria estratégia de trading — não a prever preços nem dar recomendações financeiras.

Contexto do sistema que você está analisando:
- Os sinais nascem de um Range Filter (RF) nos timeframes 1h/4h/1d, confirmados por confluência com RSI, MACD e cruzamento de EMAs.
- Entradas só são abertas no timeframe 15m, e apenas quando há uma tendência de 4h já confirmada na mesma direção — sinais de 4h sem confirmação de 15m ficam pendentes.
- Cada operação (TradeOperation) tem: score de confluência (0-100), preço de entrada, stop inicial, TP1 e TP2, e um ciclo de vida em status: SIGNAL_CONFIRMED → RUNNER_ACTIVE (após TP1, parcial realizada e stop movido a breakeven) → TP2_HIT / STOP_HIT / INVALIDATED / CLOSED.
- A gestão padrão realiza uma parcial no TP1 (partial_percent) e deixa um "runner" (runner_percent) até o TP2 ou até o stop (ATR trailing / Range Filter / híbrido, conforme exit_mode).

Seu papel: com base no histórico de operações e sinais fornecido a seguir, ajude o operador a identificar padrões — win rate real, aderência ao plano (ex: fechamentos manuais fora da regra, invalidações recorrentes em determinado símbolo/timeframe), qualidade dos scores de entrada, e sugestões objetivas de ajuste de processo. Seja direto, cite números do histórico fornecido, e deixe claro quando uma conclusão é apenas uma hipótese por falta de dados. Nunca prometa retornos nem dê conselho de investimento — o foco é processo e disciplina, não previsão de mercado. Responda em português, em markdown, de forma concisa.`;

function fmtPrice(p) {
  if (p === undefined || p === null) return '—';
  return typeof p === 'number' ? p.toString() : String(p);
}

async function buildTradeContext() {
  const snap = await db.collection('tradeOperations').orderBy('created_date', 'desc').limit(60).get();
  const ops = snap.docs.map((d) => d.data());

  if (ops.length === 0) {
    return 'Ainda não há operações registradas no histórico.';
  }

  const closed = ops.filter((o) => ['TP2_HIT', 'STOP_HIT', 'INVALIDATED', 'CLOSED'].includes(o.status));
  const wins = closed.filter((o) => o.status === 'TP2_HIT').length;
  const stopBE = closed.filter((o) => o.status === 'STOP_HIT' && o.tp1_hit).length;
  const stopLoss = closed.filter((o) => o.status === 'STOP_HIT' && !o.tp1_hit).length;
  const invalidated = closed.filter((o) => o.status === 'INVALIDATED').length;
  const winRate = closed.length ? ((wins / closed.length) * 100).toFixed(1) : '0';

  const rows = ops.slice(0, 25).map((o) => (
    `${o.symbol} ${o.side} ${o.timeframe} | score=${o.score ?? '—'} | status=${o.status} | `
    + `entrada=${fmtPrice(o.entry_price)} stop=${fmtPrice(o.current_stop ?? o.initial_stop)} `
    + `tp1=${fmtPrice(o.tp1)}${o.tp1_hit ? '✓' : ''} tp2=${fmtPrice(o.tp2)}${o.tp2_hit ? '✓' : ''} | `
    + `${o.closed_reason || ''}`
  ));

  return [
    `Resumo do histórico (últimas ${ops.length} operações, ${closed.length} fechadas):`,
    `- Win rate (TP2 completo): ${winRate}% (${wins}/${closed.length})`,
    `- Fechadas em breakeven após TP1: ${stopBE}`,
    `- Stop cheio (sem TP1): ${stopLoss}`,
    `- Invalidadas antes de qualquer TP: ${invalidated}`,
    '',
    'Últimas operações (mais recente primeiro):',
    ...rows,
  ].join('\n');
}

exports.strategyReviewerChat = onCall({ secrets: [ANTHROPIC_API_KEY], region: 'us-central1' }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Login necessário.');
  }

  const { conversationId, content } = request.data || {};
  if (!conversationId || typeof content !== 'string' || !content.trim()) {
    throw new HttpsError('invalid-argument', 'conversationId e content são obrigatórios.');
  }

  const convRef = db.collection('agentConversations').doc(conversationId);
  const convSnap = await convRef.get();
  if (!convSnap.exists || convSnap.data().user_id !== request.auth.uid) {
    throw new HttpsError('permission-denied', 'Conversa não encontrada.');
  }

  const messagesRef = convRef.collection('messages');
  const now = () => new Date().toISOString();

  await messagesRef.add({ role: 'user', content: content.trim(), created_date: now() });

  const historySnap = await messagesRef.orderBy('created_date', 'asc').limit(40).get();
  const history = historySnap.docs.map((d) => d.data());
  const tradeContext = await buildTradeContext();

  let replyText;
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY.value(),
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 1500,
        system: `${SYSTEM_PROMPT}\n\n${tradeContext}`,
        messages: history.map((m) => ({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: m.content,
        })),
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Anthropic API ${response.status}: ${errText.slice(0, 300)}`);
    }

    const data = await response.json();
    replyText = (data.content || [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      || 'Não recebi uma resposta de texto do modelo.';
  } catch (err) {
    console.error('strategyReviewerChat: Anthropic call failed', err);
    await messagesRef.add({
      role: 'assistant',
      content: 'Desculpe, não consegui completar a análise agora. Tente novamente em instantes.',
      created_date: now(),
      error: true,
    });
    throw new HttpsError('internal', 'Falha ao consultar o modelo de IA.');
  }

  await messagesRef.add({ role: 'assistant', content: replyText, created_date: now() });

  return { ok: true };
});
