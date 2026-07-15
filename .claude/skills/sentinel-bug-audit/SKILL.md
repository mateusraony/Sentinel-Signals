---
name: sentinel-bug-audit
description: Depuração sistemática de bugs no Sentinel Signals — reproduzir antes de corrigir, teste de regressão, verificação final. Use quando o usuário relatar comportamento errado, exceção, resultado inesperado, "não funciona", regressão ou pedir para investigar/corrigir um bug. Não use para features novas, refatoração estética ou perguntas conceituais.
---

# sentinel-bug-audit

## Quando usar
Relato de bug, exceção, valor errado, regressão, "parou de funcionar".

## Quando NÃO usar
Feature nova, mudança puramente visual (use `sentinel-ui-review`), pergunta
conceitual, ou quando o "bug" é uma decisão intencional (checar `CLAUDE.md` /
`docs/known-risks.md` antes).

## Arquivos relevantes
`src/lib/scanner.js`, `src/lib/indicators/**`, `src/lib/logger.js` (SystemLog /
Debug Log), `docs/known-risks.md`, os testes em `src/lib/indicators/*.test.js`.

## Procedimento
1. **Reproduzir primeiro.** Isole o caso (candle/estado/entrada concreta). De
   preferência escreva um teste Vitest que **falha** demonstrando o bug.
2. **Localizar a causa** com evidência (`arquivo:linha`), sem adivinhar. Cheque o
   Debug Log (`SystemLog`) se for runtime.
3. **Confirmar que não é intencional** (`docs/known-risks.md`, decisões do
   `CLAUDE.md`).
4. **Corrigir cirurgicamente** — a menor mudança que resolve.
5. **Verificar**: o teste de regressão passa; `npm run lint && npm test && npm
   run build`.

## Critérios de sucesso
Bug reproduzido antes da correção · teste de regressão commitado (falhava, passa)
· causa explicada com `arquivo:linha` · lint/test/build verdes.

## Testes obrigatórios
Ao menos um teste que reproduz o bug. Se o bug é no motor, seguir também
`.claude/rules/testing.md` (estado/concorrência/temporalidade).

## Limites de permissão
Não habilitar trading real. Não editar `.env*`. Não fazer push/PR sem o usuário
pedir. Não refatorar fora do escopo do bug.
