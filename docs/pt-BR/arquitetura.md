# ARQUITETURA — Crunchyroll MCP 2.0

*Versão principal em inglês: [English](../../ARCHITECTURE.md).*

Controle nativo do player, recuperação de sessão single-flight e skill atualizada.

## 1. Diagnóstico (Etapa A)

### 1.1 Qual código foi auditado

| Ref | Conteúdo | Corresponde ao ambiente local observado? |
|---|---|---|
| `main` (`09fe350`, v0.1.0) | 21 tools; **sem** `crunchyroll_play`, **sem** `callContentTool()`, sem skill | **Não** |
| `validacao-linux` (`e1c076e`) | 22 tools; `crunchyroll_play`, `callContentTool()`, `skills/crunchyroll/SKILL.md`, recuperação do desktop, reutilização da aba de playback | **Sim**: é a árvore de `~/mcp-crunchyroll-validacao` |

O trabalho foi feito sobre `validacao-linux`, porque é a única ref com o código descrito na missão.
Consequência: um PR contra `main` também carrega os 15 commits de `validacao-linux` (ver §6).

### 1.2 Componentes existentes (o que já estava certo)

```
MCP stdio ── index.ts (composição única)
               │
               ├─ AuthContextAuthority (BT3)  ← única fonte de verdade da sessão; bearer só em memória
               ├─ AuthProducer / AuthOrchestrator (BT4) ← login single-flight, logout exclusivo, readiness
               ├─ BrowserAuthObserver ← intercepta só a resposta do endpoint de token
               ├─ ContentGateway → Dispatcher → BrowserApiBackend (BT5–BT8)
               │      └─ canal fechado: UMA função congelada `fetch` na página gerenciada
               └─ BrowserSessionManager (BT2) ← processo próprio, perfil dedicado, propriedade
                      validada (13 checagens), CDP só em loopback, geração de conexão
```

Controles já existentes e preservados: perfil dedicado 0700, adoção só de navegador próprio,
CDP sem superfície genérica (nenhum `evaluate`, nenhum `send` exposto), redaction por operação
(`withRedactionScope` + `sanitizeToolResult`), guarda de egress do Node para `crunchyroll.com`,
`MUTATION_OUTCOME_UNKNOWN` sem retry cego, tripwires estruturais nos testes.

### 1.3 Problemas confirmados no código

| # | Problema | Evidência |
|---|---|---|
| P1 | Cold start: a primeira consulta de cada processo falha com `AUTH_NOT_READY`; o agente precisa chamar `crunchyroll_login` e repetir. | `callContentTool()` só recuperava quando `availability === "READY" && !hasUsableRecord()` (sessão estabelecida **neste** processo). |
| P2 | Duas consultas simultâneas no cold start = duas falhas + login + duas repetições. | Mesmo caminho; sem pré-checagem. |
| P3 | Mesmo no caso "expirado", cada chamada gastava uma tentativa no gateway antes de recuperar. | try → catch → login → retry. |
| P4 | A garantia "AUTH_NOT_READY nunca é pós-dispatch" era **implícita** (dependia de onde `bind()`/`runCurrent()` lançam). | Comentário em `callContentTool`; nenhum teste estrutural. |
| P5 | `crunchyroll_play` só navega. Não existe API de player → o Hermes improvisou terminal, WebSocket ao CDP, `video.play()`, `requestFullscreen()` e cliques simulados, **contornando** o `BrowserSessionManager`. | `openWatchPage()` faz `Page.navigate`/`createTarget` + `activateTarget` e nada mais. |
| P6 | `crunchyroll_status.player_ready` é sempre `false` (BT4 não tem fonte para o player). | `auth-orchestrator.ts`. Mantido: `status` continua estritamente read-only; o estado do player passa a vir de `crunchyroll_player_control {"action":"status"}`. |

## 2. Componentes novos

```
crunchyroll_player_control ─┐
crunchyroll_play {autoplay, │
              fullscreen} ──┴─► CrunchyrollPlayerController (player-controller.ts)
                                 · fila serial limitada (BUSY), gate de permissão a cada passo
                                 · espera episódio certo + player carregado (opcional)
                                 · ação → VERIFICAÇÃO por sonda posterior
                                 │
                                 ▼ PlaybackControlChannel (fechado)
                              BrowserSessionManager.openPlaybackControlChannel()
                                 · aba: a aberta por openWatchPage, ou a ÚNICA aba /watch/
                                 · contextos: só mundos default em origens permitidas
                                   (www.crunchyroll.com, static.crunchyroll.com)
                                 · OOPIF via Target.setAutoAttach (flatten)
                                 · UMA função congelada CRUNCHYROLL_PLAYER_FUNCTION(command, waitMs)
                                 · command ∈ {probe, play, pause, enter_fullscreen, exit_fullscreen}
                                 · userGesture só em play/enter_fullscreen
                                 · geração da conexão + perda (TAB_CLOSED / DISCONNECTED / NAVIGATED_AWAY)

conteúdo (17 tools) ─► callWithSession (session-recovery.ts)
                         1. classify(): USABLE | EXPIRED | NEVER_ESTABLISHED | LOGGED_OUT | REVOKED | LOGGING_OUT
                         2. não-USABLE → ensureSession() — UMA Promise compartilhada
                              EXPIRED → tentativa silenciosa
                              NEVER_ESTABLISHED → só se o marcador de elegibilidade existir
                              LOGGED_OUT / REVOKED / LOGGING_OUT → erro estruturado, nenhuma tentativa
                         3. despacha; repete no máximo 1× e só com prova estrutural de não-dispatch
                       AuthOrchestrator.establishSilently() — observação curta (30 s), junta-se a
                         login em curso, é superada por login interativo, cancelada por logout
                       SessionEligibilityStore (session-eligibility.ts)
                         · silent-reauth-eligible.json (0600, sem segredo) — gravado após login humano
                         · logged-out.json (tombstone, fail-closed) — gravado no logout
```

## 3. Contratos

### 3.1 `crunchyroll_player_control`

Entrada (schema fechado; o servidor revalida e recusa campo extra com `-32602`):

```json
{ "action": "play" | "pause" | "fullscreen" | "exit_fullscreen" | "status" }
```

> Por que `enum` e não `oneOf` discriminado: a API de tools de vários clientes (inclusive a da
> Anthropic) rejeita `oneOf` no topo de `input_schema`. Nenhuma ação tem parâmetro próprio, então a
> discriminação é feita no servidor (`action` + "nenhuma outra chave").

Saída:

```json
{
  "action": "fullscreen",
  "executed": true,
  "verified": true,
  "success": true,
  "outcome": "CONFIRMED",
  "state": { "playing": true, "paused": false, "ended": false, "buffering": false, "loading": false,
             "fullscreen": true, "muted": false, "current_time": 312.4, "duration": 1420, "ready_state": 4 },
  "message": "The player state was verified."
}
```

| Campo | Significado |
|---|---|
| `action` | Ação solicitada |
| `executed` | O comando de página foi de fato enviado (falso em no-op e recusas prévias) |
| `verified` | Uma sonda **posterior** observou o estado pedido |
| `success` | `outcome === "CONFIRMED"` (implica `verified`) |
| `outcome` | `CONFIRMED`, `NOT_CONFIRMED`, `REFUSED_BY_BROWSER`, `PLAYER_LOADING`, `PLAYER_UNAVAILABLE`, `TAB_NOT_FOUND`, `TAB_CLOSED`, `SESSION_DISCONNECTED`, `TIMEOUT`, `NOT_PERMITTED`, `BUSY` |
| `reason` | Nome fechado: `ALREADY_IN_STATE`, `AUTOPLAY_BLOCKED_USER_ACTIVATION_REQUIRED`, `USER_ACTIVATION_REQUIRED_OR_DENIED`, `FULLSCREEN_NOT_ALLOWED_IN_FRAME`, `NO_PLAYBACK_TAB`, `AMBIGUOUS_PLAYBACK_TAB`, `NAVIGATION_PENDING`, `VIDEO_NOT_READY`, `NO_VIDEO`, `CONTEXT_LOST`, `NAVIGATED_AWAY`, `CANCELLED`, `PAGE_<erro>`, `LOGGING_OUT`, `LOGGED_OUT` |
| `state` | Última observação (primitivos; nunca URL de stream) ou `null` |

`isError: true` sempre que `success` é falso.

### 3.2 `crunchyroll_play`

```json
{ "episode_id": "GE00377814PTBR" }                                  // inalterado
{ "episode_id": "GE00377814PTBR", "autoplay": true, "fullscreen": true }
```

Sem opções (ou com ambas `false`) a resposta é **byte a byte** a anterior
(`{opened, episode_id, url}`). Com opções: `{opened, episode_id, url, success, partial, autoplay?: <relatório>, fullscreen?: <relatório>}`,
cada passo esperando até 20 s pelo episódio pedido e pelo player carregado.

### 3.3 Erro estruturado de sessão (tools de conteúdo)

```json
{ "error": "Not authenticated: log in before requesting content",
  "code": "LOGIN_REQUIRED", "session_state": "NEVER_ESTABLISHED",
  "hint": "Call crunchyroll_login once (no arguments). ..." }
```

`code` ∈ `LOGIN_REQUIRED`, `REAUTH_REQUIRED`, `LOGGED_OUT`, `LOGGING_OUT`, `SILENT_REAUTH_FAILED`,
`SILENT_REAUTH_COOLDOWN`, `TIMEOUT`, `CANCELLED`. A mensagem de `LOGIN_REQUIRED` é a mesma de antes.

## 4. Fluxos

**"Coloca X ep 12" (cold start, sessão já autorizada antes):** `search` → (pré-checagem: NEVER_ESTABLISHED + marcador → 1 tentativa silenciosa compartilhada) → resposta; `get_seasons`, `get_episodes`, `play` sem nenhuma chamada de login.

**"Tela cheia e dá play":** `player_control fullscreen` → canal → sonda → ativa a aba → função congelada com gesto → sondas até `fullscreen === true` → `CONFIRMED`; idem `play`.

**Logout durante uma ação de player:** cada passo relê a permissão; um logout iniciado entre passos interrompe com `NOT_PERMITTED` antes de enviar o comando. Depois do logout (inclusive em outro processo, via tombstone), o player fica recusado até um login humano.

## 5. O que deliberadamente NÃO foi feito

- Nenhum `--autoplay-policy` em produção; nenhum fallback por mouse simulado, `Browser.setWindowBounds` ou F11.
- Nenhum `Runtime.evaluate`, nenhum executor genérico, nenhuma porta CDP ao agente.
- Nenhuma leitura de cookie, storage ou cabeçalho; nenhuma URL de stream sai da página.
- Nenhum contorno de DRM, autoplay, fullscreen ou verificação humana.

## 6. Branches

- Desenvolvido em `claude/brave-galileo-bnxgp6` (branch designada desta sessão), a partir de `validacao-linux`.
- O nome sugerido `feature/crunchyroll-player-controller` não foi criado para não violar a regra de branch única da sessão; o PR pode ser renomeado/rebaseado pelo mantenedor.
- PR em rascunho contra `main`, como pedido: ele inclui os commits de `validacao-linux`. Recomendação: mesclar `validacao-linux` primeiro **ou** trocar a base do PR para `validacao-linux` para revisar só o delta 2.0.
