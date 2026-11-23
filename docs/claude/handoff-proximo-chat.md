# Prompt de continuação — o que falta fazer no Sentinel Signals (reescrito em 20/11/2026)

> **Como usar:** abra um chat novo no Claude Code **neste repositório** e cole **tudo abaixo da linha `=== COPIE DAQUI ===`**
> como a primeira mensagem. O que muda com o tempo (estado do roadmap, números do Neon) o chat novo deve reler nos arquivos
> citados, não confiar neste texto. Se este arquivo ficar velho, atualize-o no mesmo PR em que mudar o estado do que ele descreve.
> (A versão de 13/11 estava velha — descrevia como pendente a aba Trades e o Contexto 4b–5, hoje todos feitos.)

=== COPIE DAQUI ===

Você vai continuar o trabalho no repositório **Sentinel Signals** (painel de sinalização de trading cripto; **nenhuma ordem é
enviada à exchange — TP/Stop são virtuais**). Antes de qualquer coisa, leia, nesta ordem: `CLAUDE.md` (e os `CLAUDE.md`
aninhados das pastas em que for mexer), `.claude/rules/operating-principles.md`, `.claude/rules/trading-safety.md`,
`docs/roadmap.md` ("Prioridades de hoje") e o item **285** de `docs/known-risks.md` (addenda 38–43, os mais recentes).
Depois responda com um resumo curto do que entendeu e **espere o meu "pode seguir"** antes de codar.

## 1. Quem sou eu e como trabalhar comigo

- Falo português, **não sou desenvolvedor**: linguagem simples, direta, profissional; aprofunde só quando ajudar a decidir.
  Ao me pedir qualquer ação na tela, use o **rótulo visível** (o texto do botão/campo), nunca o nome técnico interno.
- **Seja honesto e crítico**: separe fato (com `arquivo:linha`), hipótese e recomendação. Não valide minhas ideias
  automaticamente; traga riscos e contrapontos. Se não tiver certeza, diga. Se tiver dúvida, **pergunte** (poucas perguntas,
  cada uma com recomendação).
- **Tudo gratuito** (GitHub, Render free, Neon free, APIs públicas). Nada que exija cartão. **Não reintroduzir Base44**,
  Vercel/Netlify, Cloud Functions/Blaze. **Não habilitar trading real.** **Não alterar o que funciona sem necessidade
  demonstrada.** Dados no painel têm que ser **reais e automáticos** — nada estático, de exemplo ou fake em produção
  (imagens de teste com dados de exemplo são só para eu aprovar o visual e **nunca vão para o repositório**).
- **Segredos nunca no chat** (a chave da BEA só como segredo do GitHub). O repositório e os logs do Actions são **públicos**:
  só contagens/percentuais, nunca símbolo, preço ou resultado de operação.
- **Mudança visual**: gere imagens (computador e celular, harness local não commitado) e **espere meu "aprovado" explícito**
  antes de mesclar. **Mudança sem visual**: pode mesclar sozinho com CI verde, PR `clean` e threads resolvidas. Ação
  destrutiva/irreversível: peça confirmação.
- Disciplina de engenharia: pesquisar antes de planejar, teste primeiro, **mutações plantadas para toda regra nova**, gate
  completo (`npm run lint`, `npm test` com Postgres local, `npm run build`, `npm run typecheck:ratchet` — teto 13, só desce),
  **revisão final de impacto**, e documentar em `docs/known-risks.md` + `docs/roadmap.md` no mesmo PR. Passo manual de infra
  que meu lado precisa fazer = **pedido explícito**; a tarefa só fecha depois que eu confirmar.
- Git: o branch de trabalho é o que a sessão indicar; depois de cada merge (squash) reinicie de `origin/main` com
  `git merge -s ours` da remota + `git reset --hard origin/main`, **sem force-push**. Hooks bloqueiam `rm -rf` com variável e
  comando que misture `push` e a palavra `main` — **não contorne**: separe os comandos. Teste de banco precisa do Postgres
  local (`pg_ctlcluster 16 main start`; role `neondb_owner` / banco `neondb`, senha do CI em `.github/workflows/ci.yml`).

## 2. O que já está pronto (não refazer)

- **Neon/continuidade:** scan a 15 min, retenção de `system_logs`, medidor de uso (calibrado), recuperação depois da queda
  (item 288), **modo de observação O1+O2** (retrato no RTDB + vigia de stop/alvo; **ensaio rodado por mim em 12/11, sucesso**),
  painel que só consulta o banco com a aba visível (item 301). Itens 282/283/286/288/294/298/299/300/301.
- **Aba Trades** (cartão, resumo do topo, filtros, linha do histórico — itens 302–305) e **Raio-X de UI/UX** (todos os
  críticos, Alta e Média corrigidos — `docs/claude/ui-audit-criticos.md`). Cores de hover padronizadas (guarda `hoverColors.test.js`).
- **Contexto de Mercado (itens 284/285), Fases 1–5 completas**, só informativas (nunca tocam motor/score, sem Neon):
  coletor 3x/dia pelo fim do scan, faixa "Agenda de eventos dos EUA" (CPI/Payroll/PPI/PCE/FOMC), números oficiais do BLS e da
  BEA (**PCE na tela em 2 cartões, cheio e núcleo**), "como o BTC reagiu antes", aviso 1 h antes e aviso de depois no
  Telegram, projeção que eu registro, resumo do dia às 21h, datas do FOMC lidas no site do Fed (2027 conferido, addendum 43),
  **faixa-alvo dos juros do NY Fed como "Anterior" do FOMC** (só no aviso; nunca gravada na branch pública) e o **selo "Aberta
  durante o CPI (10/11)"** nas abas Trades e Histórico (portão medido: 28,8% das operações, ≤30%).
- Relatório diário EMA+Supertrend no Telegram (itens 271–275), `neon-usage.yml`, `health-audit.yml`, backups.

## 3. O que falta (nada urgente; em ordem)

**A. Só o tempo resolve — conferir quando chegar a data (mensagem/tela reais):**
1. **25/11/2026 ~09:30 de Brasília:** primeiro **PCE real** — aviso de antes no Telegram, tela com os 2 cartões, aviso de depois.
2. **09/12/2026 ~15h de Brasília:** primeiro **FOMC com a faixa do NY Fed** no aviso (faixa-alvo, taxa efetiva e a atribuição dos
   termos de uso). O alerta nunca grava a taxa na branch pública.
3. **A partir de 17/10/2028 (UTC):** teste agendado da regra diária em tempo novo (item 274; o workflow recusa antes).

**B. Pequeno, sem data apertada (posso fazer quando eu pedir):**
4. **Reunião de 27/10/2027 é "só de estratégia" (sem decisão de juros):** o coletor a trata como FOMC normal. Antes de outubro de
   2027, marcá-la para não gerar aviso de "decisão" com "Anterior" (confirmar no comunicado do Fed). Item 285, addendum 43.
5. **Termos do NY Fed da API:** a busca só confirma que os Termos de Uso gerais valem também para a API; o texto literal não foi
   lido (a página não abre na rede da sessão). Uso atual é ~8 leituras/ano.
6. **Neon:** reler o console (Overview → Usage) ~1x por semana e comparar com o medidor (que só vê o GitHub); só mexer se os
   números mostrarem necessidade.
7. **Investigar os `warn` ruidosos do `system_logs`** (item 298): confirmar os números nos logs antes de citar.

**C. Depende de decisão minha (pergunte-me antes; não faça por conta própria):**
0. **Visual do painel (roadmap, linha 9):** direção APROVADA em 21/11. Entregue em 2 PRs: **PR 1 (visual global: cores, painéis planos, fonte IBM Plex)** e **PR 2 (estrutura: régua no cartão, Resumo, alertas em cartões, Desempenho reorganizado)**.
   **Falta só decisão minha: EMOJIS** — o item 280 manda melhorar, não remover, e há testes protegendo o vocabulário (o Telegram usa o mesmo); os mockups aprovados mostravam a tela sem emojis, então pergunte-me se quero tirar do Dashboard.
   **Comparar** (pedido de 21/11) virou gaveta lateral (`CompareDrawer`) — antes abria no meio da página e obrigava a rolar.
   **Aba Trades** (pedido de 21/11) recebeu o mesmo visual (cartões planos de larguras diferentes, títulos com marcador, texto mínimo de 11 px, tom quente uniforme) sem mover nem remover nada aprovado; `MetricSummaryCard` tem o modo `flat` (opt-in). Aguardava o "pode mesclar".
   **Regra do usuário (21/11): ao mostrar/entregar mudança visual, abrir TODOS os estados escondidos** (histórico recolhido, detalhes técnicos, observações, janelas, celular) — ver `.claude/rules/operating-principles.md`. Na aba Trades isso já foi feito e corrigido (título "Horários", azul das observações, cantos).
   **Outras páginas:** Histórico foi refeito com estrutura nova (21/11) — a 1ª tentativa só mudou cor/tamanho e o usuário percebeu: **em cada página, mexer na ESTRUTURA (ordem, agrupamento, colunas, redundância), não só na pele**. Verificação foi mesclada; Ativos mesclado; Alertas mesclado; Ajustes mesclado; Logs refeito (PR aberto; a 1ª versão só reorganizava e o usuário pediu mais entendimento — agora tem resumo de saúde, problemas agrupados, gráfico de 24 h, legenda e "o que significa/o que fazer" por linha, em `src/lib/logInsights.js`; **lição: além de mudar a estrutura, a página precisa ajudar a entender o dado**). Logs mesclado (#614). Pine Script refeito (PR aberto; `src/lib/pineInputs.js` mostra o que o Sentinel lê do código × o que vale só no TradingView). Pine Script mesclado (#615). Backtest refeito (PR aberto; `src/lib/backtestInsights.js` lê o relatório em português, e o Aplicar ao Scanner mostra o que muda). Backtest mesclado (#616). Ajuste Fino (What-If) aprofundado a pedido do usuário (PR aberto): motor auditado (item 306 do known-risks; 3 divergências corrigidas, o que o simulador NÃO faz está declarado na tela), recálculo automático, histórico de testes e análise visual — `src/lib/whatIf.js` + `src/components/backtest/whatif/`. What-If mesclado (#617). Regime/time stop dentro do simulador (padrão = produção) e "Reavaliar nos dados atuais" feitos em PR aberto (item 306, addendum 23/11); falta modelar trailing pré-TP1/runner/4h-15m/minRR se o usuário pedir. Próxima: Relatório mensal. Cada uma: abrir todos os estados escondidos (cartões, recolhidos, vazio, celular), mostrar antes/depois, só mesclar com o "pode mesclar".
   Pendência pequena: bloco do Desempenho sem dados some e a coluna pode ficar com buraco. Como mostrar antes/depois: Playwright + Vite com `backend`, `useAuth` e o provedor de preços simulados (tudo fora do repositório).
8. **Aba Trades:** mostrar o lucro em **USDT** (precisa da minha banca) e a **linha do tempo completa do stop** (exige mudança
   no motor: skills `sentinel-trading-engine-review` + `sentinel-state-machine-test`, plano e minha aprovação).
9. **Contexto, Fase 6 (opcionais):** on-chain, notícias por RSS, horário silencioso. Só se eu pedir.
10. **Modo de observação O3** (motor completo em memória): só com dado de uma queda real do banco.
11. **Teste de restauração do backup** (`restore-postgres.yml`): nunca rodou (precisa de um Supabase meu).
12. **Paridade Pine "padrão-ouro"** (CSV oficial do TradingView): exige plano pago meu — fora do escopo gratuito.

**D. Travado de propósito (não mexer sem pedido):** Bloco 1 (flags dormentes) e o eixo "estratégia/amostra" — a entrada não
tem vantagem comprovada (itens 264/265); Futures/funding (451 de datacenter US); execução real; Strategy Reviewer pausado.

## 4. Primeira resposta que espero de você

1. Resumo (≤ 15 linhas) do que entendeu e do estado atual (releia `docs/roadmap.md`; se algo aqui estiver velho, diga).
2. Qual item da seção 3 você recomenda atacar primeiro e por quê, e as perguntas que tiver (poucas, com recomendação).
3. Só depois do meu "pode seguir" comece a implementar.

=== FIM DO PROMPT ===
