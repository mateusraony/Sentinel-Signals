# Restaurar um backup do Postgres/Neon

Procedimento **manual, de propósito** — mesmo raciocínio de
`docs/restore-firestore.md`: revisar com calma antes de escrever de volta no
banco, para não sobrescrever dado bom por engano. Ver
`docs/known-risks.md` item 170 (Fase 8) para o contexto completo da migração
Firestore→Neon.

Diferente do Firestore, aqui **não existe script de restauração próprio** —
`pg_restore` já é a ferramenta padrão e madura do próprio Postgres, então o
procedimento é chamá-lo diretamente.

## Onde estão os backups

Branch `backups-postgres` do repositório **privado**
`mateusraony/sentinel-signals-backups` (mesmo repositório do backup do
Firestore, branch SEPARADA — ver o comentário em
`.github/workflows/backup-postgres.yml` pro porquê), um arquivo por dia
(`postgres-backup-YYYY-MM-DD.dump`), gerado automaticamente todo dia de
madrugada por esse workflow. Mantém os últimos 30 dias.

```
git clone --branch backups-postgres git@github.com:mateusraony/sentinel-signals-backups.git /tmp/sentinel-backups-pg
cd /tmp/sentinel-backups-pg
git log --oneline -- 'postgres-backup-*.dump'
```

## Passo a passo

1. **Baixe o dump que você quer restaurar:**
   ```
   cp /tmp/sentinel-backups-pg/postgres-backup-2026-09-08.dump /tmp/restore.dump
   ```
   (troque a data pelo arquivo que você quer)

2. **Confira o conteúdo antes de restaurar** — `pg_restore --list` mostra o
   que está dentro do dump (tabelas/dados) sem tocar em nada:
   ```
   pg_restore --list /tmp/restore.dump
   ```
   Lembre-se: o dump **nunca** inclui `users` (perfis ligados à auth
   anônima) nem `scanner_locks` (estado de execução efêmero) — ver o
   cabeçalho de `scripts/backup-postgres.mjs` pro porquê.

3. **Restaure contra o banco de destino** (`DATABASE_URL` da instância que
   vai RECEBER os dados — nunca aponte para produção sem ter certeza):
   ```
   pg_restore --clean --if-exists --no-owner --no-privileges \
     --dbname "$DATABASE_URL" /tmp/restore.dump
   ```
   - `--clean --if-exists`: recria (`DROP`+`CREATE`) cada tabela presente
     no dump antes de repovoar — seguro tanto contra um banco vazio quanto
     contra um que já tem as tabelas (com dado desatualizado).
   - `--no-owner --no-privileges`: não exige que o role `neondb_owner`
     (dono original do dump) exista no banco de destino.
   - Restaura **só** as tabelas presentes no dump — não apaga/altera
     `users`/`scanner_locks` do banco de destino (o comando nunca as
     menciona, já que elas nunca estiveram no dump).

4. **Restaurar só uma tabela específica** (ex.: só `trade_operations`, sem
   tocar o resto): use `--table`:
   ```
   pg_restore --clean --if-exists --no-owner --no-privileges \
     --table trade_operations --dbname "$DATABASE_URL" /tmp/restore.dump
   ```

## Se a instância Neon inteira sumiu (cenário extremo)

Os passos acima assumem que o projeto Neon ainda existe, só os dados que
precisam voltar. Se o projeto inteiro precisar ser recriado do zero:
1. Crie um novo projeto Neon (Console Neon → New Project) e obtenha a nova
   connection string "pooled".
2. Rode `db/migrate.mjs` (ou dispare `.github/workflows/db-migrate.yml`) pra
   aplicar `db/schema.sql` — `pg_restore --clean --if-exists` já recria as
   tabelas sozinho a partir do passo 3 acima, mas aplicar o schema primeiro
   garante que qualquer tabela **excluída do dump** (`users`/
   `scanner_locks`) também exista, vazia, prontas pro app escrever de novo.
3. Atualize o secret `DATABASE_URL` (GitHub Actions e Render).
4. Siga os passos 1-4 acima normalmente.
