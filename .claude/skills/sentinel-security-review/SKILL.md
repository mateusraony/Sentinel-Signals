---
name: sentinel-security-review
description: Revisão de segurança para mudanças que tocam secrets, autorização Firestore, o server/webhook, execução ou permissões no Sentinel. Use ao alterar firestore.rules, server/**, telegram, .env, render.yaml, ou qualquer coisa com credencial/rede/execução. Não use para mudanças puramente visuais ou de cálculo.
---

# sentinel-security-review

## Quando usar
Mudança em `firestore.rules`, `server/`, webhook, Telegram, env, CORS,
dependências novas, ou qualquer superfície com secret/rede/execução.

## Quando NÃO usar
UI pura; cálculo de indicador (a menos que introduza rede/secret).

## Arquivos relevantes
`firestore.rules`, `server/index.js`, `src/lib/telegram.js`, `render.yaml`,
`.env.example`, `.claude/rules/security.md`, `.claude/rules/trading-safety.md`.

## Procedimento
1. **Menor privilégio**: a mudança pede só o acesso necessário?
2. **Blast radius**: o que quebra/vaza se isso falhar ou for abusado? Secret
   pode chegar ao client/bundle/log?
3. `firestore.rules`: sem `if true`; `role` não setável no client. Rodar/instruir
   `firebase deploy --only firestore:rules` (rules só valem após deploy).
4. Webhook/`server`: valida `WEBHOOK_SECRET`, CORS restrito, **nunca envia
   ordem**.
5. **Rollback** claro documentado.

## Critérios de sucesso
Nenhum secret no client/repo/log · autorização na regra, não no client · blast
radius entendido · rollback definido · trading permanece virtual.

## Testes obrigatórios
Se tocar rules, validar o comportamento esperado (permitir/negar). Se tocar
`server`, exercitar o endpoint com/sem secret.

## Limites de permissão
Não exponha caminho de promoção a admin. Não habilite execução real. Não commite
secrets. Não push/PR sem pedido.
