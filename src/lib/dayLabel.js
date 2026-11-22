import moment from 'moment';

/**
 * Título de um dia nas listas agrupadas por data (Alertas, Logs): "Hoje", "Ontem" ou DD/MM/AAAA.
 * Compartilhado para o mesmo dia ter sempre o mesmo nome nas duas telas.
 * @param {moment.Moment} m
 * @param {moment.Moment} [now] relógio de referência (testes)
 */
export function dayLabel(m, now = moment()) {
  if (m.isSame(now, 'day')) return 'Hoje';
  if (m.isSame(now.clone().subtract(1, 'day'), 'day')) return 'Ontem';
  return m.format('DD/MM/YYYY');
}
