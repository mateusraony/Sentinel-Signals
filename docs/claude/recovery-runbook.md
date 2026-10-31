# Roteiro: recuperação depois de uma pausa longa do banco

Para quando o banco (Neon) ficar dias fora do ar — por exemplo, sem cota de computação — e
voltar. Detalhe técnico em `docs/known-risks.md` item 288.

## Por que existe

O scan ao vivo só olha a **última vela**. Se ele rodar primeiro depois de dias parado:

- fecha operações antigas pelo Time Stop **no preço de hoje**;
- não vê stop nem alvo que foram tocados no meio da pausa;
- nunca cria as operações que deveriam ter aberto durante a pausa.

A recuperação reprocessa a pausa **vela a vela, com as mesmas regras do motor**, e só depois o
scan ao vivo volta. Nada aqui envia ordem para a corretora: tudo continua virtual.

## Ordem (não pule passos)

Os nomes abaixo são os que aparecem na aba **Actions** do GitHub.

1. **Desligue tudo que roda o scan sozinho** (o próprio workflow confere e se recusa a rodar se
   algo estiver ligado):
   - cron-job.org: job do scan **pausado**;
   - **Scheduled scan** → menu "…" → **Disable workflow**;
   - **Backfill check (checagem retroativa de ativo novo/reativado)** → "…" → **Disable workflow**;
   - **não abra o painel** até o passo 7 (uma aba aberta faz um scan 90 s depois de carregar).
2. **Espere o banco voltar.** Para saber: em **Daily Postgres backup** → **Run workflow**. Verde =
   o banco voltou (e você já ganhou um backup novo). Vermelho com "exceeded the quota" = ainda não.
3. **Teste a seco:** **Recuperação após pausa do banco** → **Run workflow** → campo **"O que
   fazer"** = `teste-a-seco` → **Run workflow**. Ele só lê o banco; não grava nada e não manda
   Telegram.
4. **Leia o relatório** (clique na execução → **Summary**). Confira:
   - a tabela de ativos e o período reprocessado;
   - "Operações novas (deveriam ter aberto na pausa)";
   - "Operações antigas que mudaram de estado" (stop/alvo/Time Stop na pausa, com o horário da vela);
   - no fim: **"o número desta execução é …"** — anote esse número.
5. **Aplicar** (só se o relatório fizer sentido para você, e de preferência logo em seguida):
   **Recuperação após pausa do banco** → **Run workflow** → **"O que fazer"** = `aplicar` → no campo
   **"Só para aplicar: o número do teste a seco…"** cole o número anotado → **Run workflow**.
   - Primeiro o número é conferido (só dígitos) e roda um **backup** do banco no repositório privado de
     backups, com **nome próprio**: `postgres-backup-AAAA-MM-DD-pre-recuperacao-NÚMERO.dump`. O backup
     diário do mesmo dia não o sobrescreve nem o apaga na limpeza dos 30 mais recentes.
   - Depois ele confere que **nada mudou** desde o teste a seco. Se mudou — ou se aconteceu uma
     operação nova ou um fechamento que o teste a seco não mostrou —, ele **para sem gravar** e
     pede um teste a seco novo: volte ao passo 3.
   - O teste a seco só vale por 24 h.
   - **Se o tempo estiver acabando** (a aplicação para de começar ativos novos 150 min depois de iniciar),
     ela termina o ativo em andamento, confere, e avisa **"APLICADA PARCIALMENTE"** com a lista dos
     ativos que faltam. Nesse caso **não religue o scan**: volte ao passo 3 (um novo teste a seco recomeça só
     do que faltou) e aplique de novo.
6. **Confira** a mensagem no Telegram (vem **uma** só) e o relatório da execução.
7. **Religue logo, nesta ordem** (as velas entre o fim da aplicação e o primeiro scan ao vivo **não são
   reprocessadas** — não deixe passar horas):
   - **Scheduled scan** → **Enable workflow**;
   - cron-job.org: reative o job com **a cada 15 min**;
   - **Backfill check** → **Enable workflow**;
   - abra o painel: as operações recuperadas aparecem com o selo **♻️ Recuperada**.

## Se der errado

- **"NÃO aplicada — nada foi gravado"**: corrija o motivo escrito na mensagem e volte ao passo 3.
  Se o motivo for "não consegui conferir se o Scheduled scan e o Backfill check estão desativados" é a
  API do GitHub que falhou (não o scan ligado): rode de novo.
- **"parou NO MEIO — parte já foi gravada"**: **não rode de novo e não religue o scan.** O backup
  feito logo antes está no repositório privado de backups (branch `backups-postgres`, arquivo
  `postgres-backup-AAAA-MM-DD-pre-recuperacao-NÚMERO.dump`). Chame o Claude com o link da execução.
- **"TEMPO ESGOTADO NO MEIO"**: mesma regra do "parou no meio" (não rode de novo, não religue). As
  travas (locks) se soltam sozinhas em até 40 min.
- **"GRAVADA E CONFERIDA, FALTA ETIQUETAR"**: os dados estão certos (o banco bate com a simulação);
  só a etiqueta "Recuperada" falhou. **Não rode de novo e não religue o scan** (sem a etiqueta as
  operações recuperadas contariam como ao vivo). Chame o Claude para só etiquetar.
- **Job vermelho SEM mensagem no Telegram nem relatório** (não deveria acontecer): abra o log do
  passo "Aplicar a recuperação". Se o passo **começou** a aplicar, trate como "parou no meio"; se
  falhou antes (por exemplo, no `npm ci` ou ao baixar o resultado do teste a seco), nada foi gravado.
  O que **foi** e o que **não foi** gravado: o relatório do aplicar e o artefato `recovery-apply`
  (90 dias) trazem o diário de escritas.
- **Desfazer tudo (último recurso):** restaurar o backup `-pre-recuperacao-NÚMERO` num banco NOVO com o
  workflow **Restaurar backup no banco novo**, campo **"Arquivo do backup"** = o nome exato do arquivo
  (vazio = o backup **diário** mais recente, que pode já ser de depois da recuperação).

## O que fica registrado

- Operações **novas** (abriram na pausa): `source: 'recovery'` + selo **♻️ Recuperada** no painel e
  aviso nas próximas mensagens do Telegram. **Ficam fora da medição do motor** (decisão do usuário em
  29/10: você não recebeu o aviso na hora, como as "Retroativas"): fora da **Confiança ao Vivo** e da
  **comparação com o histórico**; aparecem normalmente nas listas e nos relatórios gerais.
- Operações **antigas** que a recuperação só encerrou: continuam contando, com `recovery_run_id`.
- Cada ativo ganha `recovery_replayed_to` (até onde foi reprocessado). Uma nova recuperação começa
  depois disso — rodar de novo não refaz o que já foi feito.

## Limites honestos

- **Ativos que ficam de fora:** ativo **desativado** ou com a **checagem retroativa pendente** não é
  reprocessado, e uma operação **aberta** dele continua parada. O teste a seco e a mensagem do aplicar
  listam essas operações ("Operações ABERTAS que a recuperação NÃO reprocessa") — cuide delas à mão.
- **Cascata SMC com scan de 15 min:** a recuperação reprocessa o SMC de 5 em 5 min (a cadência de antes
  da pausa); o ao vivo agora olha uma vela de 5 min a cada 15 min. A diferença é pequena na prática (a
  SMC mede ~0 operações), mas existe — `docs/known-risks.md` item 288, addendum da auditoria de 31/10.
- Saídas decididas pela **vela** (como o motor faz): sem o price-check durante a pausa; quando a
  mesma vela toca o stop e o alvo, o **stop vence**.
- Usa a configuração da estratégia **de agora**.
