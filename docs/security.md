# Security Model

MCP Crunchyroll is designed so that an AI agent can act on your behalf without secrets leaking through prompts, tool-call traces, or results. This document summarizes the validated protections. It is deliberately factual: nothing here is promotional, and each item maps to repository implementation and tests, except where a section is explicitly marked as a candidate (in progress) — those are planned protections, not validated ones.

## 1. Secure Local Storage

Credential artifacts are stored locally and are never sent to unrelated third parties; authenticated requests communicate only with Crunchyroll services as required. They are stored under `~/.strider/crunchyroll/` as separate artifacts (tokens, session), created with restrictive permissions and validated before every read or write.

| Threat | Mitigation |
|--------|-----------|
| Symlink hijack | `lstat` without following; symlinks rejected (`INSECURE_DIR`) |
| Insecure permissions | group/other bits rejected (`INSECURE_DIR`); dirs created `0700` |
| Owner drift | owner must match effective UID (`INSECURE_OWNER`) |
| Non-regular targets (FIFO, socket, device) | rejected (`INSECURE_DIR`) |
| TOCTOU on open | `O_NOFOLLOW` where available, fallback path validated by tests |

Reads additionally validate the open file descriptor with a fresh stat. A missing file is a normal absence, never a security failure — but an insecure filesystem state can never silently become "not logged in": security errors are reported as structured states.

## 2. Persisted Schema Validation

Stored tokens are validated against a frozen structural schema before use. A corrupted or out-of-schema file is classified as corruption and never trusted; a temporal problem (expiration) remains a temporal state, never corruption.

## 3. Secret Redaction at the MCP Boundary

An operation-scoped secret registry marks known-sensitive argument fields (`password`, `access_token`, `refresh_token`) on entry and removes their values from results, redacted payloads, and error outputs. The registry is scoped to a single operation and cleaned up after it, and only the closed list of sensitive fields is ever redacted — everything else is deliberately passed through.

## 4. Structured Refresh Failure Classification

Token refresh does not guess: failures are classified into explicit states. Transient conditions (rate limits, server errors, network failures) are kept as transient — saved credentials are **preserved**. Only proven semantic rejections (e.g., invalid grant) escalate to a reauthentication requirement. Transient and server failures never degrade into credential loss.

## 5. Structured Local Logout — Candidate (In Progress)

> **This protection is not yet present in `main`.** A candidate implementation (Gate B5) is under external review on a development branch. The current `main` line uses best-effort logout; the structured behavior described here should be treated as planned, not validated, until B5 consolidates.

The candidate logout reports a per-artifact result (`tokens`, `session`) with states `CLEARED`, `ALREADY_ABSENT`, `PARTIAL`, or `FAILED`, each with a classified reason (`INSECURE_DIR`, `INSECURE_OWNER`, `FILESYSTEM_ERROR`). A shared config validation runs once before any deletion, so an insecure storage state stops the whole operation with zero deletions attempted. The client-facing presentation (`success`, `message`) is derived from these states — the domain layer contains no success/message fields of its own.

## What This Project Does NOT Do

- It does not contact any remote telemetry or licensing service.
- It does not bypass DRM or download media.
- It does not ship an HTTP server; the transport is stdio only.
- The agent's password is required by the current login flow and is redacted from results, but it still crosses the LLM/MCP boundary as an argument; an out-of-band authentication design is planned and not yet implemented.
