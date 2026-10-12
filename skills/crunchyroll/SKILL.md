---
name: crunchyroll
description: "Assistir anime na Crunchyroll do usuário pelo MCP crunchyroll: colocar/abrir/tocar um episódio (\"coloca X ep 12\", \"temporada 2\", dublado ou legendado), continuar de onde parou, próximo episódio, buscar títulos, temporadas e episódios, recomendações, lançamentos da temporada, histórico e lista (watchlist). Use SEMPRE que o pedido envolver anime, Crunchyroll ou assistir algo."
version: 1.0.0
author: Thiago
license: MIT
platforms: [linux]
metadata:
  hermes:
    tags: [Anime, Crunchyroll, Streaming, MCP, Media]
---

# Crunchyroll (MCP `crunchyroll`)

Esta skill ensina a usar o servidor MCP `crunchyroll` para encontrar e **tocar** anime na conta
Crunchyroll do usuário. O vídeo abre numa aba nova do navegador dedicado, que já está logado.
Você não precisa de navegador próprio, de senha nem de cookies.

As ferramentas aparecem com o prefixo `mcp__crunchyroll__`, por exemplo
`mcp__crunchyroll__crunchyroll_play`. Neste texto elas são citadas pelo nome curto
(`crunchyroll_play`), mas **chame sempre o nome completo**. Se o seu ambiente usa
`tool_describe`/`tool_call`, descreva só as ferramentas de que precisa e chame pelo nome completo.

## Regras de ouro

1. **Nunca abra a Crunchyroll com outro navegador** (`browser_exec`, `browser_navigate`, curl, web
   fetch). Ele não tem a sessão do usuário e cai na verificação da Cloudflare ("Um momento…",
   "Verify you are human"). Para tocar, use **somente** `crunchyroll_play`.
2. **Nunca peça e-mail, senha ou código** ao usuário. O login é feito pelo próprio usuário na janela
   do navegador dedicado.
3. **Não invente IDs.** Todo ID (série, temporada, episódio) sai de uma resposta de ferramenta.
   IDs são letras maiúsculas e números: `G8DHV78ZM`, `GS00377802ENUS`, `GE00377814ENUS`.
4. **Não repita a mesma chamada com os mesmos argumentos** depois de um erro. Leia o erro e siga a
   tabela de erros abaixo.
5. `crunchyroll_continue_watching` e `crunchyroll_get_subscription` **não funcionam** (sempre
   respondem `OPERATION_NOT_MIGRATED`). Não chame. Para "continuar", use o histórico (receita C).
6. Responda ao usuário em português, curto: o que você abriu (anime, temporada, episódio, título e
   idioma). Não despeje JSON.

## Os tipos de ID (não confunda)

| Tipo | Exemplo | De onde vem | Serve para |
|---|---|---|---|
| Série | `G8DHV78ZM` | `crunchyroll_search`, `crunchyroll_browse`, `parent_id` do histórico | `crunchyroll_get_seasons`, `crunchyroll_get_series`, `crunchyroll_get_similar` |
| Temporada | `GS00377802ENUS` | `crunchyroll_get_seasons` → `seasons[].id` ou `seasons[].versions[].guid` | `crunchyroll_get_episodes` |
| Episódio | `GE00377814ENUS` | `crunchyroll_get_episodes` → `episodes[].id` ou `episodes[].versions[].guid` | `crunchyroll_play`, `crunchyroll_get_episode`, `crunchyroll_get_playheads` |

`crunchyroll_play` só aceita **ID de episódio** (ou de filme). Nunca passe ID de série ou temporada.

## Antes de tudo: sessão

Você **não** precisa checar o login antes de cada pedido. As ferramentas de conteúdo renovam a sessão
sozinhas quando ela expira (o token dura poucos minutos). Só trate o login quando uma ferramenta
responder `Not authenticated: log in before requesting content`:

1. Chame `crunchyroll_login` (sem argumentos) **uma vez**. Se a sessão do navegador ainda vale, ele
   responde em segundos com `"auth_state": "PROFILE_READY"`. Depois, refaça a chamada que falhou.
2. Se o login demorar e voltar `LOGIN_REQUIRED`, ou der timeout: a sessão do navegador acabou. Diga ao
   usuário, sem tentar de novo por conta própria:
   "A sessão da Crunchyroll expirou. Abra o login manual com `npm run onboard:browser` na pasta
   `~/mcp-crunchyroll-validacao`, entre na conta, feche a janela pelo X e me peça de novo."
   (Se aparecer a verificação da Cloudflare dentro da janela aberta pelo MCP, é o mesmo caso: só o
   login manual resolve.)

`crunchyroll_status` só informa o estado. Ele nunca conserta nada.

## Receita A — "Coloca <anime> [temporada N] ep M"

Exemplo: "coloca Clevatess temporada 2 episódio 12".

1. `crunchyroll_search` com `{"query": "Clevatess"}`.
   - A resposta é `{"count", "results": [{"type", "id", "title", "description"}]}`. Pode haver
     itens **duplicados**: ignore repetições.
   - Escolha o resultado `type: "series"` cujo `title` bate com o pedido. Se houver dois animes
     diferentes plausíveis, pergunte qual. Se o pedido for um filme, procure `type: "movie_listing"`.
   - Nenhum resultado: tente o nome em inglês ou japonês (ex.: "Frieren", "Sousou no Frieren") antes
     de dizer que não achou.
2. `crunchyroll_get_seasons` com `{"series_id": "<id da série>"}`.
   - Cada item de `seasons` tem `id`, `title` (ex.: "Clevatess II"), `season_number`,
     `number_of_episodes`, `audio_locales`, `subtitle_locales` e `versions`.
   - "Temporada 2" = o item com `season_number: 2`. Sem temporada no pedido, use a 1 se o episódio
     couber nela; se o usuário disse só "ep M" e a série tem várias temporadas, prefira a temporada
     mais recente que tenha o episódio M **apenas se** ele estiver claramente acompanhando a série
     (histórico); senão, pergunte.
   - Ignore itens que não sejam temporadas da série principal (ex.: especiais, recaps) a menos que o
     usuário peça.
3. `crunchyroll_get_episodes` com `{"season_id": "<id da temporada>"}`.
   - Cada item de `episodes` tem `id`, `episode_number`, `title`, `is_premium_only`,
     `availability_status`, `versions`, `next_episode_id`, `duration_ms`.
   - Escolha o item com `episode_number` = M. Se não existir (ex.: temporada tem 13 episódios e pediram
     o 20), diga quantos episódios a temporada tem.
4. Escolha o idioma (veja "Idioma e versões") e chame `crunchyroll_play` com
   `{"episode_id": "<id do episódio escolhido>"}`.
   - Sucesso: `{"opened": true, "episode_id", "url"}`. A aba abre já no player.
5. Responda: "Abri **Clevatess II – ep. 12: The Millennium of a Dark Beast Lord** (dublado em PT-BR)
   no navegador da Crunchyroll."

## Receita B — Próximo episódio / episódio seguinte

- Se você acabou de abrir um episódio, ele tem `next_episode_id`: chame `crunchyroll_play` com esse ID
  (ou a versão no mesmo idioma, veja abaixo).
- Senão, use a Receita C para descobrir o último episódio visto e então `crunchyroll_get_episode`
  com esse ID para ler `next_episode_id`.

## Receita C — "Continua de onde parei" / "o que eu estava vendo?"

1. `crunchyroll_get_history` com `{"n": 10}`.
   - `items[]` vem do mais recente para o mais antigo, cada um com `id` (episódio, ex.:
     `GE00377814PTBR`), `parent_id` (série), `playhead` (segundos já vistos), `fully_watched` e
     `date_played`. O campo `panel` é grande (imagens): use só `slug_title` dele, se precisar.
2. Pegue o primeiro item (ou o primeiro da série que o usuário citou, comparando `parent_id`).
   - `fully_watched: false` → abra **esse mesmo** `id` com `crunchyroll_play`; o player retoma do
     `playhead`.
   - `fully_watched: true` → abra o próximo: `crunchyroll_get_episode` com o `id` e use
     `next_episode_id`. Sem próximo, diga que a temporada acabou e ofereça a seguinte
     (`crunchyroll_get_seasons`).
3. O sufixo do `id` no histórico mostra o idioma que o usuário costuma assistir (`...PTBR` = dublado
   em português; `...JAJP` = original japonês). Use isso como preferência padrão.

## Idioma e versões (dublado × legendado)

Episódios e temporadas têm `versions`: uma entrada por áudio, cada uma com `audio_locale` e `guid`.
Exemplo real (Clevatess II, ep. 12):

```json
"versions": [
  {"audio_locale": "ja-JP", "guid": "GE00377814JAJP", "original": true},
  {"audio_locale": "en-US", "guid": "GE00377814ENUS"},
  {"audio_locale": "pt-BR", "guid": "GE00377814PTBR"}
]
```

- "Dublado" / "em português" → use o `guid` com `audio_locale: "pt-BR"`.
- "Legendado" / "original" / "em japonês" → use o `guid` com `"original": true` (geralmente
  `ja-JP`). As legendas em português ficam disponíveis no player (`subtitle_locales` inclui `pt-BR`).
- Sem preferência no pedido → use a preferência do histórico (Receita C, passo 3). Sem histórico,
  use o `id` do episódio como veio; a própria Crunchyroll aplica o idioma preferido da conta.
- Não existe versão `pt-BR` → avise ("não tem dublagem em português; abri legendado") e use a
  original.
- Para listar episódios já num idioma, você também pode passar a `guid` da temporada naquele idioma
  (`seasons[].versions[]`) para `crunchyroll_get_episodes`.

## Receita D — Descobrir o que assistir

| Pedido | Ferramenta | Argumentos |
|---|---|---|
| "me recomenda algo" | `crunchyroll_get_recommendations` | `{"n": 5}` |
| "parecido com X" | `crunchyroll_search` → `crunchyroll_get_similar` | `{"series_id": "...", "n": 5}` |
| "populares", "novidades" | `crunchyroll_browse` | `{"sort_by": "popularity"}` ou `{"sort_by": "newly_added"}` |
| "anime de romance/ação…" | `crunchyroll_get_categories`, depois `crunchyroll_browse` | `{"categories": "romance", "sort_by": "popularity"}` (use o `id` da categoria) |
| "lançamentos da temporada" | `crunchyroll_get_simulcast_seasons`, depois `crunchyroll_browse` | `{"seasonal_tag": "fall-2026"}` (o primeiro item é a temporada atual) |
| "me fala sobre X" | `crunchyroll_search` → `crunchyroll_get_series` | `{"series_id": "..."}` |

Apresente 3 a 5 opções com título e uma frase de sinopse em português, e ofereça abrir uma.
Recomendações podem trazer itens que não são anime (ex.: "The Crunchyroll Anime Awards"): pule-os.

## Receita E — Lista (watchlist)

- Ver a lista: `crunchyroll_get_watchlist` com `{"n": 10}`. Os itens trazem **só** `id`,
  `is_favorite` e `date_added`, **sem título**. Para mostrar nomes, chame `crunchyroll_get_series`
  para os primeiros (no máximo 5) IDs; não busque os 100+ itens.
- Adicionar: busque a série e chame `crunchyroll_add_to_watchlist` com `{"content_id": "<id da série>"}`.
- Remover: `crunchyroll_remove_from_watchlist` com `{"content_id": "<id da série>"}`.
- Estas duas alteram a conta. Faça só quando o usuário pedir claramente. Se a resposta for
  `MUTATION_OUTCOME_UNKNOWN`, **não repita**: confira com `crunchyroll_get_watchlist`.

## Progresso

- Ler: `crunchyroll_get_playheads` com `{"content_ids": ["GE..."]}` → `playhead` em segundos e
  `fully_watched`.
- `crunchyroll_update_playhead` altera a conta: use só se o usuário pedir explicitamente para
  marcar progresso.

## Tabela de erros

| Resposta | O que fazer |
|---|---|
| `Not authenticated: log in before requesting content` | `crunchyroll_login` uma vez, depois refaça a chamada. Se o login falhar, oriente o login manual (seção "Sessão"). |
| `OPERATION_NOT_MIGRATED` | Ferramenta desativada. Use a alternativa (histórico em vez de continue_watching). Não repita. |
| `crunchyroll_play takes exactly one argument, episode_id...` | Você passou ID errado (série/temporada, minúsculas, URL). Pegue o `id` de `crunchyroll_get_episodes`. |
| `Upstream has no such resource` | ID não existe. Volte um passo (busca/temporadas) e pegue o ID da resposta. |
| `Upstream is rate limiting this client` | Espere um pouco antes de tentar; avise o usuário. |
| `The managed browser is unavailable` / `BROWSER_UNAVAILABLE` | O navegador dedicado fechou ou está ocupado. Chame `crunchyroll_login` uma vez (ele reabre); se continuar, diga ao usuário para fechar janelas do perfil da Crunchyroll e tentar de novo. |
| `MCP server 'crunchyroll' lost its stdio subprocess` / timeout | O servidor reiniciou. Chame `crunchyroll_status` uma vez; se ele responder, refaça o pedido. Se não, peça ao usuário para rodar `/reload-mcp`. |
| `MUTATION_OUTCOME_UNKNOWN` | Não repita a alteração. Confira o estado (watchlist/playheads) e informe. |

## Exemplo completo (real)

Pedido: "Coloca Clevatess 2ª temporada ep 12 dublado"

1. `crunchyroll_search {"query":"Clevatess"}` → série `G8DHV78ZM` "Clevatess".
2. `crunchyroll_get_seasons {"series_id":"G8DHV78ZM"}` → `season_number: 2` = `GS00377802ENUS`
   "Clevatess II", 13 episódios.
3. `crunchyroll_get_episodes {"season_id":"GS00377802ENUS"}` → `episode_number: 12` = "The Millennium
   of a Dark Beast Lord"; `versions` tem `pt-BR` → `GE00377814PTBR`.
4. `crunchyroll_play {"episode_id":"GE00377814PTBR"}` → `{"opened": true, ...}`.
5. Resposta: "Abri **Clevatess II – ep. 12: The Millennium of a Dark Beast Lord**, dublado em PT-BR,
   no navegador da Crunchyroll."

Quatro chamadas, sem login, sem navegador próprio.
