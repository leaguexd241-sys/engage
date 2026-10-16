'use strict';

/** Cada elemento es una migración. Nunca modifiques una ya publicada: añade una nueva. */
const MIGRATIONS = [
  `
  CREATE TABLE guilds (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL DEFAULT '',
    icon        TEXT,
    settings    TEXT NOT NULL DEFAULT '{}',
    active      INTEGER NOT NULL DEFAULT 1,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );

  CREATE TABLE x_links (
    user_id     TEXT PRIMARY KEY,
    handle      TEXT NOT NULL,
    handle_lc   TEXT NOT NULL,
    x_id        TEXT,
    x_name      TEXT,
    x_avatar    TEXT,
    verified    INTEGER NOT NULL DEFAULT 0,
    method      TEXT,
    protected   INTEGER NOT NULL DEFAULT 0,
    linked_at   INTEGER NOT NULL,
    verified_at INTEGER
  );
  CREATE UNIQUE INDEX ux_links_handle_verified ON x_links(handle_lc) WHERE verified = 1;
  CREATE INDEX ix_links_handle ON x_links(handle_lc);

  CREATE TABLE link_requests (
    user_id     TEXT PRIMARY KEY,
    handle      TEXT NOT NULL,
    code        TEXT NOT NULL,
    guild_id    TEXT,
    attempts    INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL
  );

  CREATE TABLE members (
    guild_id       TEXT NOT NULL,
    user_id        TEXT NOT NULL,
    username       TEXT NOT NULL DEFAULT '',
    display_name   TEXT NOT NULL DEFAULT '',
    avatar         TEXT,
    trust          INTEGER NOT NULL DEFAULT 50,
    streak         INTEGER NOT NULL DEFAULT 0,
    best_streak    INTEGER NOT NULL DEFAULT 0,
    completed      INTEGER NOT NULL DEFAULT 0,
    missed         INTEGER NOT NULL DEFAULT 0,
    rejected       INTEGER NOT NULL DEFAULT 0,
    blacklisted    INTEGER NOT NULL DEFAULT 0,
    notes          TEXT,
    last_active_at INTEGER,
    created_at     INTEGER NOT NULL,
    PRIMARY KEY (guild_id, user_id)
  );

  CREATE TABLE tasks (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id           TEXT NOT NULL,
    channel_id         TEXT,
    message_id         TEXT,
    tweet_id           TEXT NOT NULL,
    tweet_url          TEXT NOT NULL,
    tweet              TEXT NOT NULL,
    actions            TEXT NOT NULL,
    points             TEXT NOT NULL,
    note               TEXT,
    role_id            TEXT,
    ping_role_id       TEXT,
    status             TEXT NOT NULL DEFAULT 'active',
    created_by         TEXT,
    created_by_name    TEXT,
    created_at         INTEGER NOT NULL,
    ends_at            INTEGER NOT NULL,
    closed_at          INTEGER,
    reminded_at        INTEGER,
    metrics_start      TEXT,
    metrics_last       TEXT,
    metrics_checked_at INTEGER,
    flags              TEXT NOT NULL DEFAULT '[]',
    report             TEXT
  );
  CREATE INDEX ix_tasks_guild_status ON tasks(guild_id, status, id);
  CREATE INDEX ix_tasks_status_end ON tasks(status, ends_at);

  CREATE TABLE submissions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id       INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    guild_id      TEXT NOT NULL,
    user_id       TEXT NOT NULL,
    action        TEXT NOT NULL,
    status        TEXT NOT NULL,
    method        TEXT NOT NULL,
    evidence_url  TEXT,
    evidence_id   TEXT,
    evidence_text TEXT,
    quality       INTEGER,
    details       TEXT,
    reason        TEXT,
    attempts      INTEGER NOT NULL DEFAULT 1,
    reviewer_id   TEXT,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    UNIQUE (task_id, user_id, action)
  );
  CREATE INDEX ix_sub_guild_status ON submissions(guild_id, status);
  CREATE INDEX ix_sub_guild_user ON submissions(guild_id, user_id);
  CREATE UNIQUE INDEX ux_sub_evidence ON submissions(evidence_id, action)
    WHERE evidence_id IS NOT NULL AND status IN ('verified', 'pending');

  CREATE TABLE points_ledger (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id    TEXT NOT NULL,
    user_id     TEXT NOT NULL,
    task_id     INTEGER,
    kind        TEXT NOT NULL,
    amount      INTEGER NOT NULL,
    reason      TEXT,
    created_at  INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX ux_ledger_task ON points_ledger(task_id, user_id, kind) WHERE task_id IS NOT NULL;
  CREATE INDEX ix_ledger_guild_user ON points_ledger(guild_id, user_id);
  CREATE INDEX ix_ledger_guild_time ON points_ledger(guild_id, created_at);

  CREATE TABLE audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id    TEXT,
    type        TEXT NOT NULL,
    actor_id    TEXT,
    actor_name  TEXT,
    message     TEXT NOT NULL,
    data        TEXT,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX ix_audit_guild ON audit_log(guild_id, id);
  CREATE INDEX ix_audit_time ON audit_log(created_at);

  CREATE TABLE kv (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
  `,
];

module.exports = { MIGRATIONS };
