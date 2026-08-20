PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;
-- Streaming deltas are written and then pruned continuously, so without
-- incremental vacuum the file only ever grows: the pages come free but stay
-- allocated. This only takes on a database created with it, which is why
-- `Db.reclaim` converts an older file.
PRAGMA auto_vacuum = INCREMENTAL;
-- A checkpointed WAL keeps its high-water mark forever unless capped.
PRAGMA journal_size_limit = 16777216;
-- A tool call and an HTTP write can reach the file at the same time; without a
-- timeout the loser fails immediately instead of waiting out the other's commit.
PRAGMA busy_timeout = 5000;
-- SQLite's own default is 2 MiB of page cache and no mmap at all, which is sized
-- for a library embedded in anything rather than for one process that owns the
-- file. 64 MiB (negative means KiB, not pages, so the page size cannot change
-- what this means) holds the working set; 256 MiB of mmap lets a brute-force
-- vector scan read pages without copying them; temp tables and the sort spills
-- behind ORDER BY and the FTS5 queries stay off disk.
PRAGMA cache_size = -65536;
PRAGMA mmap_size = 268435456;
PRAGMA temp_store = MEMORY;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Every configuration value the web UI can edit. Stored as JSON so a new
-- capability never needs a migration just to be persisted.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- AES-256-GCM ciphertext keyed by the on-disk master key. Values are never
-- returned over HTTP; callers only learn whether a name is present.
CREATE TABLE IF NOT EXISTS secrets (
  name       TEXT PRIMARY KEY,
  iv         BLOB NOT NULL,
  tag        BLOB NOT NULL,
  ciphertext BLOB NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  device     TEXT NOT NULL DEFAULT 'web',
  created_at INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS providers (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  base_url   TEXT NOT NULL,
  -- How the credential is presented, as `{"style","header","prefix"}` JSON.
  -- Null is `bearer`, which is what every OpenAI-compatible endpoint wants.
  auth       TEXT,
  enabled    INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS models (
  id                 TEXT PRIMARY KEY,
  provider_id        TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  model              TEXT NOT NULL,
  enabled            INTEGER NOT NULL DEFAULT 1,
  pinned             INTEGER NOT NULL DEFAULT 1,
  agent_tool         INTEGER NOT NULL DEFAULT 0,
  reasoning          INTEGER NOT NULL DEFAULT 0,
  input              TEXT NOT NULL DEFAULT '["text"]',
  context_window     INTEGER NOT NULL DEFAULT 128000,
  max_tokens         INTEGER NOT NULL DEFAULT 8192,
  thinking_level     TEXT NOT NULL DEFAULT 'off',
  thinking_level_map TEXT,
  api_mode           TEXT NOT NULL DEFAULT 'openai-chat',
  -- What the model is for. Chat by default so a row written before generation
  -- existed still loads as what it was.
  kind               TEXT NOT NULL DEFAULT 'chat',
  ops                TEXT NOT NULL DEFAULT '[]',
  params             TEXT,
  librechat_compat   INTEGER NOT NULL DEFAULT 0,
  system_prompt      TEXT,
  temperature        REAL,
  top_p              REAL,
  pricing            TEXT,
  compat             TEXT,
  sort_order         INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS models_provider ON models(provider_id);

-- A record is stdio or remote depending on which of `command` and `url` it
-- carries: a command is a child process, a URL is Streamable HTTP with the
-- deprecated HTTP+SSE transport as the fallback (`mcp/transport.ts`). `command`
-- stays NOT NULL and holds '' for a remote server, because a NOT NULL column
-- cannot be relaxed in place and an empty command is already unspawnable.
CREATE TABLE IF NOT EXISTS mcp_servers (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 1,
  command    TEXT NOT NULL,
  url        TEXT,
  args       TEXT NOT NULL DEFAULT '[]',
  env        TEXT NOT NULL DEFAULT '{}',
  -- Sent on every remote request, as a JSON object. `env` is the stdio half of
  -- the same idea and is not reused for it: one is a child's environment.
  headers    TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL DEFAULT 'New conversation',
  model_id   TEXT NOT NULL,
  profile_id TEXT NOT NULL DEFAULT '',
  archived   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS conversations_updated ON conversations(archived, updated_at DESC);

-- One row per AgentMessage. `content` is the persisted (image-stripped) form;
-- base64 image payloads live in files/ on disk and are referenced by image_ref.
--
-- This table is a projection of the conversation's session tree in
-- sessions.sqlite, which is the transcript's source of truth. `entry_id` is the
-- tree entry a row was projected from: it is how a client sequence number turns
-- back into a point in the tree that a rewind can move the branch to.
CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq             INTEGER NOT NULL,
  role            TEXT NOT NULL,
  content         TEXT NOT NULL,
  entry_id        TEXT,
  created_at      INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS messages_order ON messages(conversation_id, seq);

CREATE TABLE IF NOT EXISTS runs (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  status          TEXT NOT NULL,
  model_id        TEXT NOT NULL,
  error           TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS runs_conversation ON runs(conversation_id, created_at DESC);

-- Durable, monotonically increasing event log. Clients resume a stream with
-- Last-Event-ID = seq, so the id must never be reused.
CREATE TABLE IF NOT EXISTS events (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id          TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  type            TEXT NOT NULL,
  data            TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS events_run ON events(run_id, seq);
CREATE INDEX IF NOT EXISTS events_conversation ON events(conversation_id, seq);

-- One row per destructive tool call that a person has to authorise. Keyed by
-- the tool call id, so a retried gate finds the existing decision instead of
-- asking twice, and a decision survives a refresh, a reconnect or a restart.
CREATE TABLE IF NOT EXISTS approvals (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  tool_name       TEXT NOT NULL,
  action          TEXT NOT NULL,
  summary         TEXT NOT NULL,
  detail          TEXT NOT NULL DEFAULT '{}',
  status          TEXT NOT NULL DEFAULT 'pending',
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS approvals_pending ON approvals(status, created_at);
CREATE INDEX IF NOT EXISTS approvals_conversation ON approvals(conversation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS memories (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  tokens     INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  mime             TEXT NOT NULL,
  bytes            INTEGER NOT NULL,
  disk_path        TEXT NOT NULL,
  sha256           TEXT NOT NULL,
  conversation_id  TEXT,
  source           TEXT NOT NULL DEFAULT 'upload',
  embedding_status TEXT NOT NULL DEFAULT 'none',
  embedding_error  TEXT,
  page_count       INTEGER,
  width            INTEGER,
  height           INTEGER,
  created_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS files_created ON files(created_at DESC);
-- Documents are content-addressed: an upload whose bytes are already in the
-- library reuses that row rather than opening a second one, so the same passage
-- is not chunked, embedded and retrieved twice. Every upload asks this question.
CREATE INDEX IF NOT EXISTS files_sha256 ON files(sha256);

CREATE TABLE IF NOT EXISTS chunks (
  id      TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  idx     INTEGER NOT NULL,
  page    INTEGER,
  text    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS chunks_file ON chunks(file_id, idx);

-- Trigram tokenizer: substring matching works for Latin scripts and, unlike
-- unicode61, it also matches CJK text that has no whitespace word breaks.
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text,
  content = 'chunks',
  content_rowid = 'rowid',
  tokenize = 'trigram'
);

CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, text) VALUES (new.rowid, new.text);
END;

CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;

CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO chunks_fts(rowid, text) VALUES (new.rowid, new.text);
END;

-- Float32 little-endian vectors, unit length at write time so cosine is a plain
-- dot product. A search scores every row, from one packed matrix held in memory
-- and rebuilt only when a vector is written, so no ANN index is warranted at
-- this scale.
CREATE TABLE IF NOT EXISTS embeddings (
  chunk_id TEXT PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
  file_id  TEXT NOT NULL,
  model    TEXT NOT NULL,
  dim      INTEGER NOT NULL,
  vector   BLOB NOT NULL
);

CREATE INDEX IF NOT EXISTS embeddings_file ON embeddings(file_id);

CREATE TABLE IF NOT EXISTS image_assets (
  image_id         TEXT PRIMARY KEY,
  mime             TEXT NOT NULL DEFAULT 'image/png',
  width            INTEGER,
  height           INTEGER,
  provider         TEXT,
  model            TEXT,
  parent_image_ids TEXT NOT NULL DEFAULT '[]',
  created_at       INTEGER NOT NULL
);

-- Provenance for generated video, mirroring image_assets. The bytes sit beside
-- images in assets/files and get a files row, so the library and the gallery
-- need no new table to see them.
CREATE TABLE IF NOT EXISTS video_assets (
  video_id         TEXT PRIMARY KEY,
  mime             TEXT NOT NULL DEFAULT 'video/mp4',
  width            INTEGER,
  height           INTEGER,
  duration_ms      INTEGER,
  poster_image_id  TEXT,
  provider         TEXT,
  model            TEXT,
  parent_image_ids TEXT NOT NULL DEFAULT '[]',
  created_at       INTEGER NOT NULL
);

-- One row per generation request. The row is the whole state: a reconnecting
-- client reads it instead of replaying an event log, because a job emits no
-- incremental content the way a run does.
--
-- conversation_id is nullable and deliberately not a foreign key: a studio job
-- belongs to nobody's transcript, and deleting a conversation must not erase the
-- record of work that produced assets still in the library.
CREATE TABLE IF NOT EXISTS jobs (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,
  op              TEXT NOT NULL,
  model_id        TEXT NOT NULL,
  model_name      TEXT NOT NULL DEFAULT '',
  conversation_id TEXT,
  status          TEXT NOT NULL,
  progress        REAL,
  note            TEXT,
  params          TEXT NOT NULL DEFAULT '{}',
  sources         TEXT NOT NULL DEFAULT '[]',
  assets          TEXT NOT NULL DEFAULT '[]',
  error           TEXT,
  -- The backend's own id for the work, when it has one. Its presence is what
  -- makes a job resumable after a restart rather than lost.
  provider_job_id TEXT,
  created_at      INTEGER NOT NULL,
  started_at      INTEGER,
  finished_at     INTEGER,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS jobs_recent ON jobs(created_at DESC);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status, created_at);

-- A named bundle of models, capabilities, MCP servers and prompts. A
-- conversation points at one; an empty profile_id means the default.
CREATE TABLE IF NOT EXISTS profiles (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  chat_model_id   TEXT NOT NULL DEFAULT '',
  image_model_id  TEXT NOT NULL DEFAULT '',
  edit_model_id   TEXT NOT NULL DEFAULT '',
  video_model_id  TEXT NOT NULL DEFAULT '',
  capabilities    TEXT NOT NULL DEFAULT '{}',
  mcp_servers     TEXT NOT NULL DEFAULT '[]',
  global_prompt   TEXT NOT NULL DEFAULT '',
  tool_prompt     TEXT NOT NULL DEFAULT '',
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
