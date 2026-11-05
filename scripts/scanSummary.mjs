/**
 * Resumo de UMA passada do scan para o log do GitHub Actions (pedido do usuário, 05/11/2026:
 * "faz o resumo por scan nos logs").
 *
 * Por quê: o log só dizia "10 ativo(s), 0 falha(s)". Não dava para saber, sem abrir o banco, se a passada
 * achou sinal, abriu/fechou operação ou foi barrada por algum filtro — e uma passada que saiu em 1 s
 * (lock ocupado) parecia igual a uma normal.
 *
 * REPOSITÓRIO PÚBLICO ⇒ o log do Actions é legível sem login. Então o resumo tem SÓ CONTAGENS e códigos de
 * motivo curtos (`[a-z0-9_]`). Nunca: preço de entrada/stop/alvo, R, lado junto com símbolo de operação
 * aberta (revelaria posição em tempo real), id de operação/sinal, nem texto de erro cru. Símbolos só nas
 * falhas, como `run-scan.mjs` já faz.
 *
 * Parte PURA (sem rede, sem banco, sem relógio): não importa `@/api/entities`, firebase, pg nem Telegram —
 * mesma separação de `healthAuditFormat.mjs`, para o teste não depender de credencial.
 *
 * Como conta operações SEM tocar `src/lib/scanner.js`: `instrumentTradeOps` embrulha as duas funções do
 * `backend.tradeOps` que o scanner chama no momento do uso (`createTradeOpIfNoneActive` e
 * `transitionTradeOp`) e só observa o retorno — não muda argumento, retorno nem exceção, e nenhuma
 * consulta extra ao banco.
 */

/** Campos do contador de operações, na ordem em que aparecem no log. */
export const OPS_FIELDS = Object.freeze([
  'abertas', 'tp1', 'tp2', 'stop', 'invalidadas', 'tempo', 'chop', 'outras_saidas', 'atualizadas', 'cas_descartadas',
]);

/** Quantos motivos diferentes do funil aparecem na linha; o resto vira `demais`. */
export const MAX_FUNNEL_CODES = 8;
/** Teto da linha inteira (o log não é lugar de texto longo). */
export const MAX_LINE_LENGTH = 400;

const CODE_RE = /^[a-z0-9_]{1,40}$/;

/** Contador zerado. */
export function emptyOpsCounts() {
  return Object.fromEntries(OPS_FIELDS.map((k) => [k, 0]));
}

function safeInt(n) {
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Motivo do funil como código curto. Qualquer coisa fora de `[a-z0-9_]{1,40}` vira `codigo_invalido` — nunca
 * se imprime texto vindo do scanner/erro como está.
 */
export function sanitizeCode(reason) {
  if (typeof reason !== 'string') return 'codigo_invalido';
  const code = reason.trim().toLowerCase();
  return CODE_RE.test(code) ? code : 'codigo_invalido';
}

/**
 * O que uma transição aplicada significa (só olha o `status` de destino e o motivo de fechamento; o patch
 * nunca é impresso). Mesmo status (ou sem status) = atualização de rotina (stop que sobe, MFE/MAE, marcadores).
 */
export function classifyTransition(fromStatus, patch) {
  const to = patch && typeof patch === 'object' ? patch.status : undefined;
  if (typeof to !== 'string' || to === fromStatus) return 'atualizadas';
  if (to === 'RUNNER_ACTIVE') return 'tp1';
  if (to === 'TP2_HIT') return 'tp2';
  if (to === 'STOP_HIT') return 'stop';
  if (to === 'INVALIDATED') return 'invalidadas';
  if (to === 'CLOSED') {
    if (patch.closed_reason === 'TIME_STOP') return 'tempo';
    if (patch.closed_reason === 'CHOP_EXIT') return 'chop';
    if (patch.closed_reason === 'INVALIDATION') return 'invalidadas';
    return 'outras_saidas';
  }
  return 'atualizadas';
}

/**
 * Embrulha `createTradeOpIfNoneActive` e `transitionTradeOp` de `tradeOps` para contar o que de fato foi
 * gravado nesta passada. Devolve `{ snapshot, restore }`. Contar nunca pode quebrar o scan: o retorno original é
 * devolvido sempre, a exceção original segue subindo, e um erro DENTRO da contagem é engolido.
 *
 * `applied === false` é uma transição descartada pelo compare-and-set (outro executor chegou antes) — conta à
 * parte: é o sinal observável da corrida entre os dois loops (docs/known-risks.md, "Precedência stop>TP").
 */
export function instrumentTradeOps(tradeOps) {
  const counts = emptyOpsCounts();
  const originals = {};

  const wrap = (name, onResult) => {
    if (!tradeOps || typeof tradeOps[name] !== 'function') return;
    const original = tradeOps[name];
    originals[name] = original;
    tradeOps[name] = async function instrumented(...args) {
      const res = await original.apply(this, args);
      try { onResult(res, args); } catch { /* contar nunca quebra o scan */ }
      return res;
    };
  };

  wrap('createTradeOpIfNoneActive', (res) => {
    if (res && res.created === true) counts.abertas += 1;
  });
  wrap('transitionTradeOp', (res, args) => {
    if (res && res.applied === true) counts[classifyTransition(args[1], args[2])] += 1;
    else if (res && res.applied === false) counts.cas_descartadas += 1;
  });

  return {
    snapshot: () => ({ ...counts }),
    restore: () => {
      for (const [name, fn] of Object.entries(originals)) tradeOps[name] = fn;
    },
  };
}

/**
 * Junta o que `scanAllAssets()` e `priceCheckActiveOps()` já devolvem com o contador de operações.
 * `scanResult`: `{ total, results, skipped }`; cada `results[i]` traz `success` e `persisted`
 * (`persistedSignals`, `entryFunnelOutcomes`). `priceCheckResult`: `{ errors, skipped }`.
 */
export function summarizeScanPass(input) {
  // `null` não cai no valor padrão de uma desestruturação (só `undefined` cai): trata os dois aqui.
  const { scanResult, priceCheckResult, ops } = input && typeof input === 'object' ? input : {};
  const results = Array.isArray(scanResult?.results) ? scanResult.results : [];
  const lockBusy = scanResult?.skipped === true;

  let assetsOk = 0;
  let assetsFailed = 0;
  let newSignals = 0;
  const funnelCounts = new Map();
  for (const r of results) {
    if (!r || typeof r !== 'object') continue;
    if (r.success === true) assetsOk += 1;
    else if (r.success === false) assetsFailed += 1;
    const persisted = r.persisted;
    if (!persisted || typeof persisted !== 'object') continue;
    newSignals += safeInt(persisted.persistedSignals);
    const outcomes = Array.isArray(persisted.entryFunnelOutcomes) ? persisted.entryFunnelOutcomes : [];
    for (const o of outcomes) {
      const code = sanitizeCode(o?.reason);
      funnelCounts.set(code, (funnelCounts.get(code) ?? 0) + 1);
    }
  }

  // Mais frequentes primeiro; empate por nome (saída estável). O excedente vira `demais`.
  const sorted = [...funnelCounts.entries()].sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1));
  const funnel = sorted.slice(0, MAX_FUNNEL_CODES);
  const rest = sorted.slice(MAX_FUNNEL_CODES).reduce((sum, [, n]) => sum + n, 0);
  if (rest > 0) funnel.push(['demais', rest]);

  const opsCounts = emptyOpsCounts();
  for (const k of OPS_FIELDS) opsCounts[k] = safeInt(ops?.[k]);

  return {
    lock: lockBusy ? 'ocupado' : 'ok',
    assetsTotal: safeInt(scanResult?.total),
    assetsOk,
    assetsFailed,
    newSignals,
    funnel,
    ops: opsCounts,
    priceCheck: priceCheckResult?.skipped === true
      ? 'pulado'
      : (Array.isArray(priceCheckResult?.errors) && priceCheckResult.errors.length > 0
        ? `erros:${priceCheckResult.errors.length}`
        : 'ok'),
  };
}

/** Uma linha só, em português, só contagens e códigos. */
export function formatScanSummary(summary) {
  const s = summary ?? {};
  const parts = [
    `lock=${s.lock === 'ocupado' ? 'ocupado' : 'ok'}`,
    `ativos_ok=${safeInt(s.assetsOk)}/${safeInt(s.assetsTotal)}`,
  ];
  if (safeInt(s.assetsFailed) > 0) parts.push(`falhas=${safeInt(s.assetsFailed)}`);
  parts.push(`sinais_novos=${safeInt(s.newSignals)}`);

  const opsParts = OPS_FIELDS.filter((k) => safeInt(s.ops?.[k]) > 0).map((k) => `${k}=${safeInt(s.ops[k])}`);
  parts.push(opsParts.length > 0 ? `ops{${opsParts.join(' ')}}` : 'ops=nenhuma');

  const funnelParts = (Array.isArray(s.funnel) ? s.funnel : [])
    .filter((e) => Array.isArray(e) && typeof e[0] === 'string' && safeInt(e[1]) > 0)
    .map(([code, n]) => `${CODE_RE.test(code) ? code : 'codigo_invalido'}=${safeInt(n)}`);
  parts.push(funnelParts.length > 0 ? `funil{${funnelParts.join(' ')}}` : 'funil=nenhum');

  const priceCheck = typeof s.priceCheck === 'string' && /^(ok|pulado|erros:\d{1,4})$/.test(s.priceCheck) ? s.priceCheck : 'ok';
  parts.push(`price_check=${priceCheck}`);

  const line = `[scan] resumo: ${parts.join(' ')}`;
  return line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH - 3)}...` : line;
}
