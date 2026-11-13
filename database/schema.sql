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
ALTER TABLE integrations ADD COLUMN IF NOT EXISTS auth_error text;

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
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now();

-- Durable receipts prevent a repeated HTTP request from sending twice.
CREATE TABLE IF NOT EXISTS whatsapp_send_receipts (
  delivery_id uuid PRIMARY KEY REFERENCES deliveries(id) ON DELETE CASCADE,
  session_key text NOT NULL,
  destination_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('sending','sent','unknown')),
  message_id text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS deliveries_status_idx ON deliveries(status, queued_at DESC);
CREATE INDEX IF NOT EXISTS posts_created_at_idx ON posts(created_at DESC);

-- Media lifetime is separate from mutable UI timestamps and delivery history.
ALTER TABLE posts ADD COLUMN IF NOT EXISTS finished_at timestamptz;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS media_expired_at timestamptz;
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS expired_at timestamptz;
-- Old installations did not record completion time. Give them a full grace period.
UPDATE posts SET finished_at=now()
WHERE finished_at IS NULL AND status IN ('completed','stopped');
CREATE INDEX IF NOT EXISTS posts_media_retention_idx ON posts(finished_at)
  WHERE status IN ('completed','stopped') AND mode <> 'recurring' AND media_expired_at IS NULL;

-- No FK: these jobs must survive deletion of the attachment or its parent post.
CREATE TABLE IF NOT EXISTS attachment_cleanup_jobs (
  storage_path text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  last_error text
);
CREATE INDEX IF NOT EXISTS attachment_cleanup_due_idx ON attachment_cleanup_jobs(next_attempt_at);

CREATE OR REPLACE FUNCTION track_post_media_lifetime() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.media_expired_at IS NOT NULL THEN
    IF NEW.status NOT IN ('completed','stopped') OR NEW.media_expired_at IS NULL THEN
      RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='media_not_expired',
        MESSAGE='Срок хранения вложений истёк. Создайте новую публикацию и загрузите файлы заново';
    END IF;
  END IF;
  IF NEW.status NOT IN ('completed','stopped') THEN
    NEW.finished_at := NULL;
  ELSIF TG_OP='INSERT' THEN
    NEW.finished_at := now();
  ELSIF OLD.status NOT IN ('completed','stopped') OR NEW.finished_at IS NULL THEN
    NEW.finished_at := now();
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS posts_media_lifetime ON posts;
CREATE TRIGGER posts_media_lifetime BEFORE INSERT OR UPDATE ON posts
  FOR EACH ROW EXECUTE FUNCTION track_post_media_lifetime();

-- Serialize retries/claims with retirement, including requests from older workers.
CREATE OR REPLACE FUNCTION guard_delivery_media() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE retired timestamptz;
BEGIN
  SELECT media_expired_at INTO retired FROM posts WHERE id=NEW.post_id FOR UPDATE;
  IF retired IS NOT NULL AND NEW.status IN ('queued','sending','paused','unknown') THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='media_not_expired',
      MESSAGE='Срок хранения вложений истёк. Создайте новую публикацию и загрузите файлы заново';
  END IF;
  IF TG_OP='INSERT' OR NEW.status IS DISTINCT FROM OLD.status THEN
    UPDATE posts SET finished_at=now()
      WHERE id=NEW.post_id AND status IN ('completed','stopped') AND media_expired_at IS NULL;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS deliveries_media_guard ON deliveries;
CREATE TRIGGER deliveries_media_guard BEFORE INSERT OR UPDATE OF status ON deliveries
  FOR EACH ROW EXECUTE FUNCTION guard_delivery_media();

CREATE OR REPLACE FUNCTION guard_attachment_media() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE retired timestamptz;
BEGIN
  IF TG_OP='UPDATE' AND OLD.expired_at IS NOT NULL AND NEW.expired_at IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='media_not_expired',
      MESSAGE='Истёкшее вложение нельзя использовать повторно';
  END IF;
  IF NEW.post_id IS NOT NULL THEN
    SELECT media_expired_at INTO retired FROM posts WHERE id=NEW.post_id FOR UPDATE;
    IF retired IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='media_not_expired',
        MESSAGE='Нельзя добавить вложение в публикацию с истёкшим сроком хранения';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS attachments_media_guard ON attachments;
CREATE TRIGGER attachments_media_guard BEFORE INSERT OR UPDATE OF post_id, expired_at ON attachments
  FOR EACH ROW WHEN (NEW.expired_at IS NULL) EXECUTE FUNCTION guard_attachment_media();

CREATE OR REPLACE FUNCTION enqueue_attachment_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR (OLD.expired_at IS NULL AND NEW.expired_at IS NOT NULL) THEN
    INSERT INTO attachment_cleanup_jobs(storage_path) VALUES (OLD.storage_path)
      ON CONFLICT (storage_path) DO NOTHING;
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS attachments_cleanup_outbox ON attachments;
CREATE TRIGGER attachments_cleanup_outbox AFTER DELETE OR UPDATE OF expired_at ON attachments
  FOR EACH ROW EXECUTE FUNCTION enqueue_attachment_cleanup();

CREATE OR REPLACE FUNCTION guard_post_media_deletion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM deliveries WHERE post_id=OLD.id AND status='sending') THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='post_in_flight',
      MESSAGE='Дождитесь завершения текущей отправки перед удалением публикации';
  END IF;
  RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS posts_media_deletion_guard ON posts;
CREATE TRIGGER posts_media_deletion_guard BEFORE DELETE ON posts
  FOR EACH ROW EXECUTE FUNCTION guard_post_media_deletion();
