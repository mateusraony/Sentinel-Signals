// Orçamento de computação do Neon gratuito (docs/known-risks.md item 286).
// Parte pura: sem rede, sem banco, sem Date.now. Responde "com este conjunto de
// disparos, quantas horas de computação o banco gasta por mês?" ANTES de o
// mês estourar a cota (itens 282/283: 110,33 de 100 horas).
//
// Como o Neon cobra (documentação do plano Free, conferida por pesquisa — o
// painel "Usage" do projeto é quem confirma o número real):
//  - computação mínima de 0,25 CU;
//  - o compute DORME depois de 5 minutos sem atividade (fixo no Free);
//  - só conta CU-hora enquanto está acordado;
//  - cota de 100 CU-h por mês.
// Logo: cada disparo mantém o banco acordado por (duração do job + 5 min), e
// disparos separados por menos de ~5 min mantêm o banco acordado o tempo todo.
//
// Calibração com a realidade (a prova de que o modelo não é chute): scan a
// cada 5 min ⇒ ~180 h/mês, e o console mostrou 110,33 h em ~19 dias
// (0,25 CU x 24 h x 19 d = 114) — o modelo reproduz a falha observada.
//
// O disparo EXTERNO (cron-job.org) não está no repositório: entra como
// parâmetro (`dispatchEveryMin`, que a tela lê de `SCAN_CADENCE_MIN`). Os
// agendamentos de `.github/workflows/*.yml` que tocam o banco são descobertos
// pelo teste, então um workflow novo com `schedule:` e `DATABASE_URL` passa a
// contar sozinho.

export const NEON_FREE_CU_HOURS = 100;
export const NEON_MIN_CU = 0.25;
export const NEON_IDLE_SUSPEND_MIN = 5;
export const DAYS_PER_MONTH = 30;
const MINUTES_PER_DAY = 24 * 60;

/** Expande um campo de cron simples (`*`, `*\/k`, `a,b`, `n`) em valores inteiros. */
function expandField(field, min, max) {
  const out = new Set();
  for (const part of field.split(',')) {
    let m;
    if (part === '*') {
      for (let v = min; v <= max; v += 1) out.add(v);
    } else if ((m = /^\*\/(\d+)$/.exec(part))) {
      const step = Number(m[1]);
      if (step < 1) throw new Error(`passo inválido no cron: ${part}`);
      for (let v = min; v <= max; v += step) out.add(v);
    } else if (/^\d+$/.test(part)) {
      const v = Number(part);
      if (v < min || v > max) throw new Error(`valor fora do intervalo no cron: ${part}`);
      out.add(v);
    } else {
      throw new Error(`campo de cron não suportado: ${part}`);
    }
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * Minutos do dia (0..1439, em UTC) em que uma expressão de cron dispara.
 * Só aceita dia/mês/dia-da-semana = `*` (é o que os workflows deste projeto usam).
 */
export function cronMinutesOfDay(expr) {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) throw new Error(`cron precisa de 5 campos: "${expr}"`);
  if (f[2] !== '*' || f[3] !== '*' || f[4] !== '*') throw new Error(`cron com dia/mês/semana não suportado: "${expr}"`);
  const minutes = expandField(f[0], 0, 59);
  const hours = expandField(f[1], 0, 23);
  const out = [];
  for (const h of hours) for (const m of minutes) out.push(h * 60 + m);
  return out;
}

/**
 * @param {{ dispatchEveryMin: number, scheduledCrons?: string[], jobMinutes?: number }} p
 * @returns {{ awakeMinutesPerDay: number, wakesPerDay: number, cuHoursPerMonth: number, share: number }}
 */
export function estimateNeonComputeHours({ dispatchEveryMin, scheduledCrons = [], jobMinutes = 1 }) {
  const startMinutes = [];
  if (dispatchEveryMin > 0) {
    for (let t = 0; t < MINUTES_PER_DAY; t += dispatchEveryMin) startMinutes.push(t);
  }
  for (const expr of scheduledCrons) startMinutes.push(...cronMinutesOfDay(expr));

  const awake = new Array(MINUTES_PER_DAY).fill(false);
  const window = jobMinutes + NEON_IDLE_SUSPEND_MIN;
  for (const t of startMinutes) {
    for (let k = 0; k < window; k += 1) awake[(t + k) % MINUTES_PER_DAY] = true;
  }
  const awakeMinutesPerDay = awake.filter(Boolean).length;
  const cuHoursPerMonth = (awakeMinutesPerDay / 60) * NEON_MIN_CU * DAYS_PER_MONTH;
  return {
    awakeMinutesPerDay,
    wakesPerDay: startMinutes.length,
    cuHoursPerMonth: Math.round(cuHoursPerMonth * 10) / 10,
    share: awakeMinutesPerDay / MINUTES_PER_DAY,
  };
}

/** Lê os `cron: "..."` de um workflow (texto YAML), ignorando comentários. */
export function extractWorkflowCrons(yamlText) {
  const crons = [];
  for (const line of yamlText.split('\n')) {
    if (/^\s*#/.test(line)) continue;
    const m = /^\s*-?\s*cron:\s*["']([^"']+)["']/.exec(line);
    if (m) crons.push(m[1]);
  }
  return crons;
}

/** O workflow usa o banco? (qualquer menção às variáveis de conexão fora de comentário) */
export function workflowTouchesDatabase(yamlText) {
  const code = yamlText.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  return /DATABASE_URL/.test(code);
}
