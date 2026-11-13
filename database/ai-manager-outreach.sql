-- Explicit business requests are independent of imports and channel identities.
CREATE TABLE ai_requests (
 id uuid PRIMARY KEY,
 contact_id uuid NOT NULL REFERENCES ai_contacts(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_requests_contact_idx ON ai_requests(contact_id,id);
CREATE TABLE ai_outreach_settings (
 id integer PRIMARY KEY CHECK(id=1),
 revision integer NOT NULL DEFAULT 0,
 template text NOT NULL DEFAULT '' CHECK(length(template)<=4000),
 interval_seconds integer NOT NULL DEFAULT 60 CHECK(interval_seconds BETWEEN 1 AND 86400),
 platforms text[] NOT NULL DEFAULT ARRAY['max','whatsapp']::text[],
 account_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
 updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO ai_outreach_settings(id) VALUES(1);
