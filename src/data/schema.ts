export const schemaVersion = 13

export const schema = `
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS schema_migrations(
  version INTEGER PRIMARY KEY, checksum TEXT NOT NULL DEFAULT '', applied_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS providers(
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  protocol TEXT NOT NULL CHECK(protocol IN ('responses','chat-completions')),
  base_url TEXT NOT NULL, credential_ref TEXT NOT NULL DEFAULT '',
  credential_state TEXT NOT NULL DEFAULT 'missing', enabled INTEGER NOT NULL DEFAULT 1,
  config_version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS model_bindings(
  id TEXT PRIMARY KEY, provider_id TEXT REFERENCES providers(id) ON DELETE SET NULL,
  model_id TEXT NOT NULL, context_tokens INTEGER NOT NULL DEFAULT 32768,
  output_tokens INTEGER NOT NULL DEFAULT 2048,
  purpose TEXT NOT NULL UNIQUE CHECK(purpose IN ('main','triage','summary')),
  revision INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS actors(
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('human','agent')),
  name TEXT NOT NULL, color TEXT NOT NULL DEFAULT '#2563eb',
  bio TEXT NOT NULL DEFAULT '', persona TEXT NOT NULL DEFAULT '',
  speaking_style TEXT NOT NULL DEFAULT '', avatar_data TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1, archived INTEGER NOT NULL DEFAULT 0,
  profile_version INTEGER NOT NULL DEFAULT 1, allow_private INTEGER NOT NULL DEFAULT 1,
  allow_group INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_model_bindings(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  provider_id TEXT REFERENCES providers(id) ON DELETE SET NULL, model_id TEXT NOT NULL,
  context_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
  purpose TEXT NOT NULL CHECK(purpose IN ('main','triage','summary')), revision INTEGER NOT NULL DEFAULT 1,
  UNIQUE(agent_id,purpose)
);
CREATE TABLE IF NOT EXISTS conversations(
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('direct','group','agent_direct','agent_group')),
  title TEXT NOT NULL, topic TEXT NOT NULL DEFAULT '', direct_key TEXT UNIQUE,
  origin_conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  branch_sequence INTEGER NOT NULL DEFAULT 0,
  next_sequence INTEGER NOT NULL DEFAULT 1, content_revision INTEGER NOT NULL DEFAULT 1,
  membership_version INTEGER NOT NULL DEFAULT 1, cancel_epoch INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0, muted INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0, paused INTEGER NOT NULL DEFAULT 0,
  autonomy_paused INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS conversation_members(
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL DEFAULT 0, joined_sequence INTEGER NOT NULL DEFAULT 0,
  left_sequence INTEGER, PRIMARY KEY(conversation_id, actor_id)
);
CREATE TABLE IF NOT EXISTS user_reads(
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  through_sequence INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS messages(
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL, author_name TEXT NOT NULL, author_kind TEXT NOT NULL,
  body TEXT NOT NULL, sequence INTEGER NOT NULL, quoted_id TEXT,
  request_id TEXT NOT NULL UNIQUE, activity_id TEXT, origin_run_id TEXT,
  deleted INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, media_id TEXT,
  recalled INTEGER NOT NULL DEFAULT 0, edited_at INTEGER NOT NULL DEFAULT 0, edit_history TEXT NOT NULL DEFAULT '[]',
  UNIQUE(conversation_id, sequence)
);
CREATE INDEX IF NOT EXISTS messages_page ON messages(conversation_id, sequence DESC);
CREATE INDEX IF NOT EXISTS messages_search ON messages(conversation_id, deleted, created_at DESC);
CREATE TABLE IF NOT EXISTS message_mentions(
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  target_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  PRIMARY KEY(message_id, target_actor_id)
);
CREATE TABLE IF NOT EXISTS reactions(
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL, emoji TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY(message_id, actor_id, emoji)
);
CREATE TABLE IF NOT EXISTS composer_drafts(
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  body TEXT NOT NULL DEFAULT '', quoted_id TEXT, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS command_receipts(
  command_id TEXT PRIMARY KEY, command_kind TEXT NOT NULL,
  result_id TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS inbox_events(
  id TEXT NOT NULL UNIQUE, agent_id TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','claimed','handled','skipped','cancelled','deferred')),
  reason TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL DEFAULT 0,
  retry_run_id TEXT,
  PRIMARY KEY(agent_id, message_id)
);
CREATE INDEX IF NOT EXISTS inbox_pending ON inbox_events(agent_id, status, sequence);
CREATE TABLE IF NOT EXISTS routing_plans(
  message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK(mode IN ('each','one-of-us','mention')),
  target_ids TEXT NOT NULL, tried_ids TEXT NOT NULL DEFAULT '[]',
  epoch INTEGER NOT NULL, membership_version INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS memories(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  body TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'note', about TEXT NOT NULL DEFAULT '',
  pinned INTEGER NOT NULL DEFAULT 0, origin TEXT NOT NULL CHECK(origin IN ('human','agent')),
  version INTEGER NOT NULL DEFAULT 1, valid INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS conversation_notes(
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK(scope IN ('shared','private')),
  target_actor_id TEXT REFERENCES actors(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  CHECK((scope='shared')<>(target_actor_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS conversation_notes_scope ON conversation_notes(conversation_id, scope);
CREATE TABLE IF NOT EXISTS lorebooks(
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  scope TEXT NOT NULL DEFAULT 'global' CHECK(scope IN ('global','conversation')),
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS lorebooks_scope ON lorebooks(scope, enabled, updated_at DESC);
CREATE TABLE IF NOT EXISTS lorebook_entries(
  id TEXT PRIMARY KEY,
  lorebook_id TEXT NOT NULL REFERENCES lorebooks(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  keywords TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  constant INTEGER NOT NULL DEFAULT 0,
  ordinal INTEGER NOT NULL DEFAULT 0,
  secondary_keywords TEXT NOT NULL DEFAULT '[]', selective INTEGER NOT NULL DEFAULT 0,
  case_sensitive INTEGER NOT NULL DEFAULT 0, source_json TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS lorebook_entries_book ON lorebook_entries(lorebook_id, ordinal);
CREATE TABLE IF NOT EXISTS lorebook_links(
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  lorebook_id TEXT NOT NULL REFERENCES lorebooks(id) ON DELETE CASCADE,
  PRIMARY KEY(conversation_id, lorebook_id)
);
CREATE TABLE IF NOT EXISTS lorebook_actor_links(
  actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  lorebook_id TEXT NOT NULL REFERENCES lorebooks(id) ON DELETE CASCADE,
  PRIMARY KEY(actor_id,lorebook_id)
);
CREATE TABLE IF NOT EXISTS character_cards(
  actor_id TEXT PRIMARY KEY REFERENCES actors(id) ON DELETE CASCADE,
  source_json TEXT NOT NULL, source_png TEXT NOT NULL DEFAULT '',
  warnings_json TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS media_assets(
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('image','audio')),
  owner_actor_id TEXT REFERENCES actors(id) ON DELETE SET NULL,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  prompt TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','ready','failed')),
  error TEXT NOT NULL DEFAULT '',
  bytes INTEGER NOT NULL DEFAULT 0,
  mime_type TEXT NOT NULL DEFAULT '',
  width INTEGER NOT NULL DEFAULT 0,
  height INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  transcript TEXT NOT NULL DEFAULT '',
  voice TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS media_owner ON media_assets(owner_actor_id, kind, created_at DESC);
CREATE INDEX IF NOT EXISTS media_conversation ON media_assets(conversation_id, kind, created_at DESC);
CREATE INDEX IF NOT EXISTS media_message ON media_assets(message_id,kind,created_at DESC);
CREATE TABLE IF NOT EXISTS media_blobs(
  id TEXT PRIMARY KEY REFERENCES media_assets(id) ON DELETE CASCADE,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS stickers(
  id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', data_url TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS memories_agent ON memories(agent_id, pinned, updated_at DESC);
CREATE TABLE IF NOT EXISTS memory_sources(
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  PRIMARY KEY(memory_id,message_id)
);
CREATE INDEX IF NOT EXISTS memory_sources_message ON memory_sources(message_id);
CREATE TRIGGER IF NOT EXISTS invalidate_memory_on_message_delete BEFORE DELETE ON messages BEGIN
  UPDATE memories SET valid=0 WHERE id IN (SELECT memory_id FROM memory_sources WHERE message_id=OLD.id);
END;
CREATE TRIGGER IF NOT EXISTS invalidate_memory_on_message_tombstone AFTER UPDATE OF deleted ON messages
WHEN NEW.deleted=1 AND OLD.deleted=0 BEGIN
  UPDATE memories SET valid=0 WHERE id IN (SELECT memory_id FROM memory_sources WHERE message_id=NEW.id);
END;
CREATE TABLE IF NOT EXISTS summaries(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  through_sequence INTEGER NOT NULL, content_revision INTEGER NOT NULL,
  body TEXT NOT NULL, valid INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL,
  start_sequence INTEGER NOT NULL DEFAULT 1,
  segment_start_sequence INTEGER NOT NULL DEFAULT 0,
  segment_body TEXT NOT NULL DEFAULT '',
  UNIQUE(agent_id, conversation_id, through_sequence)
);
CREATE TABLE IF NOT EXISTS conversation_memory_links(
  agent_id TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  source_conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  target_conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(agent_id,source_conversation_id,target_conversation_id),
  CHECK(source_conversation_id<>target_conversation_id)
);
CREATE INDEX IF NOT EXISTS memory_links_target ON conversation_memory_links(target_conversation_id,agent_id);
CREATE TABLE IF NOT EXISTS proactive_rules(
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  actor_id TEXT REFERENCES actors(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK(mode IN ('interval','daily')),
  interval_minutes INTEGER NOT NULL DEFAULT 0,
  daily_at INTEGER NOT NULL DEFAULT 0,
  prompt TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  last_fired_at INTEGER NOT NULL DEFAULT 0,
  next_due_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS proactive_rules_due ON proactive_rules(enabled, next_due_at);
CREATE TABLE IF NOT EXISTS activities(
  id TEXT PRIMARY KEY, root_conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  parent_activity_id TEXT, status TEXT NOT NULL, cancel_epoch INTEGER NOT NULL DEFAULT 0,
  posts INTEGER NOT NULL DEFAULT 0, model_calls INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL, ended_at INTEGER, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS runs(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, activity_id TEXT,
  status TEXT NOT NULL, phase TEXT NOT NULL DEFAULT 'queued', reason TEXT NOT NULL DEFAULT '',
  round_message_id TEXT,
  human_triggered INTEGER NOT NULL DEFAULT 1,
  started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS runs_active ON runs(status, conversation_id);
CREATE TABLE IF NOT EXISTS run_causes(
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  PRIMARY KEY(run_id,message_id)
);
CREATE INDEX IF NOT EXISTS run_causes_message ON run_causes(message_id);
CREATE TABLE IF NOT EXISTS run_retries(
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  parent_run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  PRIMARY KEY(run_id,parent_run_id), CHECK(run_id<>parent_run_id)
);
CREATE TABLE IF NOT EXISTS agent_turn_limits(
  agent_id TEXT PRIMARY KEY REFERENCES actors(id) ON DELETE CASCADE,
  window_started_at INTEGER NOT NULL, turns INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS retry_jobs(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  activity_id TEXT NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  through_sequence INTEGER NOT NULL, epoch INTEGER NOT NULL, profile_version INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('rate','http')), attempt INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','dispatched','dormant','cancelled','completed')),
  due_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(agent_id,conversation_id)
);
CREATE INDEX IF NOT EXISTS retry_jobs_due ON retry_jobs(status,due_at);
CREATE TABLE IF NOT EXISTS model_calls(
  id TEXT PRIMARY KEY, run_id TEXT, agent_id TEXT NOT NULL, provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL, purpose TEXT NOT NULL, status TEXT NOT NULL,
  input_tokens INTEGER, output_tokens INTEGER, error_code TEXT NOT NULL DEFAULT '',
  started_at INTEGER NOT NULL, ended_at INTEGER
);
CREATE TABLE IF NOT EXISTS tool_actions(
  action_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, tool_name TEXT NOT NULL,
  status TEXT NOT NULL, result_json TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS app_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
`
