---
name: sentinel-memory-hygiene
description: Higiene de memória/contexto do Sentinel — o que pode ou não ser lembrado/registrado entre sessões, mantendo secrets fora. Use ao decidir o que persistir em memória, ao revisar o que foi capturado, ou ao configurar memória. A memória nativa do Claude Code é a escolha (claude-mem foi rejeitado por capturar ambiente de secrets).
---

# sentinel-memory-hygiene

## Contexto
claude-mem foi **rejeitado** para este repo: seus hooks capturam todo prompt/tool
e podem persistir `.env`/tokens/service accounts em SQLite/Chroma (e, com sync,
em cmem.ai), além de passar tudo por um LLM de compressão. Aqui usamos a
**memória nativa** do Claude Code + estes cuidados.

## Quando usar
Ao decidir o que registrar entre sessões, revisar memória, ou se alguém propuser
uma ferramenta de memória.

## Regras
- **Nunca** persista em memória: chaves de API, `TELEGRAM_BOT_TOKEN`,
  `FIREBASE_SERVICE_ACCOUNT_JSON`, `WEBHOOK_SECRET`, conteúdo de `.env*`, valores
  de service account, IDs de chat privados.
- Persista só **fatos de projeto duráveis e não sensíveis** (decisões
  arquiteturais, convenções) — e mesmo esses preferencialmente vivem em
  `CLAUDE.md`/`.claude/rules/`, não em memória volátil.
- Se for avaliar uma ferramenta de memória externa: só em ambiente descartável,
  cloud sync OFF, sem credenciais reais, com rollback/desinstalação documentados
  antes de instalar.
- Ordem de consulta histórica: `CLAUDE.md` → `.claude/rules/` → memória nativa.

## Critérios de sucesso
Nenhum secret em memória; conhecimento durável está versionado no repo, não só na
memória; qualquer piloto de ferramenta externa é isolado e reversível.

## Limites de permissão
Não instalar ferramenta de memória de terceiros neste repo/ambiente. Não sincronizar
dados para nuvem externa.
