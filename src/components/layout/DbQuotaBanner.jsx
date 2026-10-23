import React, { useSyncExternalStore } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { getDbStatus, subscribeDbStatus } from '@/lib/dbStatus';

/**
 * Aviso global de "banco sem cota" (docs/known-risks.md item 282): quando a API
 * responde 503 `db_quota`, o painel diz o que está acontecendo em vez de ficar
 * carregando. Some sozinho na primeira resposta boa do banco. Não afirma nada
 * sobre os dados guardados — só que a leitura/gravação está recusada e que o
 * que aparece na tela pode estar velho.
 */
export default function DbQuotaBanner() {
  const status = useSyncExternalStore(subscribeDbStatus, getDbStatus, getDbStatus);
  if (!status.quotaExhausted) return null;

  const lastOk = status.lastOkAt
    ? new Date(status.lastOkAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    : null;

  return (
    <Alert variant="destructive" className="mb-4">
      <AlertTriangle className="h-4 w-4" aria-hidden="true" />
      <div>
        <p className="font-semibold">Banco de dados sem cota</p>
        <p>
          O plano gratuito do banco atingiu o limite do mês, então o painel não consegue ler nem gravar
          e o scan agendado fica parado. O que aparece na tela pode estar desatualizado
          {lastOk ? ` (último dado carregado às ${lastOk})` : ''}. O Telegram avisa quando o banco voltar.
        </p>
      </div>
    </Alert>
  );
}
