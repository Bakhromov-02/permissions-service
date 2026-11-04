# ADR 0003: Store and cache only a SHA-256 hash of each API key

- Status: accepted
- Date: 2026-11

## Context

The service receives raw API keys in every request. Keys are credentials: anyone who reads them from a database dump, a cache snapshot or a log can impersonate the client.

## Decision

The service hashes every API key with SHA-256 on arrival. Only the hash (`key_hash CHAR(64)`) is stored in PostgreSQL and used as the KV cache key. Logs contain only the first 12 characters of the hash.

## Alternatives considered

- **Plain keys** (the original design). Simplest, but a database leak becomes a credential leak.
- **bcrypt or argon2.** Built for low-entropy passwords and deliberately slow. API keys are high-entropy random strings, so a fast hash is safe. A slow hash would add milliseconds to every check, which is unacceptable on the hot path.
- **HMAC with a server secret.** Protects even low-entropy keys, but needs secret management and rotation. Worth revisiting if callers can choose weak keys.

## Consequences

- A database or cache dump doesn't reveal usable keys.
- The hash is always a valid NATS KV key. Raw keys can contain spaces, `*` or `>`, which KV rejects; the original design would have failed on such keys.
- Permissions can't be listed "by key" for an operator who only has the hash. Admin tooling must start from the raw key.
