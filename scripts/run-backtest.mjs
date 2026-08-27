// CLI entry point for the historical backtest (see
// docs/claude/backtest-usage.md for the full local-only flow). Bundled with
// esbuild (scripts/build-backtest.mjs) before running — see that file for
// why a plain `node scripts/run-backtest.mjs` won't work directly (same
// reason as scripts/run-scan.mjs).
//
// Usage:
//   node scripts/dist/run-backtest.mjs \
//     --symbols BTCUSDT,ETHUSDT \
//     --from 2026-01-01T00:00:00Z --to 2026-06-01T00:00:00Z \
//     [--evaluation-from 2026-02-01T00:00:00Z] [--evaluation-to 2026-06-01T00:00:00Z] \
//     [--data-dir scripts/__fixtures__/backtest] \
//     [--smc BTCUSDT] [--smc-confirm BTCUSDT] \
//     [--pine-config ./my-pine-overrides.json] \
//     [--step-ms 900000] [--out ./backtest-report.json] \
//     [--no-costs] [--fee-bps 5] [--slippage-bps 1] [--funding-bps 1] \
//     [--real-funding] [--min-trades 30] [--trial-label "ob-weight-7"]
//
// --real-funding (docs/known-risks.md item 131): cobra funding pela taxa REAL
// publicada, com sinal e por lado (vendido RECEBE quando a taxa é positiva),
// em vez da constante --funding-bps. Exige rodar antes
// `node scripts/fetch-backtest-funding.mjs` para os MESMOS símbolos/período.
//
// --evaluation-from/--evaluation-to (docs/known-risks.md item 47.2, both
// optional, default = --from/--to): --from/--to continue to be the DATA
// window the simulated clock runs over (indicators need it to warm up —
// ~6x their own period, .claude/rules/pine-parity.md); --evaluation-from/-to
// is the SCORED window — only operations opened inside it count toward the
// report. Fetch data starting well before --evaluation-from (same practice
// docs/claude/backtest-usage.md already recommends manually) and this flag
// makes the engine actually exclude the cold-start trades instead of
// silently scoring them.
//
// Custos (Fase 5, docs/known-risks.md item 44): taxa, slippage e funding
// são descontados POR PADRÃO. --no-costs roda a custo zero e serve para o
// A/B "quanto o custo comeu" — é também o modo que reproduz exatamente os
// números de antes da Fase 5. --trial-label só é gravado no JSON: serve
// para você contar quantas configurações já testou, que é o número que
// torna qualquer conclusão futura interpretável (overfitting).
//
// --smc and --smc-confirm are INDEPENDENT (mirrors asset.smc_enabled vs.
// asset.smc_confirm_4h15m in scanner.js — see MonitoredAsset.jsonc): --smc
// turns on the parallel 1h→5m SMC cascade (its own trades show up under
// report.byCascade['1h_5m'], next to the 4h/15m one, so a single run already
// compares plain RF vs. SMC side by side); --smc-confirm makes the EXISTING
// 4h/15m RF cascade stricter (requires 4h SMC structure/zone agreement) —
// it does not require --smc, and --smc does not imply it.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { runBacktest } from '../src/lib/backtestEngine.js';
import { analyzeReport } from '../src/lib/backtestAnalysis.js';
import { ZERO_COST, tradesForCIHalfWidth } from '../src/lib/tradeMetrics.js';
import { backend } from '@/api/entities';
import { setPineConfigOverrides, getPineConfig } from './backtestPineConfig.js';
import { loadSeries } from './backtestMarketDataProvider.js';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith('--')) continue;
    const key = tok.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { args[key] = true; continue; }
    args[key] = next;
    i++;
  }
  return args;
}

function makeAsset(symbol, { smcSymbols, smcConfirmSymbols, rfPeriod, rfMultiplier }) {
  return {
    id: symbol,
    symbol,
    display_name: symbol,
    is_active: true,
    timeframes_enabled: { '1h': true, '4h': true, '1d': true },
    rf_period: rfPeriod,
    rf_multiplier: rfMultiplier,
    // Off by default here — a backtest asset list is explicit CLI input,
    // not a panel action, so each stays opt-in via its own flag rather
    // than silently inheriting the live-panel default (AddAssetForm.jsx,
    // itself `false` again since 2026-08-20, docs/known-risks.md item 108)
    // or each other.
    smc_enabled: smcSymbols.has(symbol),
    smc_confirm_4h15m: smcConfirmSymbols.has(symbol),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.symbols || !args.from || !args.to) {
    console.error('Uso: run-backtest.mjs --symbols SYM1,SYM2 --from ISO --to ISO [--evaluation-from ISO] [--evaluation-to ISO] [--data-dir DIR] [--smc SYM1,SYM2] [--smc-confirm SYM1,SYM2] [--pine-config FILE] [--step-ms N] [--out FILE] [--no-costs] [--fee-bps N] [--slippage-bps N] [--funding-bps N] [--real-funding] [--min-trades N] [--trial-label TXT]');
    process.exitCode = 1;
    return;
  }

  if (args['data-dir']) process.env.BACKTEST_DATA_DIR = args['data-dir'];

  if (args['pine-config']) {
    const raw = fs.readFileSync(args['pine-config'], 'utf-8');
    let overrides;
    try {
      overrides = JSON.parse(raw);
    } catch (err) {
      // Causa mais comum na prática (docs/claude/backtest-usage.md): aspas
      // tipográficas/curvas em vez de retas, coladas de um editor com
      // autocorreção de texto ligada.
      console.error(`[backtest] --pine-config não é JSON válido: ${err.message}`);
      console.error('Causa mais comum: aspas tipográficas/curvas (“ ”) em vez de aspas retas ("). Regrave o arquivo com um editor de texto simples. Exemplo válido: {"allowedSide":"SELL"}');
      process.exitCode = 1;
      return;
    }
    setPineConfigOverrides(overrides);
  }

  const symbols = String(args.symbols).split(',').map((s) => s.trim()).filter(Boolean);
  const smcSymbols = new Set(String(args.smc || '').split(',').map((s) => s.trim()).filter(Boolean));
  const smcConfirmSymbols = new Set(String(args['smc-confirm'] || '').split(',').map((s) => s.trim()).filter(Boolean));
  const rfPeriod = args['rf-period'] ? Number(args['rf-period']) : 20;
  const rfMultiplier = args['rf-multiplier'] ? Number(args['rf-multiplier']) : 3.5;
  const assets = symbols.map((symbol) => makeAsset(symbol, { smcSymbols, smcConfirmSymbols, rfPeriod, rfMultiplier }));

  const fromMs = new Date(args.from).getTime();
  const toMs = new Date(args.to).getTime();
  const stepMs = args['step-ms'] ? Number(args['step-ms']) : undefined;
  // Warm-up (docs/known-risks.md item 47.2) — opcional, default = --from/--to
  // (comportamento idêntico a antes desta flag existir). Passe --from/--to
  // com um buffer de aquecimento ANTES da janela que você quer medir de
  // verdade, e diga onde ela começa/termina com estas duas flags — só
  // operações abertas dentro delas entram no relatório.
  const evaluationFromMs = args['evaluation-from'] ? new Date(args['evaluation-from']).getTime() : undefined;
  const evaluationToMs = args['evaluation-to'] ? new Date(args['evaluation-to']).getTime() : undefined;

  // Funding REAL (docs/known-risks.md item 131) — opt-in por --real-funding,
  // lendo os arquivos que scripts/fetch-backtest-funding.mjs gravou no MESMO
  // diretório dos candles. Quando ligado, substitui a constante
  // `fundingBpsPer8h` por taxa real, com sinal e por lado (SELL recebe quando
  // a taxa é positiva). Símbolo sem arquivo cai na constante — e isso é
  // avisado alto, porque uma carteira meio-real/meio-constante mediria uma
  // mistura que nenhuma das duas hipóteses descreve.
  // Piso de cobertura da série de funding. Não é 100% de propósito: pares com
  // intervalo de funding != 8h, listagem no meio do período e o mês corrente
  // ainda não consolidado produzem contagens legitimamente diferentes do
  // esperado por 8h. 90% recusa buraco real sem reprovar essas variações.
  const COBERTURA_MINIMA_FUNDING = 0.9;
  let fundingSeries = null;
  if (args['real-funding'] && !args['no-costs']) {
    const dataDir = args['data-dir'] || path.join('scripts', '__fixtures__', 'backtest');
    fundingSeries = {};
    const faltando = [];
    for (const symbol of symbols) {
      const file = path.join(dataDir, `${symbol}_funding.json`);
      if (!fs.existsSync(file)) { faltando.push(symbol); continue; }
      const rows = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (!Array.isArray(rows) || rows.length === 0) { faltando.push(symbol); continue; }

      // Codex review (PR #252, P1): "arquivo existe e não está vazio" não é
      // cobertura. Um download parcial (404 diário engolido, mês não
      // publicado) daria uma série com buraco, e operações dentro do buraco
      // não casariam liquidação nenhuma. calcFundingCost já protege por
      // operação (cai na constante, marcado `series_incomplete`), mas é
      // melhor recusar o run inteiro aqui do que produzir um relatório
      // rotulado "funding real" que na verdade é uma mistura.
      // Contagem sozinha NÃO detecta lacuna contígua: no Run #136 as 7 séries
      // pararam em 2026-07-31 (mês corrente não publicado) e mesmo assim
      // marcaram 94,8% de cobertura, porque faltavam só os 20 dias do fim.
      // A janela precisa estar COBERTA, não apenas densa — e falhar aqui custa
      // segundos, enquanto falhar depois custa os ~28 min do replay.
      const MAX_INTERVALO_FUNDING_MS = 8 * 60 * 60 * 1000;
      const primeiro = rows[0].calcTime;
      const ultimo = rows[rows.length - 1].calcTime;
      if (primeiro > fromMs + MAX_INTERVALO_FUNDING_MS || ultimo < toMs - MAX_INTERVALO_FUNDING_MS) {
        console.error(
          `[backtest] ERRO: funding de ${symbol} não cobre a janela pedida. `
          + `Série vai de ${new Date(primeiro).toISOString()} a ${new Date(ultimo).toISOString()}, `
          + `mas o período é ${new Date(fromMs).toISOString()} → ${new Date(toMs).toISOString()}. `
          + 'A Binance só publica o arquivo MENSAL depois que o mês fecha, então uma janela que '
          + 'termina no mês corrente sempre ficará truncada: rode com --to no fim do último mês '
          + 'fechado, ou rebaixe a série.',
        );
        process.exitCode = 1;
        return;
      }

      const esperado = Math.floor((toMs - fromMs) / (8 * 60 * 60 * 1000));
      const cobertura = esperado > 0 ? rows.length / esperado : 0;
      if (cobertura < COBERTURA_MINIMA_FUNDING) {
        console.error(
          `[backtest] ERRO: funding de ${symbol} cobre só ${Math.round(cobertura * 100)}% `
          + `das ${esperado} janelas de 8h do período (${rows.length} liquidações). `
          + 'Rebaixe a série (rode scripts/fetch-backtest-funding.mjs de novo) antes de comparar — '
          + 'um relatório "funding real" com lacuna subestima custo silenciosamente.',
        );
        process.exitCode = 1;
        return;
      }
      fundingSeries[symbol] = rows;
      console.log(`[backtest] funding real: ${symbol} — ${rows.length} liquidações (${Math.round(cobertura * 100)}% de cobertura)`);
    }
    if (faltando.length > 0) {
      console.warn(`[backtest] AVISO: sem funding real para ${faltando.join(', ')} — esses símbolos usam a constante. Rode scripts/fetch-backtest-funding.mjs para o mesmo período/carteira antes de comparar.`);
    }
    if (Object.keys(fundingSeries).length === 0) {
      console.warn('[backtest] AVISO: --real-funding pedido mas NENHUM símbolo tem série — rodando 100% na constante.');
      fundingSeries = null;
    }
  }

  // Modelo de custo. Sem flag nenhuma => DEFAULT_COST_MODEL (taxa real).
  // --no-costs => ZERO_COST, que reproduz os números pré-Fase-5. ZERO_COST
  // vem por ÚLTIMO de propósito: zera inclusive a série de funding, senão um
  // run --no-costs deixaria de reproduzir o baseline pré-Fase-5.
  const costModel = args['no-costs']
    ? ZERO_COST
    : {
        ...(args['fee-bps'] !== undefined
          ? { feeBpsEntry: Number(args['fee-bps']), feeBpsExit: Number(args['fee-bps']) }
          : {}),
        ...(args['slippage-bps'] !== undefined ? { slippageBpsPerSide: Number(args['slippage-bps']) } : {}),
        ...(args['funding-bps'] !== undefined ? { fundingBpsPer8h: Number(args['funding-bps']) } : {}),
        ...(fundingSeries ? { fundingSeries } : {}),
      };
  const minTrades = args['min-trades'] ? Number(args['min-trades']) : undefined;

  console.log(`[backtest] ${symbols.join(', ')} de ${new Date(fromMs).toISOString()} a ${new Date(toMs).toISOString()}`);
  if (evaluationFromMs !== undefined || evaluationToMs !== undefined) {
    console.log(`[backtest] janela avaliada (warm-up): ${new Date(evaluationFromMs ?? fromMs).toISOString()} a ${new Date(evaluationToMs ?? toMs).toISOString()}`);
  }

  // Reprodutibilidade (docs/known-risks.md item 47.2) — antes disso, comparar
  // dois relatórios meses depois exigia lembrar de cabeça qual commit/config
  // gerou cada um. commitSha ausente (checkout raso, sem .git) não bloqueia o
  // run — fica null, honesto sobre o que não deu pra capturar.
  const runStartedAt = new Date().toISOString();
  let commitSha = null;
  try {
    commitSha = execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
  } catch (e) {
    console.warn(`[backtest] não foi possível capturar o commit SHA: ${e.message}`);
  }
  const effectivePineConfig = await getPineConfig();

  // performance.now(), NÃO Date.now(): runBacktest instala um relógio simulado
  // (installSimClock troca o `Date` global) antes de chamar onStep, então
  // `Date.now()` DENTRO do callback devolve o cursor do replay, não a hora de
  // parede — e numa janela histórica a subtração dá NEGATIVO. Achado por
  // revisão externa (Codex, PR #93) depois de eu cair exatamente nisso.
  // `performance.now()` é monotônico e independente do `Date` global.
  // Regressão em backtestEngine.test.js ("onStep roda com o relógio simulado
  // ativo"), que documenta a armadilha para o próximo callback.
  const started = performance.now();
  let lastLoggedPct = -1;
  // docs/known-risks.md item 69 (Fase 1) — busca binária pelo primeiro
  // candle com closeTime ESTRITAMENTE depois do sinal, igual ao espírito de
  // sliceClosedAsOf (backtestEngine.js) mas na direção oposta (candles
  // FUTUROS ao instante, não passados). O único limite é `toMs` — o
  // fechamento declarado deste replay — NUNCA uma contagem arbitrária de
  // candles. Codex review (PR #154): (P2) um `limit` fixo de 200 candles
  // fechava runners "vivos" há mais de ~33 dias como STILL_OPEN_AT_CUTOFF
  // mesmo quando o candle de saída real já estava carregado logo depois;
  // (P1) sem clampar em `toMs`, um diretório de dados mais amplo que a
  // janela pedida (`docs/claude/backtest-usage.md` recomenda baixar uma vez
  // e reusar em replays menores) vazava candles de FORA do replay declarado
  // pro simulador — contaminação de janela, exatamente o tipo de furo que a
  // guarda de holdout deste projeto existe para evitar.
  function getFutureCandles(symbol, timeframe, afterMs) {
    const series = loadSeries(symbol, timeframe);
    let lo = 0, hi = series.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (series[mid].closeTime > afterMs) hi = mid;
      else lo = mid + 1;
    }
    let end = lo;
    while (end < series.length && series[end].closeTime <= toMs) end++;
    return series.slice(lo, end);
  }
  const report = await runBacktest({
    assets, backend, fromMs, toMs, evaluationFromMs, evaluationToMs, stepMs, costModel, minTrades,
    pineConfig: effectivePineConfig,
    getFutureCandles,
    onStep(t, err) {
      if (err) {
        console.warn(`[backtest] ${err.asset} falhou em ${new Date(t).toISOString()}: ${err.error}`);
        return;
      }
      const pct = Math.floor(((t - fromMs) / (toMs - fromMs)) * 100);
      if (pct >= lastLoggedPct + 10) {
        lastLoggedPct = pct;
        // Decorrido + projeção, não só a porcentagem. O run de 4 anos rodou
        // 5h25min e só se revelou impossível quando o job foi cortado no
        // timeout — o log mostrava percentuais avançando e nada dizia se ia
        // terminar. Com isto, o marco de 10% já permite decidir entre deixar
        // rodar e cancelar.
        //
        // A projeção é LINEAR e por isso OTIMISTA: o replay tem termo
        // superlinear conhecido (fakeBackend.filter fica mais caro conforme o
        // store de SignalEvent cresce — docs/roadmap.md, Bloco 0), então o
        // total real tende a passar do projetado. O rótulo "mínimo" existe
        // para a projeção não ser lida como promessa.
        const decorridoMin = (performance.now() - started) / 60000;
        const projecao = pct > 0 ? (decorridoMin / pct) * 100 : null;
        const sufixo = projecao === null
          ? ''
          : ` — ${decorridoMin.toFixed(1)}min decorridos, projeção ≥${projecao.toFixed(0)}min`;
        console.log(`[backtest] ${pct}% (${new Date(t).toISOString()})${sufixo}`);
      }
    },
  });

  // docs/known-risks.md item 117/118 — `report.entryFunnel` conta REJEIÇÕES
  // (uma por avaliação de retry), não sinais distintos que nunca confirmaram
  // — um sinal preso no mesmo gate por N passadas de retry conta N vezes, e
  // um sinal que expira sem nunca ter sido reavaliado (ex.: single-shot,
  // sem retry algum) não aparece ali. Query direta no backend fake (o mesmo
  // SignalEvent.expired_logged/last_rejection_reason que a produção grava —
  // scanner.js, não uma trilha nova) fecha essa lacuna: quantos sinais
  // DISTINTOS, por origem, expiraram sem nunca virar TradeOperation, e por
  // qual motivo final. Janela igual à de avaliação (evaluationFromMs/ToMs
  // quando dado, senão fromMs/toMs) — mesmo recorte que entryFunnel já usa
  // via evalFromMs/evalToMs em backtestEngine.js.
  const expiredSignals = await backend.entities.SignalEvent.filter({ expired_logged: true });
  const signalExpiryFromMs = evaluationFromMs ?? fromMs;
  const signalExpiryToMs = evaluationToMs ?? toMs;
  const signalExpiry = {};
  for (const sig of expiredSignals) {
    const t = new Date(sig.candle_time || sig.created_date).getTime();
    if (t < signalExpiryFromMs || t > signalExpiryToMs) continue;
    const bucket = (signalExpiry[sig.source] ||= { total: 0, byReason: {} });
    bucket.total += 1;
    const reason = sig.last_rejection_reason || 'unknown';
    bucket.byReason[reason] = (bucket.byReason[reason] || 0) + 1;
  }
  report.signalExpiry = signalExpiry;

  console.log(`[backtest] concluído em ${((performance.now() - started) / 1000).toFixed(1)}s`);
  console.log(`[backtest] total de operações: ${report.totalOps} (ainda abertas no corte: ${report.stillOpenAtCutoff})`);
  console.log('[backtest] signalExpiry (sinais distintos que expiraram sem nunca confirmar):', report.signalExpiry);
  console.log('[backtest] geral:', report.overall);
  for (const [cascade, summary] of Object.entries(report.byCascade)) {
    console.log(`[backtest] cascata ${cascade}:`, summary);
  }
  // Was previously only printed by backtest.yml's separate "Publicar resumo"
  // step (which writes to $GITHUB_STEP_SUMMARY, not stdout) — invisible to
  // anything reading the job's console log directly (e.g. get_job_logs).
  // Same data, now visible from both the CLI and CI without needing GitHub
  // Summary UI access.
  console.log('[backtest] smcDiagnostics:', report.smcDiagnostics);
  // known-risks item 45.3/49 — "muitos sinais, poucas operações": qual gate
  // do funil de confirmação rejeita mais, nas duas cascatas.
  console.log('[backtest] entryFunnel 4h_15m:', report.entryFunnel['4h_15m']);
  console.log('[backtest] entryFunnel 1h_5m:', report.entryFunnel['1h_5m']);
  console.log('[backtest] custos:', report.costs);

  // O veredito de amostra fica DEPOIS de tudo e em destaque de propósito: um
  // relatório com poucas operações produz win rate e profit factor de aparência
  // perfeitamente normal, e é exatamente aí que uma decisão errada nasce.
  if (!report.costs.conclusive) {
    const { countedTrades, minTrades: min, inconclusiveReason, expectancyRCI95 } = report.costs;
    const motivo = inconclusiveReason === 'sample_too_small'
      ? `amostra pequena demais (${countedTrades} operações fechadas, mínimo ${min})`
      : inconclusiveReason === 'ci_straddles_zero'
        ? `o intervalo de confiança da expectância cruza zero [${expectancyRCI95.map((v) => v.toFixed(3)).join(', ')}]`
        : 'não há operações com R calculável';
    console.log('');
    console.log('  ⚠️  RESULTADO INCONCLUSIVO — não tire conclusão deste relatório.');
    console.log(`      Motivo: ${motivo}.`);
    console.log('      Win rate e profit factor acima são ruído nesta amostra.');
    console.log('');
  } else {
    console.log(`[backtest] amostra suficiente: ${report.costs.countedTrades} operações, expectância líquida ${report.costs.netExpectancyR?.toFixed(3)}R`);
  }

  // docs/known-risks.md item 133 — ALVO DECLARADO: estreitar o IC, não
  // provar edge. Impresso SEMPRE (conclusivo ou não), porque é a única
  // métrica aqui que progride monotonicamente com amostra e responde a
  // pergunta acionável: "que tamanho de vantagem esta amostra já descarta?".
  // "Inconclusivo" continua sendo verdade e continua sendo impresso acima —
  // o que muda é que ele deixa de ser o fim da leitura.
  const meiaLargura = report.costs.expectancyRCI95HalfWidth;
  const sdPorOp = report.costs.expectancyRSd;
  if (Number.isFinite(meiaLargura) && Number.isFinite(sdPorOp) && sdPorOp > 0) {
    console.log('');
    console.log(`  📏 PODER DE DESCARTE (alvo do item 133) — meia-largura do IC95: ±${meiaLargura.toFixed(3)}R`);
    console.log(`      Esta amostra já descarta qualquer edge real maior que ~${meiaLargura.toFixed(3)}R.`);
    const alvos = [0.20, 0.15, 0.10];
    const linhas = alvos
      .filter((alvo) => alvo < meiaLargura)
      .map((alvo) => `±${alvo.toFixed(2)}R → ${tradesForCIHalfWidth(sdPorOp, alvo)} ops`);
    if (linhas.length) {
      console.log(`      Para estreitar (IC ingênuo, sd=${sdPorOp.toFixed(3)}): ${linhas.join(' · ')}`);
    }
    console.log('      Números INGÊNUOS — a correção por cluster costuma alargar neste projeto.');
    console.log('      Rode: node scripts/backtest-correlation-check.mjs --report <arquivo>');
    console.log('');
  }

  const outPath = args.out || 'backtest-report.json';
  // trialLabel/trialArgs: o "conte suas tentativas" da literatura de
  // overfitting reduzido ao mínimo — sem isso, comparar N relatórios meses
  // depois vira arqueologia. reproducibility (item 47.2) complementa: hash do
  // CONFIG EFETIVO (não só o caminho do arquivo --pine-config), commit e
  // instante do run — o que faltava pra distinguir "mesmos argumentos, código
  // diferente" de "mesmo código, config diferente".
  const configHash = createHash('sha256').update(JSON.stringify({
    pineConfig: effectivePineConfig,
    costModel,
    assets: assets.map((a) => ({
      symbol: a.symbol, smc_enabled: a.smc_enabled, smc_confirm_4h15m: a.smc_confirm_4h15m,
      rf_period: a.rf_period, rf_multiplier: a.rf_multiplier,
    })),
  })).digest('hex').slice(0, 16);
  const enriched = {
    ...report,
    trialLabel: args['trial-label'] || null,
    trialArgs: process.argv.slice(2).join(' '),
    reproducibility: {
      commitSha,
      configHash,
      runStartedAt,
      pineConfig: effectivePineConfig,
    },
  };
  fs.writeFileSync(outPath, JSON.stringify(enriched, null, 2));
  console.log(`[backtest] relatório completo salvo em ${outPath}`);

  // Trava final do funding real (item 131). As checagens de cobertura acima
  // olham a SÉRIE; esta olha o RESULTADO — quantas operações de fato casaram
  // liquidação real. É a única que pega contaminação cuja causa não é buraco
  // de dado: no Run #136, 22 de 24 operações caíram na constante porque a
  // Binance carimba `calc_time` alguns MILISSEGUNDOS depois da hora cheia e
  // a janela de cobrança é semiaberta — série 94,8% densa, cobertura
  // aprovada, e ainda assim 23% do relatório medindo a constante que este
  // trabalho existe para substituir. Um relatório assim não é "quase certo",
  // é a média de duas hipóteses diferentes: falha, não avisa.
  if (fundingSeries) {
    const { fundingModel, opsWithIncompleteFunding } = analyzeReport(enriched).cost;
    if (fundingModel !== 'series') {
      console.error(
        `[backtest] ERRO: --real-funding pedido, mas ${opsWithIncompleteFunding} de `
        + `${enriched.overall?.counted ?? '?'} operações não casaram a série real e caíram na `
        + `constante (fundingModel="${fundingModel}"). O relatório em ${outPath} mede uma MISTURA, `
        + 'não funding real — não compare com o controle. Rode scripts/fetch-backtest-funding.mjs '
        + 'de novo para o mesmo período/carteira, ou encurte --to até o fim do último mês fechado.',
      );
      process.exitCode = 1;
      return;
    }
    console.log(`[backtest] funding real: 100% das operações casaram a série (fundingModel="${fundingModel}").`);
  }
}

main().catch((err) => {
  console.error('[backtest] FALHOU:', err);
  process.exitCode = 1;
});
