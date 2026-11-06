-- Cole este arquivo inteiro no Console do banco D1 (Cloudflare) e clique em Execute.

CREATE TABLE IF NOT EXISTS games (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  description TEXT    NOT NULL,
  cover_url   TEXT,                         -- capa hospedada no itch/steam
  cover_data  TEXT,                         -- capa enviada manualmente (data URL, ~20-150 KB)
  store       TEXT    NOT NULL,             -- 'itch' | 'steam'
  store_url   TEXT    NOT NULL,
  url_key     TEXT    NOT NULL UNIQUE,      -- evita jogo duplicado
  tags        TEXT    NOT NULL DEFAULT '[]',-- JSON: ["platformer","pixel art"]
  status      TEXT    NOT NULL DEFAULT 'pending', -- approved | pending | rejected
  source      TEXT    NOT NULL,             -- 'ai' | 'manual'
  owner_sub   TEXT    NOT NULL,
  owner_email TEXT    NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_games_status_created ON games(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_games_owner ON games(owner_sub);

CREATE TABLE IF NOT EXISTS usage (
  user_sub    TEXT    NOT NULL,
  day         TEXT    NOT NULL,
  analyses    INTEGER NOT NULL DEFAULT 0,
  submissions INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_sub, day)
);
