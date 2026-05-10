ALTER TABLE repositories ADD COLUMN sync_enabled INTEGER NOT NULL DEFAULT 0;

UPDATE repositories
SET sync_enabled = 1
WHERE status = 'active';

CREATE INDEX IF NOT EXISTS repositories_sync_enabled_idx ON repositories(sync_enabled);

CREATE TABLE IF NOT EXISTS github_installation_users (
  installation_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (installation_id, user_id),
  FOREIGN KEY (installation_id) REFERENCES installations(installation_id),
  FOREIGN KEY (user_id) REFERENCES users(user_id)
);

CREATE INDEX IF NOT EXISTS github_installation_users_user_id_idx ON github_installation_users(user_id);

CREATE TABLE IF NOT EXISTS github_user_tokens (
  user_id TEXT NOT NULL,
  github_user_id TEXT NOT NULL,
  encrypted_access_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, github_user_id),
  FOREIGN KEY (user_id) REFERENCES users(user_id)
);
