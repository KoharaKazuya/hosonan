CREATE TABLE IF NOT EXISTS installations (
  installation_id INTEGER PRIMARY KEY,
  account_id INTEGER,
  account_login TEXT,
  account_type TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS repositories (
  repository_id INTEGER PRIMARY KEY,
  installation_id INTEGER NOT NULL,
  owner_login TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  full_name TEXT NOT NULL,
  default_branch TEXT NOT NULL,
  visibility TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (installation_id) REFERENCES installations(installation_id)
);

CREATE INDEX IF NOT EXISTS repositories_installation_id_idx ON repositories(installation_id);
CREATE INDEX IF NOT EXISTS repositories_owner_repo_idx ON repositories(owner_login, repo_name);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  delivery_id TEXT PRIMARY KEY,
  event TEXT NOT NULL,
  action TEXT,
  target_id INTEGER,
  status TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
