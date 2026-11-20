require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function init() {
  try {
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await pool.query(schema);
    await pool.query(`INSERT INTO plans (name, description, price, billing_period, features)
      SELECT * FROM (VALUES
        ('Starter', 'For individuals getting started', 0.00, 'month', ARRAY['Basic dashboard', '100 monthly actions', 'Email support']::text[]),
        ('Pro', 'For growing teams and creators', 499.00, 'month', ARRAY['Everything in Starter', '5,000 monthly actions', 'Priority support']::text[]),
        ('Business', 'For businesses that need more', 1499.00, 'month', ARRAY['Everything in Pro', 'Unlimited team members', 'Advanced reports']::text[])
      ) AS v(name, description, price, billing_period, features)
      WHERE NOT EXISTS (SELECT 1 FROM plans LIMIT 1)`);
    console.log('Database tables and sample plans are ready.');
  } catch (error) {
    console.error('Database setup failed:', error.message);
    process.exitCode = 1;
  } finally { await pool.end(); }
}
init();
