ALTER TABLE ai_contacts ADD COLUMN priority text NOT NULL DEFAULT 'normal' CHECK(priority IN ('high','normal','low'));
ALTER TABLE ai_contacts ADD COLUMN priority_revision integer NOT NULL DEFAULT 0 CHECK(priority_revision>=0);
CREATE INDEX ai_contacts_priority_idx ON ai_contacts(priority,id);
