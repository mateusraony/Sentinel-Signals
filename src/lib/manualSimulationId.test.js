// Item 278 (review do PR-C): o cartão do ativo confere se um aviso já foi
// simulado procurando `trade_manual_<id ou dedup_key>` — o mesmo id
// determinístico que `activateSignalManually` (src/lib/scanner.js) grava.
// O formato vive no motor, que este PR não altera; este teste trava a cópia:
// se o motor mudar o formato, o teste quebra em vez de a checagem "já
// simulado" parar de funcionar em silêncio.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (rel) => readFileSync(join(process.cwd(), rel), 'utf8');

describe('id da simulação manual: motor e cartão usam o mesmo formato', () => {
  it('scanner.js grava trade_manual_<signal.id || signal.dedup_key ...>', () => {
    expect(read('src/lib/scanner.js')).toMatch(/`trade_manual_\$\{signal\.id \|\| signal\.dedup_key \|\|/);
  });

  it('scanner.js grava a operação do motor como trade_<dedup_key> (1ª passada e retry 4h)', () => {
    const src = read('src/lib/scanner.js');
    expect(src).toMatch(/tradeOpId = `trade_\$\{signal\.dedup_key\}`/);
    expect(src).toMatch(/tradeOpId = `trade_\$\{sig\.dedup_key \|\| sig\.id\}`/);
  });

  it('AssetCard procura trade_<dedup_key || id> e trade_manual_<id || dedup_key>', () => {
    const card = read('src/components/dashboard/AssetCard.jsx');
    expect(card).toMatch(/const engineKey = sig\.dedup_key \|\| sig\.id;/);
    expect(card).toMatch(/TradeOperation\.get\(`trade_\$\{engineKey\}`\)/);
  });

  it('AssetCard procura trade_manual_<sig.id || sig.dedup_key>', () => {
    const card = read('src/components/dashboard/AssetCard.jsx');
    expect(card).toMatch(/const key = sig\.id \|\| sig\.dedup_key;/);
    expect(card).toMatch(/TradeOperation\.get\(`trade_manual_\$\{key\}`\)/);
  });
});
