CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$ BEGIN
  CREATE TYPE messenger_platform AS ENUM ('telegram', 'max', 'whatsapp');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE post_mode AS ENUM ('now', 'scheduled', 'recurring');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE delivery_status AS ENUM ('queued', 'sending', 'sent', 'failed', 'paused', 'stopped', 'skipped', 'unknown');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TYPE delivery_status ADD VALUE IF NOT EXISTS 'paused';
ALTER TYPE delivery_status ADD VALUE IF NOT EXISTS 'stopped';
ALTER TYPE delivery_status ADD VALUE IF NOT EXISTS 'skipped';
ALTER TYPE delivery_status ADD VALUE IF NOT EXISTS 'unknown';

CREATE TABLE IF NOT EXISTS integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform messenger_platform NOT NULL,
  name text NOT NULL,
  credential_ciphertext text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'messenger_platform' AND e.enumlabel = 'vk'
  ) THEN
    DELETE FROM integrations WHERE platform::text = 'vk';
    ALTER TYPE messenger_platform RENAME TO messenger_platform_legacy;
    CREATE TYPE messenger_platform AS ENUM ('telegram', 'max', 'whatsapp');
    ALTER TABLE integrations ALTER COLUMN platform TYPE messenger_platform USING platform::text::messenger_platform;
    DROP TYPE messenger_platform_legacy;
  END IF;
END $$;

DROP INDEX IF EXISTS integrations_platform_unique_idx;
ALTER TABLE integrations ADD COLUMN IF NOT EXISTS session_key text;
-- Claim the original on-disk session once; later accounts use their UUID.
UPDATE integrations SET session_key='legacy' WHERE session_key IS NULL;
ALTER TABLE integrations ALTER COLUMN session_key SET DEFAULT gen_random_uuid()::text;
ALTER TABLE integrations ALTER COLUMN session_key SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS integrations_session_key_idx ON integrations(platform,session_key);

CREATE TABLE IF NOT EXISTS destinations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id uuid NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  external_id text NOT NULL,
  title text NOT NULL,
  kind text NOT NULL DEFAULT 'group',
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (integration_id, external_id)
);

CREATE TABLE IF NOT EXISTS posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  text text NOT NULL,
  media_url text,
  mode post_mode NOT NULL,
  scheduled_at timestamptz,
  cron_pattern text,
  timezone text NOT NULL DEFAULT 'Europe/Moscow',
  status text NOT NULL DEFAULT 'scheduled',
  interval_seconds integer NOT NULL DEFAULT 30,
  max_attempts integer NOT NULL DEFAULT 3,
  retry_delay_seconds integer NOT NULL DEFAULT 30,
  scheduler_enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE posts ADD COLUMN IF NOT EXISTS interval_seconds integer NOT NULL DEFAULT 30;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS max_attempts integer NOT NULL DEFAULT 3;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS retry_delay_seconds integer NOT NULL DEFAULT 30;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS scheduler_enabled boolean NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid REFERENCES posts(id) ON DELETE CASCADE,
  original_name text NOT NULL,
  stored_name text NOT NULL UNIQUE,
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  storage_path text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS attachments_post_id_idx ON attachments(post_id);

CREATE TABLE IF NOT EXISTS admin_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS admin_sessions_expires_at_idx ON admin_sessions(expires_at);

CREATE TABLE IF NOT EXISTS post_destinations (
  post_id uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  destination_id uuid NOT NULL REFERENCES destinations(id) ON DELETE CASCADE,
  PRIMARY KEY (post_id, destination_id)
);

CREATE TABLE IF NOT EXISTS deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  destination_id uuid NOT NULL REFERENCES destinations(id) ON DELETE CASCADE,
  occurrence_key text NOT NULL,
  status delivery_status NOT NULL DEFAULT 'queued',
  attempt_count integer NOT NULL DEFAULT 0,
  external_message_id text,
  last_error text,
  last_error_kind text,
  queued_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  UNIQUE (post_id, destination_id, occurrence_key)
);

ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS last_error_kind text;

CREATE INDEX IF NOT EXISTS deliveries_status_idx ON deliveries(status, queued_at DESC);
CREATE INDEX IF NOT EXISTS posts_created_at_idx ON posts(created_at DESC);
