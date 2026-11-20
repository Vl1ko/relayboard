-- Public settings commands must not silently overwrite a concurrent manager.
ALTER TABLE ai_manager_target ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK(revision>=1);
