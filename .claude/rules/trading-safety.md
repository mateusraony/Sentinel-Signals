---
description: Política de segurança de trading — read-only/virtual por padrão. Sempre relevante quando o assunto é ordem, execução, exchange ou posição.
---

# Política de trading — READ-ONLY por padrão

O Sentinel é um **painel de sinalização**. Estado padrão e permanente até uma
fase de segurança explícita e aprovada:

```
READ_ONLY=true
PAPER_TRADING=true
LIVE_EXECUTION=false
```

**Nenhuma** skill, ferramenta, MCP ou agente pode, sem pedido explícito do
usuário e uma fase de segurança própria:

- criar/cancelar ordem · alterar posição · transferir fundos · mudar
  alavancagem/margem · habilitar trading ao vivo.

Hoje TP/Stop são **virtuais** (só atualizam `TradeOperation` no Firestore); o
webhook `server/` e o cron **só logam/notificam**. Não copie código de execução
de terceiros (ex.: o bot `claude-tradingview-mcp-trading` auditado — long-only
hardcoded, sem stop, sem reconciliação, sem idempotência; `rules.json`
decorativo). Não conecte a conta real de exchange.

Qualquer futura execução real exigiria (pré-requisitos mínimos): chave **sem**
permissão de saque · whitelist de IP · subconta · teto de exposição · kill
switch · idempotency key · reconciliação com a exchange · confirmação de fill ·
stop confirmado na corretora · trilha de auditoria · paper/testnet · rollback ·
**aprovação humana**. Só marcar op como ativa após confirmar fill de entrada e
aceite do stop pela exchange.
