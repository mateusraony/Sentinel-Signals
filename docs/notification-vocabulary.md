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
| `VERIFICATION_NEEDED` | 🔎 | Verificação Necessária |
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
| Prioridade do sinal | ⚡ Alta · Média · Baixa | `priorityLabel()` em `src/lib/signalStatus.js`, usado por `SignalAlertBanner.jsx`/`Alerts.jsx` |
| Direção BUY/SELL | 🟢/▲ compra · 🔴/▼ venda | cor (`#00ff80`/`#ff1478`) + seta, em `Alerts.jsx`/`Trades.jsx`/vários componentes de Dashboard |

## Regra ao adicionar um estágio novo

1. Adicione a entrada em `NOTIFICATION_STAGES` (`src/lib/notificationVocabulary.js`)
   com um emoji que **nenhuma outra entrada já usa** — confira a tabela acima
   antes de escolher.
2. Copie a nova linha para a tabela acima no mesmo commit.
3. Use `stageHeader(stageId)`/`NOTIFICATION_STAGES[stageId]` no template —
   nunca literal solto (`'🔔 Novo Estágio'`) duplicado em Telegram e UI.
