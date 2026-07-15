---
name: sentinel-ui-review
description: Revisão de UI/UX de páginas e componentes React/shadcn do Sentinel — layout, responsividade, acessibilidade, hierarquia visual, gráficos, design system. Use em tarefas visuais em src/pages/** e src/components/**. Nunca altere lógica de trading/backend numa tarefa de UI.
---

# sentinel-ui-review

## Quando usar
Layout, componente, responsividade, acessibilidade, gráfico, hierarquia visual,
consistência de design.

## Quando NÃO usar
Qualquer coisa que mude lógica de trading, scanner, Firestore ou regra de
negócio — pare e trate como tarefa separada.

## Arquivos relevantes
`src/pages/**`, `src/components/**`, `src/components/ui/**` (shadcn),
`tailwind.config.js`, `.claude/rules/frontend-ui.md`.

## Procedimento
1. Confirmar escopo **só visual**. Não tocar dados/negócio.
2. Reusar componentes shadcn existentes; não trazer lib de UI nova sem uso real.
3. Checar responsividade (mobile→desktop), contraste/acessibilidade (labels,
   foco, aria), estados vazio/erro/carregando, hierarquia e consistência.
4. Dados via TanStack Query + adaptador `backend`, nunca Firestore direto no
   componente.
5. Verificar no app rodando quando possível; `npm run lint && npm run build`.

## Critérios de sucesso
Muda só o visual · responsivo e acessível · reusa o design system · sem lib nova
desnecessária · build verde.

## Quando quiser mais profundidade de design
Opcionalmente o usuário pode pilotar o plugin externo `ui-ux-pro-max` na máquina
dele (fora deste repo). Esta skill é o caminho repo-nativo e auditável.

## Limites de permissão
Não alterar lógica de negócio/trading. Não mexer em `.env`, rules ou server. Não
push/PR sem pedido.
