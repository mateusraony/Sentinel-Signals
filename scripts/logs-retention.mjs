#!/usr/bin/env node
// CLI da retenção do system_logs (docs/known-risks.md item 298). A lógica mora em db/logsRetention.mjs (testada contra Postgres de verdade);
// aqui só se lê o ambiente, se abre a conexão, se imprime o relatório e se devolve o código de saída.
//
// Variáveis de ambiente:
//   DATABASE_URL    obrigatória (o Neon de produção).
//   RETENCAO_MODO   "simular" (padrão: só conta, nada é apagado) ou "aplicar" (apaga). Outro valor é recusado.
//   RETENCAO_DIAS   quantos dias de log guardar (padrão 30; aceita de 7 a 3650).
//
// O log do Actions e o resumo do job são PÚBLICOS (repositório público): saem só números, níveis e datas. Em caso de falha sai só um CÓDIGO
// ("ECONNREFUSED", "57014"…) — nunca a mensagem crua do driver, que pode trazer o endereço do banco e até a senha.
import { pathToFileURL } from 'node:url';
import { getPool, closePool } from '../db/pgEntitiesCore.mjs';
import { runLogsRetention, formatRetentionReport, RetentionInputError } from '../db/logsRetention.mjs';
import { isDatabaseQuotaExhausted } from '../src/lib/dbQuotaError.js';

/** Rótulo SEGURO de uma falha: erro de entrada (mensagem nossa) → a mensagem; cota do Neon → frase pronta; resto → só o código ou o nome. */
function safeFailureLabel(err) {
  if (err instanceof RetentionInputError) return err.message;
  if (isDatabaseQuotaExhausted(err?.message)) return 'Banco de dados sem cota (Neon): olhe o painel do Neon para saber qual limite foi atingido.';
  const code = typeof err?.code === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(err.code) ? err.code : null;
  const name = typeof err?.name === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(err.name) ? err.name : 'erro_desconhecido';
  return `Falha ao falar com o banco (${code ?? name}).`;
}

/**
 * @param {{ env?: Record<string, string|undefined>, getDb?: () => { query: Function }, closeDb?: () => Promise<void>,
 *           nowMs?: number, log?: (t: string) => void, logError?: (t: string) => void }} [deps]
 * @returns {Promise<number>} código de saída (0 = ok, 1 = falha)
 */
export async function main({
  env = process.env,
  getDb = () => getPool(env.DATABASE_URL),
  closeDb = closePool,
  nowMs = Date.now(),
  log = console.log,
  logError = console.error,
} = {}) {
  if (!env.DATABASE_URL) {
    logError('DATABASE_URL não está setada.');
    return 1;
  }
  try {
    const report = await runLogsRetention({
      db: getDb(),
      mode: env.RETENCAO_MODO,
      days: env.RETENCAO_DIAS,
      nowMs,
    });
    log(formatRetentionReport(report));
    return 0;
  } catch (err) {
    logError(`Retenção do system_logs falhou: ${safeFailureLabel(err)}`);
    return 1;
  } finally {
    await closeDb().catch(() => {});
  }
}

// Só roda como programa (nunca ao ser importado pelos testes): módulo que faz trabalho ao carregar é intestável.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code));
}
