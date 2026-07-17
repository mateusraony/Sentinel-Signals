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
  - `Authorization: Bearer SEU_TOKEN_AQUI`
  - `X-GitHub-Api-Version: 2022-11-28`
  - `Content-Type: application/json`
- **Corpo (body)**: `{"ref":"main"}`
- **Agendamento**: a cada 5 minutos (`*/5 * * * *`) — mesma cadência do
  `schedule:` interno.

> ⚠️ **Pegadinha comum (causa real de `401 Bad credentials` já vista aqui):**
> `SEU_TOKEN_AQUI` acima é só um marcador de texto — no campo "Valor" do
> header `Authorization`, digite `Bearer ` (com um espaço) seguido do token
> colado **direto**, sem nenhum símbolo `<` `>` ao redor. Se o valor final
> ficar parecido com `Bearer <github_pat_...` (com um `<` de verdade no
> meio), o GitHub rejeita como credencial inválida. Depois de colar,
> confira visualmente que não sobrou nenhum `<`/`>`/espaço extra antes ou
> depois do token.

Equivalente em `curl`, para testar manualmente antes de configurar o serviço
(troque `SEU_TOKEN_AQUI` pelo token real, sem `< >`):

```bash
curl -L -X POST \
  -H "Accept: application/vnd.github+json" \
  -H "Authorization: Bearer SEU_TOKEN_AQUI" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  https://api.github.com/repos/mateusraony/Sentinel-Signals/actions/workflows/scan.yml/dispatches \
  -d '{"ref":"main"}'
```

Uma resposta `204 No Content` confirma que o disparo foi aceito — a run
aparece em Actions → Scheduled scan em poucos segundos. `401` com
`"message": "Bad credentials"` é quase sempre o token errado/mal colado (ver
pegadinha acima) ou um token já revogado — nunca um problema no workflow em
si.
>
> **Se um token vazar** (por exemplo, colado sem querer num chat, print de
> tela ou log): revogue-o imediatamente em GitHub → Settings → Developer
> settings → Personal access tokens e gere um novo. Um fine-grained token
> escopado só a `Actions: read/write` de um único repositório é bem menos
> grave que vazar uma senha, mas ainda assim deve ser tratado como
> comprometido assim que exposto — não espere confirmar se foi "realmente"
> visto por alguém.

### 3. `schedule:` interno já reduzido para fallback (feito)

**Não manter os dois gatilhos a cada 5 minutos** — foi cogitado inicialmente,
mas a revisão automática do PR que introduziu este guia corretamente apontou
o problema: quando os dois disparam a cada 5min e ambos estão saudáveis, o
scan roda **~2x mais vezes por dia** (até 576 passadas em vez de 288) do que
o guard de quota do Firestore em `scanner.js` (`PASSES_PER_DAY`) assume — o
aviso de "perto do limite gratuito" ficaria cego a esse excesso justamente
quando ele acontece.

Depois de confirmar (o `curl`/teste manual do passo 2 deu `204`, e a própria
execução **agendada** do cron-job.org também rodou com sucesso — não só o
teste manual) que o disparo externo estava funcionando de forma confiável,
as duas edições abaixo foram feitas juntas, no mesmo PR, para não deixar o
sistema ao vivo rodando só 1x/hora achando que ainda roda a cada 5min:

1. `.github/workflows/scan.yml`: `cron: "*/5 * * * *"` → `cron: "0 * * * *"`
   (a cada hora) — vira só um fallback de baixa frequência; o disparo
   externo é o relógio principal.
2. `src/lib/scanner.js`: constante `PASSES_PER_DAY` do guard de quota
   ajustada de `288` para `312` (288 do disparo externo + 24 do fallback
   horário), para o aviso de quota continuar refletindo o volume real.

**Por que só depois de confirmar**: `scan.yml` roda a partir da branch
`main` assim que o merge acontece. Se a redução para 1x/hora fosse mergeada
ANTES do disparo externo estar de fato funcionando, o scan ao vivo cairia de
5min para 1h de cadência silenciosamente (sem erro, só sinal mais velho) até
alguém notar.

**O fallback horário NÃO garante recuperação em 30min.** Se o disparo externo
falhar logo depois de um fallback rodar, a próxima chance só vem em ~1h (mais
o drift já medido do `schedule:` — pode passar disso). O watchdog externo
(`HEALTHCHECKS_PING_URL`, `docs/known-risks.md` item 12) é quem detecta e
alerta a falta de scan dentro de ~30min — ele **avisa**, não faz o scan rodar
mais cedo. Não trate o fallback horário como rede de segurança de 30min; essa
função é do watchdog.

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

**Concluído.** O disparo externo (cron-job.org) está configurado e
confirmado funcionando pela própria execução agendada (não só o teste
manual), e o passo 3 acima (fallback horário do `schedule:` interno +
ajuste de `PASSES_PER_DAY`) já foi mergeado. A configuração do
cron-job.org em si é feita **fora do repositório** (conta pessoal do
usuário + um PAT pessoal) — não há nada para commitar além deste documento.
`docs/known-risks.md` item 18 registra a decisão e o dado real medido de
drift antes da correção.
