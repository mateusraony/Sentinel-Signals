/**
 * Tradução do estado de um SignalEvent para linguagem que o usuário entende
 * (docs/known-risks.md item 156).
 *
 * Um teste de usabilidade com persona leiga leu o card de monitoramento como
 * **uma ordem de compra** ("o app mandou comprar BTC") quando a resposta certa
 * era "não faça nada" — o motor abre a operação sozinho e o usuário nunca age.
 * Nenhuma das 16 frases do card dizia isso. Daí a regra deste módulo:
 *
 *   toda frase termina resolvendo "e eu, faço o quê?".
 *
 * Módulo puro: sem React, sem I/O, sem Firestore. Só descreve — não decide
 * nada sobre a operação (quem decide é `src/lib/scanner.js`).
 */

/** Fase do sinal, do ponto de vista de quem lê — não é o status do motor. */
export const SIGNAL_PHASE = Object.freeze({
  WAITING: 'waiting',
  EXPIRED: 'expired',
  INFO: 'info',
});

/** scanner.js FOUR_HOURS_MS — mesma janela das 2 cascatas de confirmação. */
export const CONFIRMATION_WINDOW_MS = 4 * 60 * 60 * 1000;

/**
 * Só a cascata nativa 4h→15m entra numa fila de confirmação de verdade. A
 * Range Filter também dispara em 1h/1d por ativo, mas esses nunca viram
 * operação por este mecanismo — tratar os dois como a mesma coisa é o que
 * gerava a confusão relatada pelo usuário.
 */
export function isConfirmationEligible(signal) {
  return signal?.timeframe === '4h';
}

export function classifySignal(signal, now = Date.now()) {
  if (!isConfirmationEligible(signal)) {
    return { phase: SIGNAL_PHASE.INFO, msLeft: null, expiresAt: null };
  }
  const createdAt = new Date(signal?.created_date).getTime();
  if (!Number.isFinite(createdAt)) {
    return { phase: SIGNAL_PHASE.WAITING, msLeft: null, expiresAt: null };
  }
  const expiresAt = createdAt + CONFIRMATION_WINDOW_MS;
  const msLeft = expiresAt - now;
  const expired = signal?.expired_logged === true || msLeft <= 0;
  return {
    phase: expired ? SIGNAL_PHASE.EXPIRED : SIGNAL_PHASE.WAITING,
    msLeft: expired ? null : msLeft,
    expiresAt,
  };
}

const PHASE_COPY = Object.freeze({
  [SIGNAL_PHASE.WAITING]: Object.freeze({
    badge: 'Esperando confirmação',
    icon: '⏳',
    color: '#ffd166',
    reassurance: 'Você não precisa fazer nada. Se virar operação, o app abre sozinho e ela aparece em Operações Ativas.',
  }),
  [SIGNAL_PHASE.EXPIRED]: Object.freeze({
    badge: 'Já passou',
    icon: '✓',
    color: '#64748b',
    reassurance: 'O prazo acabou e nenhuma operação foi aberta. Você não perdeu dinheiro nem perdeu nada — o app só não achou seguro entrar.',
  }),
  [SIGNAL_PHASE.INFO]: Object.freeze({
    badge: 'Só informação',
    icon: 'ℹ',
    color: '#60a5fa',
    reassurance: 'Isto é só uma observação de mercado — nunca vira operação. O app só abre operação a partir dos avisos do gráfico de 4 horas. Pode ignorar.',
  }),
});

export function phaseCopy(phase) {
  return PHASE_COPY[phase] ?? PHASE_COPY[SIGNAL_PHASE.WAITING];
}

/**
 * Três famílias de motivo, aprendíveis num olhar — hoje as 14 chaves são
 * visualmente idênticas (mesmo ponto amarelo), então o usuário não distingue
 * "ainda vai acontecer" de "piorou" nem de "problema do próprio app".
 */
export const REASON_KIND = Object.freeze({
  WAITING: 'waiting',   // ⏳ falta acontecer algo no mercado
  WORSE: 'worse',       // ⚠ o cenário piorou contra o sinal
  APP: 'app',           // ↻ problema do app, ele se resolve sozinho
});

const KIND_ICON = Object.freeze({
  [REASON_KIND.WAITING]: '⏳',
  [REASON_KIND.WORSE]: '⚠',
  [REASON_KIND.APP]: '↻',
});

export function reasonIcon(kind) {
  return KIND_ICON[kind] ?? KIND_ICON[REASON_KIND.WAITING];
}

/**
 * `SignalEvent.last_rejection_reason` (+ `last_rejection_detail`) → chip curto
 * + frase completa.
 *
 * ## Por que este bloco foi reescrito (item 163)
 *
 * O usuário leu a primeira versão e devolveu: *"falar que virou para outro
 * lado e bem vazio, sem sentido nenhum, quero saber se o pavio perdeu força
 * ou o que realmente aconteceu, não apenas que viu que acaba ficando vazio a
 * fala!"*. Estava certo: "o mercado virou para o outro lado" não diz NADA que
 * o usuário já não visse no gráfico.
 *
 * Duas correções, nesta ordem:
 *
 * 1. **No dado** — `regime_rejected` juntava dois gates diferentes numa
 *    palavra só e `confirmation_15m_not_aligned` juntava três causas. O motor
 *    passou a gravar `last_rejection_detail` (item 163), então agora existe o
 *    que dizer.
 * 2. **No texto** — cada frase diz O QUE FOI MEDIDO e POR QUE isso barra a
 *    entrada. Sem o nome técnico do indicador (o usuário não é dev: ver
 *    `.claude/rules/operating-principles.md`), mas com a coisa em si:
 *    "perdeu força", "andando de lado", "o pavio não rejeitou".
 *
 * `by` traz a variante por `last_rejection_detail`; sem detalhe (ou com um
 * detalhe desconhecido) cai na frase-base, que continua completa.
 */
export const REJECTION_COPY = Object.freeze({
  trend_reversed: {
    kind: REASON_KIND.WORSE, chip: 'Tendência virou',
    detail: 'A linha de tendência do gráfico de 4 horas — a mesma que gerou este aviso — virou para o lado contrário depois que ele apareceu. O app não entra contra a própria tendência que ele usa para decidir.',
    by: {
      now_down: {
        chipBuy: 'Tendência virou p/ baixo', chipSell: 'Tendência virou p/ baixo',
        detail: 'A linha de tendência do gráfico de 4 horas aponta para BAIXO agora. Enquanto ela apontar para baixo, um aviso de compra não vira operação — seria comprar contra a maré.',
      },
      now_up: {
        chipBuy: 'Tendência virou p/ cima', chipSell: 'Tendência virou p/ cima',
        detail: 'A linha de tendência do gráfico de 4 horas aponta para CIMA agora. Enquanto ela apontar para cima, um aviso de venda não vira operação — seria vender contra a maré.',
      },
    },
  },
  regime_rejected: {
    kind: REASON_KIND.WORSE, chip: 'Mercado ruim para entrar',
    detail: 'A medição de qualidade do movimento reprovou: o mercado não está num estado em que valha a pena arriscar.',
    by: {
      adx: {
        chip: 'Movimento sem força',
        detail: 'O preço até se mexe, mas o movimento está fraco — a medida de força da tendência ficou abaixo do mínimo que o app exige para este ativo. Movimento sem força costuma voltar atrás antes de chegar ao alvo.',
      },
      chop: {
        chip: 'Preço andando de lado',
        detail: 'O preço está preso numa faixa, subindo e descendo sem sair do lugar — a medida de "andar de lado" passou do limite. Nesse estado a proteção é atingida antes do alvo com muita frequência.',
      },
      adx_chop: {
        chip: 'Sem força e de lado',
        detail: 'Os dois sinais de qualidade reprovaram ao mesmo tempo: o movimento está fraco E o preço está preso numa faixa, sem sair do lugar. É o pior cenário para abrir uma operação.',
      },
    },
  },
  candle_pattern_rejected: {
    kind: REASON_KIND.WORSE, chip: 'A vela não confirmou',
    detail: 'A vela de 4 horas que gerou o aviso não fechou com nenhum dos três formatos que o app exige: engolir a vela anterior, deixar um pavio longo de rejeição, ou ser uma vela cheia na direção do aviso. Sem esse desenho, o aviso fica só na teoria.',
  },
  smc_confirm_zone_rejected: {
    kind: REASON_KIND.WORSE, chip: 'Preço no lado caro da faixa',
    detail: 'No gráfico de prazo maior o preço está na metade desfavorável da faixa recente (cara demais para comprar, barata demais para vender) ou a estrutura ainda aponta para o outro lado. O app espera o preço voltar para a metade boa.',
  },
  retest_pending: {
    kind: REASON_KIND.WAITING, chip: 'Falta voltar e testar',
    detail: 'O preço rompeu um nível importante, mas ainda não voltou para encostar nele de novo. Esse retorno é o que separa um rompimento de verdade de um falso — o app espera por ele antes de entrar.',
  },
  displacement_gate_rejected: {
    kind: REASON_KIND.WAITING, chip: 'Empurrão fraco demais',
    detail: 'A vela que deveria disparar a entrada teve corpo pequeno demais para o tamanho normal das velas deste ativo — um empurrão fraco, sem convicção. O app espera uma vela com corpo de verdade na direção do aviso.',
  },
  confirmation_15m_not_aligned: {
    kind: REASON_KIND.WAITING, chip: 'Gráfico curto não concorda',
    detail: 'O gráfico de 4 horas já aponta essa direção; o de 15 minutos ainda não. O app só entra quando os dois concordam — é o que evita entrar bem no momento em que o preço curto está indo para o outro lado.',
    by: {
      not_aligned: {
        chip: 'Gráfico curto na contramão',
        detail: 'O gráfico de 15 minutos está apontando para o lado CONTRÁRIO ao do aviso agora. Entrar assim seria comprar bem no meio de uma queda curta (ou vender no meio de uma alta). O app espera os dois apontarem junto.',
      },
      insufficient_data: {
        chip: 'Faltou histórico curto',
        detail: 'Não chegou histórico de 15 minutos suficiente para o app conferir a direção curta. Sem essa conferência ele não entra — e tenta de novo na próxima checagem, em ~5 minutos.',
      },
      fetch_error: {
        chip: 'Corretora não respondeu',
        detail: 'A corretora não respondeu na hora de conferir o gráfico de 15 minutos. O app não entra às cegas; tenta de novo sozinho em ~5 minutos.',
      },
    },
  },
  insufficient_data: {
    kind: REASON_KIND.APP, chip: 'Faltam dados',
    detail: 'Ainda não chegou histórico de preço suficiente para o app decidir. Ele tenta de novo em ~5 minutos.',
  },
  no_trigger: {
    kind: REASON_KIND.WAITING, chip: 'Falta o gatilho',
    detail: 'O cenário está montado, mas o evento que dispara a entrada — o preço varrer um fundo/topo recente e voltar — ainda não aconteceu no gráfico curto. Sem esse gatilho o app não tem preço de entrada nem onde colocar a proteção.',
  },
  wrong_direction_trigger: {
    kind: REASON_KIND.WAITING, chip: 'Gatilho veio ao contrário',
    detail: 'O gatilho de entrada disparou, só que para o lado CONTRÁRIO ao do aviso: o preço varreu o extremo errado. O app continua esperando o do lado certo.',
  },
  ote_zone_unfavorable: {
    kind: REASON_KIND.WORSE, chip: 'Preço fora da faixa boa',
    detail: 'O preço já andou demais desde o ponto de partida do movimento. Entrar agora deixaria a proteção longe e o alvo perto — muito risco para pouco ganho. O app espera o preço recuar para a faixa boa.',
    // Direcional: num aviso de alta o preço subiu demais; num de baixa, caiu.
    chipBuy: 'Preço já subiu demais',
    chipSell: 'Preço já caiu demais',
  },
  buy_regime_filter_blocked: {
    kind: REASON_KIND.WORSE, chip: 'Gráfico diário contra',
    detail: 'O gráfico diário — o mais lento e o que manda no resto — não está apontando para cima. O app está configurado para não comprar contra o diário.',
  },
  side_filter_blocked: {
    kind: REASON_KIND.APP, chip: 'Lado desligado',
    detail: 'O app está configurado para operar só um dos lados (só compra ou só venda), e este aviso é do lado desligado. É uma escolha de configuração, não uma leitura do mercado.',
  },
  fetch_error: {
    kind: REASON_KIND.APP, chip: 'Falha de conexão',
    detail: 'O app não conseguiu falar com a corretora na última checagem. Ele tenta de novo em ~5 minutos, sozinho.',
  },
  rr_below_min: {
    kind: REASON_KIND.WORSE, chip: 'Não compensa o risco',
    detail: 'Neste preço, a distância até o alvo é pequena perto da distância até a proteção — arrisca-se muito para ganhar pouco. O app exige um mínimo de proporção e ela não fecha.',
  },
  missing_fields: {
    kind: REASON_KIND.APP, chip: 'Conta incompleta',
    detail: 'Faltou um dado para o app calcular onde ficaria a proteção e o alvo desta entrada. Ele refaz a conta na próxima checagem.',
  },
  invalid_stop_distance: {
    kind: REASON_KIND.APP, chip: 'Cálculo inválido',
    detail: 'A conta de proteção deu um resultado impossível (proteção no mesmo preço da entrada, ou do lado errado), então o app não entra — é uma trava de segurança.',
  },
});

const NOTHING_TO_DO = 'Nada a fazer.';

/**
 * Resolve o motivo em chip + frase, já com o fecho "nada a fazer".
 * Chave desconhecida nunca vira tela em branco nem código cru sem contexto.
 */
export function rejectionCopy(signal) {
  const key = signal?.last_rejection_reason;
  const isBuy = signal?.signal_type !== 'SELL';

  if (!key) {
    return {
      kind: REASON_KIND.WAITING,
      icon: reasonIcon(REASON_KIND.WAITING),
      chip: 'Checando agora',
      detail: `Aviso recém-chegado. O app está vendo se vale abrir uma operação e refaz a conta a cada 5 minutos. ${NOTHING_TO_DO}`,
    };
  }

  const entry = REJECTION_COPY[key];
  if (!entry) {
    return {
      kind: REASON_KIND.APP,
      icon: reasonIcon(REASON_KIND.APP),
      chip: 'Checando',
      detail: `O app registrou um motivo técnico novo para ainda não entrar (código ${key}). ${NOTHING_TO_DO}`,
    };
  }

  // O detalhe é o que responde "o que REALMENTE aconteceu" (item 163). Um
  // detalhe desconhecido — sinal antigo, valor novo do motor — cai na
  // frase-base, que continua completa; nunca em texto vazio.
  const variant = entry.by?.[signal?.last_rejection_detail] ?? {};
  const kind = variant.kind ?? entry.kind;
  const chip = (isBuy ? variant.chipBuy : variant.chipSell)
    ?? variant.chip
    ?? (isBuy ? entry.chipBuy : entry.chipSell)
    ?? entry.chip;
  return {
    kind,
    icon: reasonIcon(kind),
    chip,
    detail: `${variant.detail ?? entry.detail} ${NOTHING_TO_DO}`,
  };
}

/**
 * "faltam 1h47" — contagem curta. A hora do relógio quem formata é o
 * componente, que tem o fuso do usuário; aqui fica só a parte pura.
 */
export function formatTimeLeft(msLeft) {
  if (!Number.isFinite(msLeft) || msLeft <= 0) return null;
  const totalMinutes = Math.floor(msLeft / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}min`;
  return `${hours}h${String(minutes).padStart(2, '0')}`;
}
