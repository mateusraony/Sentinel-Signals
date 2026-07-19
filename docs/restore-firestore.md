# Restaurar um backup do Firestore

Este é um procedimento **manual, de propósito** — não existe um botão de
"restaurar automaticamente". Numa situação real de desastre (dado apagado
sem querer, corrompido, etc.), é melhor revisar com calma o que está sendo
restaurado antes de escrever de volta no banco, para não sobrescrever dado
bom por engano. Ver `docs/known-risks.md` item 14 para o contexto completo.

## Onde estão os backups

Branch `backups` do repositório **privado** `mateusraony/sentinel-signals-backups`
(separado deste repo — ver `docs/known-risks.md` item 25 para o porquê), um
arquivo por dia (`backup-YYYY-MM-DD.json`), gerado automaticamente todo dia
de madrugada por `.github/workflows/backup.yml`. Mantém os últimos 30 dias.

Para ver os backups disponíveis, clone o repositório de backup (precisa de
acesso — é privado) e confira a branch:

```
git clone --branch backups git@github.com:mateusraony/sentinel-signals-backups.git /tmp/sentinel-backups
cd /tmp/sentinel-backups
git log --oneline -- 'backup-*.json'
```

## Passo a passo

1. **Baixe o snapshot que você quer restaurar:**
   ```
   cp /tmp/sentinel-backups/backup-2026-07-14.json /tmp/backup.json
   ```
   (troque a data pelo arquivo que você quer)

2. **Abra o arquivo e confira o que tem dentro** — é um JSON simples, com
   uma chave por coleção (`MonitoredAsset`, `AssetState`, `SignalEvent`,
   `TradeOperation`, `PriceAlert`, `StrategyConfig`) e um array de
   documentos dentro de cada uma. Se você só quer restaurar uma coleção
   específica (ex: só `tradeOperations`), edite o JSON e apague as outras
   chaves antes do próximo passo — o script de restauração processa
   qualquer coleção presente no arquivo.

3. **Rode o script de restauração** (precisa das mesmas credenciais do
   scan agendado — `FIREBASE_SERVICE_ACCOUNT_JSON`):
   ```
   FIREBASE_SERVICE_ACCOUNT_JSON='...' node scripts/restore-firestore.mjs /tmp/backup.json
   ```

4. **O script vai perguntar antes de escrever qualquer coisa** — ele
   mostra quantos documentos de cada coleção serão restaurados e pede
   confirmação (`sim`/`não`) antes de prosseguir. Use `--dry-run` para só
   ver o que aconteceria, sem escrever nada:
   ```
   FIREBASE_SERVICE_ACCOUNT_JSON='...' node scripts/restore-firestore.mjs /tmp/backup.json --dry-run
   ```

5. Cada documento é restaurado com o mesmo ID que tinha no backup
   (`set`, não `add`) — ou seja, restaurar sobrescreve qualquer documento
   que já exista com o mesmo ID hoje. Se você só quer recuperar dados que
   foram perdidos (não sobrescrever o que já está certo), prefira editar o
   JSON no passo 2 pra deixar só os documentos que faltam.

## Se a conta do Firebase inteira sumiu (cenário extremo)

Os passos acima assumem que o projeto Firebase ainda existe, só os dados
que precisam voltar. Se o projeto inteiro precisar ser recriado do zero:
1. Crie um novo projeto Firebase (Console Firebase → Adicionar projeto).
2. Rode `firebase deploy --only firestore:rules,firestore:indexes` (ver
   `CLAUDE.md`, seção Deploy) pra publicar `firestore.rules`/`firestore.indexes.json`.
3. Gere uma nova service account key e atualize `FIREBASE_SERVICE_ACCOUNT_JSON`
   nos secrets do GitHub Actions e no Render.
4. Siga os passos 1-5 acima normalmente.
