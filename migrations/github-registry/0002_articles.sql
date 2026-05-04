CREATE TABLE IF NOT EXISTS articles (
  repository_id INTEGER NOT NULL,
  owner_login TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  article_path TEXT NOT NULL,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  canonical_path TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  status TEXT NOT NULL,
  synced_commit TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repository_id, article_path),
  FOREIGN KEY (repository_id) REFERENCES repositories(repository_id)
);

CREATE INDEX IF NOT EXISTS articles_status_created_at_idx ON articles(status, created_at DESC);
