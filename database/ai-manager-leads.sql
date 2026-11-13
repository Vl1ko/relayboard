CREATE TABLE ai_leads (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 source_key text NOT NULL UNIQUE,
 source_fingerprint text NOT NULL,
 platform text NOT NULL CHECK(platform IN ('max','whatsapp','telegram')),
 account_id uuid NOT NULL,
 chat_id text NOT NULL,
 author_id text NOT NULL,
 message_id text NOT NULL,
 occurred_at timestamptz NOT NULL,
 source_link text,
 original_text text NOT NULL,
 source_kind text NOT NULL CHECK(source_kind IN ('manual','fixture')),
 params jsonb NOT NULL,
 confidence double precision NOT NULL CHECK(confidence>=0 AND confidence<=1),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
 revision integer NOT NULL DEFAULT 0,
 contact_id uuid REFERENCES ai_contacts(id) ON DELETE RESTRICT,
 request_id uuid REFERENCES ai_requests(id) ON DELETE RESTRICT,
 review_reason text,
 created_at timestamptz NOT NULL DEFAULT now(),
 reviewed_at timestamptz,
 CHECK((status='approved' AND contact_id IS NOT NULL AND request_id IS NOT NULL) OR (status<>'approved' AND contact_id IS NULL AND request_id IS NULL))
);
CREATE INDEX ai_leads_review_idx ON ai_leads(status,created_at,id);
CREATE TABLE ai_lead_operations (
 id uuid PRIMARY KEY,
 fingerprint text NOT NULL,
 lead_id uuid NOT NULL REFERENCES ai_leads(id) ON DELETE RESTRICT,
 result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
