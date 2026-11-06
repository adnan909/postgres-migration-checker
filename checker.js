/*
 * Postgres migration safety checker.
 * Flags statements that lock or rewrite live tables, or break running code.
 * Rules target PostgreSQL 11+ and were verified against PostgreSQL 16.
 * Works in the browser (window.analyzeMigration) and Node (module.exports).
 */
(function (root) {
  'use strict';

  // ---------- statement splitting (comments, quotes, dollar quotes) ----------
  function splitStatements(sql) {
    const out = [];
    let buf = '';
    let line = 1;
    let startLine = 1;
    let i = 0;
    let started = false;
    const n = sql.length;
    const push = () => {
      const text = buf.trim();
      if (text) out.push({ text, line: startLine });
      buf = '';
      started = false;
    };
    while (i < n) {
      const c = sql[i];
      const next = sql[i + 1];
      if (c === '-' && next === '-') {
        while (i < n && sql[i] !== '\n') i++;
        continue;
      }
      if (c === '/' && next === '*') {
        i += 2;
        while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) {
          if (sql[i] === '\n') line++;
          i++;
        }
        i += 2;
        continue;
      }
      if (!started && !/\s/.test(c) && c !== ';') {
        started = true;
        startLine = line;
      }
      if (c === "'" || c === '"') {
        const q = c;
        buf += c;
        i++;
        while (i < n) {
          if (sql[i] === '\n') line++;
          buf += sql[i];
          if (sql[i] === q) {
            if (sql[i + 1] === q) { buf += sql[i + 1]; i += 2; continue; }
            i++;
            break;
          }
          i++;
        }
        continue;
      }
      if (c === '$') {
        const m = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
        if (m) {
          const tag = m[0];
          const end = sql.indexOf(tag, i + tag.length);
          const stop = end === -1 ? n : end + tag.length;
          const chunk = sql.slice(i, stop);
          line += (chunk.match(/\n/g) || []).length;
          buf += chunk;
          i = stop;
          continue;
        }
      }
      if (c === ';') { push(); i++; continue; }
      if (c === '\n') line++;
      buf += c;
      i++;
    }
    push();
    return out;
  }

  // ---------- helpers ----------
  const ident = '(?:"[^"]+"|[A-Za-z_][\\w$]*)';
  const qualified = `(${ident}(?:\\.${ident})?)`;
  const norm = (name) => {
    if (!name) return '';
    const last = name.split('.').pop();
    return last.startsWith('"') ? last.slice(1, -1) : last.toLowerCase();
  };
  const flat = (s) => s.replace(/\s+/g, ' ').trim();
  const VOLATILE_DEFAULT = /\bDEFAULT\s+(?:[\w.]*\.)?(gen_random_uuid|uuid_generate_v[14]|uuid_generate_v1mc|random|clock_timestamp|timeofday|nextval|txid_current)\s*\(/i;
  const REWRITE_COLUMN = /\b(BIG)?SERIAL\b|\bSMALLSERIAL\b|\bGENERATED\s+(ALWAYS|BY\s+DEFAULT)\s+AS\s+IDENTITY\b|\bGENERATED\s+ALWAYS\s+AS\s*\(.*\)\s*STORED\b/i;


  // ---------- foreign keys without an index on the referencing columns ----------
  // Text inside the parentheses that open at or after `from`, or null.
  function parenBody(s, from) {
    const open = s.indexOf('(', from);
    if (open === -1 || s.slice(from, open).trim() !== '') return null;
    let depth = 0, q = null;
    for (let i = open; i < s.length; i++) {
      const ch = s[i];
      if (q) { if (ch === q) q = null; continue; }
      if (ch === "'" || ch === '"') { q = ch; continue; }
      if (ch === '(') depth++;
      if (ch === ')' && --depth === 0) return { inner: s.slice(open + 1, i), end: i + 1 };
    }
    return null;
  }
  // "a, b" -> ['a', 'b']; an expression element becomes null (it can't cover a plain column).
  const colNames = (list) => splitTopLevel(list).map((c) => {
    const mm = new RegExp(`^(${ident})(?:\\s+(?:COLLATE\\s+\\S+|ASC|DESC|NULLS\\s+(?:FIRST|LAST)|[a-z_][\\w.]*_ops))*\\s*$`, 'i').exec(c.trim());
    return mm ? norm(mm[1]) : null;
  });

  // Collects every foreign key and every index (incl. PRIMARY KEY / UNIQUE) the file defines.
  function collectKeys(statements) {
    const fks = [];
    const indexes = [];
    const newTables = new Set();
    const newCols = new Set();
    const refRe = new RegExp(`\\bREFERENCES\\s+${qualified}`, 'i');
    const fkRe = new RegExp(`^(?:CONSTRAINT\\s+${ident}\\s+)?FOREIGN\\s+KEY\\s*\\(([^)]*)\\)\\s*REFERENCES\\s+${qualified}`, 'i');
    const keyRe = new RegExp(`^(?:CONSTRAINT\\s+${ident}\\s+)?(?:PRIMARY\\s+KEY|UNIQUE(?:\\s+NULLS\\s+(?:NOT\\s+)?DISTINCT)?)\\s*\\(([^)]*)\\)`, 'i');
    const colRe = new RegExp(`^(?:ADD\\s+(?:COLUMN\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?)?(${ident})\\s+(.*)$`, 'i');

    // one element of a CREATE TABLE body or one ALTER TABLE ... ADD action
    const element = (st, table, el, isAdd) => {
      let mm;
      const body = isAdd ? el.replace(/^ADD\s+/i, '') : el;
      if ((mm = fkRe.exec(body))) {
        fks.push({ st, table, cols: colNames(mm[1]), ref: norm(mm[2]) });
        return;
      }
      if ((mm = keyRe.exec(body))) { indexes.push({ table, cols: colNames(mm[1]) }); return; }
      if (/^(CONSTRAINT|CHECK|EXCLUDE|LIKE|PRIMARY|UNIQUE|FOREIGN)\b/i.test(body)) return;
      if (isAdd && /^ADD\s+(CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN|EXCLUDE)\b/i.test(el)) return;
      if (!(mm = colRe.exec(isAdd ? el : body))) return;
      const col = norm(mm[1]);
      const def = mm[2];
      newCols.add(`${table}.${col}`);
      const r = refRe.exec(def);
      if (r) fks.push({ st, table, cols: [col], ref: norm(r[1]) });
      if (/\b(PRIMARY\s+KEY|UNIQUE)\b/i.test(def)) indexes.push({ table, cols: [col] });
    };

    for (const st of statements) {
      const s = flat(st.text);
      let m;
      if ((m = new RegExp(`^CREATE\\s+(?:UNLOGGED\\s+|TEMP(?:ORARY)?\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${qualified}`, 'i').exec(s))) {
        const table = norm(m[1]);
        newTables.add(table);
        const b = parenBody(s, m[0].length);
        if (b) for (const el of splitTopLevel(b.inner)) element(st, table, el, false);
        continue;
      }
      if ((m = new RegExp(`^CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?:CONCURRENTLY\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:${ident}\\s+)?ON\\s+(?:ONLY\\s+)?${qualified}(?:\\s+USING\\s+\\w+)?\\s*`, 'i').exec(s))) {
        const b = parenBody(s, m[0].length);
        if (b) indexes.push({ table: norm(m[1]), cols: colNames(b.inner) });
        continue;
      }
      if ((m = new RegExp(`^ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?${qualified}\\s+(.*)$`, 'i').exec(s))) {
        const table = norm(m[1]);
        for (const a of splitTopLevel(m[2])) if (/^ADD\b/i.test(a)) element(st, table, a, true);
      }
    }
    return { fks, indexes, newTables, newCols };
  }

  // An index covers a foreign key when its leading columns are exactly the key's columns (any order).
  const covers = (idx, fk) => {
    if (idx.table !== fk.table || idx.cols.length < fk.cols.length) return false;
    const lead = idx.cols.slice(0, fk.cols.length);
    return fk.cols.every((c) => c && lead.includes(c));
  };

  function analyze(sql, opts) {
    const options = Object.assign({ wrappedInTransaction: true }, opts || {});
    const statements = splitStatements(sql);
    const findings = [];
    const created = new Set();
    let explicitTxn = false;
    let lockTimeout = false;
    let lockTimeoutWarned = false;
    let heavyInTxn = [];

    const add = (st, severity, title, why, fix) =>
      findings.push({ line: st.line, statement: st.text, severity, title, why, fix });

    const inTxn = () => explicitTxn || options.wrappedInTransaction;

    const heavy = (st, table) => {
      if (!lockTimeout && !lockTimeoutWarned) {
        lockTimeoutWarned = true;
        add(st, 'warning', 'No lock_timeout before a locking statement',
          `This statement needs a strong lock on "${table}". If a long-running query is using the table, the migration waits for it, and every query that arrives after the migration queues behind it. A 1-second ALTER can turn into minutes of blocked traffic.`,
          "SET lock_timeout = '3s';  -- at the top of the migration; retry on timeout instead of raising it");
      }
      if (inTxn()) heavyInTxn.push({ st, table });
    };

    for (const st of statements) {
      const s = flat(st.text);
      const S = s.toUpperCase();
      let m;

      // transaction control & settings
      if (/^(BEGIN|START TRANSACTION)\b/.test(S)) { explicitTxn = true; continue; }
      if (/^(COMMIT|END|ROLLBACK)\b/.test(S)) {
        flushTxn();
        explicitTxn = false;
        continue;
      }
      if (/^SET\s+(LOCAL\s+|SESSION\s+)?LOCK_TIMEOUT\b/.test(S) || /SET_CONFIG\s*\(\s*'LOCK_TIMEOUT'/.test(S)) {
        lockTimeout = true;
        continue;
      }

      // CREATE TABLE: later statements on it are safe (empty table)
      if ((m = new RegExp(`^CREATE\\s+(?:UNLOGGED\\s+|TEMP(?:ORARY)?\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${qualified}`, 'i').exec(s))) {
        created.add(norm(m[1]));
        continue;
      }

      // CONCURRENTLY inside a transaction fails outright
      if (/\bCONCURRENTLY\b/.test(S) && inTxn()) {
        add(st, 'danger', 'CONCURRENTLY cannot run inside a transaction',
          'Postgres rejects this with "cannot run inside a transaction block", so the migration fails. Most migration tools wrap each file in a transaction by default.',
          'Put this statement in its own migration and turn off the transaction for that file (e.g. node-pg-migrate: pgm.noTransaction(); Knex: config.transaction = false; Rails: disable_ddl_transaction!; Django: atomic = False).');
      }

      // CREATE INDEX
      if ((m = new RegExp(`^CREATE\\s+(UNIQUE\\s+)?INDEX\\s+(CONCURRENTLY\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:${ident}\\s+)?ON\\s+(?:ONLY\\s+)?${qualified}`, 'i').exec(s))) {
        const table = norm(m[3]);
        if (!m[2] && !created.has(table)) {
          add(st, 'danger', `Index build blocks all writes to "${table}"`,
            'CREATE INDEX takes a SHARE lock: reads continue, but every INSERT, UPDATE and DELETE on the table waits until the index is fully built. On a large table that can be minutes.',
            s.replace(/^CREATE\s+(UNIQUE\s+)?INDEX\s+/i, (x, u) => `CREATE ${u ? 'UNIQUE ' : ''}INDEX CONCURRENTLY `) + ';\n-- in its own migration, outside a transaction. If it fails, DROP INDEX CONCURRENTLY the INVALID index and retry.');
        }
        continue;
      }

      // DROP INDEX
      if (/^DROP\s+INDEX\b/.test(S) && !/\bCONCURRENTLY\b/.test(S)) {
        add(st, 'warning', 'DROP INDEX takes an ACCESS EXCLUSIVE lock on the table',
          'While waiting for and holding the lock, all reads and writes on the indexed table are blocked.',
          s.replace(/^DROP\s+INDEX\s+/i, 'DROP INDEX CONCURRENTLY ') + ';  -- outside a transaction');
        continue;
      }

      // REINDEX
      if (/^REINDEX\b/.test(S) && !/\bCONCURRENTLY\b/.test(S)) {
        add(st, 'warning', 'REINDEX blocks writes',
          'REINDEX takes a SHARE lock on the table (writes wait) and an ACCESS EXCLUSIVE lock on the index being rebuilt (queries using it wait).',
          s.replace(/^REINDEX\s+(\w+)\s+/i, 'REINDEX $1 CONCURRENTLY ') + ';  -- PostgreSQL 12+, outside a transaction');
        continue;
      }

      // VACUUM FULL / CLUSTER
      if (/^VACUUM\b/.test(S) && inTxn()) {
        add(st, 'danger', 'VACUUM cannot run inside a transaction',
          'Postgres rejects VACUUM inside a transaction block, so the migration fails.', 'Run VACUUM outside migrations, from a maintenance job.');
      }
      if (/^VACUUM\b.*\bFULL\b/.test(S) || /^CLUSTER\b/.test(S)) {
        add(st, 'danger', 'Rewrites the whole table under an ACCESS EXCLUSIVE lock',
          'VACUUM FULL and CLUSTER copy the entire table. No reads or writes are possible until the copy finishes.',
          'Use pg_repack, which rebuilds the table online, or plain VACUUM (which does not lock out reads and writes).');
        continue;
      }

      // REFRESH MATERIALIZED VIEW
      if (/^REFRESH\s+MATERIALIZED\s+VIEW\b/.test(S) && !/\bCONCURRENTLY\b/.test(S)) {
        add(st, 'warning', 'REFRESH blocks reads of the materialized view',
          'A plain REFRESH takes an ACCESS EXCLUSIVE lock, so every query reading the view waits until the refresh finishes.',
          s.replace(/^REFRESH\s+MATERIALIZED\s+VIEW\s+/i, 'REFRESH MATERIALIZED VIEW CONCURRENTLY ') + ';  -- requires a UNIQUE index on the view');
        continue;
      }

      // UPDATE / DELETE (backfills)
      if ((m = new RegExp(`^(UPDATE|DELETE\\s+FROM)\\s+(?:ONLY\\s+)?${qualified}`, 'i').exec(s))) {
        const table = norm(m[2]);
        if (!created.has(table)) {
          add(st, 'warning', `Data change on "${table}" inside a migration`,
            'A single UPDATE or DELETE locks every row it touches until the migration commits. On a big table that blocks concurrent writes to those rows for the whole run, and bloats the table.',
            `-- Backfill in batches from a script, outside the migration:\nUPDATE ${m[2]} SET ... WHERE id IN (\n  SELECT id FROM ${m[2]} WHERE <not yet done> ORDER BY id LIMIT 5000\n);  -- repeat until 0 rows`);
        }
        continue;
      }

      // DROP TABLE
      if ((m = new RegExp(`^DROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?${qualified}`, 'i').exec(s))) {
        add(st, 'warning', `Dropping "${norm(m[1])}" breaks code that still uses it`,
          'During a rolling deploy, old app instances keep running against the new schema. If any of them still query this table, they start failing.',
          'Deploy code that no longer uses the table first. Drop it in a later migration.');
        continue;
      }

      // ALTER TABLE
      if ((m = new RegExp(`^ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?${qualified}\\s+(.*)$`, 'i').exec(s))) {
        const table = norm(m[1]);
        const body = m[2];
        const B = body.toUpperCase();
        if (created.has(table)) continue;

        // RENAME
        if (/^RENAME\s+TO\b/.test(B)) {
          add(st, 'danger', `Renaming table "${table}" breaks running code`,
            'Old app instances still use the old name during the deploy, and every query they send fails.',
            'Expand and contract: create a view or keep both names during the transition (e.g. rename, then CREATE VIEW old_name AS SELECT * FROM new_name), switch code, then drop the view later.');
          heavy(st, table);
          continue;
        }
        const rn = /^RENAME\s+(?:COLUMN\s+)?("?[\w$]+"?)\s+TO\s+("?[\w$]+"?)/i.exec(body);
        if (rn) {
          add(st, 'danger', `Renaming column ${rn[1]} breaks running code`,
            'Old app instances still read and write the old column name during the deploy. Their queries fail until every instance is replaced.',
            `-- Expand and contract:\n-- 1. ADD COLUMN ${rn[2]}; write to both columns in code\n-- 2. Backfill ${rn[2]} in batches\n-- 3. Switch reads to ${rn[2]}, deploy\n-- 4. Stop writing ${rn[1]}, deploy, then DROP COLUMN ${rn[1]} in a later migration`);
          heavy(st, table);
          continue;
        }

        // Sub-commands separated by commas at top level
        const actions = splitTopLevel(body);
        let isHeavy = false;
        for (const a of actions) {
          const A = a.toUpperCase();
          let mm;

          if ((mm = /^ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?("?[\w$]+"?)\s+(.*)$/i.exec(a)) && !/^ADD\s+(CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN|EXCLUDE)\b/i.test(a)) {
            const col = mm[1];
            const def = mm[2];
            isHeavy = true;
            if (REWRITE_COLUMN.test(def)) {
              add(st, 'danger', `Adding ${col} rewrites the whole table`,
                'SERIAL, IDENTITY and GENERATED ... STORED columns must fill a value into every existing row, so Postgres rewrites the table under an ACCESS EXCLUSIVE lock. No reads or writes until it finishes.',
                `-- Add a plain nullable column, attach the sequence/default, backfill in batches:\nALTER TABLE ${table} ADD COLUMN ${col} bigint;\n-- then CREATE SEQUENCE ..., ALTER COLUMN ${col} SET DEFAULT nextval(...), backfill`);
            } else if (VOLATILE_DEFAULT.test(def)) {
              const fn = VOLATILE_DEFAULT.exec(def)[1];
              add(st, 'danger', `DEFAULT ${fn}() rewrites the whole table`,
                `${fn}() is volatile, so Postgres computes a different value for every existing row by rewriting the table under an ACCESS EXCLUSIVE lock. (Constant defaults and now() are instant: they are stored once, not written into each row.)`,
                `ALTER TABLE ${table} ADD COLUMN ${col} ${def.split(/\bDEFAULT\b/i)[0].trim()};\nALTER TABLE ${table} ALTER COLUMN ${col} SET DEFAULT ${fn}();  -- new rows only, instant\n-- then backfill existing rows in batches, outside the migration`);
            } else if (/\bNOT\s+NULL\b/i.test(def) && !/\bDEFAULT\b/i.test(def)) {
              add(st, 'danger', `NOT NULL column without a DEFAULT fails on a non-empty table`,
                `Every existing row would get NULL in ${col}, which the NOT NULL rule forbids, so Postgres rejects the statement ("column contains null values"). It works in an empty dev database and fails in production.`,
                `-- Either give it a constant default (instant on Postgres 11+):\nALTER TABLE ${table} ADD COLUMN ${col} ${def.trim()} DEFAULT <value>;\n-- or add it nullable, backfill in batches, then add NOT NULL safely (see SET NOT NULL).`);
            } else if (/\bREFERENCES\b/i.test(def) && !/\bNOT\s+VALID\b/i.test(def)) {
              add(st, 'info', `Foreign key on new column ${col} briefly locks the referenced table`,
                'The new column is all NULL, so there is nothing to validate, but Postgres still takes a SHARE ROW EXCLUSIVE lock on the referenced table, blocking its writes while the lock is held.',
                'Usually fine. On a very busy referenced table, add the column first, then the constraint with NOT VALID.');
            }
            continue;
          }

          if ((mm = /^ALTER\s+(?:COLUMN\s+)?("?[\w$]+"?)\s+(?:SET\s+DATA\s+)?TYPE\s+(.*)$/i.exec(a))) {
            isHeavy = true;
            const target = mm[2].split(/\s+USING\b/i)[0].trim();
            if (/^(TEXT|VARCHAR|CHARACTER VARYING)$/i.test(target)) {
              add(st, 'info', `Changing ${mm[1]} to ${target} is usually instant`,
                'Converting varchar(n) to text or unbounded varchar does not rewrite the table. Any other source type does.',
                'Safe if the column is currently varchar/char varying. Otherwise treat it as a rewrite.');
            } else {
              add(st, 'danger', `Changing the type of ${mm[1]} rewrites the table`,
                `Changing to ${target} makes Postgres rewrite every row and rebuild every index on the table under an ACCESS EXCLUSIVE lock. Exceptions are rare (varchar(n) to text, or increasing a varchar length).`,
                `-- Expand and contract:\nALTER TABLE ${table} ADD COLUMN ${mm[1].replace(/"/g, '')}_new ${target};\n-- write to both in code, backfill in batches, switch reads, then drop the old column`);
            }
            continue;
          }

          if ((mm = /^ALTER\s+(?:COLUMN\s+)?("?[\w$]+"?)\s+SET\s+NOT\s+NULL/i.exec(a))) {
            isHeavy = true;
            const c = mm[1].replace(/"/g, '');
            add(st, 'warning', `SET NOT NULL scans the whole table under an ACCESS EXCLUSIVE lock`,
              'Postgres checks every row for NULLs while holding the strongest lock: no reads or writes on the table during the scan. It skips the scan if a validated CHECK (col IS NOT NULL) constraint already exists.',
              `ALTER TABLE ${table} ADD CONSTRAINT ${table}_${c}_not_null CHECK (${c} IS NOT NULL) NOT VALID;\nALTER TABLE ${table} VALIDATE CONSTRAINT ${table}_${c}_not_null;  -- no write lock\nALTER TABLE ${table} ALTER COLUMN ${c} SET NOT NULL;  -- instant now\nALTER TABLE ${table} DROP CONSTRAINT ${table}_${c}_not_null;`);
            continue;
          }

          if (/^ADD\b/.test(A)) {
            isHeavy = true;
            const notValid = /\bNOT\s+VALID\b/.test(A);
            const name = (/^ADD\s+CONSTRAINT\s+("?[\w$]+"?)/i.exec(a) || [])[1] || 'the_constraint';
            if (/\bFOREIGN\s+KEY\b/.test(A) && !notValid) {
              add(st, 'danger', 'Foreign key validation blocks writes on both tables',
                'Adding a foreign key scans the whole table to check every row, while holding a SHARE ROW EXCLUSIVE lock on both this table and the referenced one. Writes to both wait for the full scan.',
                `${s.replace(/;?\s*$/, '')} NOT VALID;\n-- in a later migration (only a SHARE UPDATE EXCLUSIVE lock, writes continue):\nALTER TABLE ${table} VALIDATE CONSTRAINT ${name};`);
            } else if (/\bCHECK\s*\(/.test(A) && !notValid) {
              add(st, 'warning', 'CHECK constraint scans the table under an ACCESS EXCLUSIVE lock',
                'Postgres validates every existing row while holding the strongest lock.',
                `${s.replace(/;?\s*$/, '')} NOT VALID;\nALTER TABLE ${table} VALIDATE CONSTRAINT ${name};  -- writes continue`);
            } else if (/\b(UNIQUE|PRIMARY\s+KEY)\b/.test(A) && !/\bUSING\s+INDEX\b/.test(A)) {
              const cols = (/\(([^)]*)\)/.exec(a) || [])[1] || 'cols';
              const kind = /\bPRIMARY\s+KEY\b/.test(A) ? 'PRIMARY KEY' : 'UNIQUE';
              add(st, 'danger', `Adding ${kind} builds an index while blocking reads and writes`,
                `This builds a unique index under an ACCESS EXCLUSIVE lock, so the table is unusable until the index is built.`,
                `CREATE UNIQUE INDEX CONCURRENTLY ${name}_idx ON ${table} (${cols});  -- own migration, no transaction\nALTER TABLE ${table} ADD CONSTRAINT ${name} ${kind} USING INDEX ${name}_idx;  -- instant`);
            }
            continue;
          }

          if (/^DROP\s+(COLUMN\s+)?(?!CONSTRAINT\b|DEFAULT\b|NOT\b)/.test(A)) {
            isHeavy = true;
            const col = (/^DROP\s+(?:COLUMN\s+)?(?:IF\s+EXISTS\s+)?("?[\w$]+"?)/i.exec(a) || [])[1];
            add(st, 'warning', `Dropping ${col} breaks code that still reads it`,
              'The drop itself is fast, but app instances still running old code (and ORMs that SELECT every column) fail as soon as the column is gone.',
              'Deploy code that no longer uses the column first (for Rails/Django/Prisma, also remove it from the model), then drop it in a later migration.');
            continue;
          }

          if (/^VALIDATE\s+CONSTRAINT\b/.test(A)) continue; // the safe step
          isHeavy = true; // any other ALTER TABLE still takes ACCESS EXCLUSIVE
        }
        if (isHeavy) heavy(st, table);
        continue;
      }
    }
    flushTxn();

    // Foreign keys whose referencing columns no index in this file covers
    const keys = collectKeys(statements);
    const seen = new Set();
    for (const fk of keys.fks) {
      if (fk.cols.some((c) => !c)) continue;
      const id = `${fk.table}(${fk.cols.join(',')})`;
      if (seen.has(id) || keys.indexes.some((i) => covers(i, fk))) continue;
      seen.add(id);
      const qi = (n) => (/^[a-z_][a-z0-9_$]*$/.test(n) ? n : `"${n.replace(/"/g, '""')}"`);
      const cols = fk.cols.join(', ');
      const sqlCols = fk.cols.map(qi).join(', ');
      const sqlTable = qi(fk.table);
      const newTable = keys.newTables.has(fk.table);
      const isNew = newTable || fk.cols.every((c) => keys.newCols.has(`${fk.table}.${c}`));
      const idxName = qi(`${fk.table}_${fk.cols.join('_')}_idx`);
      add(fk.st, isNew ? 'warning' : 'info', `No index on ${fk.table}(${cols}) for its foreign key`,
        `Postgres does not index foreign key columns for you. Every DELETE on "${fk.ref}" (and every UPDATE of its key) must find the matching rows in "${fk.table}", so without an index it scans the whole of "${fk.table}" once per affected row, with or without ON DELETE CASCADE. Measured on PostgreSQL 16 with 2M child rows: deleting 100 parent rows took 7.87 s without the index and 3.66 ms with it.` +
          (isNew ? '' : ` Ignore this if an earlier migration already indexes ${fk.table}(${cols}).`),
        newTable
          ? `CREATE INDEX ${idxName} ON ${sqlTable} (${sqlCols});  -- same migration is fine: the table is new and empty`
          : `CREATE INDEX CONCURRENTLY ${idxName} ON ${sqlTable} (${sqlCols});\n-- in its own migration, outside a transaction. Not needed if rows in "${fk.ref}" are never deleted and its key never changes.`);
    }

    function flushTxn() {
      const unique = [];
      for (const h of heavyInTxn) if (!unique.some((u) => u.table === h.table)) unique.push(h);
      if (heavyInTxn.length >= 2) {
        const last = heavyInTxn[heavyInTxn.length - 1].st;
        add(last, 'info', 'Locks pile up until the transaction commits',
          `This migration takes strong locks in ${heavyInTxn.length} statements inside one transaction${unique.length > 1 ? `, on ${unique.map((u) => `"${u.table}"`).join(', ')}` : ''}. Locks are only released at COMMIT, so the first lock is held while every later statement runs.`,
          'Keep each migration small, or split slow steps (backfills, validations) into their own migrations.');
      }
      heavyInTxn = [];
    }

    const rank = { danger: 0, warning: 1, info: 2 };
    findings.sort((a, b) => a.line - b.line || rank[a.severity] - rank[b.severity]);
    return { statements: statements.length, findings };
  }

  function splitTopLevel(body) {
    const parts = [];
    let depth = 0, cur = '', q = null;
    for (const ch of body) {
      if (q) { cur += ch; if (ch === q) q = null; continue; }
      if (ch === "'" || ch === '"') { q = ch; cur += ch; continue; }
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    if (cur.trim()) parts.push(cur.trim());
    return parts;
  }

  const api = { analyze, splitStatements };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MigrationChecker = api;
})(typeof window !== 'undefined' ? window : globalThis);
