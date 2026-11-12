// "Última vez que a tela leu o banco com sucesso" (docs/known-risks.md item 301). É o horário que o chip "Atualizado às HH:MM:SS" mostra.
//
// Por que não o `dataUpdatedAt` do React Query: ele também muda com a cotação da Binance (a cada 30 s), que não vem do banco, e o chip diria "agora" o tempo
// todo mesmo com o dado do banco de 30 min atrás. Aqui só entra LEITURA do banco que deu certo (`list`/`filter`/`get` de `src/api/entities.js`); escrita (o
// logger gravando) e erro não contam.
//
// Estado de módulo pequeno e testável: nada toca `window`/`document`; o relógio entra por parâmetro.

let last = 0;
const subscribers = new Set();

/** Registra uma leitura do banco que deu certo. */
export function noteDbRead(ts = Date.now()) {
  last = ts;
  for (const fn of [...subscribers]) {
    try { fn(); } catch { /* um ouvinte com defeito não pode derrubar a leitura nem os outros */ }
  }
}

/** Instante (ms) da última leitura bem-sucedida; 0 se nenhuma ainda. */
export const getLastDbRead = () => last;

/** Para `useSyncExternalStore`. Devolve a função que cancela. */
export function subscribeDbRead(fn) {
  subscribers.add(fn);
  return () => { subscribers.delete(fn); };
}

/** Só para testes. */
export function resetDbReadClock() {
  last = 0;
  subscribers.clear();
}
