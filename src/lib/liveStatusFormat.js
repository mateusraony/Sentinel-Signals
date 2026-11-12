// Textos da barra "Atualizado às …" (docs/known-risks.md item 301). Funções puras: o relógio e o fuso entram por parâmetro.

/** @type {Intl.DateTimeFormatOptions} */
const HORA = { hour: '2-digit', minute: '2-digit', second: '2-digit' };
/** @type {Intl.DateTimeFormatOptions} */
const HORA_CURTA = { hour: '2-digit', minute: '2-digit' };
/** @type {Intl.DateTimeFormatOptions} */
const DIA = { day: '2-digit', month: '2-digit' };

/** @param {number} a @param {number} b @param {string} [timeZone] */
const mesmoDia = (a, b, timeZone) => {
  const f = (/** @type {number} */ ts) => new Date(ts).toLocaleDateString('pt-BR', { ...DIA, year: 'numeric', timeZone });
  return f(a) === f(b);
};

/** "Atualizado às 16:41:20" (hoje) ou "Atualizado 11/11 às 23:10:05" (outro dia). Sem dado ainda: "Aguardando dados". */
/** @param {number|null|undefined} ts @param {number} [nowTs] @param {string} [timeZone] */
export function formatLastUpdate(ts, nowTs = Date.now(), timeZone) {
  if (!Number.isFinite(ts) || ts <= 0) return 'Aguardando dados';
  const hora = new Date(ts).toLocaleTimeString('pt-BR', { ...HORA, timeZone });
  if (mesmoDia(ts, nowTs, timeZone)) return `Atualizado às ${hora}`;
  return `Atualizado ${new Date(ts).toLocaleDateString('pt-BR', { ...DIA, timeZone })} às ${hora}`;
}

/** "17:41" — fim do "Manter ao vivo". */
/** @param {number|null|undefined} ts @param {string} [timeZone] */
export function formatClock(ts, timeZone) {
  if (!Number.isFinite(ts)) return '';
  return new Date(ts).toLocaleTimeString('pt-BR', { ...HORA_CURTA, timeZone });
}

/** Rótulo do modo: o que o painel está fazendo agora, em palavras simples (versão completa e versão curta para o celular). */
/** @param {{ resting: boolean, liveUntil: number|null|undefined }} estado @param {number} refreshMin @param {string} [timeZone] */
export function describeMode({ resting, liveUntil }, refreshMin, timeZone) {
  if (resting) return { kind: 'rest', full: `em repouso · atualiza a cada ${refreshMin} min`, short: `repouso · ${refreshMin} min` };
  if (liveUntil !== null && liveUntil !== undefined) {
    const ate = formatClock(liveUntil, timeZone);
    return { kind: 'live', full: `ao vivo até ${ate}`, short: `ao vivo até ${ate}` };
  }
  return { kind: 'active', full: 'ao vivo', short: 'ao vivo' };
}
