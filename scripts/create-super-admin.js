#!/usr/bin/env node
/**
 * Create or promote a SUPER_ADMIN for /gx-ops/admin.
 *
 * Usage:
 *   node scripts/create-super-admin.js --email admin@gradx.app --password 'Secret123!'
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const argon2 = require('argon2');
const { Pool } = require('pg');

async function main() {
  const args = process.argv.slice(2);
  const get = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const email = (get('--email') || process.env.ADMIN_EMAIL || '')
    .trim()
    .toLowerCase();
  const password = get('--password') || process.env.ADMIN_PASSWORD || '';
  const firstName = get('--firstName') || 'Platform';
  const lastName = get('--lastName') || 'Admin';

  if (!email || !password) {
    console.error(
      "Usage: node scripts/create-super-admin.js --email EMAIL --password PASSWORD",
    );
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const hash = await argon2.hash(password);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const existing = await client.query(
      'SELECT id, email FROM users WHERE email = $1 LIMIT 1',
      [email],
    );

    let userId;
    if (existing.rows[0]) {
      const updated = await client.query(
        `UPDATE users
         SET role = 'SUPER_ADMIN',
             "isActive" = true,
             "isVerified" = true,
             "passwordHash" = $2,
             "hashVersion" = 'argon2',
             "firstName" = COALESCE($3, "firstName"),
             "lastName" = COALESCE($4, "lastName"),
             "updatedAt" = NOW()
         WHERE id = $1
         RETURNING id, email, role`,
        [existing.rows[0].id, hash, firstName, lastName],
      );
      userId = updated.rows[0].id;
      console.log(
        'Updated existing user to SUPER_ADMIN:',
        updated.rows[0].email,
        userId,
      );
    } else {
      const tenant = await client.query(
        'INSERT INTO tenants DEFAULT VALUES RETURNING id',
      );
      const created = await client.query(
        `INSERT INTO users
          (email, "passwordHash", "hashVersion", "firstName", "lastName", role, "isActive", "isVerified", "tenantId", "authProvider", "updatedAt")
         VALUES ($1, $2, 'argon2', $3, $4, 'SUPER_ADMIN', true, true, $5, 'LOCAL', NOW())
         RETURNING id, email, role`,
        [email, hash, firstName, lastName, tenant.rows[0].id],
      );
      userId = created.rows[0].id;
      console.log('Created SUPER_ADMIN:', created.rows[0].email, userId);
    }
    await client.query('COMMIT');
    console.log('Open: /gx-ops/admin');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
