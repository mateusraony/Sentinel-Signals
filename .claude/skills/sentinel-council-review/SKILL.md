---
name: sentinel-council-review
description: Conselho de revisão multi-papel para DECISÕES CRÍTICAS do Sentinel (máquina de estados, concorrência, risco financeiro, execução de ordens, segurança, arquitetura de dados, mudança de estratégia). Use somente quando o usuário pedir ou quando a criticidade justificar. Roda revisores independentes LOCAIS (subagentes) que tentam refutar uns aos outros — sem enviar dados a provedores externos.
---

# sentinel-council-review

## Quando usar
Só decisões críticas: máquina de estados, concorrência, risco financeiro,
execução de ordens, segurança, arquitetura de dados, mudança de estratégia. Ou
quando o usuário pedir explicitamente "conselho".

## Quando NÃO usar
Tarefa comum, bug simples, UI, ou qualquer coisa de baixo impacto — é caro em
contexto. Substitui `llm-council` (rejeitado por fazer broadcast a provedores
externos): **aqui os revisores são subagentes locais, nada sai da máquina.**

## Como rodar
Usar o Agent tool (subagente `Explore`/`Plan`/`general-purpose`) para instanciar
papéis **independentes**, cada um com a mesma pergunta e o contexto mínimo
necessário (redigir secrets):

1. **Arquiteto** — coerência com a arquitetura atual, dívida, simplicidade.
2. **Especialista em trading** — correção da lógica de sinal/ciclo de vida, risco.
3. **Especialista em concorrência** — locks, idempotência, corridas.
4. **Especialista em segurança** — secrets, blast radius, menor privilégio.
5. **Especialista em testes** — o que precisa ser provado, casos-limite.
6. **Avaliador final** — pesa as posições, aponta refutações, decide com evidência.

Os papéis devem **tentar refutar** uns aos outros e citar `arquivo:linha`. O
avaliador final entrega uma recomendação única com fato/hipótese/recomendação
separados e um plano de teste + rollback.

## Critérios de sucesso
Pelo menos uma refutação real entre papéis; decisão final ancorada em evidência
do código; riscos e plano de verificação explícitos.

## Limites de permissão
Nenhum dado enviado a provedor externo (sem OpenRouter/multi-vendor). Redigir
secrets no contexto dos subagentes. Não executa mudança — só recomenda.
