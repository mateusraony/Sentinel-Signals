# Cron externo — disparar o scan via `workflow_dispatch` (opcional)

## Por que

`.github/workflows/scan.yml` já roda no cadenciamento mínimo do GitHub
Actions (`schedule: "*/5 * * * *"`). Pesquisa de comunidade confirma que esse
gatilho **atrasa sob carga** — não é hipotético: há relatos recorrentes de
atraso consistente de ~30min em horários de pico (ex.: [Discussion #156282](https://github.com/orgs/community/discussions/156282))
e casos de drift crescente passando de 4h em cenários piores
([Discussion #196910](https://github.com/orgs/community/discussions/196910)).
A documentação da GitHub também deixa isso explícito: jobs agendados entram
numa fila global e "podem atrasar, especialmente em horários de pico" — sem
SLA. Isso é diferente do risco já documentado no item 12 de
`docs/known-risks.md` (desativação automática após 60 dias sem push) — aqui o
workflow continua ativo, só dispara mais tarde/irregular do que o cron pede.

**Workaround confirmado pela comunidade**: dispensar o `schedule:` como único
relógio e usar um serviço externo e gratuito para chamar o endpoint REST
`workflow_dispatch` do GitHub diretamente, na hora exata — o disparo chega
como uma chamada de API comum, sem entrar na fila de agendamento do GitHub.

`.github/workflows/scan.yml` **já** declara `workflow_dispatch: {}` (estava lá
desde a criação do workflow, como conveniência para disparo manual pelo
botão "Run workflow" da UI) — nenhuma mudança no workflow é necessária, só
chamar o mesmo endpoint por fora.

## Passo a passo

### 1. Criar um Personal Access Token (fine-grained, escopo mínimo)

No GitHub: **Settings → Developer settings → Personal access tokens →
Fine-grained tokens → Generate new token**.

- **Repository access**: "Only select repositories" → `Sentinel-Signals`
  (nunca "All repositories").
- **Permissions**: em "Repository permissions", `Actions` → **Read and
  write** (é o único escopo necessário para disparar `workflow_dispatch`;
  não conceda `Contents` write nem outros escopos).
- Defina uma expiração (o GitHub permite renovar depois; evite "no
  expiration").
- Copie o token — ele só é mostrado uma vez.

Esse token **nunca** entra no repositório nem em nenhum arquivo commitado —
vive só no painel do serviço de cron externo (próximo passo), como secret
dele.

### 2. Configurar o cron-job.org (ou serviço equivalente)

Pesquisa confirmou: o plano gratuito do [cron-job.org](https://cron-job.org)
permite até 60 execuções/hora (granularidade de 1 minuto — mais que
suficiente para todo minuto múltiplo de 5) e suporta headers HTTP
customizados por job, sem cartão de crédito.

Criar uma conta gratuita e um novo cronjob:

- **URL**: `https://api.github.com/repos/mateusraony/Sentinel-Signals/actions/workflows/scan.yml/dispatches`
- **Método**: `POST`
- **Headers customizados**:
  - `Accept: application/vnd.github+json`
  - `Authorization: Bearer <TOKEN do passo 1>`
  - `X-GitHub-Api-Version: 2022-11-28`
  - `Content-Type: application/json`
- **Corpo (body)**: `{"ref":"main"}`
- **Agendamento**: a cada 5 minutos (`*/5 * * * *`) — mesma cadência do
  `schedule:` interno.

Equivalente em `curl`, para testar manualmente antes de configurar o serviço:

```bash
curl -L -X POST \
  -H "Accept: application/vnd.github+json" \
  -H "Authorization: Bearer <TOKEN>" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  https://api.github.com/repos/mateusraony/Sentinel-Signals/actions/workflows/scan.yml/dispatches \
  -d '{"ref":"main"}'
```

Uma resposta `204 No Content` confirma que o disparo foi aceito — a run
aparece em Actions → Scheduled scan em poucos segundos.

### 3. Depois de confirmar que o disparo externo está funcionando, reduzir o `schedule:` interno para fallback

**Não manter os dois gatilhos a cada 5 minutos** — foi cogitado inicialmente,
mas a revisão automática do PR que introduziu este guia corretamente apontou
o problema: quando os dois disparam a cada 5min e ambos estão saudáveis, o
scan roda **~2x mais vezes por dia** (até 576 passadas em vez de 288) do que
o guard de quota do Firestore em `scanner.js` (`PASSES_PER_DAY`) assume — o
aviso de "perto do limite gratuito" ficaria cego a esse excesso justamente
quando ele acontece.

Depois de confirmar (rodando o `curl` do passo 2 algumas vezes, ou deixando o
cron-job.org rodar por um dia e checando Actions → Scheduled scan) que o
disparo externo está funcionando de forma confiável, faça as duas edições
abaixo **juntas, no mesmo PR**, para não deixar o sistema ao vivo rodando só
1x/hora achando que ainda roda a cada 5min:

1. Em `.github/workflows/scan.yml`, trocar `cron: "*/5 * * * *"` por
   `cron: "0 * * * *"` (a cada hora) — vira só um fallback de baixa
   frequência; o disparo externo passa a ser o relógio principal.
2. Em `src/lib/scanner.js`, ajustar a constante `PASSES_PER_DAY` do guard de
   quota (linha ~1359) de `288` para `312` (288 do disparo externo + 24 do
   fallback horário), para o aviso de quota continuar refletindo o volume
   real.

**Por que esperar confirmar antes de reduzir**: `scan.yml` roda a partir da
branch `main` assim que o merge acontece. Se a redução para 1x/hora for
mergeada ANTES do disparo externo estar de fato funcionando, o scan ao vivo
cai de 5min para 1h de cadência silenciosamente (sem erro, só sinal mais
velho) até alguém notar. O fallback horário ainda se autocorrige dentro da
janela de 30min do alerta de staleness por ativo (`docs/known-risks.md` item
12) se o disparo externo falhar DEPOIS de já estar funcionando — mas o
período de transição em si (redução mergeada antes da confirmação) é o
único jeito de cair nesse buraco.

`scan.yml` já declara:

```yaml
concurrency:
  group: scheduled-scan
  cancel-in-progress: false
```

Isso significa que se os dois gatilhos caírem no mesmo minuto (raro, já que
um é horário e o outro a cada 5min), as duas runs **enfileiram** (uma espera
a outra terminar) em vez de rodar em paralelo ou cancelar uma a outra — sem
risco de corrupção de dado (o scanner já é seguro sob concorrência via
`scannerLocks` + CAS transacional, ver `.claude/rules/trading-engine.md`).

## O que isso NÃO resolve

- Continua sem SLA — o serviço externo também pode falhar (rede, o próprio
  cron-job.org fora do ar). Por isso o watchdog do item 12 de
  `docs/known-risks.md` (healthchecks.io) continua sendo a rede de segurança
  real — ele alerta se NENHUM scan rodar dentro da janela, seja qual for a
  causa.
- Não substitui a decisão de manter/desativar o `schedule:` interno — isso
  fica a critério do usuário; nenhum código muda automaticamente.

## Status

Esta configuração é feita **fora do repositório** (conta pessoal do usuário
no cron-job.org + um PAT pessoal) — não há nada para commitar além deste
documento. `docs/known-risks.md` item 16 registra a decisão.
