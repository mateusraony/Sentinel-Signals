/**
 * Cadência de polling do painel (docs/known-risks.md item 155).
 *
 * O dado que estas telas leem só muda quando o scan agendado roda — a cada
 * ~15 minutos (`.github/workflows/scan.yml`, disparo externo). Pesquisar o
 * banco a cada 10s não deixa nada mais atual: relê 30 vezes o mesmo
 * documento entre duas atualizações reais.
 *
 * E relê caro: o Firestore cobra **uma leitura por documento devolvido**, não
 * por query. Uma tela com `list('-created_date', 200)` a cada 15s consome
 * 200 leituras a cada 15s — 1,15 milhão por dia com a aba em foco, contra uma
 * cota gratuita de 50 mil/dia. Foi isso que derrubou o scan em produção.
 *
 * ATENÇÃO (item 301, 2026-11-12): até essa data os dois níveis abaixo eram
 * múltiplos conservadores da cadência real (60 s e 120 s). Hoje são 30 min
 * (= 2 scans) por decisão do usuário, para o banco dormir; o que mantém a tela
 * fresca para quem olha é o `STALE_TIME_MS` (refaz ao voltar/navegar).
 *
 * ⚠️ Isto NÃO governa o preço ao vivo. `src/hooks/useLivePrice.js` busca a
 * Binance direto (30s), fora de Firestore/RTDB e fora de qualquer cota — a
 * cotação continua viva mesmo com o banco sendo lido devagar.
 */

/**
 * Cadência real do dado: o scan agendado roda a cada ~15 minutos (item 286).
 *
 * Era ~5 min até 2026-10-29: com 5 min o banco Neon nunca dorme (o autosuspend
 * do plano gratuito é de 5 min) e gasta ~180 h/mês de computação contra um
 * limite de 100 h (itens 282/283). O disparo real mora FORA do repositório
 * (cron-job.org) — este número só diz à TELA o que esperar; se o disparo
 * mudar, mude aqui (e só aqui: textos e tolerâncias derivam dele).
 */
export const SCAN_CADENCE_MIN = 15;
export const SCAN_CADENCE_MS = SCAN_CADENCE_MIN * 60_000;

/**
 * Quanto tempo um dado lido do banco vale para a tela (`staleTime` do React Query, `src/lib/query-client.js`). NÃO é o intervalo de atualização: é a regra de
 * "voltei para a aba / abri outra página: refaz agora se o dado tem mais de 1 min". Fica curto de propósito, para quem está olhando ver dado fresco na hora,
 * sem a tela precisar consultar o banco sozinha o tempo todo.
 */
export const STALE_TIME_MS = 60_000;

/**
 * Com a aba VISÍVEL as telas que leem o banco atualizam a cada 30 min (docs/known-risks.md item 301, decisão do usuário em 2026-11-12); com a aba escondida
 * ou fechada não consultam (o React Query pausa o intervalo quando a página não está visível). Antes eram 60 s/120 s: o Neon grátis só dorme depois de 5 min
 * sem consulta, então qualquer intervalo menor que isso mantinha o banco acordado com uma aba esquecida aberta (item 300).
 *
 * 30 min = 2 scans (o dado só muda a cada ~15 min). Voltar para a aba ou trocar de página já refaz na hora pelo `STALE_TIME_MS`. Com operação ativa o
 * acompanhamento de stop/alvo continua a cada 2 min pelo `useAutoScan` (não é um `refetchInterval`).
 */
export const VISIBLE_REFRESH_MS = 30 * 60_000;

/** Telas que o usuário acompanha enquanto opera (Dashboard, Trades, Assets, ticker). */
export const POLL_OPERATIONAL_MS = VISIBLE_REFRESH_MS;

/** Diagnóstico e histórico (logs, verificação, alertas, relatórios, conta virtual). */
export const POLL_DIAGNOSTIC_MS = VISIBLE_REFRESH_MS;
