# TESTES — Crunchyroll MCP 2.0

*Versão principal em inglês: [English](../../TESTING.md).*

## 1. Ambiente

| Item | Valor |
|---|---|
| Container | Claude Code Cloud, Linux 6.18, Node v22.22.0, sessão como `root` |
| Usuário de teste sem privilégio | `tester` (criado no container), para o sandbox do Chromium funcionar **sem** `--no-sandbox` |
| Navegadores | Chrome for Testing **131.0.6778.85** (a mesma versão fixada no CI) e Chromium 141 (build 1194 do Playwright) |
| Modo | headless (`--headless=new`), sandbox ativo |
| Conta Crunchyroll | **nenhuma**. Nenhum teste toca a Crunchyroll real, a conta ou a sessão real |

## 2. Comandos executados

```bash
npm ci
npm run typecheck            # tsc --noEmit — limpo
npm run build                # dist/index.js
# suíte completa, sem privilégio, com o navegador do CI:
su tester -c 'HOME=/home/tester CI=true CRUNCHYROLL_BROWSER_EXECUTABLE=/opt/cft-131/chrome-linux64/chrome npm test'
# idem com Chromium 141:
su tester -c 'HOME=/home/tester CI=true CRUNCHYROLL_BROWSER_EXECUTABLE=/opt/pw-browsers/chromium-1194/chrome-linux/chrome npm test'
# suíte completa como root (para comparação):
CI=true npm test
# estabilidade do teste de navegador real (5× Chromium 141, 3× CfT 131):
npx tsx --test test/player-real-browser.test.ts
```

## 3. Resultados

| Execução | Testes | Passaram | Falharam |
|---|---:|---:|---:|
| **Antes** (`validacao-linux@e1c076e`), `tester`, CfT 131 | 1055 | 1055 | 0 |
| **Depois**, `tester`, CfT 131 | **1167** | **1167** | **0** |
| **Depois**, `tester`, Chromium 141 | **1167** | **1167** | **0** |
| Depois, `root` (referência) | 1150 | 1145 | 5 |
| `player-real-browser` repetido | 8 execuções | 8/8 verdes | 0 |

As 5 falhas como `root` são de ambiente e **também ocorrem antes da mudança**: o Chromium recusa
rodar como root sem `--no-sandbox` (3 suítes de navegador real, incluindo a nova) e o root ignora
permissões de arquivo (2 testes de storage B2/B5 que esperam `EACCES`/dono diferente). No CI
(usuário `runner`, SUID sandbox) elas rodam normalmente.

## 4. Testes novos (+112)

| Arquivo | Testes | Cobre |
|---|---:|---|
| `test/player-controller.test.ts` | 26 | play/pause, fullscreen/saída, no-op `ALREADY_IN_STATE`, status sem comando, player inexistente, vídeo carregando (com e sem espera), recusa por política de autoplay, falta de ativação, frame sem permissão de fullscreen, comando sem efeito (`NOT_CONFIRMED`), `play()` pendente, aba inexistente/ambígua/não configurada, aba fechada no meio, reconexão CDP, timeout por comando e por orçamento total, espera do episódio certo, duas ações concorrentes em ordem, `BUSY`, logout antes/durante, cancelamento, ação desconhecida, **propriedade: nenhum sucesso sem verificação** (11 scripts × 3 estados × 5 ações) |
| `test/playback-channel.test.ts` | 22 | seleção de aba (gravada, única, ambígua, nenhuma, lookalikes de origem/userinfo/http/ID inválido, URL vazia durante navegação), só mundos default em origens permitidas (extensão e isolated world nunca), função congelada + argumentos fechados, gesto só em play/fullscreen, comando desconhecido recusado antes de enviar, URL de stream nunca sai, OOPIF via auto-attach e worker desanexado, frame de origem estranha nunca sondado, **regressão do OOPIF no primeiro comando**, reconexão torna o canal obsoleto, aba destruída, deadline, `currentContentId` validado, `close` libera listeners e sessão, superfície do canal, **allowlist exata de métodos CDP**, `adoptOnly` nunca faz spawn |
| `test/session-recovery.test.ts` | 20 | classificação dos 6 estados (inclui tombstone), reutilização, cold start com/sem marcador, expirado sem ler marcador, logout/revogação/logout em curso nunca desfeitos, **20 chamadores → 1 tentativa e 1 leitura do marcador**, cool-down contra tempestade, recuperação após cool-down, login humano limpa cool-down, timeout/cancelamento por chamador sem afetar os outros, logout durante a tentativa, `callWithSession`: pré-checagem, erro estruturado, 1 repetição só pré-dispatch, **nunca repete pós-dispatch**, outros erros nunca repetem, sem loop, 10 chamadas concorrentes → 1 tentativa e 10 dispatches |
| `test/auth-orchestrator-silent.test.ts` | 10 | deadline curto só no silencioso, falha silenciosa não instala nem grava marcador, voos não empilham, junta-se a login interativo, login interativo durante silencioso falho espera o humano, logout cancela e material tardio não instala, sem tentativa durante logout/após revogação, ordem `recordLogout` → produtor, store com falha não bloqueia logout |
| `test/session-eligibility.test.ts` | 7 | caminho, gravar/ler/limpar sem segredo, permissão frouxa não confiável, symlink nunca seguido e `clear` não apaga o alvo, conteúdo malformado, tombstone gravado/limpo pelo login, tombstone fail-closed |
| `test/session-dispatch-integration.test.ts` | 9 | **cadeia real** registry→dispatcher→backend→authority: sem sessão não abre canal; com sessão a sonda é marcada antes do request; mutação em cold start escrita **1×**; 3 mutações concorrentes = 1 estabelecimento + 3 escritas distintas; escrita incerta nunca repetida; sondas concorrentes não vazam; bearer nunca no erro; classificação com a authority real (fresca/usável/expirada/logout/revogada) |
| `test/player-real-browser.test.ts` | 8 | **Chromium real** + fixture loopback com iframe cross-site (OOPIF) e política de autoplay estrita (flag **só no teste**): autoplay sem gesto da própria página recusado (`NotAllowedError`) e o do controller confirmado; `currentTime` avança; pause; fullscreen e saída no OOPIF; frame com `allow="fullscreen 'none'"` → `REFUSED_BY_BROWSER`; player top-level após navegação na mesma aba; **nenhuma sessão CDP fica anexada** (verificado com conexão independente; o teste falha se o detach for removido) |
| `test/mcp-harness.test.ts` | +10 (5 × tsx/bundle) | via stdio: schema estrito do player (ação desconhecida, `script`, `port`, vazio, tipo errado → `-32602`, nada ecoado); sem aba → recusa estruturada e **nenhum navegador iniciado**; opções não booleanas/campos extras/ID inválido em `crunchyroll_play` → `-32602`; cold start sem marcador → `LOGIN_REQUIRED` estruturado e nenhum navegador; **logout sobrevive a reinício do processo** (player `NOT_PERMITTED`, conteúdo `LOGGED_OUT`) |

## 5. Bugs encontrados pelos testes e corrigidos antes da entrega

1. A primeira checagem de permissão do controller ficava fora do `try` → recusa virava exceção em vez de relatório (`player-controller`).
2. **Chromium real:** frames OOPIF já existentes só registravam contextos depois da primeira sonda → `NO_VIDEO` falso. Corrigido aguardando o `Runtime.enable` dos filhos; regressão reproduzida no fake (falha sem a correção).
3. **Chromium real:** durante a navegação a aba reporta URL `""` → `TAB_NOT_FOUND` falso. A aba aberta por nós continua sendo nossa nesse intervalo; outra URL qualquer não.
4. Fixture que só funcionava onde `localhost` resolve para `::1` primeiro (colidiria no CI). Trocado por `127.0.0.2`.
5. Ajuste do harness que quebrou testes que realocam `HOME` — refinado (só substitui o `HOME` real).
6. Auditoria: logout não sobrevivia a reinício do processo (ver SEGURANCA.md).

## 6. Limitações dos testes

- **Nenhum teste com a Crunchyroll real** (proibido sem autorização). O player real (Vilos, em
  `static.crunchyroll.com`) não foi exercitado: seleção de frame, `allowfullscreen` do iframe e o
  comportamento do player com DRM ficam para a validação autorizada (DECISAO-FINAL.md §3).
- Apenas headless. Em modo visível o fullscreen afeta a janela real; o comportamento é o mesmo da
  Fullscreen API, mas não foi medido aqui.
- Mídia sintética (WAV); EME/Widevine não estão no caminho testado.
- O CI do GitHub ainda não rodou nesta branch no momento da redação (ver PR).
- Frames OOPIF aninhados (iframe dentro de iframe cross-site) não são auto-anexados.
