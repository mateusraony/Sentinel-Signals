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
 * `SignalEvent.last_rejection_reason` → chip curto + frase completa.
 *
 * O chip vai na face do card; a frase, logo abaixo. Toda frase termina
 * dizendo que não há nada a fazer, porque de fato não há: o usuário nunca
 * executa nada aqui.
 */
export const REJECTION_COPY = Object.freeze({
  trend_reversed: {
    kind: REASON_KIND.WORSE, chip: 'Perdendo força',
    detail: 'O mercado virou para o outro lado depois do aviso. Este sinal provavelmente não vira operação.',
  },
  regime_rejected: {
    kind: REASON_KIND.WORSE, chip: 'Mercado parado',
    detail: 'O preço está andando de lado, sem direção clara. O app não abre operação nesse cenário.',
  },
  smc_confirm_zone_rejected: {
    kind: REASON_KIND.WORSE, chip: 'Sem apoio do gráfico maior',
    detail: 'No gráfico de prazo mais longo o preço ainda aponta para o lado contrário. Falta os dois concordarem.',
  },
  retest_pending: {
    kind: REASON_KIND.WAITING, chip: 'Falta um teste',
    detail: 'O preço rompeu um nível importante; agora o app espera ele voltar e testar esse nível antes de entrar.',
  },
  displacement_gate_rejected: {
    kind: REASON_KIND.WAITING, chip: 'Falta força',
    detail: 'O app espera um movimento forte o bastante na direção do aviso antes de entrar. Ainda não veio.',
  },
  confirmation_15m_not_aligned: {
    kind: REASON_KIND.WAITING, chip: 'Falta confirmação rápida',
    detail: 'O gráfico de prazo longo (4 horas) já aponta essa direção; o de prazo curto (15 minutos) ainda não. O app só entra quando os dois concordarem.',
  },
  insufficient_data: {
    kind: REASON_KIND.APP, chip: 'Faltam dados',
    detail: 'Ainda não chegou histórico de preço suficiente para o app decidir. Ele tenta de novo em ~5 minutos.',
  },
  no_trigger: {
    kind: REASON_KIND.WAITING, chip: 'Esperando o momento',
    detail: 'O cenário está montado, mas o empurrão de preço que dispara a entrada ainda não veio.',
  },
  wrong_direction_trigger: {
    kind: REASON_KIND.WAITING, chip: 'Veio pelo lado errado',
    detail: 'O empurrão de preço aconteceu, só que para o lado contrário ao do aviso. O app continua esperando o certo.',
  },
  ote_zone_unfavorable: {
    kind: REASON_KIND.WORSE, chip: 'Preço fora da faixa boa',
    detail: 'Entrar neste preço sairia caro demais para o risco. O app espera um preço melhor.',
    // Direcional: num aviso de alta o preço subiu demais; num de baixa, caiu.
    chipBuy: 'Preço já subiu demais',
    chipSell: 'Preço já caiu demais',
  },
  fetch_error: {
    kind: REASON_KIND.APP, chip: 'Falha de conexão',
    detail: 'O app não conseguiu falar com a corretora na última checagem. Ele tenta de novo em ~5 minutos, sozinho.',
  },
  rr_below_min: {
    kind: REASON_KIND.WORSE, chip: 'Não compensa o risco',
    detail: 'Nesse preço, o ganho possível é pequeno perto do que se arrisca. O app prefere não entrar.',
  },
  missing_fields: {
    kind: REASON_KIND.APP, chip: 'Conta incompleta',
    detail: 'Faltou um dado para o app calcular o risco desta entrada. Ele recalcula na próxima checagem.',
  },
  invalid_stop_distance: {
    kind: REASON_KIND.APP, chip: 'Cálculo inválido',
    detail: 'A conta de proteção deu um resultado impossível, então o app não entra — é uma trava de segurança.',
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

  const chip = (isBuy ? entry.chipBuy : entry.chipSell) ?? entry.chip;
  return {
    kind: entry.kind,
    icon: reasonIcon(entry.kind),
    chip,
    detail: `${entry.detail} ${NOTHING_TO_DO}`,
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
