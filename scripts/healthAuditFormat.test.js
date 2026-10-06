// docs/known-risks.md item 164 — a auditoria só presta se o relatório for
// legível. Sem agrupamento ela devolve o log cru com outro nome, e um
// relatório que ninguém lê é exatamente o estado que ela existe para consertar.
import { describe, it, expect } from 'vitest';
import { agrupar, celula, descreverContextoNavegador, descreverOrigem, haQuantoTempo, normalizarMensagem, notaSoNavegador, ocorreuRecentemente, soNavegador, sufixoOrigem } from './healthAuditFormat.mjs';

describe('normalizarMensagem', () => {
  it('junta o mesmo problema em ativos diferentes', () => {
    expect(normalizarMensagem('BTCUSDT falhou ao buscar candles'))
      .toBe(normalizarMensagem('LDOUSDT falhou ao buscar candles'));
  });

  it('junta o mesmo problema com números diferentes', () => {
    expect(normalizarMensagem('Timeout: não retornou em 90000ms'))
      .toBe(normalizarMensagem('Timeout: não retornou em 300000ms'));
  });

  it('NÃO junta problemas realmente diferentes', () => {
    expect(normalizarMensagem('BTCUSDT falhou ao buscar candles'))
      .not.toBe(normalizarMensagem('BTCUSDT falhou ao gravar operação'));
  });

  it('degrada sem lançar', () => {
    expect(normalizarMensagem(null)).toBe('');
    expect(normalizarMensagem(undefined)).toBe('');
  });
});

describe('agrupar', () => {
  const log = (over = {}) => ({ module: 'scanner', message: 'BTCUSDT falhou', created_date: '2026-09-05T10:00:00.000Z', ...over });

  it('conta ocorrências e ordena do mais frequente ao menos', () => {
    const grupos = agrupar([
      log(), log({ symbol: 'ETHUSDT', message: 'ETHUSDT falhou' }),
      log({ module: 'alerts', message: 'outra coisa' }),
    ]);
    expect(grupos[0].total).toBe(2);
    expect(grupos[1].total).toBe(1);
  });

  it('conta ATIVOS DISTINTOS — é isso que separa falha sistêmica de azar de um símbolo', () => {
    // A assinatura do item 136: o mesmo erro em muitos ativos ao mesmo tempo.
    const grupos = agrupar([
      log({ symbol: 'BTCUSDT', message: 'BTCUSDT falhou' }),
      log({ symbol: 'ETHUSDT', message: 'ETHUSDT falhou' }),
      log({ symbol: 'LDOUSDT', message: 'LDOUSDT falhou' }),
    ]);
    expect(grupos).toHaveLength(1);
    expect(grupos[0].ativos.size).toBe(3);
  });

  it('o mesmo ativo repetindo NÃO infla a contagem de ativos', () => {
    const grupos = agrupar([
      log({ symbol: 'BTCUSDT' }), log({ symbol: 'BTCUSDT' }), log({ symbol: 'BTCUSDT' }),
    ]);
    expect(grupos[0].total).toBe(3);
    expect(grupos[0].ativos.size).toBe(1); // 1 ativo — não é sistêmico
  });

  it('guarda a janela de tempo do grupo', () => {
    const grupos = agrupar([
      log({ created_date: '2026-09-05T10:00:00.000Z' }),
      log({ created_date: '2026-09-05T08:00:00.000Z' }),
    ]);
    expect(grupos[0].primeiro).toBe('2026-09-05T08:00:00.000Z');
    expect(grupos[0].ultimo).toBe('2026-09-05T10:00:00.000Z');
  });

  it('degrada sem lançar em entrada vazia ou malformada', () => {
    expect(agrupar([])).toEqual([]);
    expect(agrupar(null)).toEqual([]);
    expect(agrupar([{}])).toHaveLength(1);
  });
});

describe('haQuantoTempo', () => {
  const AGORA = Date.parse('2026-09-05T12:00:00.000Z');

  it('usa minuto, hora e dia conforme a distância', () => {
    expect(haQuantoTempo('2026-09-05T11:30:00.000Z', AGORA)).toBe('há 30min');
    expect(haQuantoTempo('2026-09-05T09:00:00.000Z', AGORA)).toBe('há 3h');
    expect(haQuantoTempo('2026-09-01T12:00:00.000Z', AGORA)).toBe('há 4.0d');
  });

  it('não devolve "há 0min" para algo que acabou de acontecer', () => {
    expect(haQuantoTempo('2026-09-05T11:59:59.000Z', AGORA)).toBe('há 1min');
  });

  it('data ausente, inválida ou no futuro não vira texto sem sentido', () => {
    expect(haQuantoTempo(null, AGORA)).toBe('?');
    expect(haQuantoTempo('lixo', AGORA)).toBe('?');
    expect(haQuantoTempo('2026-09-06T00:00:00.000Z', AGORA)).toBe('?');
  });
});

describe('celula', () => {
  it('escapa | para não quebrar a tabela do relatório', () => {
    expect(celula('a | b')).toBe('a \\| b');
    expect(celula(null)).toBe('');
  });
});

// Achado real (2026-09-16): um problema já corrigido (item 179) continuou
// disparando o MESMO alerta no Telegram em toda execução seguinte do
// health-audit, porque `g.ultimo` (a ocorrência mais recente do grupo)
// seguia dentro da janela de leitura (LIMITE_LOGS/AMOSTRA_ERROS_JANELA_DIAS)
// mesmo horas/dias depois do fix já ter sido aplicado e confirmado.
describe('ocorreuRecentemente', () => {
  const AGORA = Date.parse('2026-09-16T12:00:00.000Z');
  const grupo = (ultimo) => ({ chave: 'x', total: 1, ativos: new Set(['BTCUSDT']), primeiro: ultimo, ultimo });

  it('grupo com a última ocorrência dentro das 24h vira achado', () => {
    expect(ocorreuRecentemente(grupo('2026-09-16T00:00:01.000Z'), AGORA)).toBe(true);
  });

  it('grupo cuja última ocorrência já passou de 24h não vira mais achado', () => {
    // O caso real: um problema corrigido ontem à tarde, ainda dentro da
    // janela de leitura do health-audit, mas já morto — não deve voltar a
    // alertar todo dia até sair da janela sozinho.
    expect(ocorreuRecentemente(grupo('2026-09-15T11:59:00.000Z'), AGORA)).toBe(false);
  });

  it('um problema REALMENTE ativo nunca é suprimido — `ultimo` se renova a cada nova ocorrência', () => {
    // Simula o problema continuando a acontecer: mesmo tendo COMEÇADO fora
    // da janela de 24h, a ocorrência mais recente ainda está dentro dela.
    expect(ocorreuRecentemente(grupo('2026-09-16T11:00:00.000Z'), AGORA)).toBe(true);
  });

  it('respeita o limite exato de 24h', () => {
    expect(ocorreuRecentemente(grupo('2026-09-15T12:00:00.000Z'), AGORA)).toBe(true);
    expect(ocorreuRecentemente(grupo('2026-09-15T11:59:59.000Z'), AGORA)).toBe(false);
  });
});

// item 254 — a auditoria passa a mostrar DE ONDE veio o erro (executor +
// error_class), que é o que o "Failed to fetch" recorrente precisava.
describe('origem do erro (executor + error_class)', () => {
  const log = (over = {}) => ({ module: 'scanner', message: 'Erro no scan de BTCUSDT: Failed to fetch', created_date: '2026-10-03T10:00:00.000Z', ...over });

  it('agrupar coleta executores e classes distintos do grupo', () => {
    const [g] = agrupar([
      log({ symbol: 'BTCUSDT', executor: 'browser', details: { error_class: 'NETWORK' } }),
      log({ symbol: 'ETHUSDT', message: 'Erro no scan de ETHUSDT: Failed to fetch', executor: 'cron', details: { error_class: 'NETWORK' } }),
    ]);
    expect([...g.executores].sort()).toEqual(['browser', 'cron']);
    expect([...g.classes]).toEqual(['NETWORK']);
  });

  it('lê executor também de details (formato de logError/logWarn: lock e fallback de config) — Codex review PR #457', () => {
    const [g] = agrupar([
      log({ message: 'Falha ao adquirir lock "price-check" — prosseguindo sem lock', details: { executor: 'browser', error_class: 'NETWORK', scan_id: 'price-check_1_a' } }),
      log({ message: 'Falha ao adquirir lock "price-check" — prosseguindo sem lock', details: { executor: 'cron', error_class: 'NETWORK' } }),
    ]);
    expect(descreverOrigem(g)).toBe('browser/cron · NETWORK');
  });

  it('nível de cima tem precedência sobre details quando os dois existem', () => {
    const [g] = agrupar([log({ executor: 'cron', details: { executor: 'browser' } })]);
    expect([...g.executores]).toEqual(['cron']);
  });

  it('descreverOrigem: um lado só, os dois lados, e logs antigos sem os campos', () => {
    expect(descreverOrigem(agrupar([log({ executor: 'browser', details: { error_class: 'NETWORK' } })])[0])).toBe('browser · NETWORK');
    expect(descreverOrigem(agrupar([
      log({ executor: 'browser' }), log({ executor: 'cron', details: { error_class: 'TIMEOUT' } }),
    ])[0])).toBe('browser/cron · TIMEOUT');
    expect(descreverOrigem(agrupar([log()])[0])).toBe('—');
  });

  it('sufixoOrigem: vazio sem origem (mensagem de achado inalterada), preenchido com origem', () => {
    expect(sufixoOrigem(agrupar([log()])[0])).toBe('');
    expect(sufixoOrigem(agrupar([log({ executor: 'browser', details: { error_class: 'NETWORK' } })])[0]))
      .toBe(' (origem: browser · NETWORK)');
  });
});

// item 255 — erro que SÓ o navegador teve não é falha do sistema (o cron é o
// relógio de trading): continua no relatório, mas não vira aviso. Só vale se
// o registro foi deduplicado POR EXECUTOR (details.dedup_scope) — senão um
// `browser` pode estar escondendo a mesma falha do cron (Codex, PR #458, P1).
describe('soNavegador', () => {
  const log = (over = {}) => ({ module: 'scanner', message: 'Erro no scan de BTCUSDT: Failed to fetch', created_date: '2026-10-03T10:00:00.000Z', ...over });
  const novo = (over = {}) => log({ details: { dedup_scope: 'executor', ...(over.details ?? {}) }, ...over, ...(over.details ? { details: { dedup_scope: 'executor', ...over.details } } : {}) });

  it('verdadeiro só quando TODOS os registros vieram do navegador E foram deduplicados por executor', () => {
    expect(soNavegador(agrupar([novo({ executor: 'browser' }), novo({ executor: 'browser' })])[0])).toBe(true);
    expect(notaSoNavegador(agrupar([novo({ executor: 'browser' })])[0])).toContain('não gera aviso');
  });

  it('REGRESSÃO (Codex P1): log antigo (sem dedup_scope) NUNCA é "só navegador" — pode estar escondendo o cron', () => {
    const antigo = agrupar([log({ executor: 'browser' }), log({ executor: 'browser' })])[0];
    expect(soNavegador(antigo)).toBe(false);
    expect(notaSoNavegador(antigo)).toBe('');
  });

  it('um único registro sem o marcador já desliga a supressão do grupo', () => {
    expect(soNavegador(agrupar([novo({ executor: 'browser' }), log({ executor: 'browser' })])[0])).toBe(false);
  });

  it('falso com cron no meio, ou sem executor — continua virando achado', () => {
    expect(soNavegador(agrupar([novo({ executor: 'browser' }), novo({ executor: 'cron' })])[0])).toBe(false);
    expect(soNavegador(agrupar([novo()])[0])).toBe(false);
  });

  it('reconhece executor também em details (formato de logError/logWarn)', () => {
    expect(soNavegador(agrupar([log({ details: { executor: 'browser', dedup_scope: 'executor' } })])[0])).toBe(true);
  });
});

// item 257 — achado real (auditoria de 06/10/2026): o aviso "Failed to fetch em
// 8-9 ativos (browser · NETWORK)" continuou chegando 3x no dia mesmo com a regra
// "só navegador" do item 255. Causa: `soNavegador` olhava a janela INTEIRA de logs
// (≈ 5 dias) e exigia `dedup_scope` em TODOS os registros; os erros de 03/10
// (anteriores ao marcador, PR #458) mantinham a supressão desligada, mesmo com
// todo erro das últimas 24h já marcado. O aviso só olha as últimas 24h
// (`ocorreuRecentemente`), então a supressão também só pode olhar elas.
describe('soNavegador decide pelas últimas 24h (item 257)', () => {
  const AGORA = Date.parse('2026-10-06T12:00:00.000Z');
  const RECENTE = '2026-10-06T09:30:00.000Z';
  const ANTIGO = '2026-10-03T08:00:00.000Z'; // dias antes, ANTES do marcador
  const log = (over = {}) => ({ module: 'scanner', message: 'Erro no scan de BTCUSDT: Failed to fetch', symbol: 'BTCUSDT', ...over });
  const antigoSemMarcador = (over = {}) => log({ executor: 'browser', created_date: ANTIGO, ...over });
  const recenteMarcado = (over = {}) => log({ executor: 'browser', created_date: RECENTE, details: { dedup_scope: 'executor' }, ...over });

  it('REGRESSÃO: erro antigo sem marcador NÃO mantém o aviso quando tudo das últimas 24h é navegador marcado', () => {
    const [g] = agrupar([antigoSemMarcador(), antigoSemMarcador({ symbol: 'ETHUSDT' }), recenteMarcado()], AGORA);
    expect(soNavegador(g)).toBe(true);
    expect(notaSoNavegador(g)).toContain('não gera aviso');
  });

  it('continua avisando se um registro RECENTE não tem o marcador (pode esconder o cron)', () => {
    const [g] = agrupar([antigoSemMarcador(), recenteMarcado(), recenteMarcado({ details: {} })], AGORA);
    expect(soNavegador(g)).toBe(false);
  });

  it('continua avisando se o cron falhou nas últimas 24h', () => {
    const [g] = agrupar([antigoSemMarcador(), recenteMarcado(), recenteMarcado({ executor: 'cron' })], AGORA);
    expect(soNavegador(g)).toBe(false);
  });

  it('falha ANTIGA do cron (fora das 24h) não segura o aviso de hoje', () => {
    const [g] = agrupar([antigoSemMarcador({ executor: 'cron' }), recenteMarcado()], AGORA);
    expect(soNavegador(g)).toBe(true);
  });

  it('a nota qualifica o recorte: com falha antiga do cron no grupo, não afirma "o cron não falhou" sem limite de tempo (Codex P2, PR #471)', () => {
    const [g] = agrupar([antigoSemMarcador({ executor: 'cron' }), recenteMarcado()], AGORA);
    expect(descreverOrigem(g)).toContain('browser/cron');
    expect(notaSoNavegador(g)).toContain('nas últimas 24h');
  });

  it('sem nenhum registro recente o grupo nem vira achado; o critério cai para a janela inteira (comportamento do item 255)', () => {
    const [g] = agrupar([antigoSemMarcador()], AGORA);
    expect(ocorreuRecentemente(g, AGORA)).toBe(false);
    expect(soNavegador(g)).toBe(false);
  });

  it('registro sem created_date conta como recente (não dá para provar que é antigo)', () => {
    const [g] = agrupar([recenteMarcado(), log({ executor: 'browser', details: {} })], AGORA);
    expect(soNavegador(g)).toBe(false);
  });
});

// item 257 — a auditoria passou a gravar `online`/`visibility` do navegador
// (item 255) mas nunca os mostrava: sem isso a causa do "Failed to fetch"
// (rede caída × aba em segundo plano × aparelho acordando) seguia hipótese.
describe('descreverContextoNavegador (item 257)', () => {
  const browser = (details, over = {}) => ({ module: 'scanner', message: 'Erro no scan de BTCUSDT: Failed to fetch', symbol: 'BTCUSDT', executor: 'browser', created_date: '2026-10-06T09:30:00.000Z', details, ...over });

  it('conta aba oculta, visível, offline e sem dado', () => {
    const [g] = agrupar([
      browser({ online: true, visibility: 'hidden' }),
      browser({ online: true, visibility: 'hidden' }),
      browser({ online: true, visibility: 'visible' }),
      browser({ online: false, visibility: 'visible' }),
      browser({}),
      browser(undefined),
    ]);
    expect(descreverContextoNavegador(g)).toBe('aba oculta 2×, aba visível 2×, offline 1×, sem dado 2×');
  });

  it('só mostra o que ocorreu', () => {
    const [g] = agrupar([browser({ online: true, visibility: 'hidden' })]);
    expect(descreverContextoNavegador(g)).toBe('aba oculta 1×');
  });

  it('vazio quando não há registro do navegador (cron nunca tem esse contexto)', () => {
    const [g] = agrupar([browser({}, { executor: 'cron' })]);
    expect(descreverContextoNavegador(g)).toBe('');
  });

  it('ignora o contexto de registros do cron no meio do grupo', () => {
    const [g] = agrupar([browser({ online: true, visibility: 'hidden' }), browser({ online: false, visibility: 'visible' }, { executor: 'cron' })]);
    expect(descreverContextoNavegador(g)).toBe('aba oculta 1×');
  });
});
