import React from 'react';

/**
 * Calculates how close the current price is to triggering an RF signal.
 * Uses rf_filter_value, last_close, rf_direction from AssetState.
 * Returns null if insufficient data or already has active signal.
 *
 * Proximity levels (só mudam a intensidade do contorno na barra, item 277):
 *   < 1%  → very_close
 *   < 2%  → close
 *   < 3,5% → watching
 *   ≥ 3,5% → null (not close enough to show)
 */
export function calcProximity(state) {
  if (!state || !state.rf_filter_value || !state.last_close) return null;
  const { rf_filter_value, last_close, rf_direction } = state;
  if (rf_direction === 0 || rf_direction === undefined || rf_direction === null) return null;

  const distance = Math.abs(last_close - rf_filter_value) / rf_filter_value * 100;
  if (distance >= 3.5) return null; // Not close enough

  const side = rf_direction === 1 ? 'BUY' : 'SELL';

  let level;
  if (distance < 1) level = 'very_close';
  else if (distance < 2) level = 'close';
  else level = 'watching';

  return { distance, side, level };
}

// Item 277 (PR-B): a barra mostrava "🔥 MUITO PRÓXIMO ↑ BUY" pulsando, o que
// soava como compra iminente. Ela só mede a distância do preço até a linha do
// Range Filter — não diz se haverá aviso nem para que lado. Cor neutra única,
// sem lado e sem animação; o nível só muda a intensidade do contorno.
const NEUTRAL = '96,165,250'; // azul informativo (mesmo tom de "observação" no painel)
const LEVEL_ALPHA = { very_close: 0.45, close: 0.3, watching: 0.18 };

export default function ProximityBar({ state }) {
  const prox = calcProximity(state);
  if (!prox) return null;

  const { distance, level } = prox;
  const alpha = LEVEL_ALPHA[level];

  // Barra: 0% de distância = cheia (preço na linha), 3,5% = vazia
  const progress = Math.max(0, Math.min(100, ((3.5 - distance) / 3.5) * 100));

  return (
    <div
      className="rounded-lg px-3 py-2 mb-2.5"
      style={{ background: `rgba(${NEUTRAL},0.06)`, border: `1px solid rgba(${NEUTRAL},${alpha})` }}
    >
      <div className="flex items-center justify-between mb-1">
        <span className="text-10px font-mono font-semibold" style={{ color: `rgba(${NEUTRAL},0.9)` }}>
          📏 Distância até a linha do filtro
        </span>
        <span className="text-10px font-mono" style={{ color: 'rgba(255,255,255,0.55)' }}>{distance.toFixed(2)}%</span>
      </div>
      <div className="relative h-1.5 w-full rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.05)' }}>
        <div
          className="absolute h-full rounded-full"
          style={{ width: `${progress}%`, background: `rgba(${NEUTRAL},0.6)` }}
        />
      </div>
      <p className="text-8px font-mono mt-1" style={{ color: 'rgba(255,255,255,0.3)' }}>
        Só mostra o quanto o preço está perto da linha — não indica sinal próximo.
      </p>
    </div>
  );
}
