CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$ BEGIN
  CREATE TYPE messenger_platform AS ENUM ('telegram', 'max', 'whatsapp', 'vk');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE post_mode AS ENUM ('now', 'scheduled', 'recurring');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE delivery_status AS ENUM ('queued', 'sending', 'sent', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform messenger_platform NOT NULL,
  name text NOT NULL,
  credential_ciphertext text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

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
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

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
  queued_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  UNIQUE (post_id, destination_id, occurrence_key)
);

CREATE INDEX IF NOT EXISTS deliveries_status_idx ON deliveries(status, queued_at DESC);
CREATE INDEX IF NOT EXISTS posts_created_at_idx ON posts(created_at DESC);
