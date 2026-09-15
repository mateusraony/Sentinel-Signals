---
description: Princípios de engenharia do dia a dia neste repo (sempre válidos).
---

# Princípios operacionais (camada core)

Aplicam-se a toda tarefa neste repositório. Complementam o `~/.claude/CLAUDE.md`
global do usuário (ver `docs/claude/global-CLAUDE.md.example`).

- **Pesquise a comunidade antes de planejar.** Toda tarefa não trivial (novo
  ticket, decisão de design, adoção de ferramenta, correção do motor) inclui
  uma etapa de pesquisa externa (Reddit, Stack Overflow, fóruns/documentação
  oficial, issues de projetos maduros) ANTES do plano — para validar armadilhas
  conhecidas e práticas consolidadas. Registre no plano/PR o que a pesquisa
  mudou na decisão (ou que não mudou nada, com fonte). Popularidade não é
  prova: priorize evidência técnica e docs oficiais.
- **Menor alteração, maior ganho verificável.** Prefira a mudança cirúrgica que
  resolve o problema; não refatore fora de escopo nem "melhore" de passagem.
- **Reuse antes de criar.** Este projeto já removeu muita dependência morta —
  procure a função/utilitário existente (ex.: adaptador `backend` em
  `src/api/entities.js`, `logInfo/logError` em `src/lib/logger.js`) antes de
  escrever algo novo.
- **Reproduza antes de corrigir.** Para bug, primeiro um teste (ou um caso
  concreto de candle/estado) que falha; depois a correção; depois a confirmação.
- **Verifique antes de concluir.** Rode `npm run lint && npm test && npm run
  build` para mudanças com superfície de runtime. Não afirme que algo passou sem
  ter rodado. Se pulou um passo, diga.
- **Revisão final obrigatória (pedido explícito do usuário, 2026-09-14).**
  Depois de qualquer execução/alteração/atualização, antes de dar por
  concluído: não basta rodar lint/test/build — revise explicitamente se nada
  quebrou em rotas/endpoints tocados (`server/routes/*.js`, workflows em
  `.github/workflows/*.yml`, scripts que viram job agendado) e em outras
  partes do sistema que consomem o que mudou (ex.: campo novo numa entidade —
  quem mais lê isso? Dashboard, Telegram, backtest, health-audit?). Vale para
  toda tarefa, não só motor de trading.
- **Passo manual de infra pendente = pedido explícito, não nota de rodapé
  (achado real, 2026-09-15, `docs/known-risks.md` item 179 addendum).**
  Código e migração de schema neste projeto não têm o mesmo timing de
  deploy (código: automático a cada push em `main`; schema Postgres:
  manual, via `db-migrate.yml`). Documentar um passo manual pendente no
  PR/plano e seguir em frente não é suficiente quando o código que já foi
  mesclado DEPENDE dele — isso já causou uma janela real de operações sem
  gestão (10 ativos, PR #364). Sempre que um passo manual for
  pré-requisito de código que já vai pro ar no merge (não um "quando
  puder"), peça explicitamente pro usuário executá-lo, e só considere a
  tarefa concluída depois de confirmar que ele rodou — mesma disciplina já
  usada pro secret `DATABASE_URL_READONLY` na mesma rodada, que por isso
  não teve o mesmo problema.
- **Fato × hipótese × recomendação.** Sempre separe o que você observou no
  código do que é plausível e do que é opinião. Sem "parece bom" — traga
  evidência (`arquivo:linha`).
- **Preserve decisões intencionais.** Auth anônima, Telegram client-side,
  Strategy Reviewer pausado, sem Base44, sem Vercel/Netlify, sem Cloud
  Functions/Blaze, trading virtual — são escolhas do usuário (ver `CLAUDE.md` e
  `docs/known-risks.md`). Não "corrija" sem pedido explícito.
- **Prioridade P0.** Não proponha novos indicadores/estratégias/execução real
  antes de resolver ou aceitar formalmente os riscos P0 do motor de trading
  (ver `.claude/rules/trading-engine.md`).
- **Nome que o usuário vê, não o interno.** Ao instruir o usuário sobre um
  campo de UI (ex.: `workflow_dispatch` do GitHub Actions, um input do
  painel), refira-se ao rótulo/label visível na tela — nunca ao nome
  técnico da chave/variável por trás dele. O usuário não é dev; peça e
  descreva os campos pelo texto que ele efetivamente lê.
- **Merge automático autorizado (2026-08-30, pedido explícito do usuário).**
  Em qualquer PR que você mesmo abriu neste repo: assim que a CI estiver
  verde E o PR estiver `mergeable_state: clean` (sem conflito, sem review
  bloqueando) E as threads de review que você endereçou estiverem
  resolvidas, pode mesclar direto — não espere um "pode dar merge" a cada
  vez. Continua exigindo confirmação explícita: qualquer coisa fora desse
  crivo (CI vermelho, conflito, review humano pedindo mudança ainda não
  atendida, PR que você não abriu) e ações destrutivas/irreversíveis em
  geral (force-push, `reset --hard`, deletar branch/dado).
