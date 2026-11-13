// Aba em segundo plano (docs/known-risks.md item 301). "Escondida" = o navegador diz que a página não está visível (outra aba na frente, janela minimizada,
// ou tela bloqueada). É a MESMA regra que o React Query usa para pausar o `refetchInterval` das telas: tudo que consulta o banco por conta própria usa esta
// função para ficar quieto quando ninguém está olhando. Sem `document` (testes de Node, SSR) nunca está escondida.

/** @returns {boolean} */
export function isTabHidden() {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}
