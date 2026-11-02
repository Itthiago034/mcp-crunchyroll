# DECISAO-FINAL — Crunchyroll MCP 2.0

*Versão principal em inglês: [English](../../RELEASE-DECISION.md).*

## Classificação

**READY_FOR_INDEPENDENT_AUDIT**

Nenhuma aprovação para produção está implícita. Nenhum merge ou implantação foi feito.

## 1. Critérios de conclusão

| Critério | Estado | Evidência |
|---|---|---|
| Controle nativo de reprodução | Feito | `crunchyroll_player_control`; `openPlaybackControlChannel`; Chromium real 8/8 |
| Autenticação concorrente determinística | Feito | single-flight; 20 chamadores → 1 tentativa; cadeia real: mutações escritas 1× |
| Skill atualizada | Feito | `skills/crunchyroll/SKILL.md` 2.0.0 |
| Testes relevantes passam | Feito | 1167/1167 (sem privilégio, CfT 131 e Chromium 141); antes 1055/1055 |
| Novos controles de segurança verificados | Feito | SEGURANCA.md §2–3 |
| Compatibilidade preservada | Feito | IMPLEMENTACAO.md §3; `crunchyroll_play` sem opções idêntico |
| Limitações de fullscreen/autoplay documentadas | Feito | SEGURANCA.md §4, TESTES.md §6, skill "Respostas do player" |
| Draft PR disponível | Feito | ver link no PR |

## 2. Por que não é mais que isso

- Nenhum teste contra a Crunchyroll real (proibido sem autorização). O player real (iframe Vilos
  em `static.crunchyroll.com`) é a principal incógnita: origem, `allowfullscreen`, vários `<video>`.
- O CI do GitHub ainda precisa rodar nesta branch.
- O PR contra `main` também carrega os commits de `validacao-linux` (ver ARQUITETURA.md §6).

## 3. Próxima validação recomendada (exige autorização explícita do usuário)

1. Rodar o CI (Node 18/20/22) no PR.
2. Auditoria independente do diff 2.0 (`git diff e1c076e..HEAD`), focada em `browser-session-manager.ts`
   (canal), `session-recovery.ts` e `index.ts`.
3. Validação **local, com a conta do usuário e autorização explícita**, em modo visível:
   - `crunchyroll_play {"episode_id": <episódio já assistido>, "autoplay": true}` e conferir `verified`.
   - `crunchyroll_player_control` `pause`, `play`, `fullscreen`, `exit_fullscreen`, `status`.
   - Anotar `outcome`/`reason` de cada passo; se `PLAYER_UNAVAILABLE`, registrar a origem real do
     frame do player (sem conteúdo da página) para ajustar `CRUNCHYROLL_PLAYER_FRAME_ORIGINS`.
   - Reiniciar o MCP e repetir uma consulta: deve funcionar sem `crunchyroll_login` (marcador).
   - `crunchyroll_logout`, reiniciar, `player_control status` → `NOT_PERMITTED`.
4. Repetir com o Hermes e medir chamadas MCP/terminal reais contra a tabela "MODELADO" do BENCHMARK.md.
