#!/usr/bin/env bash
# Aviso de FALHA de um workflow agendado no Telegram (docs/known-risks.md item 288, addendum de
# 04/11/2026). Usado pelo job `avisar-falha` de backup.yml e backup-postgres.yml.
#
# Por que existe: o backup diário ficou vermelho de 31/10 a 03/11 e ninguém soube. O CI já avisa
# no Telegram quando falha (ci.yml); o backup, que roda sozinho e sem ninguém olhando, não avisava.
#
# Entradas, só por variável de ambiente (nada interpolado no shell):
#   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID   os mesmos segredos do scan/CI
#   ALERT_TITLE                            primeira linha ("Backup diário do Postgres FALHOU")
#   ALERT_RUN_URL                          link da execução que falhou
#   ALERT_HINT                             o que fazer (texto fixo do workflow)
#
# MELHOR ESFORÇO: este script SEMPRE termina com código 0. Se o Telegram estiver fora do ar ou sem
# segredos, vira um aviso (::warning::) no log — o job de backup já está vermelho, não precisa de um
# segundo erro. Texto puro (sem parse_mode): nada de HTML para escapar.
#
# Segurança: o token só existe na URL da requisição. Nenhuma mensagem do script imprime a URL, e a
# saída de erro do curl (que pode citá-la) é descartada. Sem banco, sem Firebase, sem escrita.
set -uo pipefail

if [ -z "${TELEGRAM_BOT_TOKEN:-}" ] || [ -z "${TELEGRAM_CHAT_ID:-}" ]; then
  echo "::warning::Segredos do Telegram (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID) não configurados: o aviso de falha NÃO foi enviado."
  exit 0
fi

titulo="${ALERT_TITLE:-Um workflow agendado FALHOU}"
quando="$(date -u '+%d/%m/%Y %H:%M') UTC"
texto="⚠️ ${titulo}

Quando: ${quando}
Veja o motivo: ${ALERT_RUN_URL:-(link indisponível)}"
if [ -n "${ALERT_HINT:-}" ]; then
  texto="${texto}

${ALERT_HINT}"
fi

codigo="$(curl -sS -m 20 -o /dev/null -w '%{http_code}' -X POST \
  "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
  --data-urlencode "text=${texto}" 2>/dev/null)" || codigo="sem resposta"

if [ "$codigo" = "200" ]; then
  echo "Aviso de falha enviado ao Telegram."
else
  echo "::warning::O aviso de falha NÃO chegou ao Telegram (resposta: ${codigo})."
fi
exit 0
