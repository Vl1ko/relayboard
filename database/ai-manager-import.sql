-- A clean legacy baseline lacks this additive account-health field.
ALTER TABLE integrations ADD COLUMN IF NOT EXISTS auth_error text;
ALTER TABLE ai_contacts ADD COLUMN phone_e164 text UNIQUE
  CHECK (phone_e164 IS NULL OR phone_e164 ~ '^\+[1-9][0-9]{6,14}$');
ALTER TABLE ai_contacts ADD COLUMN comment text NOT NULL DEFAULT '';
-- Source stage is metadata, never a qualification/automation command.
ALTER TABLE ai_contacts ADD COLUMN imported_stage text NOT NULL DEFAULT '';
CREATE TABLE ai_contact_import_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_scope text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('inspection','preview')),
  filename text NOT NULL,
  payload jsonb,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now()+interval '20 minutes'
);
CREATE INDEX ai_contact_import_expiry_idx ON ai_contact_import_sessions(expires_at) WHERE result IS NULL;
