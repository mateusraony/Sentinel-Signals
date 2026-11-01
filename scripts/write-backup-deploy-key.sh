#!/usr/bin/env bash
# Grava a deploy key SSH do backup (secret BACKUP_DEPLOY_KEY) num arquivo e CONFERE que o OpenSSH
# consegue ler a chave — antes de qualquer `git fetch`/`git push` no repositório privado de backups.
#
# Usado por backup.yml, backup-postgres.yml e restore-postgres.yml (docs/known-risks.md item 288,
# addendum de 01/11/2026). Por que existe: em 31/10 o secret ficou ilegível ("Load key …: error in
# libcrypto" seguido de "Permission denied (publickey)") e os 3 workflows falharam só NO ÚLTIMO PASSO,
# com uma mensagem que parecia problema de permissão. Aqui o problema aparece cedo e em português.
#
# Uso:   BACKUP_DEPLOY_KEY="$segredo" bash scripts/write-backup-deploy-key.sh ~/.ssh/backup_deploy_key
# Saída: arquivo com modo 600; código 0 = chave legível. Em qualquer falha o arquivo é apagado.
#
# Segurança: o conteúdo da chave NUNCA é impresso (nem na mensagem de erro, nem a saída do ssh-keygen,
# que é descartada). Só o caminho do arquivo e o texto fixo abaixo aparecem no log.
#
# O que é normalizado (e só isso), porque costuma acontecer ao colar um secret: fim de linha do Windows
# (CRLF), espaços no fim das linhas e linhas em branco no começo. O conteúdo da chave não é alterado.
# O que NÃO tem conserto: quebras de linha perdidas (chave colada numa linha só), chave PÚBLICA no lugar
# da privada, chave com senha, texto cortado — nesses casos o script para com a mensagem de erro.
set -euo pipefail

destino="${1:-}"
if [ -z "$destino" ]; then
  echo "uso: write-backup-deploy-key.sh <arquivo de destino>" >&2
  exit 2
fi

if [ -z "${BACKUP_DEPLOY_KEY:-}" ]; then
  echo "::error::O secret BACKUP_DEPLOY_KEY não está configurado (ou está vazio). Settings → Secrets and variables → Actions → BACKUP_DEPLOY_KEY → Update, colando a chave PRIVADA inteira (da linha BEGIN até a linha END)."
  exit 1
fi

mkdir -p "$(dirname "$destino")"
umask 077
# Tira espaços/tabs do fim de cada linha ([[:space:]] inclui o \r do CRLF do Windows) e as linhas em
# branco do começo. (Medido com o ssh-keygen real: o OpenSSH recusa CRLF, espaço no fim da linha e
# linha em branco ANTES da chave, e aceita linhas em branco DEPOIS dela.)
chave="$(printf '%s\n' "$BACKUP_DEPLOY_KEY" | sed -e 's/[[:space:]]*$//' | sed -e '/./,$!d')"
# O $( ) já tirou as linhas em branco do FIM; o printf devolve exatamente uma quebra de linha final.
printf '%s\n' "$chave" > "$destino"
chmod 600 "$destino"

# `-y -P ''` só LÊ a chave e imprime a pública (descartada aqui): não toca a rede. Sem tty e com senha
# vazia, uma chave com senha também falha — e é isso mesmo que queremos (o CI não tem como digitar).
if ! ssh-keygen -y -P '' -f "$destino" </dev/null >/dev/null 2>&1; then
  rm -f "$destino"
  echo "::error::O secret BACKUP_DEPLOY_KEY está ilegível para o OpenSSH (por isso o GitHub negaria o acesso ao repositório de backups). Causas mais comuns: a chave foi colada sem as quebras de linha, faltam as linhas BEGIN/END, foi colada a chave PÚBLICA (.pub) no lugar da privada, ou a chave tem senha. Conserto: gere uma chave nova SEM senha (ssh-keygen -t ed25519 -f sentinel-backup-key, Enter duas vezes quando pedir a senha), cadastre o arquivo .pub como Deploy key com acesso de escrita no repositório sentinel-signals-backups e cole o arquivo PRIVADO inteiro em Settings → Secrets and variables → Actions → BACKUP_DEPLOY_KEY → Update."
  exit 1
fi
