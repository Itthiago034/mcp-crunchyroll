# SEGURANCA — Crunchyroll MCP 2.0

*Versão principal em inglês: [English](../../SECURITY-MODEL.md).*

## 1. Ativos e atores

| Ativo | Onde vive | Regra |
|---|---|---|
| Bearer observado | memória da authority (BT3) | nunca em disco, nunca em resposta, registrado no redactor |
| Sessão do navegador (cookies) | perfil dedicado `~/.strider/crunchyroll/browser-profile` | **nunca lido** por este servidor |
| Endpoint CDP | loopback, porta efêmera, só o processo dono | nunca exposto ao agente |
| Conta do usuário | Crunchyroll | ações de conta só por tools explícitas |

Atores: o **agente LLM** (pode ser induzido por prompt injection a pedir coisas erradas), a
**página** (código da Crunchyroll, anúncios, iframes de terceiros), **outro processo do mesmo
usuário** (fora do escopo de defesa: já tem acesso ao perfil), o **usuário humano**.

## 2. Modelo de ameaças e controles

| Ameaça | Controle | Evidência |
|---|---|---|
| Agente obtém executor genérico de JS/CDP | Nenhum argumento é script; comando ∈ enum fechado validado em Node **e** na página; uma função congelada; `functionDeclaration` pinado em 2 constantes | `playback-channel`: função/argumentos fechados, comando desconhecido; tripwires `browser-api-transport`/`bt8-structural` |
| Agente conecta em porta de depuração arbitrária | Nenhum parâmetro de porta/URL/target; CDP só pela conexão do manager | harness: `{action, port}` → `-32602` |
| Comando na aba errada | Aba gravada por `openWatchPage` ou a única `/watch/<ID>`; ambígua → recusa; página gerenciada excluída; URL comparada por campos (lookalike, userinfo, http, ID inválido recusados) | `playback-channel` "which tab" |
| Comando em frame errado (anúncio, extensão, isolated world) | Só `isDefault` em origens allowlist; sessões filhas só de `iframe` sob a própria aba; workers desanexados | `playback-channel` "which frames" |
| CDP obsoleto/reutilizado | Canal preso à geração; `assertUsable()` antes e depois de cada chamada; canal novo por ação | reconexão torna canal inutilizável; controller abre canal por ação |
| Ação após aba fechada | `targetDestroyed`/`detachedFromTarget` → `TAB_CLOSED` | testes de perda |
| Vazamento de token/cookie | Caminho do player não toca a authority; métodos CDP do canal em allowlist exata (sem `Network.*`, `Storage.*`, cookies); função de página não referencia cookie/storage/fetch; estado só com primitivos, sem `currentSrc` | allowlist de métodos; "no stream URL travels"; bearer ausente de erros de sessão |
| Logs | Toda saída passa por `sanitizeToolResult` dentro do escopo de redaction; erros de sessão têm mensagens fixas | `session-dispatch-integration` |
| Bypass de autenticação | Silencioso só para EXPIRED (neste processo) ou cold start com marcador de login **humano** anterior; LOGGED_OUT/REVOKED/LOGGING_OUT nunca; mesma observação fechada do login (sem credencial, sem cookie) | `session-recovery`, `auth-orchestrator-silent` |
| Tempestade de retries / processo bloqueado | Promise única; cool-down 120 s; prazo por chamador (40 s) e da tentativa (30 s); fila do player limitada | testes de concorrência |
| Requisição com efeito colateral duplicada | Repetição só com `DispatchProbe.dispatched === false` (marcado ao abrir o canal do provedor) — prova estrutural na cadeia real | `session-dispatch-integration` |
| Fullscreen/play declarado sem confirmação | `success ⇒ verified ⇒ sonda posterior viu o estado` | propriedade em `player-controller` + Chromium real |
| Bypass de autoplay/fullscreen/DRM | Nenhuma flag de produção; recusa do navegador vira `REFUSED_BY_BROWSER`; nenhum fallback | Chromium real com política estrita e `allow="fullscreen 'none'"` |
| Controle após logout | Gate relido a cada passo; tombstone fail-closed sobrevive a reinício | harness "logout survives a process restart" |
| Spawn de navegador por ação de controle | `start({adoptOnly})` só a partir de `STOPPED` | harness "no browser launch"; `adoptOnly` nunca faz spawn |
| Recursos CDP abertos | `close()` no `finally`, listeners removidos, sessão desanexada | Chromium real: nenhuma sessão anexada (teste falha sem o detach) |
| Testes tocando a sessão real | Harness usa `HOME` descartável quando o herdado é o home real | `_harness-client.ts` |

## 3. Revisão adversarial (o que tentei quebrar)

| Tentativa | Resultado |
|---|---|
| Corrida autenticação × playback: login silencioso navegar a aba do vídeo | Não ocorre: a superfície de login usa a página gerenciada; `findReusableManagedPage` exclui abas `/watch/` e abas anexadas; durante navegação (URL `""`) a origem não parseia e a aba é ignorada. |
| Enviar comando para aba errada | Coberto por seleção por campos e recusa de ambiguidade (testes). |
| Usar canal após reconexão | Recusado (`DISCONNECTED`), teste. |
| Vazar bearer por erro estruturado | Não aparece (teste com sentinela). |
| Comando de player após logout | Recusado no mesmo processo; **falha encontrada**: em processo novo era permitido → corrigido com tombstone (commit `f3cd9ae`) e teste E2E por stdio. |
| Fullscreen declarado sem confirmação | Propriedade testada em 165 combinações; Chromium real. |
| Repetição de mutação | Cadeia real: 1 escrita por chamada, mesmo concorrente e em cold start; incerteza pós-dispatch nunca repete. |
| Adoção concorrente com reconexão (`DEGRADED`) | **Falha encontrada na revisão**: `start({adoptOnly})` em `DEGRADED` correria com o loop de reconexão → restrito a `STOPPED`. |
| Sessões CDP penduradas | Verificado no Chromium real com conexão independente. |
| Regressões | Suíte anterior: 1055/1055 continua verde (agora 1167/1167). |

## 4. Riscos residuais (aceitos e documentados)

1. **Ativação transitória concedida à página.** `userGesture: true` dá ativação de usuário ao frame
   do player (e, pela UAv2, aos ancestrais) por alguns segundos. O código da própria página poderia
   usá-la para outra ação que exige gesto (ex.: popup). Escopo: só `play`/`enter_fullscreen`, só
   frames de `www`/`static.crunchyroll.com`; irmãos cross-origin (anúncios) não recebem.
2. **Foco.** `play`/`fullscreen` chamam `Target.activateTarget`: a aba do vídeo vem para frente.
3. **Comando em voo não é cancelado por logout.** O gate impede o próximo passo; um comando já
   enviado completa.
4. **`player_control` sem `expectContentId`** age no vídeo que estiver na aba; se chamado durante a
   navegação de um `crunchyroll_play`, pode encontrar `PLAYER_LOADING`/`NO_VIDEO` (nunca outra aba).
   `crunchyroll_play` com opções espera o episódio certo.
5. **Janela no cold start.** Com marcador, a primeira consulta de um processo novo pode abrir a
   janela do navegador dedicado (o mesmo que `crunchyroll_login` já fazia).
6. **Marcador após onboarding manual.** Quem entra só por `npm run onboard:browser` precisa de um
   `crunchyroll_login` para gravar o marcador; até lá o cold start responde `LOGIN_REQUIRED`.
7. **Logout do MCP não sai da conta no navegador dedicado** (comportamento anterior, inalterado).
8. **Mesmo usuário local** pode criar/apagar marcador e tombstone. Criar o marcador só causa uma
   tentativa de observação; apagar o tombstone só re-permite controlar o player local. Fora do
   modelo de defesa (esse ator já controla o perfil).
9. **Mudança do player da Crunchyroll** (origem do iframe, sandbox/allow, players múltiplos) pode
   levar a `PLAYER_UNAVAILABLE`/`REFUSED_BY_BROWSER` — falha fechada, nunca contorno.

## 5. Restrições da missão — conformidade

Não modificado: Hermes, instalação local, configuração global do Chromium, `main`. Nenhuma
dependência global. Nenhum dado privado de autenticação acessado. Nenhuma ação na conta
Crunchyroll. Nenhum serviço do usuário reiniciado. Nenhum merge/implantação.
