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
| Prioridade do sinal | ⚡ Alta · Média · Baixa (painel) · ⭐ Prioridade: ALTA (Telegram) | `priorityLabel()` em `src/lib/signalStatus.js`, usado por `SignalAlertBanner.jsx`/`Alerts.jsx`; Telegram em `buildVerificationTaskMessage`. Unificação em ⭐ prevista no PR-E2 (item 276) |
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

## Regra ao adicionar um estágio novo

1. Adicione a entrada em `NOTIFICATION_STAGES` (`src/lib/notificationVocabulary.js`)
   com um emoji que **nenhuma outra entrada já usa** — confira a tabela acima
   antes de escolher.
2. Copie a nova linha para a tabela acima no mesmo commit.
3. Use `stageHeader(stageId)`/`NOTIFICATION_STAGES[stageId]` no template —
   nunca literal solto (`'🔔 Novo Estágio'`) duplicado em Telegram e UI.
