# NANI Persistence Report

## What is persisted
`apps/web/src/features/nani/naniStore.ts` — `localStorage` (survives application restart):

- **Conversations** (`np.nani.conversations.v1`): id, title, timestamps, messages (`role`, `content`, `at`, source/warning/error).
- **Investigations** (`np.nani.investigations.v1`): id, query, status, started/updated timestamps, summary, error, event count.

## Bounds / retention
- Max 50 conversations, 50 investigations.
- Max 200 messages per conversation.
- Oldest dropped first.

## Correctness
- Corrupt or non-array JSON is ignored (returns fallback) — never crashes the page.
- Records missing required fields (id/query/messages) are filtered out on load.
- No credentials, tokens, secrets, or raw network addresses are stored.

## Explicit deletion
- Delete a single conversation or investigation.
- Settings → "Clear history" (confirmation required) removes both keys.

## Existing architecture reused
- The Rust `PersistenceStore` and crash-safe `context/storage.rs` already persist the learned model journal. This phase adds the user-visible conversation/investigation record in the web layer; it does not duplicate the model journal.

## Not implemented
- No new D1/SQLite migration for conversations (desktop history is local by design).
- No cross-device sync.
