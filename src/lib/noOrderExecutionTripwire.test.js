// Item 278 (PR-C) — tripwire de segurança. O Sentinel é um painel de
// sinalização: TP/Stop são virtuais e nenhuma ordem vai para a corretora
// (.claude/rules/trading-safety.md, READ_ONLY=true / LIVE_EXECUTION=false).
// O botão "🧪 Simular entrada (virtual)" deixa isso explícito na tela; este
// teste impede que código de envio de ordem entre no repositório sem alguém
// ver: endpoint de ordem da Binance, chave de API assinada, ccxt, createOrder
// ou um interruptor LIVE_EXECUTION ligado — e também alavancagem/margem e
// saque/transferência (as outras ações proibidas pela regra). Liberar exige a fase de segurança
// própria descrita na regra (e apagar/ajustar este teste conscientemente).
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const PASTAS = ['src', 'scripts', 'server', 'functions'].map(p => join(ROOT, p)).filter(existsSync);
const IGNORAR = new Set(['node_modules', 'dist', '__fixtures__']);

function arquivos(dir) {
  const out = [];
  for (const nome of readdirSync(dir)) {
    if (IGNORAR.has(nome)) continue;
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory()) { out.push(...arquivos(caminho)); continue; }
    if (!/\.(js|jsx|mjs|cjs|ts|tsx)$/.test(nome) || /\.test\.(js|jsx|mjs|ts|tsx)$/.test(nome)) continue;
    out.push(caminho);
  }
  return out;
}

const PROIBIDOS = [
  { nome: 'endpoint de ordem Spot/Futures da Binance', re: /\/(api\/v3|fapi\/v\d|dapi\/v\d|sapi\/v\d|papi\/v\d(\/(um|cm))?)\/(order|orderList|batchOrders|margin\/order)(\b|\/)/ },
  { nome: 'alavancagem/margem/posição (Futures)', re: /\/(fapi|dapi)\/v\d\/(leverage|marginType|positionMargin|positionSide)\b/ },
  { nome: 'saque/transferência de fundos', re: /\/sapi\/v\d\/(capital\/withdraw|asset\/transfer|futures\/transfer)\b/ },
  { nome: 'caminho "/order" montado por concatenação', re: /(['"`]|\})\/order(['"`?]|$)/m },
  { nome: 'cabeçalho de chave de API assinada', re: /X-MBX-APIKEY/i },
  { nome: 'biblioteca ccxt', re: /['"]ccxt['"]/ },
  { nome: 'createOrder/cancelOrder', re: /\b(createOrder|cancelOrder|newOrder)\s*\(/ },
  { nome: 'LIVE_EXECUTION ligado', re: /LIVE_EXECUTION\s*[:=]\s*(true|['"]true['"])/ },
];

function achados(lista) {
  const out = [];
  for (const caminho of lista) {
    const texto = readFileSync(caminho, 'utf8');
    for (const { nome, re } of PROIBIDOS) if (re.test(texto)) out.push(`${caminho.replace(ROOT, '.')}: ${nome}`);
  }
  return out;
}

describe('tripwire: nenhum código de envio de ordem real (item 278)', () => {
  it('src, scripts, server e functions não contêm envio de ordem', () => {
    const lista = PASTAS.flatMap(arquivos);
    expect(lista.length).toBeGreaterThan(100); // não-vacuidade: varreu o código de verdade
    expect(achados(lista)).toEqual([]);
  });

  it('pega cada padrão se ele for plantado (prova do guard)', () => {
    const plantados = [
      "await fetch('https://fapi.binance.com/fapi/v1/order', { method: 'POST' })",
      "fetch('https://api.binance.com/api/v3/order?symbol=BTCUSDT')",
      "headers: { 'X-MBX-APIKEY': key }",
      "import ccxt from 'ccxt';",
      'exchange.createOrder(symbol, "market", "buy", 1)',
      'const LIVE_EXECUTION = true;',
      "fetch(base + '/fapi/v1/leverage')",
      "fetch('https://api.binance.com/sapi/v1/capital/withdraw/apply')",
      "fetch('https://api.binance.com/api/v3/orderList/oto')",
      "fetch(FAPI + '/order')",
      "fetch(`${PAPI}/papi/v1/um/order`, { method: 'POST' })",
      'fetch(`${base}/order`)',
    ];
    for (const linha of plantados) {
      expect(PROIBIDOS.some(({ re }) => re.test(linha)), linha).toBe(true);
    }
    // E não acusa o que é leitura pública de mercado nem a política desligada.
    for (const linha of ["fetch('https://fapi.binance.com/fapi/v1/ticker/24hr')", 'LIVE_EXECUTION=false', "fetch('/api/v3/klines')", "<Route path='/order-history' />", 'fetch(`${base}/orders-summary`)']) {
      expect(PROIBIDOS.some(({ re }) => re.test(linha)), linha).toBe(false);
    }
  });
});
