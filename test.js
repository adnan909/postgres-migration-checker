const { test } = require('node:test');
const assert = require('node:assert');
const { analyze, splitStatements } = require('./checker.js');

const titles = (sql, opts) => analyze(sql, opts).findings.map((f) => `${f.severity}: ${f.title}`);
const has = (sql, re, opts) => titles(sql, opts).some((t) => re.test(t));
const LT = "SET lock_timeout = '3s';\n";

test('splitter handles comments, quotes and dollar quotes', () => {
  const st = splitStatements(`-- a; comment\nSELECT 'x;y';\n/* b; */ CREATE FUNCTION f() RETURNS int AS $$ SELECT 1; $$ LANGUAGE sql;\nSELECT "a;b"`);
  assert.equal(st.length, 3);
  assert.equal(st[1].line, 3);
});

test('CREATE INDEX on existing table', () => {
  assert.ok(has(LT + 'CREATE INDEX i ON users (email);', /^danger: Index build blocks all writes to "users"/));
  assert.ok(!has(LT + 'CREATE INDEX CONCURRENTLY i ON users (email);', /Index build/, { wrappedInTransaction: false }));
  assert.ok(!has('CREATE TABLE users (id int);\nCREATE INDEX i ON users (id);', /Index build/));
  assert.ok(has('CREATE UNIQUE INDEX i ON public."Users" (email);', /blocks all writes to "Users"/));
});

test('CONCURRENTLY inside a transaction', () => {
  assert.ok(has('CREATE INDEX CONCURRENTLY i ON users (email);', /cannot run inside a transaction/));
  assert.ok(!has('CREATE INDEX CONCURRENTLY i ON users (email);', /cannot run inside/, { wrappedInTransaction: false }));
  assert.ok(has('BEGIN;\nCREATE INDEX CONCURRENTLY i ON users (email);\nCOMMIT;', /cannot run inside/, { wrappedInTransaction: false }));
});

test('ADD COLUMN variants', () => {
  assert.equal(titles(LT + 'ALTER TABLE users ADD COLUMN age int;').length, 0);
  assert.equal(titles(LT + "ALTER TABLE users ADD COLUMN status text NOT NULL DEFAULT 'active';").length, 0);
  assert.equal(titles(LT + 'ALTER TABLE users ADD COLUMN seen_at timestamptz DEFAULT now();').length, 0);
  assert.ok(has(LT + 'ALTER TABLE users ADD COLUMN token uuid DEFAULT gen_random_uuid();', /^danger: DEFAULT gen_random_uuid\(\) rewrites/));
  assert.ok(has(LT + 'ALTER TABLE users ADD COLUMN n int NOT NULL;', /^danger: NOT NULL column without a DEFAULT/));
  assert.ok(has(LT + 'ALTER TABLE users ADD COLUMN seq bigserial;', /^danger: Adding seq rewrites/));
  assert.ok(has(LT + 'ALTER TABLE users ADD COLUMN n int GENERATED ALWAYS AS IDENTITY;', /rewrites the whole table/));
  assert.ok(has(LT + 'ALTER TABLE orders ADD COLUMN user_id int REFERENCES users(id);', /^info: Foreign key on new column/));
});

test('ALTER COLUMN TYPE', () => {
  assert.ok(has(LT + 'ALTER TABLE users ALTER COLUMN id TYPE bigint;', /^danger: Changing the type of id rewrites/));
  assert.ok(has(LT + 'ALTER TABLE users ALTER COLUMN name TYPE text;', /^info: Changing name to text is usually instant/));
  assert.ok(has(LT + 'ALTER TABLE users ALTER COLUMN n SET DATA TYPE numeric(10,2) USING n::numeric;', /Changing the type of n rewrites/));
});

test('SET NOT NULL', () => {
  assert.ok(has(LT + 'ALTER TABLE users ALTER COLUMN email SET NOT NULL;', /^warning: SET NOT NULL scans/));
});

test('constraints', () => {
  assert.ok(has(LT + 'ALTER TABLE orders ADD CONSTRAINT fk FOREIGN KEY (user_id) REFERENCES users(id);', /^danger: Foreign key validation/));
  assert.ok(!has(LT + 'ALTER TABLE orders ADD CONSTRAINT fk FOREIGN KEY (user_id) REFERENCES users(id) NOT VALID;', /Foreign key/));
  assert.ok(has(LT + 'ALTER TABLE users ADD CONSTRAINT ck CHECK (age > 0);', /^warning: CHECK constraint scans/));
  assert.ok(!has(LT + 'ALTER TABLE users ADD CONSTRAINT ck CHECK (age > 0) NOT VALID;', /CHECK constraint/));
  assert.ok(has(LT + 'ALTER TABLE users ADD CONSTRAINT u UNIQUE (email);', /^danger: Adding UNIQUE builds an index/));
  assert.ok(has(LT + 'ALTER TABLE users ADD PRIMARY KEY (id);', /^danger: Adding PRIMARY KEY/));
  assert.ok(!has(LT + 'ALTER TABLE users ADD CONSTRAINT u UNIQUE USING INDEX u_idx;', /Adding UNIQUE/));
  assert.equal(titles(LT + 'ALTER TABLE users VALIDATE CONSTRAINT ck;').length, 0);
});

test('renames and drops', () => {
  assert.ok(has(LT + 'ALTER TABLE users RENAME COLUMN name TO full_name;', /^danger: Renaming column name/));
  assert.ok(has(LT + 'ALTER TABLE users RENAME TO accounts;', /^danger: Renaming table "users"/));
  assert.ok(has(LT + 'ALTER TABLE users DROP COLUMN legacy;', /^warning: Dropping legacy/));
  assert.ok(!has(LT + 'ALTER TABLE users DROP CONSTRAINT ck;', /Dropping/));
  assert.ok(!has(LT + 'ALTER TABLE users ALTER COLUMN a DROP DEFAULT;', /Dropping/));
  assert.ok(has('DROP TABLE IF EXISTS old_events;', /^warning: Dropping "old_events"/));
});

test('maintenance statements', () => {
  assert.ok(has('VACUUM FULL users;', /Rewrites the whole table/, { wrappedInTransaction: false }));
  assert.ok(has('CLUSTER users USING users_pkey;', /Rewrites the whole table/));
  assert.ok(has('REINDEX TABLE users;', /^warning: REINDEX blocks writes/));
  assert.ok(has('REFRESH MATERIALIZED VIEW stats;', /REFRESH blocks reads/));
  assert.ok(has('DROP INDEX idx_users_email;', /DROP INDEX takes/));
});

test('data changes', () => {
  assert.ok(has("UPDATE users SET status = 'active';", /^warning: Data change on "users"/));
  assert.ok(!has('CREATE TABLE t (id int);\nINSERT INTO t VALUES (1);\nUPDATE t SET id = 2;', /Data change/));
});

test('lock_timeout and lock pile-up', () => {
  assert.ok(has('ALTER TABLE users ADD COLUMN age int;', /^warning: No lock_timeout/));
  assert.ok(!has(LT + 'ALTER TABLE users ADD COLUMN age int;', /lock_timeout/));
  assert.ok(!has("SET LOCAL lock_timeout = '2s';\nALTER TABLE users ADD COLUMN age int;", /lock_timeout/));
  assert.equal(titles('ALTER TABLE users ADD COLUMN age int;\nALTER TABLE users ADD COLUMN b int;').filter((t) => /lock_timeout/.test(t)).length, 1);
  assert.ok(has(LT + 'ALTER TABLE users ADD COLUMN a int;\nALTER TABLE orders ADD COLUMN b int;', /^info: Locks pile up/));
  assert.ok(!has(LT + 'ALTER TABLE users ADD COLUMN a int;\nALTER TABLE orders ADD COLUMN b int;', /pile up/, { wrappedInTransaction: false }));
});

test('new tables are always safe', () => {
  const sql = `CREATE TABLE IF NOT EXISTS events (id bigserial PRIMARY KEY, user_id int NOT NULL);
ALTER TABLE events ADD CONSTRAINT fk FOREIGN KEY (user_id) REFERENCES users(id);
CREATE INDEX ON events (user_id);
ALTER TABLE events ADD COLUMN token uuid DEFAULT gen_random_uuid();`;
  assert.deepEqual(titles(sql), []);
});

test('foreign keys without an index', () => {
  const NO = /No index on/;
  assert.ok(has('CREATE TABLE orders (id bigserial PRIMARY KEY, user_id int NOT NULL REFERENCES users(id) ON DELETE CASCADE);', /^warning: No index on orders\(user_id\) for its foreign key/));
  assert.ok(!has('CREATE TABLE orders (id int, user_id int REFERENCES users(id));\nCREATE INDEX ON orders (user_id);', NO));
  assert.ok(has('CREATE TABLE m (a int, b int, FOREIGN KEY (a, b) REFERENCES p(x, y));\nCREATE INDEX i ON m (a);', /warning: No index on m\(a, b\)/));
  assert.ok(!has('CREATE TABLE m (a int, b int, CONSTRAINT f FOREIGN KEY (a, b) REFERENCES p(x, y));\nCREATE INDEX i ON m USING btree (b, a, id);', NO));
  assert.ok(!has('CREATE TABLE m (user_id int PRIMARY KEY REFERENCES users(id));', NO));
  assert.ok(has('CREATE TABLE m (user_id int REFERENCES users, tag_id int REFERENCES tags, PRIMARY KEY (user_id, tag_id));', /No index on m\(tag_id\)/));
  assert.ok(!has('CREATE TABLE m (user_id int REFERENCES users, tag_id int REFERENCES tags, PRIMARY KEY (user_id, tag_id));', /No index on m\(user_id\)/));
  assert.ok(has('CREATE TABLE m (a int);\nCREATE INDEX i ON m (lower(a));\nALTER TABLE m ADD FOREIGN KEY (a) REFERENCES p;', /No index on m\(a\)/));
  assert.ok(has(LT + 'ALTER TABLE orders ADD COLUMN user_id int REFERENCES users(id);', /^warning: No index on orders\(user_id\)/));
  assert.ok(has(LT + 'ALTER TABLE orders ADD CONSTRAINT fk FOREIGN KEY (user_id) REFERENCES users(id) NOT VALID;', /^info: No index on orders\(user_id\)/));
  assert.ok(!has(LT + 'ALTER TABLE orders ADD CONSTRAINT fk FOREIGN KEY (user_id) REFERENCES users(id) NOT VALID;\nCREATE INDEX CONCURRENTLY i ON orders (user_id DESC NULLS LAST);', NO, { wrappedInTransaction: false }));
  assert.ok(!has('CREATE TABLE "Orders" ("userId" int REFERENCES "Users"(id));\nCREATE INDEX ON "Orders" ("userId");', NO));
  const f = analyze('CREATE TABLE "Orders" ("userId" int REFERENCES "Users"(id));').findings.find((x) => NO.test(x.title));
  assert.match(f.fix, /^CREATE INDEX "Orders_userId_idx" ON "Orders" \("userId"\);/);
  const g = analyze(LT + 'ALTER TABLE orders ADD COLUMN user_id int REFERENCES users(id);').findings.find((x) => NO.test(x.title));
  assert.match(g.fix, /^CREATE INDEX CONCURRENTLY orders_user_id_idx ON orders \(user_id\);/);
  assert.equal(titles('CREATE TABLE t (LIKE other INCLUDING ALL);').length, 0);
});

test('line numbers point at the statement', () => {
  const f = analyze(LT + '\n\nCREATE INDEX i ON users (email);').findings[0];
  assert.equal(f.line, 4);
});
