---
description: Manter a documentação fiel ao código. Carregue ao editar CLAUDE.md, README ou docs.
paths:
  - CLAUDE.md
  - README.md
  - docs/**
---

# Verdade documental

Docs deste repo já divergiram do código (ex.: README descrevia auth email/senha e
Cloud Functions inexistentes; CLAUDE.md dizia que `server/` não estava deployado
e que `adminPineConfig` retornava defaults fixos). Regras:

- **Confronte com o código antes de afirmar.** Não empilhe instrução nova sobre
  base contraditória — corrija a contradição primeiro.
- **Sem redundância.** Cada fato num lugar canônico: decisões/índice no
  `CLAUDE.md`; detalhe por domínio em `.claude/rules/`; riscos em
  `docs/known-risks.md`; princípios universais no `~/.claude/CLAUDE.md` global.
  Não duplique — referencie.
- **`CLAUDE.md` abaixo de ~200 linhas.** Detalhe extenso vai para uma rule.
- **Preserve decisões intencionais** ao reescrever (auth anônima, Telegram
  client-side, Strategy Reviewer pausado, sem Base44/Vercel/Netlify/Blaze,
  trading virtual). Documente o estado real, não o desejado.
- A cada plano/rodada relevante, **atualize** o doc afetado em vez de criar um
  paralelo — mantenha fonte única.
