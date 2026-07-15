---
description: Princípios de engenharia do dia a dia neste repo (sempre válidos).
---

# Princípios operacionais (camada core)

Aplicam-se a toda tarefa neste repositório. Complementam o `~/.claude/CLAUDE.md`
global do usuário (ver `docs/claude/global-CLAUDE.md.example`).

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
