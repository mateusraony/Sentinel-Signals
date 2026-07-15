# Hooks de proteção (camada 4) — ATIVOS

Estes hooks bloqueiam ações perigosas que instruções em Markdown não conseguem
garantir. **Estão ativos neste repositório** a pedido explícito do usuário:
`.claude/hooks/protect.py` está ligado via `.claude/settings.json` (PreToolUse
sobre Bash/Edit/Write). O `.claude/hooks/protect.py.example` fica como cópia de
referência/fonte. Para desligar, ver "Rollback / desativar" abaixo.

## O que os hooks bloqueiam (PreToolUse)

- `git push` para `main` e force-push envolvendo `main` (feature branch + PR ok);
- `rm -rf` com alvo amplo (`/`, `~`, `.`, `*`, `.git`);
- instalação global (`npm/pnpm/yarn -g`);
- `curl … | bash` / `wget … | sh` (script remoto sem auditoria);
- imprimir `.env*` ou variáveis de secret (`*TOKEN/SECRET/KEY/SERVICE_ACCOUNT`);
- `git add` de service account / `.env`;
- editar `.env` real (só `.env.example` é permitido);
- setar `PAPER_TRADING=false` / `LIVE_EXECUTION=true` / `READ_ONLY=false`.

Mensagens de erro são claras. **Override consciente** (uma ação): rode o comando
com `SENTINEL_ALLOW_DANGEROUS=1` no ambiente — o bloqueio vira aviso registrado.

## Como ATIVAR (passo consciente)

1. Revise `.claude/hooks/protect.py.example`.
2. Copie para o nome ativo:
   ```
   cp .claude/hooks/protect.py.example .claude/hooks/protect.py
   chmod +x .claude/hooks/protect.py
   ```
3. Crie/edite `.claude/settings.json` com:
   ```json
   {
     "hooks": {
       "PreToolUse": [
         {
           "matcher": "Bash",
           "hooks": [
             { "type": "command", "command": "python3 \"$CLAUDE_PROJECT_DIR/.claude/hooks/protect.py\"" }
           ]
         },
         {
           "matcher": "Edit|Write|MultiEdit",
           "hooks": [
             { "type": "command", "command": "python3 \"$CLAUDE_PROJECT_DIR/.claude/hooks/protect.py\"" }
           ]
         }
       ]
     }
   }
   ```
4. Reinicie a sessão do Claude Code (hooks carregam no início da sessão) e
   aprove o hook quando solicitado.

## Testar (recomendado antes de confiar)

```
# Deve BLOQUEAR (exit 2):
echo '{"tool_name":"Bash","tool_input":{"command":"git push origin main"}}' | python3 .claude/hooks/protect.py; echo "exit=$?"
echo '{"tool_name":"Write","tool_input":{"file_path":".env.local","content":"x"}}' | python3 .claude/hooks/protect.py; echo "exit=$?"
echo '{"tool_name":"Edit","tool_input":{"file_path":"server/index.js","new_string":"PAPER_TRADING=false"}}' | python3 .claude/hooks/protect.py; echo "exit=$?"

# Deve PERMITIR (exit 0):
echo '{"tool_name":"Bash","tool_input":{"command":"git push -u origin claude/minha-branch"}}' | python3 .claude/hooks/protect.py; echo "exit=$?"
echo '{"tool_name":"Write","tool_input":{"file_path":".env.example","content":"X="}}' | python3 .claude/hooks/protect.py; echo "exit=$?"
```

## Rollback / desativar

- Remova o bloco `hooks` de `.claude/settings.json` (ou apague o arquivo) e
  apague `.claude/hooks/protect.py`. O `.example` pode ficar no repo.
- Nenhum estado global é tocado — a proteção é 100% local ao repositório.

## Limitações honestas

- Hooks de projeto exigem confiança/aprovação do usuário no Claude Code e podem
  não rodar em toda superfície (ex.: algumas sessões web). Não são substituto das
  regras em `.claude/rules/` — são uma segunda linha para os casos críticos.
- A detecção é por regex sobre a entrada da ferramenta; é uma rede, não uma prova
  formal. Mantenha as regras/skills como a primeira linha.
- Mudanças de auth anônima e "commit de secret" dependem de intenção/estado que um
  hook não enxerga com segurança — ficam a cargo de `.claude/rules/security.md` e
  `.gitignore`, para evitar falso positivo.
