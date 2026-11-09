// "Por que o Dashboard não carregou" (docs/known-risks.md item 6, correção de 08/11/2026). Antes, toda falha de leitura virava o mesmo
// "Não foi possível carregar…", e uma causa simples (falta a chave de acesso neste navegador: o servidor responde 403 e o ícone de chave fica
// rosa) passou dias sem ser notada. Esta função PURA traduz o erro de `callBackend` numa causa em português simples e no que fazer; nunca muda
// o fluxo de quem chama e devolve null quando não sabe dizer a causa (aí a tela fica como sempre foi). O banco sem cota (503 `db_quota`) já tem
// aviso próprio: devolve null para não repetir.
import { classifyError, ERROR_CLASS } from '@/lib/errorClass';
import { DB_QUOTA_CODE } from '@/lib/dbQuotaError';

const CAUSES = Object.freeze({
  no_key: {
    title: 'Falta a chave de acesso neste navegador',
    hint: 'O servidor só entrega os dados do painel para quem tem a chave. Toque em "Colar a chave" e cole o valor de OWNER_ACCESS_KEY (no Render, serviço sentinel-signals-api, aba Environment).',
    needsKey: true,
  },
  bad_key: {
    title: 'A chave salva neste navegador não é aceita pelo servidor',
    hint: 'Ela pode ter sido trocada no Render. Toque em "Colar a chave" e cole de novo o valor atual de OWNER_ACCESS_KEY.',
    needsKey: true,
  },
  login: {
    title: 'O painel não conseguiu fazer o login deste navegador',
    hint: 'Recarregue a página. Se continuar, limpe os dados do site neste navegador e abra de novo.',
    needsKey: false,
  },
  sem_resposta: {
    title: 'O servidor não respondeu',
    hint: 'Ele pode estar acordando (leva até 1 minuto) ou o aparelho está sem internet. Espere um pouco e toque em "Tentar de novo".',
    needsKey: false,
  },
  erro_servidor: {
    title: 'O servidor teve um erro',
    hint: 'Tente de novo em instantes. Se continuar, o banco de dados pode estar fora do ar.',
    needsKey: false,
  },
  sem_endereco: {
    title: 'O painel não sabe o endereço do servidor',
    hint: 'Falta a configuração VITE_BACKEND_URL no Render do site. É defeito de configuração, não do seu aparelho.',
    needsKey: false,
  },
});

/**
 * @param {{ message?: string, status?: number, code?: string } | null | undefined} error o erro lançado por `callBackend`
 * @param {{ ownerKeyConfigured?: boolean }} [opts] se há chave salva neste navegador (`isOwnerKeyConfigured()`)
 * @returns {{ code: string, title: string, hint: string, needsKey: boolean } | null}
 */
export function loadFailureCause(error, { ownerKeyConfigured = false } = {}) {
  if (!error || typeof error !== 'object') return null;
  if (error.code === DB_QUOTA_CODE) return null; // aviso próprio de cota
  const message = String(error.message ?? '');
  const status = Number.isInteger(error.status) ? error.status : null;

  const pick = (code) => ({ code, ...CAUSES[code] });
  if (/VITE_BACKEND_URL/.test(message)) return pick('sem_endereco');
  // `requireOwner` (server/requireOwner.js) responde 403 "Chave de acesso ausente ou inválida." — com ou sem chave salva a mensagem é a mesma;
  // quem diferencia é o navegador: sem chave salva = falta; com chave salva = a do servidor é outra.
  if (status === 403 || /chave de acesso/i.test(message)) return pick(ownerKeyConfigured ? 'bad_key' : 'no_key');
  if (status === 401 || message === 'Não autenticado.') return pick('login');

  const cls = classifyError(error);
  if (cls === ERROR_CLASS.AUTH) return pick('login');
  if (cls === ERROR_CLASS.NETWORK || cls === ERROR_CLASS.TIMEOUT) return pick('sem_resposta');
  if (cls === ERROR_CLASS.HTTP_5XX) return pick('erro_servidor');
  return null;
}
