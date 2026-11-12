-- Additive E02 expansion. Applied explicitly by migrate-ai-manager, not on production yet.
CREATE TABLE ai_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name text NOT NULL DEFAULT '',
  opted_out_at timestamptz,
  opt_out_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ai_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid NOT NULL REFERENCES ai_contacts(id) ON DELETE RESTRICT,
  -- Snapshot identity, not a FK: legacy hard-delete must not cascade history or fail.
  account_id uuid NOT NULL,
  platform text NOT NULL CHECK (platform IN ('max','whatsapp')),
  external_id text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 512 AND btrim(external_id)<>''),
  business_status text NOT NULL DEFAULT 'new' CHECK (business_status IN
    ('new','ai_dialog','qualified','unqualified','insufficient_data','manager_required','manager_working','refused','closed')),
  automation_mode text NOT NULL DEFAULT 'paused' CHECK (automation_mode IN ('auto','paused','manual')),
  automation_epoch bigint NOT NULL DEFAULT 0 CHECK (automation_epoch>=0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id,external_id),
  UNIQUE (id,contact_id)
);
CREATE INDEX ai_conversations_contact_idx ON ai_conversations(contact_id,id);
CREATE TABLE ai_inbox (
  event_key text PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES ai_conversations(id) ON DELETE RESTRICT,
  external_message_id text NOT NULL,
  occurred_at timestamptz NOT NULL,
  direction text NOT NULL CHECK (direction IN ('inbound','outbound')),
  origin text NOT NULL CHECK (origin IN ('customer','service','human','unresolved')),
  disposition text NOT NULL CHECK (disposition IN ('process_customer','suppress_service_echo','takeover','hold_for_review')),
  text text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((origin='customer' AND direction='inbound') OR
    (origin IN ('service','human') AND direction='outbound') OR origin='unresolved')
);
CREATE INDEX ai_inbox_conversation_idx ON ai_inbox(conversation_id,occurred_at,event_key);
CREATE TABLE ai_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid NOT NULL REFERENCES ai_contacts(id) ON DELETE RESTRICT,
  conversation_id uuid NOT NULL,
  logical_key text NOT NULL CHECK (length(logical_key) BETWEEN 1 AND 512 AND btrim(logical_key)<>''),
  kind text NOT NULL CHECK (kind IN ('first_message','reply','follow_up')),
  text text NOT NULL CHECK (btrim(text)<>''),
  fingerprint text NOT NULL,
  automation_epoch bigint NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','dispatching','confirmed','rejected','unknown','cancelled')),
  attempt_token uuid,
  dispatch_started_at timestamptz,
  external_message_id text,
  outcome_code text,
  cancellation_requested boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (contact_id,kind,logical_key),
  CHECK (state<>'confirmed' OR external_message_id IS NOT NULL),
  FOREIGN KEY (conversation_id,contact_id) REFERENCES ai_conversations(id,contact_id) ON DELETE RESTRICT
);
CREATE INDEX ai_outbox_pending_idx ON ai_outbox(created_at,id) WHERE state='pending';
CREATE INDEX ai_outbox_conversation_idx ON ai_outbox(conversation_id,state);
