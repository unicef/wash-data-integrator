-- Source builder drafts are agent_sessions rows of kind 'builder': their
-- client_state holds the screens ({ step, id, name, source, trigger, recipe }),
-- and their previews reuse the session scratch area (draft schema, /work,
-- file staging).
ALTER TABLE app.agent_sessions DROP CONSTRAINT agent_sessions_kind_check;
ALTER TABLE app.agent_sessions
  ADD CONSTRAINT agent_sessions_kind_check CHECK (kind IN ('designer', 'assistant', 'dashboard', 'builder'));

-- A builder draft's credentials (the web API key), encrypted like
-- integration_secrets. They belong to the draft until Accept moves them to
-- the installed integration, and go with the draft when it is deleted.
CREATE TABLE app.draft_secrets (
  session_id uuid NOT NULL REFERENCES app.agent_sessions(id) ON DELETE CASCADE,
  name text NOT NULL,
  value bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, name)
);
