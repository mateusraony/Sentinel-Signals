/**
 * Cadência de polling do painel (docs/known-risks.md item 155).
 *
 * O dado que estas telas leem só muda quando o scan agendado roda — a cada
 * ~5 minutos (`.github/workflows/scan.yml`, disparo externo). Pesquisar o
 * banco a cada 10s não deixa nada mais atual: relê 30 vezes o mesmo
 * documento entre duas atualizações reais.
 *
 * E relê caro: o Firestore cobra **uma leitura por documento devolvido**, não
 * por query. Uma tela com `list('-created_date', 200)` a cada 15s consome
 * 200 leituras a cada 15s — 1,15 milhão por dia com a aba em foco, contra uma
 * cota gratuita de 50 mil/dia. Foi isso que derrubou o scan em produção.
 *
 * Os dois níveis abaixo são múltiplos conservadores da cadência real: mesmo o
 * mais lento continua amostrando o dado mais rápido do que ele muda.
 *
 * ⚠️ Isto NÃO governa o preço ao vivo. `src/hooks/useLivePrice.js` busca a
 * Binance direto (30s), fora de Firestore/RTDB e fora de qualquer cota — a
 * cotação continua viva mesmo com o banco sendo lido devagar.
 */

/** Cadência real do dado: o scan agendado roda a cada ~5 minutos. */
export const SCAN_CADENCE_MS = 5 * 60_000;

/**
 * Telas que o usuário acompanha enquanto opera (Dashboard, Trades, Assets,
 * ticker). Amostra 5× mais rápido que a cadência real do dado.
 */
export const POLL_OPERATIONAL_MS = 60_000;

/**
 * Diagnóstico e histórico (logs, verificação, alertas, relatórios, conta
 * virtual). Ninguém toma decisão de segundo a segundo aqui.
 */
export const POLL_DIAGNOSTIC_MS = 120_000;
