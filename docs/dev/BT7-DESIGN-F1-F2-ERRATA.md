# BT7 Design Errata — F-1 and F-2

Small and specific. It corrects two premises of `BT7-DESIGN.md` that live
evidence falsified, and nothing else. No other operation is altered, no public
schema moves, and BT8 stays where it is.

The rule this errata applies: **live evidence takes precedence over the legacy
client.** A faithful copy of a stale contract is still a stale contract, and
BT7's own live smoke is the first place the staleness could be observed — the
Node egress guard had prevented the legacy client from reaching either endpoint.

## F-1 — `GET_CONTINUE_WATCHING` is not migrable at this stage

`BT7-DESIGN.md` listed `GET_CONTINUE_WATCHING` among the six account reads to
migrate, on the strength of the legacy call site
`` `${API_BASE}/content/v2/${account_id}/continue_watching?${params}` ``.

That endpoint no longer exists. Observed live, in one session, on the dedicated
profile:

| Query sent | Status | Content type | HTML shell | Bytes |
|---|---|---|---|---|
| `n=10&locale=en-US` (the legacy wire, verbatim) | 404 | `text/html` | yes | 274907 |
| *(none)* | 404 | `text/html` | yes | 274907 |
| `n=10` | 404 | `text/html` | yes | 274907 |

Byte-identical regardless of the query, so this is routing and not validation —
validation failures on this host answer JSON `400`, as F-2 demonstrates on a
sibling path under the same `/content/v2/{accountId}/` prefix. `GET_HISTORY`
answered `200` on the same channel with the same identity, seconds apart.

**Correction:** the design's scope of six becomes five. `GET_CONTINUE_WATCHING`
is DEFERRED — no descriptor, no path template anywhere in the tree, no parser,
no legacy fallback, no substitute endpoint guessed. The public tool stays
published among the 21 and answers `OPERATION_NOT_MIGRATED` with zero transport
attempts, exactly as `GET_SUBSCRIPTION` has since D-1c.

Where the capability moved is a question for a later round, and a matter of
evidence rather than inference.

## F-2 — G-2's premise was wrong for `GET_PLAYHEADS`

`BT7-DESIGN.md` specified G-2, a repeated-query mechanism, because the legacy
client built `content_ids[]=A&content_ids[]=B`. The design comment went further
and asserted that a comma-joined value "would be a different request than the
provider expects". Live evidence inverts that sentence.

The provider names the fault itself:

```
code    = "content.get_playheads_v2.format_validation_error"
context = [ { field: "content_ids", code: "content.get_playheads_v2.missing_required_field" } ]
```

Four wires, probed read-only in one session with content ids the account has
actually watched, so a non-empty answer could discriminate them:

| Wire | Status | Result |
|---|---|---|
| `content_ids=<id>` | 200 | `data=array[1]` |
| `content_ids=<id1>,<id2>` | 200 | **`data=array[2]`** |
| `content_ids=<id1>&content_ids=<id2>` | 200 | `data=array[1]` — second id dropped |
| `content_ids[]=<id1>&content_ids[]=<id2>` | 400 | `missing_required_field` |

**Correction:** the wire key is `content_ids` and the encoding is a single
comma-joined scalar. `GET_PLAYHEADS` no longer consumes G-2. It declares
`joinedQueryParams`, a closed mechanism in which the descriptor owns both the
wire key and the separator, so no operation is special-cased inside the URL
builder and no caller can choose either. The bounds are unchanged: 1–100 ids,
each validated by the existing `contentId` predicate.

## G-2 is retained as a capability

`repeatedQueryParams` now has no production consumer. It is kept, deliberately.

It is a general, closed encoding that a provider may still require; it is fully
covered by tests, including its registry invariants and its rendering; and it is
unreachable by construction — a caller cannot declare a descriptor, so with no
descriptor declaring a repeated key there is no path to it at all. Removing
tested machinery that nothing can reach buys no safety and costs the next stage
the work of rebuilding it. The design rule stands: if in doubt, preserve the
capability that is already proven.

What was removed is the false claim in its documentation, not the mechanism.

## Scope of this errata

Changed: `GET_CONTINUE_WATCHING` (deferred), `GET_PLAYHEADS` (wire corrected),
the descriptor type (one new field), the URL builder (one new rendering rule),
the registry (invariants for that field).

Unchanged: `GET_SIMILAR`, `GET_RECOMMENDATIONS`, `GET_WATCHLIST`, `GET_HISTORY`,
all eight BT5/BT6 catalog reads, `GET_SUBSCRIPTION`'s deferral, the three BT8
mutations, the 21 public tools and their input schemas, G-1, the identity
contract, the error taxonomy, and the redaction rule.
