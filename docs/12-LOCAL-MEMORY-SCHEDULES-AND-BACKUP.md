# Local memory, schedules and modular backup

Implemented on 2026-10-23. This record describes the four additions requested after the meixinji comparison. Existing role-card, world-book and media changes remain in place.

## Memory and notes

- Conversation details provides shared memory/notes and per-member private notes, with create, edit and delete controls. These are user-authored records in `conversation_notes`.
- Shared notes enter all participating agents' contexts. A private note enters only its target agent's context. Targets must be current agent members of the conversation.
- The character editor provides a cross-conversation private memo, stored as a human-authored, pinned `private-note` memory. Existing automatic personal memories remain separate.
- Sharing context does not imply that every character already learned the fact in the story. Prompt labels preserve that distinction. Agents still decide what to say; prompt isolation cannot guarantee that an agent never repeats information in a reply.

## Summary coverage

Summaries retain the existing cumulative compaction model: each new summary incorporates the preceding one and the newly covered messages. `start_sequence` records the first covered message and `through_sequence` the last. Context labels expose the covered range and prefer available original messages over a conflicting summary. If token limits leave a gap between summary and recent history, the prompt explicitly identifies missing history.

Migration adds the start column without discarding valid summaries. Legacy rows default to start sequence 1; that is a coverage boundary, not a promise that deleted or access-restricted messages are available. Schema 13 now retains historical snapshots and incremental segments for browsing while injecting only the latest cumulative summary; see [summary timeline and conversation links](16-SUMMARY-TIMELINE-AND-LINKED-MEMORY.md).

The earlier claim that sequence numbers allow recovering a date such as "last week" was overstated: message indices provide order and coverage, not calendar dates or retrieval of omitted originals.

## Proactive conversation

- Per-conversation rules support intervals of 5 minutes to 7 days, or a daily device-local time, and may target one member or all current enabled agents.
- Due-time updates and scheduler inbox events commit in the same SQLite transaction. Scheduler markers have a system identity and do not impersonate a user or create a human routing round.
- A scheduled turn can send a message or remain silent. Normal activity budgets, cancellation and agent rate limits apply.
- Paused conversations, autonomy pause, pending/deferred work and unresolved failures suppress scheduled work. Missed slots do not accumulate. On startup, overdue slots move forward; interrupted conversations require a user's recovery decision.
- Android background mode is opt-in for the current app session. An explicitly started foreground service displays a persistent notification, emits native ticks and holds a bounded, renewed partial wake lock. New background replies produce a generic notification without message content. Stopping from the notification, removing the app task, or process death ends the session. No boot receiver or automatic process restart is installed.
- Without background mode, the scheduler runs while the app is in the foreground. Other platforms currently support this foreground mode only. Vendor battery controls and Doze can delay scheduling; this is not an exact alarm or an always-running cloud agent.

Android service declarations follow [foreground service types](https://developer.android.com/develop/background-work/services/fgs/service-types#special-use) and [foreground service startup requirements](https://developer.android.com/develop/background-work/services/fgs/launch). Store distribution of a `specialUse` service requires the appropriate service declaration review; no store release is claimed here.

## Modular ZIP backup

The existing full `.yomi` backup was already encrypted and already used staging, validation and database-generation rollback. The earlier description of direct live-database deletion and plaintext export was incorrect.

The new ZIP workflow adds six selectable modules: roles, chats, memories/notes, connection/schedule settings, world books, and media/stickers. Each module is independently AES-GCM encrypted using the existing password-derived key scheme. The ZIP manifest contains module identifiers and export time; data remains encrypted. API credentials are excluded.

Read a ZIP with its password, select modules, then merge. Default conflicts retain current rows; an explicit option uses the archive version of matching records in selected modules. Unselected dependencies only fill missing records, following references so unrelated chats are not imported. New local messages are not removed. Unresolvable ID/unique/foreign-key conflicts fail validation rather than silently rewriting history. Summaries are invalidated after merge. Imported proactive rules are disabled until reviewed and enabled.

The complete merged snapshot is validated in a new database and switched atomically using the existing catalog. The prior generation remains available for rollback. Runtime ledgers remain local during partial restoration. Existing same-origin model credentials are retained; changed connection origins require new credentials.

The archive and expanded archive are capped at 150 MB, with a 100 MB plaintext limit per encrypted module. Very large databases need a future streaming backup format.

## Verification

- `npm run test:agent`: existing Agent regression checks.
- `node scripts/audit-local-features.cjs`: real SQLite tests for note isolation/editing, summary injection and migration, atomic scheduler dispatch, password protection, partial merge, SQL rollback, staged activation and rollback.
- TypeScript/Vite production build and Android debug compilation.
- Android API 35 emulator: update installation and startup succeeded; settings exposed the modular ZIP workflow; the foreground service started successfully, delivered two native ticks while the app was behind the home screen, and stopped successfully after the check.

Tests use synthetic local data and mocked model responses. They do not consume a real model API. Device-specific long-duration power-management behavior is not covered by these checks.
