// Ponto de entrada do ENSAIO do vigia de stop/alvo (docs/known-risks.md item 299, addendum 6; workflow .github/workflows/observation-rehearsal.yml).
// Só LÊ o RTDB e as regras, busca velas públicas da Binance e manda 2 mensagens "ENSAIO" no Telegram. Não grava nada e não toca o Postgres.
// O log do Actions é PÚBLICO: imprime só a linha de contagens e códigos. O job fica vermelho se algum ponto do caminho falhou.
import { pathToFileURL } from 'node:url';
import { withTimeout, forceExit } from './scanTimeout.mjs';
import { runObservationRehearsal, describeRehearsalResult } from './observationRehearsal.mjs';

const REHEARSAL_TIMEOUT_MS = 120 * 1000;

/** Só roda quando o arquivo é EXECUTADO, nunca quando é importado (módulo que faz trabalho no carregamento é intestável). */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  withTimeout(runObservationRehearsal({}), REHEARSAL_TIMEOUT_MS, 'observationRehearsal')
    .then((r) => {
      console.log(describeRehearsalResult(r));
      forceExit(r?.ok ? 0 : 1); // forceExit: a conexão persistente do RTDB mantém o processo vivo
    })
    .catch(() => {
      // Mensagem FIXA: o texto da exceção não passa por sanitização e o log é público.
      console.error('[ensaio] falhou sem resultado (prazo ou erro inesperado)');
      forceExit(1);
    });
}
