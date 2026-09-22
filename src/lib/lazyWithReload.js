import { lazy } from 'react';

// Sinal de que uma aba está rodando um bundle velho, de antes do deploy mais
// recente: o arquivo do chunk que ela tenta buscar já não existe mais no
// servidor (nome do arquivo muda a cada build). Como a aba não recarrega
// sozinha, ela fica presa nesse estado até alguém atualizar manualmente —
// achado real (docs/known-risks.md item 184 addendum): um "Illegal
// invocation" de dias atrás, já corrigido e confirmado em produção, seguia
// aparecendo no log porque a aba nunca tinha sido atualizada.
const CHUNK_LOAD_ERROR = /failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed/i;

// Uma única tentativa de recarregar por sessão de aba (sessionStorage — não
// sobrevive a fechar a aba, então uma aba nova sempre tenta de novo se
// precisar). Sem esse limite, uma falha REAL e persistente (ex.: usuário
// offline) entraria num loop de recarregamento infinito em vez de cair no
// ErrorBoundary com o botão manual.
const RELOAD_FLAG_KEY = 'sentinel_chunk_reload_attempted';

/**
 * A lógica de decisão, separada de `React.lazy` para ser testável sem
 * precisar montar Suspense/React inteiro (mesmo raciocínio de
 * `healthAuditFormat.mjs`: parte pura testável separada do wrapper).
 *
 * Se o import falhar porque o chunk não existe mais no servidor (deploy novo
 * trocou os nomes dos arquivos), recarrega a página uma vez em vez de deixar
 * a aba presa nesse erro para sempre. Uma falha de qualquer outro tipo (rede
 * offline, etc.) propaga normalmente para o ErrorBoundary, sem tentar reload.
 */
export async function loadWithReload(factory) {
  try {
    return await factory();
  } catch (err) {
    const isChunkError = CHUNK_LOAD_ERROR.test(err?.message || '');
    const alreadyTried = sessionStorage.getItem(RELOAD_FLAG_KEY) === '1';
    if (isChunkError && !alreadyTried) {
      sessionStorage.setItem(RELOAD_FLAG_KEY, '1');
      window.location.reload();
      // A navegação do reload() é assíncrona — devolve uma promise que nunca
      // resolve para o Suspense continuar mostrando o fallback de
      // carregamento em vez de renderizar um estado de erro que vai
      // desaparecer no instante seguinte.
      return new Promise(() => {});
    }
    throw err;
  }
}

/** `React.lazy` com a autorrecuperação de `loadWithReload` acima. */
export function lazyWithReload(factory) {
  return lazy(() => loadWithReload(factory));
}

export default lazyWithReload;
