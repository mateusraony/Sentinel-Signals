/**
 * Registro "1 emoji = 1 significado" (item 280, PR-E3). Pedido do usuário:
 * aprimorar os emojis, não removê-los — cada glifo com um único sentido, sempre
 * acompanhado de texto (leitor de tela anuncia emoji de forma irregular; o
 * texto ao lado é o que garante o sentido).
 *
 * Fonte única do código; `docs/notification-vocabulary.md` é o espelho humano.
 * Os estágios do ciclo de vida continuam em `NOTIFICATION_STAGES`
 * (`notificationVocabulary.js`) — o teste deste módulo confere que cada um
 * deles aparece aqui com o mesmo sentido.
 *
 * Como a varredura (`emojiRegistry.test.js`) decide se um uso está certo:
 * - `forbidden`: o glifo não pode aparecer fora de comentário;
 * - senão, o texto logo depois de cada ocorrência (até fechar a string ou a
 *   tag) precisa casar com `context` (palavras do próprio sentido), ou o
 *   arquivo precisa ser um dos `files` donos daquele vocabulário (onde o glifo
 *   é escolhido por ternário/tabela, sem a palavra ao lado);
 * - sem `context` nem `files`: só referência, sem checagem automática (glifos
 *   de uso amplo, como ✅/⚠️, ou já cobertos por outra guarda).
 *
 * Nada aqui é lido pelo motor de trading.
 */

/**
 * @typedef {{ meaning: string, context?: RegExp, files?: string[], forbidden?: boolean }} EmojiRule
 * @param {string} meaning
 * @param {{ context?: RegExp, files?: string[], forbidden?: boolean }} [rules]
 * @returns {Readonly<EmojiRule>}
 */
const entry = (meaning, rules = {}) => Object.freeze({ meaning, ...rules });

export const EMOJI_REGISTRY = Object.freeze({
  // ── Ciclo de vida sinal → operação (espelha NOTIFICATION_STAGES) ──────────
  '🔔': entry('Sinal Detectado'),
  '🔎': entry('Sinal para Conferir'),
  '⏳': entry('Aguardando Entrada', {
    context: /aguardando (confirmação|entrada)|entrada|confirma/i,
    files: ['src/lib/notificationVocabulary.js', 'src/lib/signalStatus.js'],
  }),
  '✅': entry('Entrada Confirmada'),
  '🎯': entry('TP1 Atingido'),
  '🏃': entry('Runner Ativo', { context: /runner/i, files: ['src/lib/notificationVocabulary.js'] }),
  '🏆': entry('TP2 Atingido — Alvo Final'),
  '🛑': entry('Stop Atingido'),
  '🟡': entry('Encerrada no Breakeven', {
    context: /\bBE\b|breakeven/i,
    files: ['src/lib/notificationVocabulary.js'],
  }),
  '💰': entry('Stop Travou Lucro', { context: /lucro/i, files: ['src/lib/notificationVocabulary.js'] }),
  '⚠️': entry('Sinal Invalidado'),
  '⏱️': entry('Time Stop', { context: /time\s?stop|prazo máximo/i, files: ['src/lib/notificationVocabulary.js'] }),
  '🌊': entry('Chop Exit'),
  '🚫': entry('Sinal Cancelado', {
    // signalStatus.js: fase "Já passou" (prazo acabou sem operação) — o mesmo
    // evento que o Telegram chama de Sinal Cancelado.
    context: /cancelad|expir/i,
    files: ['src/lib/notificationVocabulary.js', 'src/lib/signalStatus.js'],
  }),

  // ── Linhas auxiliares (Telegram e painel) ──────────────────────────────────
  'ℹ️': entry('Só informação — este aviso não abre operação'),
  '👉': entry('Próximo passo'),
  '🏷️': entry('Preço de referência'),
  '🧩': entry('Regras alinhadas N/100 — não é chance de acerto', {
    context: /\/100|regras|concordância|score/i,
    files: ['src/lib/ruleAgreement.js'],
  }),
  '🛡️': entry('Stop protegido: no preço de entrada ou melhor (operação viva)', { context: /stop[^'"`]*entrada|protegid/i }),
  '📈': entry('Preço subiu no período mostrado', { files: ['src/lib/priceChange24h.js'] }),
  '📉': entry('Preço caiu no período mostrado', { files: ['src/lib/priceChange24h.js'] }),
  '⌛': entry('Duração / tempo de espera'),
  '📌': entry('Nota explicativa sobre um encerramento'),
  '🧭': entry('Tendência do timeframe maior'),

  // ── Painel ─────────────────────────────────────────────────────────────────
  '📏': entry('Distância até a linha do Range Filter — não indica sinal próximo', { context: /filtro|dist/i }),
  '📡': entry('Dado de mercado: fonte (Futures/Spot/TradingView), frescor e rede (atualizado / atrasado / falha / desligado / sem leitura)', {
    context: /fonte|tradingview|atualiz|atrasad|falha|desligad|leitura|saúde|verificando|rede/i,
    files: ['src/lib/assetDataQuality.js'],
  }),
  '🧪': entry('Simulação manual — fora da medição do motor', {
    context: /simula|manual/i,
    files: ['src/lib/operationProvenance.js'],
  }),
  '✏️': entry('Encerrada à mão pelo painel — fora da medição do motor'),
  '♻️': entry('Recuperada após pausa do banco — reconstruída pelo replay, fora da medição do motor', { context: /recuper/i }),
  '⭐': entry('Prioridade alta', { context: /⭐ ?(alta|prioridade:? ?alta)(?![\wà-ú])/i }),
  '👍': entry('O que ajuda o aviso', { context: /ajuda/i }),
  '👎': entry('O que atrapalha o aviso', { context: /atrapalha/i }),
  '⚙️': entry('Configuração / parâmetro ajustável'),
  '🕯️': entry('Vela (candle) aberta ou fechada'),
  '🎚️': entry('Tier (classe de volatilidade do ativo)'),
  '📐': entry('Evidência numérica (resultado em R, fatos que levaram à decisão)'),
  '🚨': entry('Alerta do sistema (infraestrutura) — não é evento de operação'),
  '🔄': entry('Sincronização', { context: /sincroniz|\bsync\b/i }),
  '⚡': entry('Marca "⚡ Sentinel Signals" — não é prioridade, runner nem força', { context: /Sentinel Signals/ }),

  // ── Proibidos (sentido antigo enganoso) ────────────────────────────────────
  '🔥': entry('Não usar — soava como chance de acerto (força é 🧩)', { forbidden: true }),
  '〰': entry('Não usar — "fraco" virou 🧩 N/100', { forbidden: true }),
  '🚀': entry('Não usar — runner é 🏃', { forbidden: true }),
  '⏰': entry('Não usar — Time Stop é ⏱️', { forbidden: true }),
});

/** Seletor de variação (U+FE0F): "🛡️" e "🛡" são o mesmo glifo para a checagem. */
const bare = (s) => s.replace(/\uFE0F/g, '');

/**
 * Onde termina o texto que acompanha o glifo: fim da string, tag JSX, linha,
 * `\n` escrito dentro da string (outra linha da mensagem) ou o próximo emoji.
 */
const WINDOW_END = /['"`<\n]|\\n|\p{Extended_Pictographic}/u;
/** Ícone isolado lê até o fim do objeto/tag em que está (o `label` vizinho). */
const ICON_END = /[}>]|\p{Extended_Pictographic}/u;
const WINDOW_MAX = 80;
/** Tags de formatação das mensagens do Telegram não separam o glifo do texto. */
const TELEGRAM_TAGS = /<\/?(?:b|i|u|s|code|pre)>/g;

/**
 * O texto logo depois do glifo (até fechar a string/tag, no máximo 80
 * caracteres). A regra olha só esse trecho — olhar a linha inteira deixava
 * "⚡ Prioridade mínima … ⚡ Sentinel Signals" passar pela palavra da marca no
 * fim da mesma linha (achado da 2ª revisão). Glifo sozinho numa string (ícone
 * de tabela: `icon: '🧩', label: 'Score…'`) lê até fechar o objeto/tag — o
 * `label` vizinho, não o objeto seguinte (3ª revisão).
 */
function textAfter(line, index, glyphLength) {
  const glyph = line.slice(index, index + glyphLength);
  const rest = line.slice(index + glyphLength);
  const stop = rest.search(WINDOW_END);
  const near = (stop === -1 ? rest : rest.slice(0, stop)).slice(0, WINDOW_MAX);
  if (near.trim() !== '') return glyph + near;
  const iconStop = rest.search(ICON_END);
  return glyph + (iconStop === -1 ? rest : rest.slice(0, iconStop));
}

/**
 * Usos fora do sentido registrado em um arquivo.
 * @param {string} relPath caminho relativo à raiz do repositório
 * @param {string} code conteúdo do arquivo JÁ SEM COMENTÁRIOS (quem chama
 *   remove — comentários podem citar o glifo antigo para explicar a troca)
 * @returns {string[]} "caminho:linha glifo — trecho"
 */
export function findEmojiViolations(relPath, code) {
  const out = [];
  const lines = bare(code).replace(TELEGRAM_TAGS, '').split('\n');
  for (const [glyph, rule] of Object.entries(EMOJI_REGISTRY)) {
    if (!rule.forbidden && !rule.context && !rule.files) continue;
    if (rule.files?.includes(relPath)) continue;
    const g = bare(glyph);
    lines.forEach((line, i) => {
      for (let at = line.indexOf(g); at !== -1; at = line.indexOf(g, at + g.length)) {
        if (!rule.forbidden && rule.context?.test(textAfter(line, at, g.length))) continue;
        out.push(`${relPath}:${i + 1} ${glyph} — ${line.trim().slice(0, 120)}`);
      }
    });
  }
  return out;
}
