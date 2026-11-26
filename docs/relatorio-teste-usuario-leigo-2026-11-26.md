# Relatório do teste com usuário leigo (26/11/2026) — T-2026-007

**Pedido do usuário (26/11/2026):** "use um agente que nunca viu o sistema, como se fosse um novo usuário, para ver se tudo está certo e fácil de entender… navegação, páginas, operações, testes… e faça um relatório com prós e contras."

## Como foi feito (e os limites)

- **3 agentes leigos independentes**, cada um numa área, sem acesso ao código nem à documentação (só ao painel no navegador, via Playwright, e aos textos/prints que um usuário vê). Persona: brasileiro, sabe o básico de cripto, não conhece termos como ATR, R, TP1, trailing, Pine.
  - **A:** navegação, Dashboard, Ativos, Alertas. **B:** Trades, Histórico, Verificação, Logs, Relatório mensal. **C:** Ajustes, Telegram, Pine Script, Backtest (3 abas), Revisor, erros, teclado.
- **Ambiente:** o painel real rodando numa cópia local com **dados de exemplo** (6 ativos, 2 operações abertas, 27 fechadas, ~40 sinais, logs). Preços e velas são sintéticos; o Telegram e a simulação do GitHub são simulados; login é falso. **Não cobre:** preço ao vivo, envio real de alerta, workflow real do GitHub, tema claro (o painel só tem tema escuro).
- **Valor das notas:** são a opinião dos agentes, não medida científica. Cada um teve um estilo de nota; use como termômetro.
- **Verificação:** os achados marcados **[código]** foram conferidos no código por mim; os marcados **[observado]** só foram vistos na tela do ambiente de teste (alguns podem ser do ambiente falso e precisam de confirmação em produção).

## Notas dadas pelos testadores

| Área | Fácil de entender (leigo) | Funciona direito |
|---|---|---|
| A — Dashboard, Ativos, Alertas | 4/10 | 7/10 |
| B — Operações, Histórico, Verificação, Logs, Relatório | 6,5/10 | 7/10 |
| C — Ajustes, Pine, Backtest, Revisor | 5/10 | 7/10 |

## PRÓS (o que o sistema faz bem)

1. **Honestidade sobre o que os números provam.** "Ainda não dá para dizer se a estratégia tem vantagem. Amostra pequena: 12 operações (mínimo 30)", "não é chance de acerto", "TP/Stop são virtuais; nenhuma ordem vai à corretora", "Amostra pequena… não prova vantagem" no Relatório mensal.
2. **Cartões de operação muito claros.** Barra Stop → Entrada → TP1 → TP2 com o preço atual, % até cada nível e frase do que acontece se bater no stop; "A história até agora" conta em português o que houve.
3. **Gaveta de detalhe do ativo** ("Por quê?", "O que ajuda / atrapalha", "O que anularia a ideia", "Nada a fazer: o app continua verificando sozinho").
4. **Ações destrutivas pedem confirmação** (remover ativo, editar/invalidar/encerrar operação, arquivar todos, limpar logs, restaurar Pine) e explicam que não dá para desfazer.
5. **Números batem entre telas.** B refez as contas do Histórico (27 operações, 17 ganhos, 10 perdas, soma +49,24%, profit factor 2,52) e conferiu o Relatório mensal e o PDF contra a lista.
6. **Ajuste Fino (What-If) é forte para quem explora:** "padrão X" em cada controle, comparação atual × padrão, aviso quando só há 1 operação, explicação de por que deu 0 operações, seção "Posso confiar?", "Analisar sensibilidade". Os 6 controles e 7 interruptores mudam o resultado.
7. **Cuidados de estado:** contagem de Verificação nunca mostrou "0" durante a carga; F5 mantém tudo; simulação do GitHub retoma depois de recarregar; mensagens de erro em português em quase tudo; 404 com botão de voltar.
8. **Logs didáticos:** resumo em português, "O que mais se repete", "Como ler esta tela", "O que significa / O que fazer".
9. **Celular e teclado:** sem rolagem lateral nas telas principais (exceto Histórico, 11 px), menu "Mais opções" com texto, Tab percorre tudo com foco visível, botões de ícone com nome.
10. **Estabilidade:** nenhum travamento, nenhuma tela em branco, nenhuma rota quebrada nas 12 páginas, desktop e celular.

## CONTRAS (problemas), em ordem de importância

### Bugs / resultado errado
| # | Onde | Problema | Evidência |
|---|---|---|---|
| 1 | Trades → **Encerrar à mão** | Não grava o preço de saída; o Histórico usa o **stop atual** como saída. Com stop editado para 9.999, a operação virou +196% e o profit factor foi de 2,52 para 8,58 | **[código]** `Trades.jsx:593-596` (grava só status/motivo) + `tradeMetrics.js:339-341` ("current_stop é o único proxy gravado") |
| 2 | Trades → **Editar** | Aceita stop absurdo (9.999 numa compra a 3.372) sem aviso, e não deixa voltar atrás sem explicar | **[observado]** (B) |
| 3 | Histórico, operação encerrada à mão | Hora de fechamento é a de abertura; duração "a few seconds" | **[observado]** (B) |
| 4 | Ativos → **Adicionar** | Aceita um ativo **duplicado** (BTC/USDT 2×) | **[código]** `AddAssetForm.jsx` não tem checagem de duplicado |
| 5 | **Alertas de preço** | Existem no motor/logs ("Falha ao avaliar alerta de preço"), mas **não há tela para criar, editar ou apagar** | **[código]** nenhuma página usa `PriceAlert`; **[observado]** (A) |
| 6 | Pine Script → **Salvar** | Texto sem sentido ("oi eu quero comprar bitcoin…") é salvo com "Salvo!/Auto-sync OK", sobrescreve o código e iguala parâmetros dos ativos aos padrões; só há um aviso laranja discreto | **[observado]** (C) |
| 7 | Backtest → colar JSON incompleto | A tela inteira cai em "SINAL PERDIDO — Cannot read properties of undefined (reading 'toFixed')" | **[observado]** (C) |
| 8 | Ajustes → Swing Period/Multiplier | Salvam ("Salvo!") mas voltam ao valor antigo ao recarregar; Pine mostra outro valor | **[observado]** (C) — pode ser do ambiente falso; **confirmar em produção** |
| 9 | Verificação → campo de nota | O 1º clique em OK com nota digitada não faz nada; "Reenviar" sempre apagado sem motivo | **[observado]** (B) |
| 10 | Pequenos | Alerta arquivado some sem confirmar/desfazer; "Limpar antigos" sem retorno; sem mensagem de "salvo/encerrado"; Histórico 11 px mais largo no celular; Capital inicial aceita 0 e −500; "Disparar backtest" sem rótulo não avisa; BTC/USDT duas vezes na lista do What-If; contadores que não batem (420 × 62 × 60) | **[observado]** |

### Confusões (funciona, mas o leigo não entende)
1. **Menu só de ícones**, sem nome (nem no hover em todos); o nome só aparece em "Mais opções" no celular. Três ícones soltos no canto (setas, funil riscado, lixeira) assustam.
2. **Jargão sem tradução:** R, TP1/TP2, runner, trailing, ATR, Tier T1-T3, RF, MFE/MAE, Score, "Confl.", Profit Factor, drawdown (dois nomes e dois valores para a mesma ideia), "Stop" em operação que **ganhou**, "Invalidada", "Time stop".
3. **Primeira tela sobrecarregada:** abre com a agenda econômica dos EUA (CPI, FOMC…) sem explicar por que importa; os sinais ficam abaixo.
4. **Textos que se contradizem:** "Avisos em análise" mostrando avisos "Já passou"; "Profit Factor Saudável" ao lado de "ainda não dá para dizer se tem vantagem"; "Fora da conta … mas entram nos números"; contadores com número ≠ lista de nomes.
5. **Dois lugares para os mesmos parâmetros** (Ajustes × Pine Script) que discordam; "Salvar & Sincronizar" não diz que altera **todos os ativos**.
6. **Opções avançadas sem aviso de risco** ("Fidelidade ao TradingView", "Bypass 15m", "Desligar teto de TP2") — ligam e salvam sem confirmação, com referência a "known-risks item 120".
7. **Textos de desenvolvedor na tela:** "OWNER_ACCESS_KEY no Render", "localStorage", "workflow backtest.yml", "artifact", "npm run backtest", "JSON", "pineConfig", "known-risks item 46", "código rr_rejected", "Cole o diagnóstico numa conversa com o Claude Code".
8. **Inglês e formato misturados:** "5 hours ago", "a few seconds", "Win/BE/Loss", "Side/Entry/Exit", "Not Found", "Close"; datas mm/dd/yyyy; "$96,873.12" × "$3.388,21"; "+4.47%" × "1,36×".
9. **Telegram:** o token aparece em texto aberto; "ATIVO" acende antes de salvar; botões desabilitados sem dizer por quê; sino do topo sugere notificações do painel, mas abre a configuração do Telegram.
10. **Pequenos:** gráfico vazio da "Análise Preditiva" parece quebrado; o selo "Atualizado às…" cobre conteúdo; link com `?id=` inexistente abre a página normal sem aviso; só tema escuro.

## O que eu recomendo (ordem de valor, só proposta — nada foi alterado)

1. **Corrigir já (dados errados):** (a) encerrar à mão gravar o preço de mercado como saída e a hora real; (b) validar o stop ao editar (lado certo, faixa razoável); (c) bloquear ativo duplicado.
2. **Dar tela aos alertas de preço** (ou remover a menção nos logs) — decisão de produto sua.
3. **Proteger o Pine Script:** recusar texto sem parâmetros reconhecidos e pedir confirmação antes de sobrescrever os ativos.
4. **Um "modo iniciante" de texto:** nomes no menu, glossário curto sempre visível para R/TP1/Stop/runner, tradução do inglês restante, esconder "known-risks"/"workflow/JSON" num "Avançado".
5. **Ordem da primeira tela:** sinais e operações primeiro, agenda dos EUA abaixo, com uma frase de contexto.
6. **Confirmar em produção** o item 8 (Swing não persiste), que pode ser só do ambiente de teste.

Nada disto foi implementado: cada item é mudança de comportamento e exige o seu pedido (regra do projeto).
