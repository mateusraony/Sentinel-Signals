import { lazy } from 'react';

// Sinal de que uma aba está rodando um bundle velho, de antes do deploy mais
// recente: o arquivo do chunk que ela tenta buscar já não existe mais no
// servidor (nome do arquivo muda a cada build). Como a aba não recarrega
// sozinha, ela fica presa nesse estado até alguém atualizar manualmente —
// achado real (docs/known-risks.md item 184 addendum): um "Illegal
// invocation" de dias atrás, já corrigido e confirmado em produção, seguia
// aparecendo no log porque a aba nunca tinha sido atualizada.
const CHUNK_LOAD_ERROR = /failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed/i;

// Uma única tentativa de recarregar por INCIDENTE (sessionStorage — limpa no
// próximo import que carregar com sucesso, ver abaixo; também não sobrevive a
// fechar a aba). Sem esse limite, uma falha REAL e persistente (ex.: usuário
// offline, ou o próprio reload não resolve nada) entraria num loop de
// recarregamento infinito em vez de cair no ErrorBoundary com o botão manual.
//
// Achado real (docs/known-risks.md, auditoria de 2026-09-25): a flag nunca
// era limpa após um reload bem-sucedido, então virava "uma tentativa pra
// sempre nesta aba", não "uma tentativa por incidente" — numa aba deixada
// aberta por dias (item 184 addendum), um 2º deploy mais tarde produzia um
// 2º chunk-error genuíno (página diferente) que já não se autocurava, caindo
// direto no ErrorBoundary. Limpar no sucesso resolve isso sem reabrir o
// risco de loop: se a MESMA importação continuar falhando, o sucesso nunca
// acontece, a flag nunca é limpa, e um 2º reload da mesma falha continua
// bloqueado.
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
    const mod = await factory();
    sessionStorage.removeItem(RELOAD_FLAG_KEY);
    return mod;
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
