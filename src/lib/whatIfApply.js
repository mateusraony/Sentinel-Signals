// "Aplicar ao scanner" a partir do Ajuste Fino (What-If): lista TODOS os parâmetros que dá para levar ao scanner, com o valor que o scanner tem AGORA e o valor desta tela, para o
// USUÁRIO ESCOLHER, um a um, o que aplica (a tela nunca decide por ele). Funções PURAS (sem React, sem rede): quem grava é a tela, depois do clique. Nada aqui lê nem escreve no banco.
//
// Regras (todas conferidas no código do scanner):
//  - o valor "atual" é o da configuração ao vivo LIDA AGORA (outro navegador/administrador pode ter mudado); parâmetro igual ao atual aparece, mas não há o que aplicar;
//  - o stop (× ATR) NÃO é configuração: vem do TIER do ativo (tier.js), então não dá para aplicar;
//  - trailing do runner e saída do runner pelo Range Filter são sempre ligados na produção (exit_mode HYBRID_RF_ATR): não existe chave para desligar;
//  - Range Filter (período/multiplicador) é POR ATIVO (MonitoredAsset), não global: itens à parte, valem só para o ativo em análise.

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Itens globais (StrategyConfig) que os controles da tela viram. `to` já no tipo que o scanner espera. */
function globalItems(params) {
  const items = [
    { configKey: 'tp1R', label: 'TP1 (R)', to: params.tp1R },
    { configKey: 'minScore', label: 'Score mínimo', to: params.minScore },
  ];
  if (params.minRR > 0) items.push({ configKey: 'minRR', label: 'Piso R:R do TP1', to: params.minRR });
  items.push(
    { configKey: 'useADX', label: 'Filtro de regime — ADX', to: Boolean(params.regime) },
    { configKey: 'useChop', label: 'Filtro de regime — Choppiness', to: Boolean(params.regime) },
    { configKey: 'useTimeStop', label: 'Time stop', to: Boolean(params.timeStop) },
    { configKey: 'preTp1TrailEnabled', label: 'Trailing do stop antes do TP1', to: Boolean(params.trail) },
  );
  if (params.trail) {
    items.push(
      { configKey: 'preTp1TrailStartAtrMult', label: 'Trailing pré-TP1: começa em (× ATR)', to: params.trailStart },
      { configKey: 'preTp1TrailAtrMult', label: 'Trailing pré-TP1: distância (× ATR)', to: params.trailDist },
    );
  }
  if (params.runnerTrail) items.push({ configKey: 'trailAtrMult', label: 'Trailing do runner: distância (× ATR)', to: params.runnerTrailDist });
  return items;
}

const BLOCKED = {
  atrMult: { label: 'Stop (× ATR)', why: 'O stop do scanner vem do tier de volatilidade do ativo (2× / 2,5× / 3× ATR), não de uma configuração. Para mudar, é uma alteração de código, não um ajuste.' },
  runnerTrail: { label: 'Trailing do runner (ligar/desligar)', why: 'Na produção o runner sempre usa o trailing por ATR depois do TP1: não existe chave para desligá-lo. Só a distância dele é configurável.' },
  runnerRf: { label: 'Saída do runner pelo Range Filter (ligar/desligar)', why: 'Na produção essa saída é sempre ligada: não existe chave para desligá-la.' },
};

/**
 * @param {{ params: any, defaults: any, live: any, asset?: { rf_period?: number, rf_multiplier?: number } | null }} args
 *   params = controles agora; defaults = padrão da tela (a configuração ao vivo de quando a tela abriu); live = configuração ao vivo lida AGORA (null = não lida).
 * @returns {{ items: Array<{id: string, scope: 'global'|'asset', key: string, label: string, from: any, to: any, differs: boolean}>, blocked: Array<{key: string, label: string, why: string}> }}
 *   `items` traz TODOS os aplicáveis (`differs` diz se o valor da tela é diferente do atual do scanner). A ordem é a da tela.
 */
export function buildScannerPlan({ params, defaults, live, asset = null }) {
  /** @type {Array<{ id: string, scope: 'global' | 'asset', key: string, label: string, from: any, to: any, differs: boolean }>} */
  const items = globalItems(params).map((e) => {
    const from = live ? live[e.configKey] : undefined;
    return { id: `g:${e.configKey}`, scope: /** @type {'global'} */ ('global'), key: e.configKey, label: e.label, from, to: e.to, differs: !live || !eq(e.to, from) };
  });
  if (asset) {
    if (Number.isFinite(asset.rf_period)) items.push({ id: 'a:rf_period', scope: 'asset', key: 'rf_period', label: 'Range Filter deste ativo: período', from: asset.rf_period, to: params.rfPeriod, differs: params.rfPeriod !== asset.rf_period });
    if (Number.isFinite(asset.rf_multiplier)) items.push({ id: 'a:rf_multiplier', scope: 'asset', key: 'rf_multiplier', label: 'Range Filter deste ativo: multiplicador', from: asset.rf_multiplier, to: params.rfMult, differs: params.rfMult !== asset.rf_multiplier });
  }
  const blocked = [];
  if (params.atrMult !== defaults.atrMult) blocked.push({ key: 'atrMult', ...BLOCKED.atrMult });
  if (params.runnerTrail !== 1) blocked.push({ key: 'runnerTrail', ...BLOCKED.runnerTrail });
  if (params.runnerRf !== 1) blocked.push({ key: 'runnerRf', ...BLOCKED.runnerRf });
  return { items, blocked };
}

/** Itens que o usuário pode marcar (só os que realmente mudam o scanner). */
export const appliable = (plan) => plan.items.filter((i) => i.differs);

/**
 * Objeto a gravar em StrategyConfig/current a partir dos ids ESCOLHIDOS pelo usuário: SÓ essas chaves (a gravação mescla; o resto fica intacto).
 * Ligar o trailing pré-TP1 também liga a proteção mestre do bloco pré-TP1 (sem ela o scanner nem roda o trailing) — só quando o usuário escolheu ligar o trailing.
 */
export function scannerPayload(plan, chosenIds, nowIso) {
  const chosen = plan.items.filter((i) => i.scope === 'global' && i.differs && chosenIds.has(i.id));
  const payload = Object.fromEntries(chosen.map((c) => [c.key, c.to]));
  if (payload.preTp1TrailEnabled === true) payload.preTp1StopProtectionEnabled = true;
  return { ...payload, updated_at: nowIso };
}

/** Campos do MonitoredAsset a gravar (Range Filter por ativo) a partir dos ids escolhidos. */
export function assetPayload(plan, chosenIds) {
  return Object.fromEntries(plan.items.filter((i) => i.scope === 'asset' && i.differs && chosenIds.has(i.id)).map((i) => [i.key, i.to]));
}

/** Avisos de honestidade para mostrar ANTES de confirmar (o que o resultado da tela não prova). */
export function applyWarnings({ summary, testedCount }) {
  const out = [];
  if (!summary || !(summary.counted > 0)) out.push('Esta combinação não teve nenhuma operação na simulação: não há resultado para sustentar a mudança.');
  else if (!summary.conclusive) out.push(`Resultado ainda inconclusivo (${summary.counted} ${summary.counted === 1 ? 'operação' : 'operações'}): a melhora que você vê pode ser só sorte.`);
  if (testedCount >= 8) out.push(`Você testou ${testedCount} combinações nesta janela: o "melhor" entre muitas tentativas tende a ser sorte. Confirme em outro período ou ativo.`);
  out.push('A simulação é simplificada (1 ativo, 1 timeframe, 1 janela de dados) e ainda não faz a confirmação de 15 min nem o filtro 4h.');
  return out;
}
