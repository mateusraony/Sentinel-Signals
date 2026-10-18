/**
 * Rótulo único de "regras alinhadas" (item 277, PR-B). Antes cada tela tinha
 * o seu ("🔥 Forte / ⚡ Moderado / 〰 Fraco", "🔥 Score N/100"), com limiares
 * próprios, e o 🔥 soava como chance de acerto. O score mede quantas regras
 * concordam com o aviso — não a probabilidade de dar certo (item 264).
 *
 * Mesmo vocabulário do Telegram (`scoreAgreementLine` em
 * `notificationTemplates.js`, que reusa `STRENGTH_WORD` daqui).
 */
export const STRENGTH_WORD = Object.freeze({ strong: 'forte', medium: 'média', moderate: 'moderada', weak: 'fraca' });

export const AGREEMENT_HINT = 'Regras alinhadas com o aviso — não é chance de acerto.';

/**
 * @param {{ score?: number, strength?: string }} [input]
 * @returns {string|null} "🧩 85/100", "🧩 concordância forte" ou null sem dado.
 */
export function agreementLabel({ score, strength } = {}) {
  if (Number.isFinite(score)) return `🧩 ${score}/100`;
  const word = STRENGTH_WORD[strength];
  return word ? `🧩 concordância ${word}` : null;
}
