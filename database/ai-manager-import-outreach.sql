-- A contact can enter automatic import outreach only once, across files/retries.
CREATE TABLE ai_import_outreach_batches (
 id uuid PRIMARY KEY REFERENCES ai_contact_import_sessions(id),
 state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','paused','stopped')),
 platforms text[] NOT NULL,
 account_ids uuid[] NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ai_import_outreach_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 batch_id uuid NOT NULL REFERENCES ai_import_outreach_batches(id),
 contact_id uuid NOT NULL UNIQUE REFERENCES ai_contacts(id),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','resolving','ready','not_found','skipped')),
 lease_token uuid,
 lease_until timestamptz,
 retry_at timestamptz NOT NULL DEFAULT now(),
 reason text,
 request_id uuid REFERENCES ai_requests(id),
 conversation_id uuid REFERENCES ai_conversations(id),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_import_outreach_pending_idx ON ai_import_outreach_jobs(retry_at) WHERE state IN ('pending','resolving');
