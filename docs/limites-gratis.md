# Orçamento dos limites grátis (o que pode estourar, quanto já usamos, quem avisa)

**Por que existe (pedido do usuário, 25/11/2026):** em 3 meses estouraram 3 cotas grátis diferentes — **Firestore (setembro)**, **Neon (outubro)** e **Render (novembro, `docs/known-risks.md` item 309)**.
O padrão é o mesmo nas três: o sistema trabalha por **cadência** (um scan a cada ~15 min, um ping a cada 10 min), então qualquer serviço cobrado por **tempo ligado**
ou por **quantidade de operações** vai chegando ao teto sem ninguém ver, até o dia em que para. Este arquivo é o orçamento de TODOS os limites, no mesmo lugar, para isso não depender de memória.

Fonte dos números: telas do próprio serviço (marcadas "tela") ou a documentação oficial (marcadas "doc"); o que eu só lembro de cabeça está marcado **"conferir"**. Estado medido em 25/11/2026.

## 1. Quadro geral

| Serviço | Limite grátis | Uso medido (25/11) | Risco | Quem avisa hoje | O que acontece se estourar |
|---|---|---|---|---|---|
| **Render — horas de instância** (workspace inteiro, mês de calendário) | **750 h/mês, dividido entre TODOS os serviços Web grátis do workspace** ([doc](https://render.com/docs/free); serviço dormindo não gasta) | **739,37 h (tela)** → **ESTOUROU** (suspenso até 01/12); causa: outros serviços ligados no workspace, agora suspensos | **Médio (era ALTO)** | `api-health-alert` (Telegram, queda/volta) desde 25/11. **Não há aviso de "você está em 80%".** | Todos os serviços Web grátis do workspace ficam **suspensos** até o 1º dia do mês seguinte; o painel fica sem dados |
| **Neon — computação** | **100 CU-h/mês por projeto** ([doc](https://neon.com/faqs/free-plan-limits-and-quotas)) | **57,9 CU-h (58%)**, projeção do mês 72,3 (medidor, 25/11) | Médio | `neon-usage.yml` (Telegram, 2×/dia; avisa em 60% e 80%) | O banco para de responder: scan cego (aconteceu em outubro, item 282) |
| **Neon — armazenamento** | 1 GB por projeto (doc, mudou de 0,5 GB; **conferir** no console) | ~70 MB em outubro (item 283); **conferir** hoje | Baixo | Nenhum automático | Escritas que aumentam o banco falham |
| **GitHub Actions** (repositório **público**) | Sem limite de minutos para runners padrão em repositório público (**conferir** a política atual) | ~197 min/dia de execução (3,3 h); repositório 10 MB; artefatos 5 MB | Baixo | — | — |
| **GitHub — agendamento** | `schedule:` é desligado após ~60 dias sem atividade no repositório (item 12 do known-risks) | Sempre há commits | Baixo | Watchdog `HEALTHCHECKS_PING_URL` (se o scan parar de bater, avisa) | O relógio de reserva (6 h) para; o de 15 min vem do cron-job.org |
| **Tokens do GitHub (PAT)** — o do cron-job.org e o `GITHUB_ACTIONS_TOKEN` do Render | **Expiram** (o GitHub exige uma data; máximo 1 ano) | **Data de expiração desconhecida** — só você vê, no GitHub | **Médio — bomba-relógio silenciosa** | Nenhum (o GitHub manda e-mail antes de expirar) | O scan de 15 min volta ao relógio de reserva de 6 h; o botão de backtest do painel para |
| **Firebase Spark** — Firestore | 50 mil leituras e 20 mil escritas por dia, 1 GiB ([doc](https://firebase.google.com/pricing)) | Os dados de negócio saíram do Firestore em 12/09; sobram `users/{uid}.role` e o backup diário | Baixo | `health-audit.yml` | O que estourou em setembro (item 142) |
| **Firebase Spark** — Realtime Database | 1 GB guardado, 10 GB/mês de download | O retrato do modo de observação é 1 nó pequeno por scan; **conferir** o uso no console | Baixo | Nenhum automático | O vigia sem banco para de gravar |
| **Binance (dados públicos)** | Limite de peso por IP; os runners do GitHub compartilham IPs | Cerca de 40 requisições por scan, peso baixo | Baixo | Retry com espera (`fetchWithRetry`) | 429/418 temporário: um scan perde um ativo |
| **Telegram (bot)** | ~30 mensagens/s no total e ~20/min por conversa (**conferir**) | Dezenas por dia | Muito baixo | — | Mensagem atrasada/recusada |
| **BLS / FRED / BEA (chaves grátis)** | BLS v2: ~500 consultas/dia com chave; FRED e BEA: ~100 por minuto (**conferir**) | 3 coletas por dia + janela de divulgação | Baixo | Sonda (`context-probe.yml`) | O Contexto de Mercado fica "indisponível" (nunca toca o motor) |
| **cron-job.org** (relógio externo do scan) | Plano grátis: até 60 execuções/hora por job (**conferir**) | 1 job a cada 15 min | Baixo | Watchdog do scan | O scan cai para o relógio de reserva de 6 h |
| **Render — banda / pipeline / serviços** | 5 GB / 500 min / 25 serviços (tela) | **482 MB / 74 min / 12 serviços (tela)** | Baixo | Nenhum automático | Cobrança ou bloqueio do excedente |

## 2. Por que o Render estourou — fato, hipótese, correção

- **Fato (tela do Billing):** 739,37 de 750 h; banda, pipeline e serviços folgados. O limite é **do workspace inteiro** (a própria tela diz "applies to the entire workspace") e as horas **são compartilhadas por todos os serviços Web grátis** ([doc do Render](https://render.com/docs/free)).
- **Fato (aritmética):** um serviço só ligado 24 h por dia soma no máximo 586 h até 25/11 (24 h × 24,4 dias). 739 h **não cabem em um serviço só**. Logo, **outro(s) serviço(s) Web grátis do mesmo workspace consumiu(ram) pelo menos ~150 h**.
- **Hipótese que eu fiz antes e que NÃO se sustenta:** "cada deploy sobrepõe instâncias e gasta horas". O painel do Render mostra que o `sentinel-signals-api` só foi implantado de novo **há 1 mês** (21 deploys no total), então deploys não explicam as horas. Corrigido no item 309.
- **CONFIRMADO pelo usuário (25/11):** havia **outros serviços Web grátis ligados no workspace** (inativos, mas rodando, então gastando horas do pool). Ele os **deixou suspensos: sobrou só o `sentinel-signals-api`**. Orçamento atual: um serviço; com o `keep-warm` em 16 h/dia (~480 h/mês) sobram ~270 h; ligado 24 h/dia (744 h em mês de 31 dias) sobrariam ~6 h, por isso a janela fica.
- **Reset:** no início do mês de calendário (**01/12**), pelas docs do Render.

**Feito:** (1) os outros serviços Web grátis foram suspensos pelo usuário; (2) a janela do `keep-warm` fica em 16 h/dia. **Regra daqui em diante:** nenhum outro serviço Web grátis fica ligado nesse workspace sem somar as horas (o pool é de todos).

## 3. As regras para não repetir (valem daqui em diante)

1. **Antes de criar qualquer rotina agendada, "ping" ou serviço sempre ligado, calcular o custo mensal contra CADA limite desta tabela** e escrevê-lo no PR. Cadência × 24 h × 30 dias é a conta que faltou nas três vezes.
2. **Cada limite tem dono e aviso.** Hoje só o Neon (medidor) e a queda do Render (alerta) avisam sozinhos. Os demais dependem do **roteiro mensal** abaixo.
3. **Alerta de 80%, não só de "caiu".** Onde a plataforma não expõe o uso por API (Render, GitHub PAT, Firebase), o aviso é o roteiro mensal do usuário.
4. **O motor não pode depender do servidor da API.** Já é verdade (o scan fala direto com o Postgres): o painel é que depende da API, e foi só ele que parou.
5. **Nada de upgrade pago** (decisão do usuário): a saída de cada limite é reduzir uso, nunca pagar.

## 4. Roteiro mensal (5 minutos, no dia 20 de cada mês — 3 telas)

1. **Render → menu do workspace → Billing → Monthly Included Usage:** "Free Instance Hours" deve estar abaixo de **~600 h no dia 20** (80% de 750 h). Passou? Suspenda/apague serviços Web grátis que não usa.
2. **Neon → console → Billing/Usage:** compare "Compute" com o último aviso do Telegram (o medidor só enxerga o GitHub). Acima de 70 CU-h no dia 20 → falar com o Claude para cortar cadência.
3. **GitHub → Settings → Developer settings → Personal access tokens:** olhe a coluna de expiração dos tokens. **Menos de 30 dias** → renovar e atualizar o cron-job.org e o Render (`GITHUB_ACTIONS_TOKEN`).

## 5. Pendências deste orçamento

- **Do usuário:** (a) listar os serviços do Render e dizer quais são Web grátis ligados; (b) olhar a data de expiração dos dois tokens do GitHub; (c) conferir o armazenamento do Neon e o uso do Realtime Database no console.
- **Do Claude (feito neste PR):** este orçamento, a correção do item 309 e a regra no `operating-principles.md`.
- **Não dá para automatizar com o que é grátis:** ler as horas do Render e a expiração dos tokens (não há API pública simples); por isso o roteiro mensal existe.
