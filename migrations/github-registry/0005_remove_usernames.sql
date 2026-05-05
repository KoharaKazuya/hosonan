CREATE TABLE users_new (
  user_id TEXT PRIMARY KEY,
  display_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO users_new (user_id, display_name, created_at, updated_at)
SELECT user_id, display_name, created_at, updated_at FROM users;

CREATE TABLE auth_identities_backup AS
SELECT provider, provider_user_id, user_id, provider_username, created_at, updated_at FROM auth_identities;

CREATE TABLE passkey_credentials_backup AS
SELECT
  credential_id,
  user_id,
  public_key,
  counter,
  transports,
  credential_device_type,
  credential_backed_up,
  created_at,
  updated_at
FROM passkey_credentials;

CREATE TABLE auth_challenges_backup AS
SELECT challenge_id, kind, challenge, user_id, redirect_path, expires_at, consumed_at, created_at FROM auth_challenges;

CREATE TABLE sessions_backup AS
SELECT session_id, session_hash, user_id, expires_at, revoked_at, created_at FROM sessions;

DROP TABLE auth_identities;
DROP TABLE passkey_credentials;
DROP TABLE auth_challenges;
DROP TABLE sessions;

ALTER TABLE users RENAME TO users_old;
ALTER TABLE users_new RENAME TO users;
DROP TABLE users_old;

CREATE TABLE auth_identities (
  provider TEXT NOT NULL,
  provider_user_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  provider_username TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (provider, provider_user_id),
  FOREIGN KEY (user_id) REFERENCES users(user_id)
);

INSERT INTO auth_identities (provider, provider_user_id, user_id, provider_username, created_at, updated_at)
SELECT provider, provider_user_id, user_id, provider_username, created_at, updated_at FROM auth_identities_backup;

CREATE TABLE passkey_credentials (
  credential_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL,
  transports TEXT,
  credential_device_type TEXT,
  credential_backed_up INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(user_id)
);

INSERT INTO passkey_credentials (
  credential_id,
  user_id,
  public_key,
  counter,
  transports,
  credential_device_type,
  credential_backed_up,
  created_at,
  updated_at
)
SELECT
  credential_id,
  user_id,
  public_key,
  counter,
  transports,
  credential_device_type,
  credential_backed_up,
  created_at,
  updated_at
FROM passkey_credentials_backup;

CREATE TABLE auth_challenges (
  challenge_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  challenge TEXT NOT NULL,
  user_id TEXT,
  redirect_path TEXT,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(user_id)
);

INSERT INTO auth_challenges (challenge_id, kind, challenge, user_id, redirect_path, expires_at, consumed_at, created_at)
SELECT challenge_id, kind, challenge, user_id, redirect_path, expires_at, consumed_at, created_at FROM auth_challenges_backup;

CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  session_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(user_id)
);

INSERT INTO sessions (session_id, session_hash, user_id, expires_at, revoked_at, created_at)
SELECT session_id, session_hash, user_id, expires_at, revoked_at, created_at FROM sessions_backup;

DROP TABLE auth_identities_backup;
DROP TABLE passkey_credentials_backup;
DROP TABLE auth_challenges_backup;
DROP TABLE sessions_backup;

CREATE INDEX auth_identities_user_id_idx ON auth_identities(user_id);
CREATE INDEX passkey_credentials_user_id_idx ON passkey_credentials(user_id);
CREATE INDEX auth_challenges_lookup_idx ON auth_challenges(kind, user_id, expires_at);
CREATE INDEX auth_challenges_challenge_idx ON auth_challenges(kind, challenge);
CREATE INDEX sessions_user_id_idx ON sessions(user_id);
CREATE INDEX sessions_hash_idx ON sessions(session_hash);
