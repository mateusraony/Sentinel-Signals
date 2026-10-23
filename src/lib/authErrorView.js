// O que a tela cheia de erro de autenticação (App.jsx) diz — função pura para ser testável sem
// montar o App inteiro. Achado do Codex no PR #514: ao recarregar com o banco sem cota, o
// `/api/me` falha ANTES do layout existir, então o aviso global (DbQuotaBanner) nunca aparecia
// justamente no cenário que ele explica. Aqui a causa `db_quota` ganha o texto próprio.
import { DB_QUOTA_CODE, DB_QUOTA_USER_MESSAGE, DB_QUOTA_USER_TITLE } from '@/lib/dbQuotaError';

const GENERIC = Object.freeze({
  title: 'Sem conexão com o servidor',
  message: 'Não conseguimos confirmar sua sessão agora. Seus dados estão salvos e seguros — isso costuma ser uma instabilidade temporária de conexão.',
});

/**
 * @param {{ code?: string } | null | undefined} authError
 * @returns {{ title: string, message: string }}
 */
export function authErrorFallbackProps(authError) {
  if (authError?.code === DB_QUOTA_CODE) {
    return { title: DB_QUOTA_USER_TITLE, message: DB_QUOTA_USER_MESSAGE };
  }
  return GENERIC;
}
