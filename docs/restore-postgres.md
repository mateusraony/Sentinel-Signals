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

2. **Confirme a versão do `pg_restore` local ANTES de tentar** (`pg_restore
   --version`) — achado real rodando `backup-postgres.yml` em produção
   (`docs/known-risks.md`): `pg_dump`/`pg_restore` recusam operar contra um
   servidor de major version MAIOR que a própria ferramenta ("aborting
   because of server version mismatch"). O Neon roda Postgres 18.x — se o
   `pg_restore` da sua máquina for mais antigo (ex.: 16, o default de
   muitas distros), instale a versão 18 antes de seguir (no Ubuntu/Debian,
   via o repositório oficial `apt.postgresql.org`, pacote
   `postgresql-client-18`; no macOS, `brew install postgresql@18`).

3. **Confira o conteúdo antes de restaurar** — `pg_restore --list` mostra o
   que está dentro do dump (tabelas/dados) sem tocar em nada:
   ```
   pg_restore --list /tmp/restore.dump
   ```
   Lembre-se: o dump **nunca** inclui `users` (perfis ligados à auth
   anônima) nem `scanner_locks` (estado de execução efêmero) — ver o
   cabeçalho de `scripts/backup-postgres.mjs` pro porquê.

4. **Restaure contra o banco de destino** (`DATABASE_URL` da instância que
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

5. **Restaurar só uma tabela específica** (ex.: só `trade_operations`, sem
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
   tabelas sozinho a partir do passo 4 acima, mas aplicar o schema primeiro
   garante que qualquer tabela **excluída do dump** (`users`/
   `scanner_locks`) também exista, vazia, prontas pro app escrever de novo.
3. Atualize o secret `DATABASE_URL` (GitHub Actions e Render).
4. Siga os passos 1-5 acima normalmente.

## Trocar de provedor: restaurar num banco NOVO (Supabase) — item 282

Quando o Neon gratuito estoura a cota, ele recusa tudo até o mês renovar. O caminho sem pagar é
restaurar o último backup diário num Postgres novo e só então trocar o `DATABASE_URL`.
**Perde-se o que foi gravado depois do backup usado** (operações virtuais, sinais, logs).
Nada é apagado no Neon.

### Você faz (nomes como aparecem na tela; o painel do Supabase pode mudar um rótulo de lugar)

1. **Supabase → New project.** Nome `sentinel-signals`, escolha uma senha forte e guarde. Região nos
   EUA (o Render e o GitHub rodam nos EUA; perto = mais rápido). Crie um projeto **só do Sentinel**:
   não use o banco de outro app seu. O plano gratuito permite 2 projetos ativos.
2. **Baixar o certificado:** Project Settings → Database → *SSL Configuration* → *Download certificate*.
   Abra o arquivo `.crt` no bloco de notas e copie o texto inteiro (de `-----BEGIN CERTIFICATE-----` até
   `-----END CERTIFICATE-----`). O certificado é público.
3. **Copiar a conexão:** botão *Connect* no topo do projeto → aba *Connection string* → método
   **Session pooler** → copie. Troque `[YOUR-PASSWORD]` pela senha e **acrescente `?sslmode=require` no
   fim**. Tem que ser *Session pooler*: a "Direct connection" só funciona por IPv6, que o Render e o
   GitHub não usam no plano gratuito.
4. **GitHub → Settings → Secrets and variables → Actions → New repository secret**, dois secrets:
   - `RESTORE_DATABASE_URL` = a conexão do passo 3;
   - `DATABASE_SSL_CA` = o texto do certificado do passo 2.
5. **GitHub → Actions → "Restaurar backup no banco novo (Sentinel Signals)" → Run workflow.** Deixe
   "Apagar o que já existe…" desmarcado. No fim, abra o resumo do job: ele mostra qual backup foi usado,
   as linhas por tabela e o tamanho do banco contra os 500 MB do plano gratuito.
6. Só depois de conferir o resumo, troque a conexão viva:
   - GitHub: edite o secret `DATABASE_URL` com a mesma conexão do passo 3 (Session pooler + `?sslmode=require`);
   - Render → serviço `sentinel-signals-api` → Environment: `DATABASE_URL` com a mesma conexão e
     `DATABASE_SSL_CA` com o certificado;
   - espere o Render reiniciar e dispare o workflow "Scheduled scan" uma vez: o log deve mostrar a linha
     "leitura do banco" e nenhum erro.

### Por que é seguro

- O workflow só escreve em `RESTORE_DATABASE_URL` e se recusa a rodar se for igual ao `DATABASE_URL` vivo.
- Restaura só os dados, numa transação: se falhar, nada fica pela metade. O schema vem de `db/schema.sql`.
- Se o certificado estiver errado, o passo "Conferir a conexão" falha cedo e diz isso.
- Deu errado no meio e quer refazer: rode de novo marcando "Apagar o que já existe".
