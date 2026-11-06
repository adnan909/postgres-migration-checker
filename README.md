# Postgres Migration Safety Checker

**Check every pull request in CI with the GitHub Action below, or paste a migration into the web version: https://adnan909.github.io/postgres-migration-checker/**

Paste a PostgreSQL migration and see which statements will lock or rewrite a live table, fail on a table that has data, or break your app during a rolling deploy, with a safe rewrite for each one. Runs entirely in your browser.

## Use it in CI (GitHub Action)

Check every pull request's migrations automatically. Risky statements get inline marks in the diff and one summary comment with a safe version of each.
See it on a real pull request: [demo](https://github.com/adnan909/postgres-migration-checker/pull/1).

```yaml
# .github/workflows/migrations.yml
name: migration safety
on:
  pull_request:
    paths: ['**/*.sql']
jobs:
  check:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write   # for the summary comment
    steps:
      - uses: actions/checkout@v4
      - uses: adnan909/postgres-migration-checker@v1
        with:
          files: db/migrations/**/*.sql   # default: **/*.sql
```

| Input | Default | What it does |
| --- | --- | --- |
| `files` | `**/*.sql` | Glob patterns for migration files (comma or newline separated). Only files changed in the pull request are checked. |
| `wrapped-in-transaction` | `true` | Set to `false` if your tool runs each migration outside a transaction. |
| `fail-on` | `danger` | Fail the check on `danger`, on `warning` (and worse), or `never`. |
| `comment` | `true` | Post one summary comment and keep it updated as you push fixes. Clean pull requests get no comment. |

Works with any tool that keeps migrations as SQL files: Prisma (`prisma/migrations/*/migration.sql`), Supabase, Flyway, golang-migrate, dbmate, node-pg-migrate SQL files and more. Runs on Node with no dependencies, so it adds about a second to your job.

## What it catches

- `CREATE INDEX` without `CONCURRENTLY` (blocks writes)
- `CONCURRENTLY` inside a transaction (the migration fails)
- `ADD COLUMN` with a volatile default like `gen_random_uuid()` (rewrites the table), or `NOT NULL` with no default (fails on non-empty tables)
- `ALTER COLUMN ... TYPE` (rewrite), `SET NOT NULL` (full scan under the strongest lock)
- `FOREIGN KEY` / `CHECK` without `NOT VALID`, `UNIQUE` / `PRIMARY KEY` without `USING INDEX`
- Foreign keys with no index on the referencing columns: every `DELETE` on the parent table (cascade or not) scans the whole child table. Measured on 2M child rows: deleting 100 parents took 7.87 s without the index, 3.66 ms with it. The checker only sees the migration, so on an existing column this is a note (the index may already exist); on a new column it is a warning.
- `RENAME` and `DROP` that break code still running during a deploy
- `VACUUM FULL`, `CLUSTER`, `REINDEX`, `REFRESH MATERIALIZED VIEW`, in-migration `UPDATE`/`DELETE` backfills
- Missing `lock_timeout`, and strong locks piling up inside one transaction

Every rule's behaviour (which lock it takes, whether it rewrites the table) was measured on PostgreSQL 16, and every suggested fix is run against a real database. Targets PostgreSQL 11+.

## Use it in your own tooling

`checker.js` has no dependencies:

```js
const { analyze } = require('./checker.js');
const { findings } = analyze(sql, { wrappedInTransaction: true });
for (const f of findings) console.log(f.severity, `line ${f.line}:`, f.title);
```

Run the tests with `node --test test.js action/test.js`.

## Make Claude Code write safe migrations

The free [`postgres-safe-migrations` Claude Code skill](https://github.com/adnan909/free-sample) teaches Claude these same rules, so it writes migrations like this in the first place. The full [Backend Skills Pack](https://adnology0.gumroad.com/l/backend-skills-pack) covers the rest of a TypeScript + GraphQL + Postgres backend.

MIT licensed.
