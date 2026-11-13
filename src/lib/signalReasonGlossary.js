/**
 * Glossário dos "motivos técnicos" de uma operação (aba Trades, docs/known-risks.md item 303).
 *
 * Pedido do usuário (13/11/2026): "os motivos estão muito simples, só valores; para quem não entende fica confuso". O motor grava
 * em `TradeOperation.signal_reasons` frases curtas com os pontos ("MACD hist negativo (+20)") — produzidas em
 * `src/lib/indicators/confluence.js` (cascata do Range Filter) e `smcConfluence.js` (cascata SMC). Este módulo traduz cada frase
 * CONHECIDA em: um título em português simples, "o que é" e "por que entra na conta".
 *
 * Regras:
 * - só explica o que a regra MEDE. Nunca promete resultado, nunca cita chance de acerto (a entrada não tem vantagem comprovada
 *   sobre o acaso — item 264 — e os pontos são regras alinhadas, não probabilidade);
 * - frase desconhecida (texto novo do motor, operação manual, legado) NÃO ganha explicação inventada: volta só o texto original;
 * - não é lido pelo motor. Se o texto de um motivo mudar lá, o `signalReasonGlossary.test.js` quebra (ele confere contra as
 *   frases reais geradas pelos dois módulos de confluência).
 */

/** `"MACD hist negativo (+20)"` → `{ text: 'MACD hist negativo', points: 20 }`. Sem pontos no fim, `points: null`. */
export function splitReasonPoints(raw) {
  if (typeof raw !== 'string') return { text: '', points: null };
  const match = raw.match(/^(.*?)\s*\(\+(\d+(?:[.,]\d+)?)\)\s*$/);
  if (!match) return { text: raw.trim(), points: null };
  return { text: match[1].trim(), points: Number(match[2].replace(',', '.')) };
}

const down = (side) => side === 'SELL';

/**
 * Cada entrada: `test` (casa com o texto SEM os pontos) e `build(side, match)` → { title, what, why }.
 * A ordem importa só onde um texto é prefixo de outro.
 */
const GLOSSARY = [
  {
    test: /^Follow-through confirmado$/i,
    build: (side) => ({
      title: 'O movimento continuou depois da virada',
      what: `O Range Filter é a linha principal da estratégia: ela acompanha o preço e ignora os balanços pequenos. Aqui o preço virou para ${down(side) ? 'baixo' : 'cima'} dessa linha e continuou desse lado no fechamento da vela.`,
      why: 'É a condição que dispara o aviso. Sem ela a estratégia não considera que houve virada.',
    }),
  },
  {
    test: /^MACD hist (positivo|negativo)$/i,
    build: (side, m) => {
      const negative = /negativo/i.test(m[1]);
      return {
        title: `Força do movimento a favor (MACD ${negative ? 'negativo' : 'positivo'})`,
        what: `O MACD compara uma média rápida do preço com uma lenta. O histograma ${negative ? 'negativo' : 'positivo'} diz que o movimento recente de ${negative ? 'queda' : 'alta'} está mais forte que o de antes.`,
        why: `Uma ${down(side) ? 'venda' : 'compra'} a favor de um movimento que ganha força concorda com a direção do aviso.`,
      };
    },
  },
  {
    test: /^EMA tendência (bullish|bearish)$/i,
    build: (side, m) => {
      const bear = /bearish/i.test(m[1]);
      return {
        title: `Tendência de fundo de ${bear ? 'baixa' : 'alta'} (médias móveis)`,
        what: `EMA é uma média móvel do preço. A média curta está ${bear ? 'abaixo' : 'acima'} da longa, o que descreve uma tendência de ${bear ? 'baixa' : 'alta'} no gráfico do aviso.`,
        why: 'O aviso aponta para o mesmo lado da tendência de fundo, e não contra ela.',
      };
    },
  },
  {
    test: /^RSI cruzou 50 para (cima|baixo)$/i,
    build: (side, m) => {
      const downCross = /baixo/i.test(m[1]);
      return {
        title: `RSI passou para o lado ${downCross ? 'vendedor' : 'comprador'}`,
        what: `O RSI vai de 0 a 100 e mede se as últimas velas foram mais de alta ou de baixa; 50 é o meio. Ele acabou de cruzar o 50 para ${downCross ? 'baixo' : 'cima'}.`,
        why: `Mostra que a força recente mudou para o lado ${downCross ? 'da venda' : 'da compra'}, o mesmo do aviso.`,
      };
    },
  },
  {
    test: /^Volume acima da média$/i,
    build: () => ({
      title: 'Mais negociação que o normal',
      what: 'O volume (quanto foi negociado) na vela do aviso ficou acima da média das últimas velas.',
      why: 'Indica que houve participação do mercado no movimento, e não só uma oscilação com pouco negócio.',
    }),
  },
  {
    test: /^Preço (acima|abaixo) do filtro$/i,
    build: (side, m) => {
      const below = /abaixo/i.test(m[1]);
      return {
        title: `Preço ${below ? 'abaixo' : 'acima'} da linha do Range Filter`,
        what: `No fechamento da vela, o preço estava ${below ? 'abaixo' : 'acima'} da linha do Range Filter e a linha apontava para ${below ? 'baixo' : 'cima'}.`,
        why: `É a regra básica da estratégia: só ${below ? 'vende' : 'compra'} com o preço desse lado da linha.`,
      };
    },
  },

  // ── Cascata SMC (1h → 5m) ────────────────────────────────────────────────────────────────────────────────────────
  {
    test: /^Estrutura 1H: (BOS|CHoCH)$/i,
    build: (side, m) => {
      const choch = /choch/i.test(m[1]);
      return {
        title: choch ? 'Mudança de estrutura no gráfico de 1 hora (CHoCH)' : 'Rompimento de estrutura no gráfico de 1 hora (BOS)',
        what: choch
          ? 'O preço rompeu o último topo ou fundo importante CONTRA a tendência que vinha: é o primeiro sinal de que ela pode ter virado.'
          : 'O preço rompeu o último topo ou fundo importante A FAVOR da tendência que vinha: ela continuou.',
        why: 'Nesta cascata, o rompimento de estrutura é o próprio aviso.',
      };
    },
  },
  {
    test: /^Bônus CHoCH$/i,
    build: () => ({
      title: 'Pontos extras por ser mudança de estrutura',
      what: 'A estratégia dá pontos a mais quando o rompimento é uma mudança de tendência (CHoCH), e não uma continuação (BOS).',
      why: 'É uma escolha de peso da estratégia: ela trata a mudança de tendência como um evento mais marcante que a continuação.',
    }),
  },
  {
    test: /^EMA alinhada$/i,
    build: (side) => ({
      title: 'Médias móveis a favor',
      what: `EMA é uma média móvel do preço. A média curta está ${down(side) ? 'abaixo' : 'acima'} da longa, o que descreve uma tendência de ${down(side) ? 'baixa' : 'alta'} — o mesmo lado do aviso.`,
      why: 'O aviso concorda com a tendência de fundo.',
    }),
  },
  {
    test: /^Range Filter 1H alinhado$/i,
    build: (side) => ({
      title: 'Range Filter de 1 hora a favor',
      what: `A linha do Range Filter no gráfico de 1 hora aponta para ${down(side) ? 'baixo' : 'cima'}, o mesmo lado do aviso.`,
      why: 'Dois métodos diferentes (estrutura e Range Filter) apontam para o mesmo lado.',
    }),
  },
  {
    test: /^Alinhamento multi-timeframe (completo|parcial)$/i,
    build: (side, m) => {
      const full = /completo/i.test(m[1]);
      return {
        title: full ? 'Gráficos maiores todos a favor' : 'Parte dos gráficos maiores a favor',
        what: full
          ? 'Os gráficos diário, de 4 horas e de 1 hora apontam para o mesmo lado do aviso.'
          : 'Só parte dos gráficos (diário, 4 horas, 1 hora) aponta para o mesmo lado do aviso; por isso vale metade dos pontos.',
        why: 'O aviso não está contra a direção dos prazos maiores.',
      };
    },
  },
  {
    test: /^Sweep de liquidez confirmado no 5m$/i,
    build: () => ({
      title: 'Varrida de liquidez no gráfico de 5 minutos',
      what: 'O preço passou rapidamente de um topo ou fundo recente (onde costumam ficar ordens de stop) e voltou logo em seguida.',
      why: 'É o gatilho de entrada desta cascata no gráfico de 5 minutos.',
    }),
  },
  {
    test: /^Preço dentro de Order Block$/i,
    build: () => ({
      title: 'Preço dentro de um Order Block',
      what: 'Order Block é a região da última vela contrária antes de um movimento forte. O preço estava dentro de uma região dessas a favor do aviso.',
      why: 'A estratégia conta essa região como um ponto a favor na soma.',
    }),
  },
  {
    test: /^Fair Value Gap não preenchido a favor$/i,
    build: () => ({
      title: 'Espaço vazio no gráfico a favor (Fair Value Gap)',
      what: 'Fair Value Gap é um espaço que o preço atravessou rápido, sem negociar direito. Havia um ainda aberto do lado do aviso.',
      why: 'A estratégia conta esse espaço como um ponto a favor na soma.',
    }),
  },
];

/**
 * @param {unknown} raw frase gravada em `signal_reasons`
 * @param {'BUY'|'SELL'|undefined} side lado da operação (afina o texto: "para cima"/"para baixo")
 * @returns {{ raw: string, known: boolean, title: string, what: string|null, why: string|null, points: number|null }}
 */
export function explainSignalReason(raw, side) {
  const original = typeof raw === 'string' ? raw.trim() : '';
  const { text, points } = splitReasonPoints(original);
  for (const item of GLOSSARY) {
    const match = text.match(item.test);
    if (match) {
      const { title, what, why } = item.build(side === 'SELL' ? 'SELL' : 'BUY', match);
      return { raw: original, known: true, title, what, why, points };
    }
  }
  return { raw: original, known: false, title: text || original, what: null, why: null, points };
}

/** Lista explicada, sem itens vazios. Aceita qualquer coisa em `reasons` (operação legada pode trazer `null`). */
export function explainSignalReasons(reasons, side) {
  if (!Array.isArray(reasons)) return [];
  return reasons
    .filter((r) => typeof r === 'string' && r.trim())
    .map((r) => explainSignalReason(r, side));
}

/** "25 pontos" / "1 ponto" / "7.5 pontos" (ponto decimal, como o resto do painel); `null` sem pontos. */
export function formatReasonPoints(points) {
  if (typeof points !== 'number' || !Number.isFinite(points)) return null;
  return `${points} ${points === 1 ? 'ponto' : 'pontos'}`;
}
