# Prompt de continuação — o que falta fazer no Sentinel Signals (escrito em 13/11/2026)

> **Como usar:** abra um chat novo no Claude Code **neste repositório** e cole **tudo abaixo da linha `=== COPIE DAQUI ===`**
> como a primeira mensagem. Ele foi escrito para ser autossuficiente; o que muda com o tempo (estado do roadmap, números do
> Neon) o chat novo deve reler nos arquivos citados, não confiar neste texto. Se este arquivo ficar velho, atualize-o no mesmo
> PR em que mudar o estado do que ele descreve.

=== COPIE DAQUI ===

Você vai continuar o trabalho no repositório **Sentinel Signals** (painel de sinalização de trading cripto; **nenhuma ordem é
enviada à exchange — TP/Stop são virtuais**). Antes de qualquer coisa, leia, nesta ordem: `CLAUDE.md` (e os `CLAUDE.md`
aninhados das pastas em que for mexer), `.claude/rules/operating-principles.md`, `.claude/rules/trading-safety.md`,
`docs/roadmap.md` ("Prioridades de hoje") e os itens **300, 301 e 302** de `docs/known-risks.md`. Depois responda com um resumo
curto do que entendeu e **espere o meu "pode seguir"** antes de codar.

## 1. Quem sou eu e como trabalhar comigo

- Falo português, **não sou desenvolvedor**: linguagem simples, direta, profissional; aprofunde só quando ajudar a decidir.
  Ao me pedir qualquer ação na tela, use o **rótulo visível** (o texto do botão/campo), nunca o nome técnico interno.
- **Seja honesto e crítico**: separe fato (com `arquivo:linha`), hipótese e recomendação. Não valide minhas ideias
  automaticamente; traga riscos e contrapontos. Se não tiver certeza, diga. Se tiver dúvida, **pergunte** (poucas perguntas,
  cada uma com recomendação).
- **Tudo gratuito** (GitHub, Render free, Neon free, APIs públicas). Nada que exija cartão. **Não reintroduzir Base44**,
  Vercel/Netlify, Cloud Functions/Blaze. **Não habilitar trading real.** **Não alterar o que funciona sem necessidade
  demonstrada.** Dados no painel têm que ser **reais e automáticos** — nada estático, de exemplo ou fake em produção
  (imagens de teste feitas com dados de exemplo são só para eu aprovar o visual e **nunca vão para o repositório**).
- **Mudança visual**: gere imagens (computador e celular, harness local não commitado), mande para mim e **espere meu
  "aprovado" explícito** antes de mesclar. **Mudança sem visual**: pode mesclar sozinho quando o CI estiver verde, o PR
  `clean` e as threads resolvidas. Ação destrutiva/irreversível: peça confirmação.
- Disciplina de engenharia deste projeto: pesquisar antes de planejar (registrar o que mudou na decisão), teste primeiro,
  **mutações plantadas para toda regra nova** (o teste tem que falhar com o defeito), gate completo
  (`npm run lint`, `npm test` com Postgres local, `npm run build`, `npm run typecheck:ratchet` — teto 13, só desce),
  **revisão final de impacto** (rotas, workflows e quem mais consome o que mudou) e documentar em `docs/known-risks.md`
  (item novo) + `docs/roadmap.md`. Passo manual de infra que meu lado precisa fazer = **pedido explícito**, e a tarefa só
  fecha depois que eu confirmar.
- Ambiente: o branch de trabalho é `claude/compassionate-faraday-hiccbu` (reiniciar de `origin/main` + `git merge -s ours`
  da remota depois de cada merge, **sem force-push**). Os hooks de proteção bloqueiam `rm -rf` com variável e qualquer comando
  que misture `push` e a palavra `main` — **não contorne**: separe os comandos. Teste de banco precisa do Postgres local
  (`pg_ctlcluster 16 main start`; role `neondb_owner` / banco `neondb`, senha do CI em `.github/workflows/ci.yml`).

## 2. O que já está pronto (não refazer)

- Neon: scan a 15 min, retenção de `system_logs`, medidor de uso, **modo de observação** (O1 retrato no RTDB + O2 vigia de
  stop/alvo quando o banco estoura a cota, com ensaio manual) — itens 286, 294, 298, 299.
- **Item 301 (mesclado em 12–13/11, PR #575, aprovado por mim):** com a aba **visível** as telas que leem o banco atualizam a
  cada **30 min**; com a aba **escondida/fechada** nada consulta o banco; com **operação ativa** o acompanhamento de stop/alvo
  a cada **2 min** continua; sem operação ativa só se pergunta se surgiu uma a cada 30 min; chip pequeno **"Atualizado às
  HH:MM:SS"** no canto inferior esquerdo (última leitura bem-sucedida do banco, `src/lib/dbReadClock.js`). Custo no Neon é
  **estimativa não medida** — confira o console do Neon antes de mexer de novo.
- **Medidor do Neon calibrado** (variáveis `NEON_BASELINE_CU_HOURS`=26.72 e `NEON_BASELINE_AT`=2026-11-12T15:50:00Z já
  criadas por mim; execução manual de 13/11 verde: **27,7 de 100 CU-h (28%)**, projeção do mês ~72,3 CU-h — é um **mínimo**
  (só vê o GitHub; o painel e o Render não entram)).
- Contexto de Mercado **Fases 1–3** (sonda, coletor de datas na branch pública `context-data`, faixa "Agenda de eventos dos
  EUA" no Dashboard com Anterior/Atual/Revisado do BLS, "Últimas divulgações", "como o BTC reagiu antes") e **Fase 4a** (botão
  manual "Aviso do Contexto no Telegram", sem banco, nada automático) — itens 284/285.
- Recuperação depois da queda do banco (item 288), Histórico H1–H3, cores dos cartões do Dashboard (277), logo dos tokens.

## 3. O que falta — em ordem de prioridade (confirme a ordem comigo antes de começar)

### A. Aba **Trades**: tornar o cartão da operação entendível "de bater o olho" (pedido meu de 13/11) — **começar por aqui**

> **Estado em 13/11/2026 (item 303 de `docs/known-risks.md`):** o **cartão já foi implementado** (hora de abertura, trilha com
> nomes e faixas, "se bater no stop fecha com +X% (+Y R)", "a história até agora", motivos explicados; só tela, motor intocado)
> e está num PR **aguardando o meu "aprovado" do visual** e a minha escolha da orientação da trilha na venda (lucro à direita ×
> eixo de preço). Respostas que já dei: lucro em **% e R** (USDT depois); **só o cartão agora**, e a lista/filtros/resumo do topo
> num **segundo PR**. Não refaça o que está abaixo: leia o item 303 e o roadmap (linha 7) e continue de onde parou. Ordem
> combinada: **C → A → B → D**.

Minha mensagem original (resumida fielmente): *"hoje tem essa operação (QNT/USDT, SELL, ativa), porém tem coisas que ficam
confusas. Na aba Trades dá para entender de alguma forma que já está no 0 a 0 se a operação voltar e fechar, mas fica confuso
saber em que horário foi aberta. O gráfico (a barra) também me deixa confuso: não consigo bater o olho e entender o que está
acontecendo e para onde está indo. Sei que elevou o stop, mas não entendo, nessa barra, o que aconteceu, onde aconteceu, o que
já tem garantido ou o que garante se fechar nesse novo stop de proteção. Os 'motivos' também estão muito simples: só valores e
o que querem dizer; para quem não entende fica confuso, dá para melhorar muito essa parte e a aba toda."*

Fatos já levantados (detalhe e `arquivo:linha` no **item 302** de `docs/known-risks.md`; **releia o código, não confie só
neste resumo**): o cartão é `src/components/dashboard/TradeCard.jsx` (usado por `src/pages/Trades.jsx`).
1. **Horário de abertura confuso:** o "aberta 10/11 16:57" é um texto de 9 px com 25% de opacidade; embaixo, em "Detalhes
   técnicos", aparece **outro** intervalo ("10/11 09:00 → 10/11 12:59 BRT") que é a **vela de sinal de 4 h**, ao lado de
   **"✅ Fechado"** (= a vela fechou) **numa operação "Ativa"** — leitura contraditória. O "15M" no título é o timeframe da
   entrada, não o do sinal (4H).
2. **A barra** (`LevelRail`, `TradeCard.jsx:124`): fina (6 px, `h-1.5`), com o TP1 e a entrada marcados por traços de 1 px e a
   "agulha" do preço de 3 px; nenhum nome escrito em cima dela. A zona **rosa (stop↔entrada) é pintada sempre**, mesmo quando o
   stop já passou da entrada e aquela faixa é **lucro garantido**: ela se sobrepõe ao verde (entrada↔TP2) e vira uma faixa
   olivácea/cinza (é a que aparece na ponta direita da barra no print — **inferência pela leitura do código + imagem; confirme
   renderizando**). Numa **venda** a ordem fica invertida de propósito (menor preço à esquerda: TP2 à esquerda, entrada à direita,
   `orderLevelsByRail`, `priceProximity.js:231`), sem nenhum aviso na tela. A trilha também **não mostra onde o stop estava
   antes** nem **quando** subiu.
3. **O que está garantido:** neste caso o stop (171,60) já está **além da entrada** (180,56 numa venda) — fechar nele dá
   **+4,96% bruto** (antes de taxas), ~+0,5 R (inferência: R ≈ 20,33 / 1,08 ≈ 18,8; **confirme com o `initial_stop` da
   operação**). O cartão só diz "Stop 🔒" e "Proteção aumentada — o preço avançou o suficiente para a trilha elevar o stop";
   nunca diz **quanto** está garantido.
4. **"Medido: movimento favorável 20.3300, gatilho da trilha em 5.6857. Stop foi de 172.00 para 171.60"** é jargão (unidades de
   ATR/preço) — só o motor entende. **Motivos técnicos** (`op.signal_reasons`) são frases soltas com pontos ("Follow-through
   confirmado (+25)", "MACD hist negativo (+20)") sem explicar o que cada coisa significa nem por que pesa.
5. **O que o motor já grava sobre o stop (verificado no código) e o que falta:** existem `current_stop` (valor final),
   `initial_stop`, `mfe_r`/`mae_r`/`bars_to_*`, e `pre_tp1_stop_advanced_at` + `pre_tp1_stop_advanced_candle_time` (hora e vela
   da **última** subida; no modo trailing são **sobrescritos a cada avanço**, `scanner.js:4266-4274`). O `decision_snapshot`
   (`buildPreTp1TrailingSnapshot`, `decisionSnapshot.js:185`) traz `stop_before`/`stop_after` da **última avaliação persistida**, e
   é dele que vem o "Medido… Stop foi de 172.00 para 171.60" (`decisionExplanation.js:344-355`) — **mas ele é regravado a cada
   avaliação que persiste** (ex.: uma vela nova que só muda MFE/MAE, `scanner.js:4241-4247` e `4450-4453`), e então vira
   `pre_tp1_trailing_dormant` com `stop_before == stop_after`: **o valor anterior da subida se perde**. Portanto: o "de A para B,
   com hora" **só dá para mostrar enquanto o snapshot ainda é `pre_tp1_trailing_advanced`** (caso do print); nos outros casos
   mostre apenas o que sobra (hora/vela da última subida, stop inicial e stop atual, sem inventar o valor intermediário).
   **Não existe o histórico** das subidas nem o primeiro stop protetor: uma "linha do tempo do stop" completa exigiria **gravar
   algo novo = mudança no motor** (outra skill: `sentinel-trading-engine-review` + `sentinel-state-machine-test`), com plano e a
   minha aprovação. Dá para entregar **já**, sem mexer no motor: entrada (hora real), stop inicial, stop atual, hora da última
   subida e **o que está garantido agora**; o "de A para B" entra como bônus quando o snapshot ainda o registra.

O que eu quero como resultado (direção, não especificação fechada — **proponha com imagens antes de codar**): um cartão em
que, em 5 segundos, eu entenda (a) **quando abriu** (data/hora de Brasília, legível e uma vez só, sem "Fechado" enganoso),
(b) **onde o preço está e para onde vai** (uma trilha legível, com os nomes escritos, o stop antigo e o novo, e a zona
"garantida"), (c) **o que já está garantido se bater no stop** (em % e em R, com a frase "se fechar no stop você sai com
+X% bruto"), (d) **o que aconteceu** (linha do tempo curta: entrou → preço andou → stop subiu; o "de A para B" só quando o snapshot ainda o registra, o histórico completo só se eu aprovar a mudança no motor), (e) **por que
entrou**, em português simples, com cada motivo explicado ("o que é", "por que importa") e sem inventar probabilidade. Reuse
os módulos existentes (`rrGeometry`, `describeProximity`, `nextMilestone`, `stopPosture`, `explainOperationDecision`,
`eventTimeline`, `emojiRegistry`) e **o Histórico (H1–H3, PRs #543–#545) já tem a "história do trade"** — reaproveite o estilo
em vez de criar outro. Cuidados: `TradeCard.test.jsx` e `Trades.test.jsx` travam textos; emoji novo exige
`src/lib/emojiRegistry.js` + `docs/notification-vocabulary.md`; **nada de lógica de negócio nesta tarefa** (skill
`sentinel-ui-review`); dados 100% reais.

Perguntas que o chat novo deve me fazer **antes** de desenhar: (1) mostrar o lucro garantido só em % ou também em USDT (preciso
informar a banca?); (2) a aba Trades inteira (lista, filtros, resumo do topo) entra neste pacote ou só o cartão? (3) posso
ver o cartão de uma operação **fechada** e de uma **de compra** para o mesmo desenho servir nos dois lados?

### B. **Contexto de Mercado — Fases 4b, 4c, 5 e 6** (itens 284/285; só informativas, **nunca tocam motor/score, sem Neon**)

Estado: Fases 1–3 e 4a feitas. Pendências, na ordem do plano:
1. **Jobs do coletor no cron-job.org** (ver seção C — **passo meu**). Sem eles o coletor só roda no `schedule` do GitHub, que
   atrasa horas; o critério "**2 semanas só coletando**" (≥ 95% das 42 coletas, 0 push perdido, 0 acesso ao Neon) não começa
   de forma confiável. Depois disso, medir o critério (ler `status.json` da branch `context-data`) e só então liberar a 4b.
2. **4b — avisos automáticos de evento** no Telegram (a regra aprovada: os 3 resumos 07h/12h/21h BRT **e** avisos de evento,
   com chave liga/desliga por categoria; risco registrado de excesso de mensagens — comece com o mínimo e me mostre). Reaproveite
   `context-notify.yml` (4a) e o vocabulário de `docs/notification-vocabulary.md`. **Sem `DATABASE_URL`** no workflow
   (`adminTelegram.js` grava `SystemLog` no banco quando o envio falha — usar o remetente sem banco).
3. **4c — resumos 07h/12h/21h** = fatos + "leitura possível" em texto de modelo **rotulado como hipótese** (sem IA generativa;
   **nada de probabilidade nem direção**; regra do item 285 add. 5: "profissional = tamanho do movimento, não direção").
4. **5 — marcador "aberta durante <evento>" no Histórico**: só se o portão passar (≤ 30% das operações marcadas, medido
   retroativamente com as ~344 operações do backtest + datas passadas). Calculado no navegador (`contextOverlap.js`), **sem
   mexer em `TradeOperation`/Neon**; correlação, nunca causa.
5. **6 — opcionais** (on-chain, notícias RSS, horário silencioso — este último não existe no código): só se eu pedir.
6. Também aberto no item 285: o "valor estimado/previsão" **só** se achar fonte gratuita **com licença**; senão a faixa fica
   "Anterior × Atual".

### C. Os **3 jobs no cron-job.org** do coletor de contexto (**passo manual meu — peça-me explicitamente e confirme antes de fechar**)

Roteiro exato em `docs/claude/external-cron-setup.md` (seção "Coletor de contexto (Fase 2)"). Resumo: criar 3 jobs iguais ao do
scan (mesmo token, mesmos 4 cabeçalhos, corpo `{"ref":"main"}`), trocando só a URL
(`https://api.github.com/repos/mateusraony/Sentinel-Signals/actions/workflows/context-collect.yml/dispatches`) e o horário
(UTC): `0 10 * * *`, `0 15 * * *`, `0 0 * * *` (= 07h, 12h, 21h de Brasília). Antes, rodar o coletor 1 vez à mão
(Actions → **Coletor de contexto — datas dos eventos** → Run workflow). **Não** criar o 4º job "janela" (opcional; o próprio
coletor já dispara a janela no fim de cada "Scheduled scan" — os dois ligados dobram os disparos). Quando eu disser que criei,
confira nos logs do Actions que os disparos chegaram nos horários certos (use `mcp__github__actions_list`).

### D. Neon e custo (acompanhar, não "otimizar por otimizar")

Depois do item 301, confirme no **console do Neon** (Overview → Usage; eu mando print) se o consumo por dia caiu como o
estimado (~3,6 → ~1 CU-h/dia por aba esquecida — **hipótese**). O medidor do GitHub subestima (não vê painel/Render). Só mexa
em novo corte se os números mostrarem necessidade; qualquer mudança no ritmo do painel precisa da minha aprovação (já mudei de
ideia duas vezes sobre isso no item 301 — leia o texto antes).

### E. Pendências menores / opcionais (só se eu pedir ou se sobrar espaço)

- Conferir o selo ♻️ "Recuperada" no Histórico (passo meu, item 288) e rodar uma vez o botão "Aviso do Contexto no Telegram"
  (4a) para provar o envio real.
- **O3** do modo de observação (item 299): só com dados reais de uma queda; opcional: alinhar o horário do alerta de exemplo do
  ensaio do vigia (cosmético, observado em 12/11; ver item 299 add. 6).
- Investigar os `warn` ruidosos do `system_logs` (a retenção de 12/11 apagou dezenas de milhares; a maioria era `warn` repetido) — item pequeno, ver item 298; **confirme os números nos logs antes de citar**.
- Teste de **restauração do backup** (`restore-postgres.yml`) **nunca foi rodado** (item 288/roadmap linha 3).
- Dívida de tipos: `typecheck:ratchet` em 13 (só pode descer).

## 4. Primeira resposta que espero de você

1. Resumo (≤ 15 linhas) do que entendeu e do estado atual (releia `docs/roadmap.md`; se algo aqui estiver velho, diga).
2. A ordem que você recomenda (eu sugiro A → C → B → D) e **as perguntas da seção A** (e qualquer dúvida sua).
3. Para a tarefa A: um plano curto (sem código) com **o que você vai pesquisar antes**, quais arquivos vai tocar, quais dados já
   existem e quais faltam, e **como vai me mostrar o resultado** (imagens de computador e celular). Só depois do meu "pode
   seguir" comece a implementar.

=== FIM DO PROMPT ===
