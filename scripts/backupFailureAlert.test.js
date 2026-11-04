// docs/known-risks.md item 288, addendum de 04/11/2026.
//
// O backup diário ficou vermelho de 31/10 a 03/11 e ninguém soube. `avisar-falha` (job de
// backup.yml e backup-postgres.yml) manda um aviso no Telegram quando o backup AGENDADO falha, usando
// `scripts/telegram-workflow-alert.sh`. Estes testes rodam o script de verdade (bash, com um `curl`
// falso no PATH) e travam o desenho dos dois workflows. Cada defesa é provada falhando quando é tirada.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const RAIZ = process.cwd();
const SCRIPT = join(RAIZ, 'scripts', 'telegram-workflow-alert.sh');
const WORKFLOWS = ['backup.yml', 'backup-postgres.yml'];
const TOKEN = 'TOKEN-SECRETO-123:abcDEF';
const CHAT = '-100999';

let pasta;

// curl falso: grava os argumentos (um por linha) e responde conforme FAKE_CURL_MODE.
// No modo "neterr" imita o curl real, que cita a URL (com o token) na mensagem de erro em stderr.
const CURL_FALSO = `#!/usr/bin/env bash
printf '%s\\n' "$@" > "$FAKE_CURL_LOG"
url=""
for a in "$@"; do case "$a" in https://*) url="$a";; esac; done
case "\${FAKE_CURL_MODE:-ok}" in
  ok) printf '200'; exit 0;;
  http401) printf '401'; exit 0;;
  neterr) echo "curl: (7) Failed to connect to $url" >&2; printf '000'; exit 7;;
esac
`;

beforeAll(() => {
  pasta = mkdtempSync(join(tmpdir(), 'alerta-'));
  writeFileSync(join(pasta, 'curl'), CURL_FALSO);
  chmodSync(join(pasta, 'curl'), 0o755);
});
afterAll(() => rmSync(pasta, { recursive: true, force: true }));

function rodar(extraEnv = {}, scriptPath = SCRIPT) {
  const log = join(pasta, `args-${Math.random().toString(36).slice(2)}.txt`);
  const env = {
    PATH: `${pasta}:${process.env.PATH}`,
    HOME: pasta,
    FAKE_CURL_LOG: log,
    TELEGRAM_BOT_TOKEN: TOKEN,
    TELEGRAM_CHAT_ID: CHAT,
    ALERT_TITLE: 'Backup diário do Postgres FALHOU',
    ALERT_RUN_URL: 'https://github.com/o/r/actions/runs/123',
    ALERT_HINT: 'Abra o link e leia a mensagem em vermelho.',
    ...extraEnv,
  };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const r = spawnSync('bash', [scriptPath], { env, encoding: 'utf8' });
  return {
    status: r.status,
    saida: `${r.stdout}${r.stderr}`,
    chamou: existsSync(log),
    args: existsSync(log) ? readFileSync(log, 'utf8').split('\n') : [],
  };
}

describe('telegram-workflow-alert.sh (bash real, curl falso)', () => {
  it('envia: URL do bot, chat e texto com título, hora UTC, link da execução e dica', () => {
    const r = rodar();
    expect(r.status).toBe(0);
    expect(r.saida).toContain('Aviso de falha enviado');
    expect(r.args).toContain(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(r.args).toContain(`chat_id=${CHAT}`);
    const texto = r.args.join('\n');
    expect(texto).toContain('⚠️ Backup diário do Postgres FALHOU');
    expect(texto).toMatch(/Quando: \d{2}\/\d{2}\/\d{4} \d{2}:\d{2} UTC/);
    expect(texto).toContain('Veja o motivo: https://github.com/o/r/actions/runs/123');
    expect(texto).toContain('Abra o link e leia a mensagem em vermelho.');
  });

  it('manda o texto por --data-urlencode (acentos e quebras de linha seguros) e sem parse_mode', () => {
    const r = rodar();
    expect(r.args).toContain('--data-urlencode');
    expect(r.args.join(' ')).not.toContain('parse_mode');
  });

  it('o token nunca aparece na saída do script', () => {
    for (const modo of ['ok', 'http401', 'neterr']) {
      const r = rodar({ FAKE_CURL_MODE: modo });
      expect(r.saida).not.toContain('TOKEN-SECRETO');
      expect(r.saida).not.toContain('api.telegram.org');
    }
  });

  it('sem os segredos do Telegram: avisa, sai com 0 e nem chama a rede', () => {
    for (const faltando of [{ TELEGRAM_BOT_TOKEN: '' }, { TELEGRAM_CHAT_ID: '' }, { TELEGRAM_BOT_TOKEN: undefined }]) {
      const r = rodar(faltando);
      expect(r.status).toBe(0);
      expect(r.chamou).toBe(false);
      expect(r.saida).toContain('::warning::');
      expect(r.saida).toContain('NÃO foi enviado');
    }
  });

  it('Telegram recusa (HTTP 401): continua saindo com 0 e diz o código, sem vazar nada', () => {
    const r = rodar({ FAKE_CURL_MODE: 'http401' });
    expect(r.status).toBe(0);
    expect(r.saida).toContain('::warning::');
    expect(r.saida).toContain('resposta: 401');
  });

  it('rede caiu (curl sai com erro e cita a URL com o token): sai com 0, avisa e NÃO repete a URL', () => {
    const r = rodar({ FAKE_CURL_MODE: 'neterr' });
    expect(r.status).toBe(0);
    expect(r.saida).toContain('sem resposta');
    expect(r.saida).not.toContain(TOKEN);
  });

  it('título e link ausentes têm texto padrão (o aviso nunca sai vazio)', () => {
    const r = rodar({ ALERT_TITLE: undefined, ALERT_RUN_URL: undefined, ALERT_HINT: undefined });
    expect(r.status).toBe(0);
    const texto = r.args.join('\n');
    expect(texto).toContain('Um workflow agendado FALHOU');
    expect(texto).toContain('(link indisponível)');
  });

  // ---- Provas de mutação: tirar a defesa tem que fazer o teste correspondente falhar ----
  it('MUTAÇÃO: sem descartar o stderr do curl, o token vaza no log (o teste da rede caída não é vácuo)', () => {
    const original = readFileSync(SCRIPT, 'utf8');
    const mutado = original.replace('2>/dev/null)"', ')"');
    expect(mutado).not.toBe(original);
    const arq = join(pasta, 'mutado-vaza.sh');
    writeFileSync(arq, mutado);
    const r = rodar({ FAKE_CURL_MODE: 'neterr' }, arq);
    expect(r.saida).toContain(TOKEN); // sem a defesa, vaza
    expect(rodar({ FAKE_CURL_MODE: 'neterr' }).saida).not.toContain(TOKEN); // com a defesa, não
  });

  it('MUTAÇÃO: sem a checagem dos segredos o script chamaria a rede com token vazio', () => {
    const original = readFileSync(SCRIPT, 'utf8');
    const mutado = original.replace('[ -z "${TELEGRAM_BOT_TOKEN:-}" ] ||', 'false ||');
    expect(mutado).not.toBe(original);
    const arq = join(pasta, 'mutado-segredo.sh');
    writeFileSync(arq, mutado);
    expect(rodar({ TELEGRAM_BOT_TOKEN: '' }, arq).chamou).toBe(true); // sem a defesa, chama
    expect(rodar({ TELEGRAM_BOT_TOKEN: '' }).chamou).toBe(false); // com a defesa, não
  });

  it('MUTAÇÃO: se o script falhasse com o Telegram fora do ar, o teste de "sempre 0" pegaria', () => {
    const original = readFileSync(SCRIPT, 'utf8');
    const mutado = original.replace(/exit 0\n$/, 'exit 1\n');
    expect(mutado).not.toBe(original);
    const arq = join(pasta, 'mutado-exit.sh');
    writeFileSync(arq, mutado);
    expect(rodar({ FAKE_CURL_MODE: 'http401' }, arq).status).toBe(1);
    expect(rodar({ FAKE_CURL_MODE: 'http401' }).status).toBe(0);
  });
});

// ---- Desenho dos dois workflows ----
function blocoAviso(texto) {
  const i = texto.indexOf('\n  avisar-falha:');
  return i < 0 ? '' : texto.slice(i);
}

function problemasDoAviso(nome, texto) {
  const b = blocoAviso(texto);
  if (!b) return [`${nome}: não tem o job avisar-falha`];
  const p = [];
  if (!/\n {4}needs: backup\n/.test(b)) p.push(`${nome}: o aviso não espera o job backup (needs: backup)`);
  if (!/github\.event_name == 'schedule'/.test(b)) p.push(`${nome}: o aviso não se limita ao disparo agendado`);
  if (!/needs\.backup\.result == 'failure'/.test(b)) p.push(`${nome}: o aviso não olha a falha do backup`);
  if (!/bash scripts\/telegram-workflow-alert\.sh/.test(b)) p.push(`${nome}: não chama o script de aviso`);
  if (!/persist-credentials: false/.test(b)) p.push(`${nome}: checkout do aviso sem persist-credentials: false`);
  const segredos = [...b.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((m) => m[1]).sort();
  if (segredos.join(',') !== 'TELEGRAM_BOT_TOKEN,TELEGRAM_CHAT_ID') {
    p.push(`${nome}: segredos do aviso fora do combinado (${segredos.join(', ') || 'nenhum'})`);
  }
  if (/contents:\s*write|git\s+push/.test(b)) p.push(`${nome}: o aviso não pode escrever no repositório`);
  return p;
}

describe('backup.yml e backup-postgres.yml avisam a falha do backup agendado', () => {
  const textos = Object.fromEntries(
    WORKFLOWS.map((f) => [f, readFileSync(join(RAIZ, '.github', 'workflows', f), 'utf8')]),
  );

  it.each(WORKFLOWS)('%s: job avisar-falha com o desenho combinado', (f) => {
    expect(problemasDoAviso(f, textos[f])).toEqual([]);
  });

  it.each(WORKFLOWS)('%s: o job avisar-falha é o ÚLTIMO (o bloco vai até o fim do arquivo)', (f) => {
    const b = blocoAviso(textos[f]);
    expect(b).not.toBe('');
    // nenhum outro job depois dele
    expect(b.match(/\n {2}[a-z][a-z-]*:\n/g)).toHaveLength(1);
  });

  it('o aviso do Postgres e o do Firestore têm título próprio', () => {
    expect(textos['backup-postgres.yml']).toContain('ALERT_TITLE: "Backup diário do Postgres FALHOU"');
    expect(textos['backup.yml']).toContain('ALERT_TITLE: "Backup diário do Firestore FALHOU"');
  });

  it('o job de backup em si NÃO ganhou segredo do Telegram (o aviso é outro job)', () => {
    for (const f of WORKFLOWS) {
      const antes = textos[f].slice(0, textos[f].indexOf('\n  avisar-falha:'));
      expect(antes).not.toMatch(/TELEGRAM_/);
    }
  });

  // Variantes plantadas: cada uma tem que DIFERIR do original e ser acusada.
  const VARIANTES = [
    ['sem needs', (t) => t.replace('    needs: backup\n', '')],
    ['sem a condição de disparo agendado', (t) => t.replace("github.event_name == 'schedule' && ", '')],
    ['sem olhar a falha', (t) => t.replace("needs.backup.result == 'failure' || ", '')],
    ['sem chamar o script', (t) => t.replace('run: bash scripts/telegram-workflow-alert.sh', 'run: echo pronto')],
    ['segredo do banco no aviso', (t) => t.replace('          ALERT_TITLE:', '          DB: ${{ secrets.DATABASE_URL }}\n          ALERT_TITLE:')],
    ['chave do backup no aviso', (t) => t.replace('          ALERT_TITLE:', '          K: ${{ secrets.BACKUP_DEPLOY_KEY }}\n          ALERT_TITLE:')],
    ['sem um dos segredos do Telegram', (t) => t.replace('          TELEGRAM_CHAT_ID: ${{ secrets.TELEGRAM_CHAT_ID }}\n', '')],
    ['checkout deixando credencial', (t) => t.replace('persist-credentials: false', 'persist-credentials: true')],
    ['aviso com permissão de escrita', (t) => t.replace('    timeout-minutes: 3\n', '    timeout-minutes: 3\n    permissions:\n      contents: write\n')],
  ];

  for (const f of WORKFLOWS) {
    it.each(VARIANTES)(`${f}: variante plantada "%s" é acusada`, (_nome, planta) => {
      const real = textos[f];
      const variante = planta(real);
      expect(variante).not.toBe(real);
      expect(problemasDoAviso(f, variante).length).toBeGreaterThan(0);
    });
  }
});
