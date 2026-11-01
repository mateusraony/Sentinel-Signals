// docs/known-risks.md item 288, addendum de 01/11/2026.
//
// Em 31/10 o secret BACKUP_DEPLOY_KEY ficou ilegível ("Load key …: error in libcrypto" e depois
// "Permission denied (publickey)") e os três workflows que o usam falharam só no ÚLTIMO passo, com uma
// mensagem que parecia problema de permissão. `scripts/write-backup-deploy-key.sh` confere a chave
// ANTES de qualquer fetch/push. Estes testes rodam o script de verdade (bash + ssh-keygen reais, como
// o runner roda) e provam que cada defesa falha quando a defesa é retirada.
//
// Sem `ssh-keygen` na máquina (o runner do GitHub tem) os testes que dependem dele são pulados;
// os que olham só o texto dos workflows rodam sempre.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const RAIZ = process.cwd();
const SCRIPT = join(RAIZ, 'scripts', 'write-backup-deploy-key.sh');
const WORKFLOWS = ['backup.yml', 'backup-postgres.yml', 'restore-postgres.yml'];

const temSshKeygen = !spawnSync('ssh-keygen', ['-y', '-f', '/dev/null'], { stdio: 'ignore' }).error;

let pasta;
let chaveBoa; // texto da chave privada válida, sem senha
let chaveComSenha;
let chavePublica;

function gerar(nome, senha) {
  const arq = join(pasta, nome);
  const r = spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', senha, '-C', 'teste', '-f', arq]);
  expect(r.status).toBe(0);
  return { privada: readFileSync(arq, 'utf8'), publica: readFileSync(`${arq}.pub`, 'utf8') };
}

// Roda o script como o workflow roda: bash, segredo só por variável de ambiente.
function rodar(segredo, destino, scriptPath = SCRIPT) {
  const env = { PATH: process.env.PATH, HOME: pasta };
  if (segredo !== undefined) env.BACKUP_DEPLOY_KEY = segredo;
  const r = spawnSync('bash', [scriptPath, destino], { env, encoding: 'utf8' });
  return { status: r.status, saida: `${r.stdout}${r.stderr}` };
}

beforeAll(() => {
  pasta = mkdtempSync(join(tmpdir(), 'deploy-key-'));
  if (!temSshKeygen) return;
  const boa = gerar('boa', '');
  chaveBoa = boa.privada;
  chavePublica = boa.publica;
  chaveComSenha = gerar('comsenha', 'abc123').privada;
});
afterAll(() => rmSync(pasta, { recursive: true, force: true }));

describe.skipIf(!temSshKeygen)('write-backup-deploy-key.sh (bash + ssh-keygen reais)', () => {
  it('chave boa: grava com modo 600 e termina com sucesso', () => {
    const dest = join(pasta, 'out-boa');
    const r = rodar(chaveBoa, dest);
    expect(r.status).toBe(0);
    expect(statSync(dest).mode & 0o777).toBe(0o600);
    expect(readFileSync(dest, 'utf8')).toMatch(/-----END OPENSSH PRIVATE KEY-----\n$/);
  });

  it('cria a pasta de destino se ela não existe (~/.ssh no runner novo)', () => {
    const dest = join(pasta, 'nova', 'sub', 'k');
    expect(rodar(chaveBoa, dest).status).toBe(0);
    expect(existsSync(dest)).toBe(true);
  });

  // Defeitos que o script CONSERTA sozinho (comuns ao colar um secret):
  it.each([
    ['fim de linha do Windows (CRLF)', (k) => k.replace(/\n/g, '\r\n')],
    ['espaços no fim de cada linha', (k) => k.replace(/\n/g, '   \n')],
    ['linhas em branco antes da chave', (k) => `\n\n${k}`],
    ['linhas em branco depois da chave', (k) => `${k}\n\n\n`],
    ['sem a quebra de linha final', (k) => k.replace(/\n+$/, '')],
  ])('aceita e normaliza: %s', (_nome, estraga) => {
    const entrada = estraga(chaveBoa);
    expect(entrada).not.toBe(chaveBoa); // a variante realmente mudou o texto
    const dest = join(pasta, 'out-normaliza');
    const r = rodar(entrada, dest);
    expect(r.status).toBe(0);
    const gravado = readFileSync(dest, 'utf8');
    expect(gravado).not.toContain('\r');
    expect(gravado).toBe(chaveBoa);
  });

  // Defeitos SEM conserto: o script tem que parar, apagar o arquivo e explicar em português.
  const SEM_CONSERTO = [
    ['quebras de linha viraram espaço (colada numa linha só)', (k) => k.trim().replace(/\n/g, ' ')],
    ['tudo junto, sem espaços', (k) => k.replace(/\n/g, '')],
    ['sem a última linha (END cortada)', (k) => k.trim().split('\n').slice(0, -1).join('\n')],
    ['lixo no lugar da chave', () => 'isto-nao-e-uma-chave'],
  ];
  it.each(SEM_CONSERTO)('recusa: %s', (_nome, estraga) => {
    const entrada = estraga(chaveBoa);
    expect(entrada).not.toBe(chaveBoa);
    const dest = join(pasta, 'out-recusa');
    const r = rodar(entrada, dest);
    expect(r.status).toBe(1);
    expect(existsSync(dest)).toBe(false);
    expect(r.saida).toContain('::error::');
    expect(r.saida).toContain('BACKUP_DEPLOY_KEY está ilegível');
  });

  it('recusa a chave PÚBLICA colada no lugar da privada', () => {
    const r = rodar(chavePublica, join(pasta, 'out-pub'));
    expect(r.status).toBe(1);
    expect(r.saida).toContain('PÚBLICA');
  });

  it('recusa chave com senha (o CI não tem como digitar)', () => {
    const r = rodar(chaveComSenha, join(pasta, 'out-senha'));
    expect(r.status).toBe(1);
    expect(existsSync(join(pasta, 'out-senha'))).toBe(false);
  });

  it('secret ausente ou vazio: mensagem própria, sem criar arquivo', () => {
    for (const valor of [undefined, '', '   ']) {
      const dest = join(pasta, 'out-vazio');
      const r = rodar(valor, dest);
      expect(r.status).toBe(1);
      expect(existsSync(dest)).toBe(false);
      expect(r.saida).toMatch(/não está configurado|ilegível/);
    }
  });

  it('o conteúdo da chave nunca aparece no log, nem na falha', () => {
    const corpo = chaveBoa.trim().split('\n').slice(1, -1).filter((l) => l.length >= 20);
    expect(corpo.length).toBeGreaterThan(0);
    for (const estraga of [(k) => k.trim().replace(/\n/g, ' '), (k) => k, (k) => `${k}x`]) {
      const r = rodar(estraga(chaveBoa), join(pasta, 'out-log'));
      for (const linha of corpo) expect(r.saida).not.toContain(linha.slice(0, 20));
    }
  });

  it('sob `bash -e` (como o passo do workflow), a falha INTERROMPE o passo: nada roda depois', () => {
    const env = { PATH: process.env.PATH, HOME: pasta, BACKUP_DEPLOY_KEY: 'lixo' };
    const r = spawnSync(
      'bash',
      ['-e', '-c', `bash "${SCRIPT}" "${join(pasta, 'out-e')}"\necho DEPOIS_DA_CHAVE`],
      { env, encoding: 'utf8' },
    );
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain('DEPOIS_DA_CHAVE');
  });

  // Prova de mutação: sem a conferência, a chave quebrada passaria — é exatamente o estado de 31/10.
  it('MUTAÇÃO: sem a conferência do ssh-keygen a chave quebrada passa (o teste acima não é vácuo)', () => {
    const original = readFileSync(SCRIPT, 'utf8');
    const mutado = original.replace("ssh-keygen -y -P ''", 'true');
    expect(mutado).not.toBe(original);
    const arq = join(pasta, 'mutado.sh');
    writeFileSync(arq, mutado);
    const quebrada = chaveBoa.trim().replace(/\n/g, ' ');
    expect(rodar(quebrada, join(pasta, 'out-mut'), arq).status).toBe(0); // sem a defesa, passa
    expect(rodar(quebrada, join(pasta, 'out-orig')).status).toBe(1); // com a defesa, barra
  });

  it('MUTAÇÃO: sem o sed que limpa o fim das linhas o CRLF passa a falhar (a normalização é o que o conserta)', () => {
    const original = readFileSync(SCRIPT, 'utf8');
    const mutado = original.replace("'s/[[:space:]]*$//'", "'s/$//'");
    expect(mutado).not.toBe(original);
    const arq = join(pasta, 'mutado-crlf.sh');
    writeFileSync(arq, mutado);
    const crlf = chaveBoa.replace(/\n/g, '\r\n');
    expect(rodar(crlf, join(pasta, 'out-crlf-mut'), arq).status).toBe(1);
    expect(rodar(crlf, join(pasta, 'out-crlf')).status).toBe(0);
  });
});

// ---- Os três workflows têm que usar o script (e não voltar a gravar a chave "no braço") ----
const RE_GRAVA_CRU = /(?:echo|printf)\b[^\n]*\$BACKUP_DEPLOY_KEY[^\n]*>\s*\S*backup_deploy_key/;

function problemasDoWorkflow(nome, texto) {
  const problemas = [];
  if (!/bash scripts\/write-backup-deploy-key\.sh ~\/\.ssh\/backup_deploy_key/.test(texto)) {
    problemas.push(`${nome}: não chama scripts/write-backup-deploy-key.sh`);
  }
  if (RE_GRAVA_CRU.test(texto)) {
    problemas.push(`${nome}: grava BACKUP_DEPLOY_KEY direto no arquivo, sem conferir a chave`);
  }
  return problemas;
}

describe('workflows que usam BACKUP_DEPLOY_KEY conferem a chave antes de usar', () => {
  const textos = Object.fromEntries(
    WORKFLOWS.map((f) => [f, readFileSync(join(RAIZ, '.github', 'workflows', f), 'utf8')]),
  );

  it.each(WORKFLOWS)('%s chama o script e não grava a chave direto', (f) => {
    expect(problemasDoWorkflow(f, textos[f])).toEqual([]);
  });

  it('nenhum OUTRO workflow passou a usar o secret sem passar por aqui', () => {
    // recovery.yml, por exemplo, só chama backup-postgres.yml (workflow_call): nunca toca o secret.
    const dir = join(RAIZ, '.github', 'workflows');
    const usam = readdirSync(dir)
      .filter((f) => f.endsWith('.yml'))
      .filter((f) => /secrets\.BACKUP_DEPLOY_KEY\b/.test(readFileSync(join(dir, f), 'utf8')))
      .sort();
    expect(usam).toEqual([...WORKFLOWS].sort());
  });

  // Variantes plantadas: cada uma tem que ser DIFERENTE do real e ser acusada.
  it.each(WORKFLOWS)('%s: voltar a gravar a chave com echo/printf é acusado', (f) => {
    const real = textos[f];
    const chamada = 'bash scripts/write-backup-deploy-key.sh ~/.ssh/backup_deploy_key';
    const comEcho = real.replace(chamada, 'echo "$BACKUP_DEPLOY_KEY" > ~/.ssh/backup_deploy_key');
    const comPrintf = real.replace(chamada, "printf '%s\\n' \"$BACKUP_DEPLOY_KEY\" > ~/.ssh/backup_deploy_key");
    const semNada = real.replace(chamada, 'true');
    for (const variante of [comEcho, comPrintf, semNada]) {
      expect(variante).not.toBe(real);
      expect(problemasDoWorkflow(f, variante).length).toBeGreaterThan(0);
    }
  });
});
