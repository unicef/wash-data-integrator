-- The built library entry an installed copy came from: the entry version and
-- a fingerprint of its definition (without deployment fields, code and
-- connector version) at install. A copy whose definition still matches the
-- fingerprint has no local changes, so a newer approved version of its entry
-- shows as an update; a copy that differs was changed here.
ALTER TABLE app.integrations ADD COLUMN built_base jsonb;
