// Achado do sentinel-council-review (papel Segurança, revisão do PR do
// redesenho do CAS): a rota HTTP POST /api/trade-ops/:id/transition recebe
// `patch` do corpo da requisição — ao contrário do Firestore SDK do
// browser, uma rota Express não tem NENHUMA validação de shape embutida no
// protocolo, então precisa da guarda explícita.
//
// **Denylist, não allowlist** (desvio deliberado da sugestão literal do
// conselho, que citou o padrão de BACKTEST_INPUT_KEYS em server/index.js —
// documentado aqui para quem revisar o porquê): `BACKTEST_INPUT_KEYS` é uma
// meia-dúzia de parâmetros estáveis; os campos legítimos de um patch de
// TradeOperation são dezenas e crescem com frequência
// (.claude/rules/trading-engine.md documenta um histórico real disso —
// tier, adx_at_entry, pd_zone, mfe_r, mae_r, cascade, e por aí vai). Uma
// allowlist aqui exigiria atualização toda vez que scanner.js ganha um
// campo novo — o MESMO atrito de "espelho mantido à mão" que este projeto
// já tenta evitar em outros lugares (ver o comentário de topo de
// opTransition.js sobre adminPineConfig.js). A denylist cobre o risco real
// identificado (sobrescrever identidade/chaves do CAS) sem essa fricção:
// os campos aqui são estruturais, não de negócio, e não mudam.
const FORBIDDEN_PATCH_FIELDS = Object.freeze([
  'id', 'asset_id', 'created_date', 'symbol', 'active_ops_anchor',
]);

function validateTradeOpPatch(patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return 'patch precisa ser um objeto.';
  }
  for (const field of FORBIDDEN_PATCH_FIELDS) {
    if (Object.hasOwn(patch, field)) {
      return `Campo "${field}" não pode ser alterado via patch.`;
    }
  }
  return null;
}

module.exports = { FORBIDDEN_PATCH_FIELDS, validateTradeOpPatch };
