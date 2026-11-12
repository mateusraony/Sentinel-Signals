// Texto do chip "Atualizado às …" (docs/known-risks.md item 301). Função pura: o relógio e o fuso entram por parâmetro.

/** @type {Intl.DateTimeFormatOptions} */
const HORA = { hour: '2-digit', minute: '2-digit', second: '2-digit' };
/** @type {Intl.DateTimeFormatOptions} */
const DIA = { day: '2-digit', month: '2-digit' };

/** @param {number} a @param {number} b @param {string} [timeZone] */
const mesmoDia = (a, b, timeZone) => {
  const f = (/** @type {number} */ ts) => new Date(ts).toLocaleDateString('pt-BR', { ...DIA, year: 'numeric', timeZone });
  return f(a) === f(b);
};

/**
 * "Atualizado às 14:00:03" (hoje) ou "Atualizado 11/11 às 23:10:05" (outro dia, para não parecer de hoje). Sem leitura ainda: "Aguardando dados".
 * @param {number|null|undefined} ts @param {number} [nowTs] @param {string} [timeZone]
 */
export function formatLastUpdate(ts, nowTs = Date.now(), timeZone) {
  if (!Number.isFinite(ts) || /** @type {number} */ (ts) <= 0) return 'Aguardando dados';
  const hora = new Date(/** @type {number} */ (ts)).toLocaleTimeString('pt-BR', { ...HORA, timeZone });
  if (mesmoDia(/** @type {number} */ (ts), nowTs, timeZone)) return `Atualizado às ${hora}`;
  return `Atualizado ${new Date(/** @type {number} */ (ts)).toLocaleDateString('pt-BR', { ...DIA, timeZone })} às ${hora}`;
}
