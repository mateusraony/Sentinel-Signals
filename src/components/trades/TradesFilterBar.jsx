import React from 'react';
import { Search, Calendar, ChevronDown, ChevronUp, X } from 'lucide-react';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { PERIOD_OPTIONS, countActiveFilters } from '@/lib/tradesOverview';

const ON = { background: 'rgba(0,229,255,0.12)', border: '1px solid rgba(0,229,255,0.3)', color: 'rgba(0,229,255,0.9)' };
const OFF = { background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.45)' };
const SIDE_ON = {
  BUY: { background: 'rgba(0,255,128,0.12)', border: '1px solid rgba(0,255,128,0.3)', color: '#00ff80' },
  SELL: { background: 'rgba(255,20,120,0.12)', border: '1px solid rgba(255,20,120,0.3)', color: '#ff1478' },
};
const TF_OPTIONS = [{ id: 'all', label: 'Todos' }, { id: '1h', label: '1H' }, { id: '4h', label: '4H' }, { id: '1d', label: '1D' }];
const SIDE_OPTIONS = [{ id: 'all', label: 'Todos' }, { id: 'BUY', label: 'BUY' }, { id: 'SELL', label: 'SELL' }];

/** Um grupo de botões com o nome do que eles filtram escrito ao lado (antes "1H 4H 1D" e "BUY SELL" vinham soltos numa fila de 17 botões). */
function Group({ label, options, value, onPick, styleOn = (/** @type {string} */ _id) => ON }) {
  return (
    <div className="flex items-center gap-1.5" role="group" aria-label={label}>
      <span className="text-9px font-mono uppercase tracking-wide" style={{ color: 'rgba(255,255,255,0.35)' }}>{label}</span>
      {options.map((option) => (
        <button key={option.id} type="button" onClick={() => onPick(option.id)} aria-pressed={value === option.id}
          className="text-10px font-mono px-2.5 py-1 rounded-md transition-all"
          style={value === option.id ? styleOn(option.id) : OFF}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Barra de filtros da aba Trades (docs/known-risks.md item 304).
 *
 * O que mudou em relação à fila antiga: cada grupo diz o que filtra, o período virou um seletor (eram 7 botões), há um
 * "Limpar filtros" quando algum está ligado e uma linha dizendo quanto os filtros estão escondendo — sem ela, um filtro
 * esquecido fazia a tela parecer vazia.
 *
 * @param {{
 *   filters: { search: string, timeframe: string, side: string, period: string },
 *   onChange: (patch: object) => void,
 *   onClear: () => void,
 *   showDetails: boolean,
 *   onToggleDetails: () => void,
 *   counts: { activeShown: number, activeTotal: number, analysisShown: number, analysisTotal: number, closedShown: number, closedTotal: number },
 * }} props
 */
export default function TradesFilterBar({ filters, onChange, onClear, showDetails, onToggleDetails, counts }) {
  const activeCount = countActiveFilters(filters);

  return (
    <div className="rounded-xl px-3 py-2.5 space-y-2" role="search" aria-label="Filtros das operações"
      style={{ background: 'rgba(10,13,22,0.6)', border: '1px solid rgba(255,255,255,0.06)' }}>
      <div className="flex items-center gap-x-4 gap-y-2 flex-wrap">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground" aria-hidden="true" />
          <input type="text" placeholder="Buscar operação..." aria-label="Buscar pela moeda" value={filters.search}
            onChange={(e) => onChange({ search: e.target.value })}
            className="pl-7 pr-3 h-8 w-44 rounded-lg text-10px font-mono outline-none focus-visible:ring-1 focus-visible:ring-ring"
            style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.75)' }} />
        </div>

        <label className="flex items-center gap-1.5">
          <Calendar className="w-3 h-3 text-muted-foreground shrink-0" aria-hidden="true" />
          <span className="text-9px font-mono uppercase tracking-wide" style={{ color: 'rgba(255,255,255,0.35)' }}>Período</span>
          <select value={filters.period} onChange={(e) => onChange({ period: e.target.value })}
            className="h-8 px-2 rounded-lg text-10px font-mono outline-none focus-visible:ring-1 focus-visible:ring-ring"
            style={filters.period !== 'all' ? { ...ON, colorScheme: 'dark' } : { ...OFF, color: 'rgba(255,255,255,0.75)', colorScheme: 'dark' }}>
            {PERIOD_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>
        </label>

        <Group label="Gráfico do aviso" options={TF_OPTIONS} value={filters.timeframe} onPick={(id) => onChange({ timeframe: id })} />
        <Group label="Lado" options={SIDE_OPTIONS} value={filters.side} onPick={(id) => onChange({ side: id })}
          styleOn={(id) => SIDE_ON[id] ?? ON} />

        {/* Densidade — abre/fecha os detalhes técnicos de TODOS os cards de uma vez. Cada card continua podendo ser aberto sozinho depois. */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" onClick={onToggleDetails} aria-pressed={showDetails}
              className="flex items-center gap-1 text-10px font-mono px-2.5 py-1 rounded-md transition-all"
              style={showDetails ? ON : OFF}>
              {showDetails ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              {showDetails ? 'Detalhado' : 'Compacto'}
            </button>
          </TooltipTrigger>
          <TooltipContent className="max-w-[260px] text-10px font-mono normal-case tracking-normal leading-relaxed">
            Abre ou fecha os detalhes técnicos de todos os cards de operação ao mesmo tempo.
          </TooltipContent>
        </Tooltip>

        {activeCount > 0 && (
          <button type="button" onClick={onClear}
            className="flex items-center gap-1 text-10px font-mono px-2.5 py-1 rounded-md transition-all ml-auto"
            style={{ background: 'rgba(255,209,102,0.1)', border: '1px solid rgba(255,209,102,0.35)', color: '#ffd166' }}>
            <X className="w-3 h-3" aria-hidden="true" />
            Limpar filtros ({activeCount})
          </button>
        )}
      </div>

      {activeCount > 0 && (
        <p className="text-10px font-mono" role="status" style={{ color: '#ffd166' }}>
          Filtros ligados — mostrando {counts.activeShown} de {counts.activeTotal} ativas · {counts.analysisShown} de {counts.analysisTotal} avisos · {counts.closedShown} de {counts.closedTotal} fechadas.
        </p>
      )}
    </div>
  );
}
