# Vocabulário visual das notificações

Catálogo de referência — "1 emoji = 1 significado". Fonte única do código é
`src/lib/notificationVocabulary.js` (`NOTIFICATION_STAGES`); esta tabela é só
leitura humana, copiada de lá no momento do commit abaixo. Se divergir do
arquivo, o arquivo está certo — atualize esta tabela, não o contrário.

Auditoria do Telegram, Fase 5 (2026-10-02), item 5.1.

## Ciclo de vida sinal → operação

| Estágio (`stageId`) | Emoji | Rótulo |
|---|---|---|
| `SIGNAL_DETECTED` | 🔔 | Sinal Detectado |
| `VERIFICATION_NEEDED` | 🔎 | Sinal para Conferir |
| `AWAITING_ENTRY` | ⏳ | Aguardando Entrada |
| `ENTRY_CONFIRMED` | ✅ | Entrada Confirmada |
| `TP1_HIT` | 🎯 | TP1 Atingido |
| `RUNNER_ACTIVE` | 🏃 | Runner Ativo |
| `TP2_HIT` | 🏆 | TP2 Atingido — Alvo Final |
| `STOP_LOSS` | 🛑 | Stop Atingido |
| `STOP_BREAKEVEN` | 🟡 | Encerrada no Breakeven |
| `STOP_LOCKED_PROFIT` | 💰 | Stop Travou Lucro |
| `INVALIDATED` | ⚠️ | Sinal Invalidado |
| `TIME_STOP` | ⏱️ | Time Stop |
| `CHOP_EXIT` | 🌊 | Chop Exit |
| `SIGNAL_CANCELED` | 🚫 | Sinal Cancelado |

Cada emoji aparece em uma única entrada — usado em Telegram
(`src/lib/notificationTemplates.js`) e no Dashboard (`SignalToast.jsx`,
`SignalAlertBanner.jsx`) via o mesmo objeto, nunca repetido à mão.

## Outros vocabulários de emoji no projeto (domínios separados, não conflitam)

Estes dois sistemas existem fora de `NOTIFICATION_STAGES` — não devem ser
"unificados" com a tabela acima: são eixos diferentes (prioridade e direção),
não estágio do ciclo de vida.

| Domínio | Valores | Onde |
|---|---|---|
| Prioridade do sinal | ⭐ Alta · Média · Baixa (painel e Telegram) | `priorityLabel()` em `src/lib/signalStatus.js`, usado por `SignalAlertBanner.jsx`/`Alerts.jsx`/`TelegramSettings.jsx`; Telegram em `buildVerificationTaskMessage` (⭐ Prioridade: ALTA). Unificado em ⭐ no item 280 (antes ⚡ no painel e 🟡/🟠/🔴 nas configurações do Telegram) |
| Direção BUY/SELL | 🟢/▲ compra · 🔴/▼ venda | cor (`#00ff80`/`#ff1478`) + seta, em `Alerts.jsx`/`Trades.jsx`/vários componentes de Dashboard; **no Telegram desde o item 276** (`sideLabel()` em `notificationTemplates.js` — antes era 📈/📉) |

### Linhas auxiliares do Telegram (item 276)

Pedido do usuário: aprimorar os emojis, não removê-los — cada um com um único
significado, sempre acompanhado de texto.

| Emoji | Significado único | Onde |
|---|---|---|
| ℹ️ | Só informação — este aviso não abre operação | "Situação" de sinais não elegíveis (`isConfirmationEligible` falso) |
| 👉 | Próximo passo (o que o usuário faz — quase sempre "nada") | todas as mensagens (antes era ➡️) |
| 🏷️ | Preço de referência (no sinal / atual) | sinal detectado, cancelado, TP1 (antes 💰, que agora é só `STOP_LOCKED_PROFIT`) |
| 🧩 | Regras alinhadas N/100 — concordância das regras, **não é chance de acerto** | linha de score (antes 📊 Score + 💪 Forte/📊 Médio/🔹 Fraco) |
| 🛡️ | Stop protegido: no preço de entrada ou melhor — sem prejuízo, exceto taxas/slippage/funding | TP1 com runner (antes 🔄 "Stop movido para breakeven") |
| 📈 / 📉 | **Reservados para movimento de preço** (subiu/caiu no período mostrado) | painel desde o item 279: só via `describeChange24h` (`src/lib/priceChange24h.js`) — "📈 +x% em 24h · Futures"; nunca para lado do sinal nem MFE/MAE (⬆️/⬇️) |
| ⌛ | Duração / tempo de espera | resumo de encerramento e sinal cancelado (antes ⏳, que é só `AWAITING_ENTRY`) |
| 📌 | Nota explicativa sobre um encerramento já ocorrido (stop e take na mesma vela) | `AMBIGUOUS_EXIT_NOTE` (antes ℹ️) |

### Painel (item 277, PR-B)

| Emoji | Significado único | Onde |
|---|---|---|
| 📏 | Distância do preço até a linha do Range Filter — **não indica sinal próximo** | `ProximityBar`, filtro "Perto da linha do filtro" (antes 🔥/⚡/🎯 "MUITO PRÓXIMO") |
| 🧩 | Regras alinhadas N/100 — não é chance de acerto (mesmo do Telegram) | `agreementLabel()` em `src/lib/ruleAgreement.js` (antes 🔥 Forte/⚡ Moderado/〰 Fraco) |
| 📡 | Frescor do dado: atualizado há N min / atrasado / falha / desligado / sem leitura | `qualityBadge()`/`healthChip()` em `src/lib/assetDataQuality.js` (antes "LIVE" fixo) |

### Origem da operação (item 278, PR-C)

| Emoji | Significado único | Onde |
|---|---|---|
| 🧪 | Simulação manual — operação virtual criada no painel ("Simular entrada"), fora da medição do motor (Confiança ao Vivo e comparação com o histórico) | botão do cartão do ativo, banner do TradeCard, selo do Histórico |
| ✏️ | Encerrada à mão pelo painel (edição, Encerrar, Invalidar) — fora da medição do motor | banner do TradeCard, selo do Histórico |
| ♻️ | Recuperada após pausa do banco — operação reconstruída pelo replay de recuperação (item 288), fora da medição do motor | selo do Histórico, banner do TradeCard, aviso do Telegram e a mensagem única da recuperação |

### Registro "1 emoji = 1 significado" (item 280, PR-E2/E3)

Fonte única: `src/lib/emojiRegistry.js` (`EMOJI_REGISTRY`, glifo → significado).
`src/lib/emojiRegistry.test.js` varre `src/**`, `scripts/**` e `server/**` (`.js/.jsx/.mjs/.ts/.tsx`; todos os
canais do Telegram: `adminTelegram.js`, relatório diário, auditoria, webhook do
TradingView) e falha quando um glifo controlado aparece fora do sentido
registrado. A regra olha o texto logo depois do glifo (até fechar a string ou a
tag), não a linha inteira; comentários são removidos pelo parser do TypeScript
(`src/lib/__fixtures__/stripComments.js`). Glifos sem regra no registro (✅, ⚠️, 🔔, 🎯, 🏆, 🛑…) são só
referência — uso amplo demais para checar por linha.

| Emoji | Significado único | Mudou no item 280 |
|---|---|---|
| ⚡ | Só a marca "⚡ Sentinel Signals" | saiu de prioridade (→ ⭐), runner (→ 🏃), filtro "Sinais" (→ 🔔 Com sinal ou operação), "Failed to fetch" dos Logs (→ 📡 Falhas de rede) e score do Pine (→ 🧩) |
| 🏃 | Runner ativo | cartão do ativo (antes ⚡) e banner do TradeCard (antes 🚀 — agora proibido) |
| 🟡 | Encerrada no breakeven (BE) | Histórico, Operações, Relatório mensal, Desempenho, Backtest e banner do TradeCard (antes 🔄 / 🛡️ BE); ATR Trail virou 🟠, prioridade "Baixa" ficou sem emoji |
| 💰 | Stop travou lucro | Relatório mensal "Stop (lucro)" (antes ✅) |
| 🚫 | Sinal cancelado / prazo acabou sem operação | fase "Já passou" do painel (antes ✓, que lia como "deu certo") |
| ⭐ | Prioridade alta (só o valor "Alta") | painel, filtros de Alertas e opções do Telegram; o campo "Prioridade mínima" usa ⚙️ |
| 👍 / 👎 | O que ajuda / atrapalha o aviso | painel lateral do ativo (antes ✅/⚠️ no fim do título) |
| 🔄 | Sincronização | ícone do RF Period/Multiplier no Pine virou ⚙️ |
| ⏳ | Aguardando entrada (confirmação) | "Entrada em 15m" do Pine; vela aberta virou 🕯️ |
| 🕯️ | Vela (candle) aberta ou fechada | TradeCard, cartão do ativo e Histórico (antes "⏳ Aberto") |
| ⏱️ | Time Stop | duração no Histórico virou ⌛, "Linha do Tempo" virou 🕐, "Entrada em 15m" do Pine virou ⏳, "Detectada retroativamente" no Telegram virou ⌛, "Uma etapa travou" (canal 24h) virou 🚨 |
| 📡 | Dado de mercado: fonte (Futures/Spot/TradingView), frescor e rede | inclui "📡 Fonte" e "📡 TradingView" do Telegram, "📡 Falhas de rede (Failed to fetch)" nos Logs e a linha de status do cartão (antes "⚠️ STALE"/"⚠️ Falha persistente") |
| 📈 / 📉 | Movimento de preço (ver acima) | o relatório diário da regra EMA+Supertrend no Telegram usava 📈 no título — virou 🧭 (tendência) |
| ⚙️ | Configuração / parâmetro ajustável | "Prioridade mínima" do Telegram e RF Period/Multiplier do Pine (como já era em "Filtros Avançados" e "Parâmetros Ativos") |
| 🎚️ | Tier (classe de volatilidade do ativo) | TradeCard (já era) |
| 📐 | Evidência numérica (resultado em R, fatos da decisão) | Telegram, TradeCard, Operações, Histórico, console do backtest |
| 🚨 | Alerta do sistema (infraestrutura) — não é evento de operação | cota esgotada (já era) e "Uma etapa travou" (canal 24h) |
| 🧩 | Regras alinhadas N/100 | painel lateral ("Score técnico" → 🧩), aviso flutuante, notificação do navegador, Análise Preditiva e comparador ("Score" → "Regras") |
| 🔥 · 〰 · 🚀 · ⏰ | Proibidos | ⏰ era Time Stop na página do Pine — virou ⏱️ |

## Regra ao adicionar um estágio novo

1. Adicione a entrada em `NOTIFICATION_STAGES` (`src/lib/notificationVocabulary.js`)
   com um emoji que **nenhuma outra entrada já usa** — confira a tabela acima
   antes de escolher.
2. Copie a nova linha para a tabela acima no mesmo commit.
3. Use `stageHeader(stageId)`/`NOTIFICATION_STAGES[stageId]` no template —
   nunca literal solto (`'🔔 Novo Estágio'`) duplicado em Telegram e UI.
