---
name: sentinel-release-gate
description: Portão de release/milestone do Sentinel — checklist de verificação por fase antes de concluir uma mudança grande, refatoração arquitetural ou entrega. Use em milestones, mudanças multi-arquivo ou antes de abrir PR de algo relevante. Não use para edições triviais.
---

# sentinel-release-gate

## Quando usar
Milestone, refatoração arquitetural, mudança multi-arquivo, ou antes de concluir/
abrir PR de algo não trivial. Substitui a necessidade de um orquestrador pesado
(GSD foi rejeitado) — combine com o plan mode.

## Quando NÃO usar
Correção de uma linha, ajuste de texto, tarefa isolada trivial.

## Arquivos relevantes
Depende da mudança; sempre `.claude/rules/*` do(s) domínio(s) tocado(s).

## Procedimento (portão por fase)
1. **Escopo**: a mudança é a menor que entrega o objetivo? Nada fora de escopo?
2. **Domínio**: rodar a(s) skill(s) relevante(s) (engine/pine/security/ui).
3. **Testes**: cobertura adequada rodou e passou? (Não afirmar sem rodar.)
4. **Docs**: `CLAUDE.md`/`README`/`known-risks` continuam verdadeiros? Atualizar
   sem duplicar (`.claude/rules/documentation-truth.md`).
5. **Segurança/trading**: nada de secret exposto; trading segue virtual.
6. **CI local**: `npm run lint && npm test && npm run build` verdes.
7. **Rollback**: como reverter (revert do PR) está claro.

## Critérios de sucesso
Todos os itens acima checados com evidência; fato/hipótese/recomendação separados
no resumo final.

## Testes obrigatórios
Os do(s) domínio(s) tocado(s).

## Limites de permissão
Não push/merge sem pedido explícito do usuário. Respeitar os hooks de proteção.
