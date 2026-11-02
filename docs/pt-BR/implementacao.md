# IMPLEMENTACAO — Crunchyroll MCP 2.0

*Versão principal em inglês: [English](../../IMPLEMENTATION.md).*

## 1. Commits (branch `claude/brave-galileo-bnxgp6`, sobre `validacao-linux@e1c076e`)

| Commit | Escopo |
|---|---|
| `834f43c` feat(player): closed playback control channel | `browser-lifecycle-types.ts`, `browser-session-manager.ts`, tripwires |
| `f714a5e` feat(player): native player controller | `player-controller.ts` |
| `6ba590d` feat(auth): single-flight session recovery | `auth-orchestrator.ts`, `session-recovery.ts`, `session-eligibility.ts` |
| `55aa0f9` feat(mcp): player_control + play options | `index.ts`, fixture de tools, harness |
| `fca58b1`, `765c5fe` test(player): real Chromium | `player-real-browser.test.ts`, `_player-fixture.ts` |
| `95092a9` bench | `scripts/benchmark-player.ts`, `docs/validation-results/benchmark-player.json` |
| `b6eb3bd` docs(skill) | `skills/crunchyroll/SKILL.md` 2.0.0 |
| `f3cd9ae` fix(auth): logout across restarts | achado da auditoria adversarial |
| `0c46f42` test(audit) | prova de não-dispatch na cadeia real, allowlist de CDP |
| `342b87e` docs | README, manifest |

## 2. Arquivos e justificativas

### `src/transport/browser-lifecycle-types.ts`
- `playerFrameOrigins` na config (constante de build, como `watchPageBaseUrl`).
- Tipos fechados: `PlayerCommand`, `PLAYER_COMMANDS`, `PlayerFrameState`, `PlayerPageError`,
  `PlayerCommandResult`, `PlaybackChannelLoss`, `PlaybackControlChannel`.

### `src/transport/browser-session-manager.ts`
- `CRUNCHYROLL_PLAYER_FUNCTION`: segunda (e única outra) função de página, literal congelado,
  argumentos estruturados `(command, playWaitMs)`. Só toca `<video>` do próprio frame e a
  Fullscreen API; devolve primitivos; `play()` limitado por `playWaitMs` (→ `PENDING`).
- `openPlaybackControlChannel()`:
  - Seleção de aba: `playbackTargetId` (gravado por `openWatchPage`) se ainda for aba de watch ou
    estiver no meio da navegação (URL `""`, achado no Chromium real); senão a **única** aba
    `/watch/<ID>` (URL comparada por campos, nunca prefixo); 0 → `no-playback-tab`, >1 → `ambiguous-playback-tab`.
    A página gerenciada (login/API) nunca é escolhida.
  - Sessão `flatten` + `Runtime.enable` + `Target.setAutoAttach` (OOPIF). Workers são desanexados.
    Espera o `Runtime.enable` dos frames já existentes (achado no Chromium real: sem isso a primeira
    sonda não via o player).
  - Contextos aceitos: `auxData.isDefault === true` **e** origem na allowlist; removidos em
    `executionContextDestroyed`/`executionContextsCleared`/`detachedFromTarget`.
  - Perda: `Target.targetDestroyed` → `TAB_CLOSED`; `onClose`/geração trocada → `DISCONNECTED`;
    URL fora do watch → `NAVIGATED_AWAY`. Toda operação revalida geração, estado e `stopRequested`.
  - `run(command, deadlineMs)`: sonda todos os contextos, escolhe o frame com vídeo (com fonte
    primeiro), agrega `fullscreen` de todos os frames; `Target.activateTarget` + `userGesture: true`
    só para `play`/`enter_fullscreen`; `exit_fullscreen` sai em todo frame que está em fullscreen.
    Deadline próprio.
  - `close()`: remove todos os listeners e desanexa a sessão (filhos caem junto — verificado no Chromium real).
- `start({ adoptOnly: true })`: adota um navegador próprio já em execução, nunca faz spawn.
  Um `start()` normal que encontra um voo `adoptOnly` refaz o start se a adoção falhar.
- `openWatchPage()` grava `playbackTargetId` (limpo em `targetDestroyed` e no dispose).

### `src/transport/player-controller.ts` (novo)
`createPlayerController(ports)`; fila serial (`maxQueued` 4 → `BUSY`); orçamento por ação
(15 s + espera opcional); `checkpoint()` antes de cada passo (permissão, cancelamento, prazo);
`expectContentId` (age só no episódio recém-aberto); espera de player carregado
(`hasSource && readyState ≥ 1`); no-op confirmado quando já está no estado; mapeamento de
recusas da página; verificação por sondas (3 s); canal sempre fechado no `finally`.

### `src/transport/session-recovery.ts` (novo)
`classify()`, `ensureSession()` (Promise única; prazo e `AbortSignal` por chamador; cool-down de
120 s após falha; limpeza no `finally`), `callWithSession()` (pré-checagem + no máximo 1 repetição
com `DispatchProbe.dispatched === false`), `SessionRequiredError`, `SESSION_HINTS`.

### `src/transport/session-eligibility.ts` (novo)
Marcador `silent-reauth-eligible.json` e tombstone `logged-out.json` em
`~/.strider/crunchyroll/` (ao lado do perfil, nunca dentro). Escrita atômica 0600 com `wx` +
`rename`; recusa symlink; marcador só é confiável se arquivo regular 0600 do próprio uid;
tombstone **fail-closed** (qualquer entrada conta como logout).

### `src/transport/auth-orchestrator.ts`
`establishSilently({observationDeadlineMs})`; `startAttempt()` extraído (sem mudança de
semântica do `login()` interativo); `login()` que encontra um voo silencioso espera e, se falhar,
inicia o interativo; porta opcional `eligibility` (`record` após ESTABLISHED, `recordLogout`
antes do produtor no logout, `clear` na revogação). Falha do store nunca bloqueia logout.

### `src/index.ts`
Origens do player como constantes; store de elegibilidade; `sessionRecovery`; `dispatchScope`
(`AsyncLocalStorage`) marcado pelo `openChannel` do backend; `callContentTool` → `callWithSession`
com o `AbortSignal` da requisição MCP; `playerController` (adoção só a partir de `STOPPED`; gate:
`LOGGING_OUT` ou `LOGGED_OUT`); tool `crunchyroll_player_control`; opções de `crunchyroll_play`;
`SessionRequiredError` → `{error, code, session_state, hint}`.

## 3. Compatibilidade

| Superfície | Antes | Depois | Compatível? |
|---|---|---|---|
| `crunchyroll_play {"episode_id"}` | `{opened, episode_id, url}` | idêntico | Sim |
| `crunchyroll_play` schema | 1 propriedade | +2 booleanas opcionais | Sim (aditivo) |
| tools/list | 22 | 23 (+`crunchyroll_player_control`) | Sim (aditivo) |
| Erro de conteúdo sem sessão | `{error, hint}` | `{error, code, session_state, hint}`, mesma `error` | Sim (aditivo) |
| `crunchyroll_status` | — | inalterado (`player_ready` continua `false`) | Sim |
| `crunchyroll_login/logout` | — | contrato inalterado; logout agora grava tombstone | Sim |
| Cold start com marcador | falhava | restabelece sozinho (pode abrir a janela do navegador dedicado) | Mudança de comportamento intencional |
| Logout → novo processo | player permitido | player recusado até login | Mudança intencional (segurança) |
| `BrowserSessionManager` | 13 chaves | +`openPlaybackControlChannel`, `start(options?)` | Sim (aditivo) |

Tripwires atualizados conscientemente (não removidos): conjunto de métodos `Runtime.*` (+2 eventos
read-only), novo pino de `functionDeclaration` nas duas constantes, contagem de tools 22→23,
chaves do manager, `browserTools` do cutover, fixture `baseline-tools.json` regenerada (só
`crunchyroll_play` alterado e `crunchyroll_player_control` adicionado).

Infra de testes: `McpClient` passa a usar `HOME` descartável quando o `HOME` herdado ainda é o
home real da conta (testes que realocam `HOME` mantêm o seu).

## 4. Dependências

Nenhuma dependência nova. Nenhuma instalação global. Nenhuma alteração no Hermes, na instalação
local ou na configuração global do Chromium.
