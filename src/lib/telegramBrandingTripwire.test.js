// Auditoria do Telegram (2026-09-29), item 1.6/1.9 — rebranding "CryptoRadar"
// -> "Sentinel Signals" em todo texto visível ao usuário (mensagens do
// Telegram, tela de loading, rodapé do PDF mensal). A chave interna de
// localStorage (`cryptoradar_telegram_cfg`/`cryptoradar_pine_config`) foi
// deixada de propósito — não é visível ao usuário e trocá-la exigiria
// migração de dado já salvo (fora de escopo desta rodada).
//
// Lê o texto-fonte em vez de importar os módulos: scripts/adminTelegram.js
// depende de firebase-admin/RTDB no carregamento de algumas funções e
// TelegramSettings.jsx é um componente React — nenhum dos dois precisa
// rodar para este teste, só precisa não conter a string antiga.
//
// Regex é case-sensitive de propósito: "CryptoRadar" (marca, com maiúsculas)
// nunca deveria voltar; "cryptoradar_..." (chave interna, minúscula) é
// esperado e não deve derrubar este teste.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const BRAND_REGRESSION = /CryptoRadar/;

const FILES_WITH_USER_VISIBLE_TEXT = [
  './telegram.js',
  '../../scripts/adminTelegram.js',
  '../components/settings/TelegramSettings.jsx',
  '../App.jsx',
  '../pages/MonthlyReport.jsx',
];

describe('Rebranding CryptoRadar → Sentinel Signals — tripwire de regressão', () => {
  for (const rel of FILES_WITH_USER_VISIBLE_TEXT) {
    it(`"CryptoRadar" não reaparece em ${rel}`, () => {
      const source = readFileSync(resolve(__dirname, rel), 'utf-8');
      expect(source).not.toMatch(BRAND_REGRESSION);
    });
  }
});
