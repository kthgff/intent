-- 0011_release_client_ref.sql — code-review S6 (D56):
--
--   POST /releases retries could double-create a draft release. A
--   client-supplied idempotency key (`client_ref`) is now stored on
--   the row and unique per workspace; createRelease short-circuits on
--   an existing row the same way deployments dedupe on deployment_id.

ALTER TABLE releases ADD COLUMN IF NOT EXISTS client_ref TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS releases_client_ref_key
  ON releases (workspace, client_ref)
  WHERE client_ref IS NOT NULL;
