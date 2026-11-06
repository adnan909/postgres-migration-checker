-- Example of a risky migration (used to demo the Action).
ALTER TABLE users ADD COLUMN api_token uuid DEFAULT gen_random_uuid();
ALTER TABLE users ADD COLUMN plan text NOT NULL;
CREATE INDEX users_email_lower_idx ON users (lower(email));
ALTER TABLE users RENAME COLUMN email TO email_address;
