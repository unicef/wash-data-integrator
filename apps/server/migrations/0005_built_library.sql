-- Library entries made with the source builder. An editor proposes an
-- installed builder source's definition (without its deployment-owned fields
-- and without code, which is re-inlined from the connector at install); an
-- admin approves or rejects it. A new version proposed for an approved entry
-- waits in pending_definition while the approved one stays installable.
CREATE TABLE app.built_library_entries (
  id text PRIMARY KEY,
  definition jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('proposed', 'approved', 'rejected')),
  version int NOT NULL DEFAULT 1,
  pending_definition jsonb,
  proposed_by uuid REFERENCES app.users(id) ON DELETE SET NULL,
  approved_by uuid REFERENCES app.users(id) ON DELETE SET NULL,
  proposed_at timestamptz,
  decided_at timestamptz,
  note text
);
