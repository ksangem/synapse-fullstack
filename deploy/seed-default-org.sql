-- Default org used by the API (org_id hardcoded in routes until multi-tenancy is built)
INSERT INTO app.organizations (org_id, name, slug, plan)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'Default Organization',
  'default',
  'free'
)
ON CONFLICT (org_id) DO NOTHING;
