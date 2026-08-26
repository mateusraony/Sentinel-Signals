// docs/known-risks.md item 132 — o trailing pré-TP1 foi promovido de
// backtest-only para LIGADO por padrão em 2026-08-26 (decisão do usuário,
// depois da medição contra a grade pré-registrada: mesma expectância dentro
// do ruído, sd(R) -35%, max drawdown pela metade). Este arquivo SUBSTITUI
// src/lib/preTp1TrailTripwire.test.js, cuja premissa ("essas 3 chaves NUNCA
// aparecem em pineParser.js/adminPineConfig.js") ficou falsa por construção
// — manter aquele teste como estava faria CI vermelho na promoção
// intencional. Este cobre o invariante que substitui o antigo: os 3 arquivos
// que espelham DEFAULTS à mão (browser/cron/backtest) concordam no valor
// promovido, e uma op nova nasce com o modo promovido sem nenhum
// --pine-config.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { getPineConfig as getBacktestConfig } from '../../scripts/backtestPineConfig.js';

// Mocked the same way telegram.test.js mocks pineParser.js's sibling module
// (same firebaseClient-avoidance reason as the comment below) — this lets
// getPineConfig/getLocalPineConfig be imported and exercised for REAL,
// instead of only regex-checked as text, for the localStorage-staleness
// regression test below.
vi.mock('./logger', () => ({
  logWarn: vi.fn(),
  logError: vi.fn(),
}));
vi.mock('@/api/entities', () => ({
  backend: { entities: { StrategyConfig: { get: vi.fn().mockResolvedValue(null) } } },
}));

const __dirname = dirname(fileURLToPath(import.meta.url));

const VALORES_ESPERADOS = {
  preTp1StopProtectionEnabled: true,
  preTp1TrailEnabled: true,
  preTp1TrailStartAtrMult: 1.0,
  preTp1TrailAtrMult: 2.0,
};

// Forma exata como o literal aparece no texto-fonte (`1.0`, não `1`) — só
// usada pelo teste que lê adminPineConfig.js como texto, porque esse
// arquivo não pode ser importado em ambiente de teste (ver comentário
// abaixo).
const LITERAL_FONTE = {
  preTp1StopProtectionEnabled: 'true',
  preTp1TrailEnabled: 'true',
  preTp1TrailStartAtrMult: '1.0',
  preTp1TrailAtrMult: '2.0',
};

describe('trailing pré-TP1 — promovido a LIGADO por padrão (item 132)', () => {
  // pineParser.js não pode ser importado direto aqui: puxa ./logger, que
  // por sua vez chega em firebaseClient.js (getAuth() no top-level) e
  // quebra com FirebaseError fora do browser sem uma API key real — mesmo
  // motivo pelo qual o tripwire antigo já lia o texto-fonte em vez de
  // importar. Regex simples: os 3 arquivos são objetos literais estáticos
  // ("Keep DEFAULTS mirrored by hand", comentário de topo de
  // backtestPineConfig.js), sem indireção que confunda o parser.
  it('src/lib/pineParser.js (browser): DEFAULTS no texto-fonte tem os 4 campos no valor promovido', () => {
    const source = readFileSync(resolve(__dirname, './pineParser.js'), 'utf-8');
    for (const [chave, literal] of Object.entries(LITERAL_FONTE)) {
      const m = source.match(new RegExp(`\\b${chave}\\s*:\\s*([^,\\n]+),`));
      expect(m, `${chave} ausente de DEFAULTS`).not.toBeNull();
      expect(m[1].trim(), chave).toBe(literal);
    }
  });

  it('scripts/backtestPineConfig.js: getPineConfig() sem nenhum override devolve os 4 campos no valor promovido', async () => {
    const config = await getBacktestConfig();
    for (const [chave, valor] of Object.entries(VALORES_ESPERADOS)) {
      expect(config[chave], chave).toBe(valor);
    }
  });

  // scripts/adminPineConfig.js inicializa firebase-admin no top-level
  // (precisa de FIREBASE_SERVICE_ACCOUNT_JSON, ausente no ambiente de
  // teste) — mesmo motivo pelo qual o tripwire antigo lia o texto-fonte em
  // vez de importar. Regex simples: os 3 arquivos são objetos literais
  // estáticos ("Keep DEFAULTS mirrored by hand", comentário de topo de
  // backtestPineConfig.js), sem indireção que confunda o parser.
  it('scripts/adminPineConfig.js (cron): DEFAULTS no texto-fonte tem os 4 campos no valor promovido', () => {
    const source = readFileSync(resolve(__dirname, '../../scripts/adminPineConfig.js'), 'utf-8');
    for (const [chave, literal] of Object.entries(LITERAL_FONTE)) {
      const m = source.match(new RegExp(`\\b${chave}\\s*:\\s*([^,\\n]+),`));
      expect(m, `${chave} ausente de DEFAULTS`).not.toBeNull();
      expect(m[1].trim(), chave).toBe(literal);
    }
  });

  it('as 3 chaves novas (preTp1Trail*) estão nas listas de sync do browser e do cron', () => {
    const browserSource = readFileSync(resolve(__dirname, './pineParser.js'), 'utf-8');
    const cronSource = readFileSync(resolve(__dirname, '../../scripts/adminPineConfig.js'), 'utf-8');
    for (const chave of ['preTp1TrailEnabled', 'preTp1TrailStartAtrMult', 'preTp1TrailAtrMult']) {
      expect(browserSource, `${chave} ausente de alguma lista de sync (browser)`).toMatch(new RegExp(`'${chave}'`));
      expect(cronSource, `${chave} ausente da lista de sync (cron)`).toMatch(new RegExp(`'${chave}'`));
    }
  });

  // Codex review (PR #258, P1): um usuário que salvou o Pine script ANTES
  // desta promoção tem um blob de localStorage carregando
  // preTp1StopProtectionEnabled: false para sempre — parsePineScript() nunca
  // sobrescreve essa chave (sem input.*() correspondente no Pine), então o
  // valor gravado é sempre o DEFAULTS de quando o usuário salvou por último.
  // Sem correção, getPineConfig()/getLocalPineConfig() faziam
  // {...DEFAULTS, ...localStorage}, deixando esse blob antigo vencer o novo
  // default `true`. Reproduz o bug real (o teste falha sem
  // stripNonPineSyncedKeys em pineParser.js) e prova a correção.
  describe('cache antigo em localStorage não mascara a promoção (Codex P1, PR #258)', () => {
    function makeLocalStorage(initial) {
      const store = new Map(Object.entries(initial ?? {}));
      return {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k),
        clear: () => store.clear(),
      };
    }

    it('getPineConfig(): blob salvo antes do deploy (preTp1StopProtectionEnabled: false) não sobrevive — DEFAULTS promovido vence', async () => {
      globalThis.localStorage = makeLocalStorage({
        cryptoradar_pine_config: JSON.stringify({
          // Blob real de um usuário: DEFAULTS de antes da promoção, gravado
          // por parsePineScript() num save de Pine script anterior a
          // 2026-08-26 — junto de um valor GENUINAMENTE parseado do Pine
          // (rng_per), que precisa continuar vindo do cache normalmente.
          preTp1StopProtectionEnabled: false,
          preTp1TrailEnabled: false,
          rng_per: 55,
        }),
      });
      const { getPineConfig } = await import('./pineParser.js');
      const config = await getPineConfig();
      expect(config.preTp1StopProtectionEnabled, 'mestre deveria seguir o DEFAULTS promovido, não o cache antigo').toBe(true);
      expect(config.preTp1TrailEnabled).toBe(true);
      // Prova que a correção não é um bypass geral do cache — valores
      // genuinamente Pine-parsed continuam vindo do localStorage.
      expect(config.rng_per, 'valor Pine-parsed real não deveria ser afetado pelo strip').toBe(55);
    });

    it('getLocalPineConfig() (leitura síncrona): mesma proteção, sem round-trip ao Firestore', async () => {
      globalThis.localStorage = makeLocalStorage({
        cryptoradar_pine_config: JSON.stringify({ preTp1StopProtectionEnabled: false, preTp1TrailEnabled: false }),
      });
      const { getLocalPineConfig } = await import('./pineParser.js');
      const config = getLocalPineConfig();
      expect(config.preTp1StopProtectionEnabled).toBe(true);
      expect(config.preTp1TrailEnabled).toBe(true);
    });
  });
});
