require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const Stripe = require('stripe');

const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const stripe = process.env.STRIPE_SECRET_KEY && process.env.STRIPE_SECRET_KEY.startsWith('sk_')
  ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));
app.use(session({ secret: process.env.SESSION_SECRET || 'development-secret-change-me', resave: false, saveUninitialized: false, cookie: { httpOnly: true, maxAge: 24 * 60 * 60 * 1000 } }));
app.use((req, res, next) => { res.locals.currentUser = req.session.user || null; res.locals.message = req.session.message || null; delete req.session.message; next(); });

function requireLogin(req, res, next) { if (!req.session.user) return res.redirect('/login'); next(); }
function requireAdmin(req, res, next) { if (!req.session.user || req.session.user.role !== 'admin') return res.status(403).render('error', { title: 'Access denied', message: 'You need an administrator account to view this page.' }); next(); }
function flash(req, message) { req.session.message = message; }

app.get('/', async (req, res) => {
  try { const { rows: plans } = await pool.query('SELECT * FROM plans ORDER BY price'); res.render('index', { title: 'Plans', plans }); }
  catch (e) { res.status(500).render('error', { title: 'Setup needed', message: 'Please configure PostgreSQL and run npm run db:init. ' + e.message }); }
});

app.get('/register', (req, res) => res.render('register', { title: 'Create account' }));
app.post('/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password || password.length < 6) { flash(req, 'Enter all details. Password must be at least 6 characters.'); return res.redirect('/register'); }
  try {
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query('INSERT INTO users(name,email,password_hash) VALUES($1,$2,$3) RETURNING id,name,email,role', [name.trim(), email.toLowerCase().trim(), hash]);
    await pool.query("INSERT INTO subscriptions(user_id,plan_id,status) SELECT $1,id,'active' FROM plans WHERE name='Starter'", [result.rows[0].id]);
    req.session.user = result.rows[0]; flash(req, 'Your account has been created. Welcome!'); res.redirect('/dashboard');
  } catch (e) { flash(req, e.code === '23505' ? 'That email is already registered.' : 'Could not create account. Check your database setup.'); res.redirect('/register'); }
});
app.get('/login', (req, res) => res.render('login', { title: 'Login' }));
app.post('/login', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE email=$1', [req.body.email.toLowerCase().trim()]);
    if (!rows[0] || !(await bcrypt.compare(req.body.password, rows[0].password_hash))) { flash(req, 'Invalid email or password.'); return res.redirect('/login'); }
    const { id, name, email, role } = rows[0]; req.session.user = { id, name, email, role }; res.redirect('/dashboard');
  } catch (e) { flash(req, 'Unable to log in. Please try again.'); res.redirect('/login'); }
});
app.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/')));

app.get('/dashboard', requireLogin, async (req, res) => {
  try {
    const [sub, invoices, usage, plans] = await Promise.all([
      pool.query(`SELECT s.*, p.name AS plan_name, p.price FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.user_id=$1 ORDER BY s.id DESC LIMIT 1`, [req.session.user.id]),
      pool.query('SELECT * FROM invoices WHERE user_id=$1 ORDER BY issued_at DESC LIMIT 5', [req.session.user.id]),
      pool.query("SELECT COALESCE(SUM(quantity),0) AS total FROM usage_events WHERE user_id=$1 AND created_at >= date_trunc('month', CURRENT_DATE)", [req.session.user.id]),
      pool.query('SELECT * FROM plans ORDER BY price')
    ]);
    res.render('dashboard', { title: 'Dashboard', subscription: sub.rows[0], invoices: invoices.rows, usage: usage.rows[0].total, plans: plans.rows });
  } catch (e) { res.status(500).render('error', { title: 'Dashboard error', message: e.message }); }
});

app.post('/subscribe/:planId', requireLogin, async (req, res) => {
  try {
    const planResult = await pool.query('SELECT * FROM plans WHERE id=$1', [req.params.planId]);
    const plan = planResult.rows[0]; if (!plan) { flash(req, 'Plan not found.'); return res.redirect('/'); }
    if (plan.price > 0 && stripe && plan.stripe_price_id) {
      const checkout = await stripe.checkout.sessions.create({ mode: 'subscription', line_items: [{ price: plan.stripe_price_id, quantity: 1 }], success_url: `${process.env.BASE_URL}/billing/success?session_id={CHECKOUT_SESSION_ID}&plan_id=${plan.id}`, cancel_url: `${process.env.BASE_URL}/dashboard`, customer_email: req.session.user.email });
      return res.redirect(checkout.url);
    }
    // Local demo flow: updates the selected plan and records a sample invoice.
    const result = await pool.query(`INSERT INTO subscriptions(user_id,plan_id,status,renews_at) VALUES($1,$2,'active',CURRENT_TIMESTAMP + INTERVAL '1 month') RETURNING id`, [req.session.user.id, plan.id]);
    if (Number(plan.price) > 0) await pool.query('INSERT INTO invoices(user_id,subscription_id,amount,status,description) VALUES($1,$2,$3,$4,$5)', [req.session.user.id, result.rows[0].id, plan.price, 'paid', `${plan.name} plan (demo payment)`]);
    flash(req, `${plan.name} plan activated in demo mode.`); res.redirect('/dashboard');
  } catch (e) { flash(req, 'Could not update subscription: ' + e.message); res.redirect('/dashboard'); }
});
app.get('/billing/success', requireLogin, async (req, res) => {
  try {
    const planId = Number(req.query.plan_id); const plan = await pool.query('SELECT * FROM plans WHERE id=$1', [planId]);
    if (plan.rows[0]) {
      const sub = await pool.query("INSERT INTO subscriptions(user_id,plan_id,status) VALUES($1,$2,'active') RETURNING id", [req.session.user.id, planId]);
      await pool.query("INSERT INTO invoices(user_id,subscription_id,amount,status,description) VALUES($1,$2,$3,'paid',$4)", [req.session.user.id, sub.rows[0].id, plan.rows[0].price, `${plan.rows[0].name} plan payment`]);
    }
    flash(req, 'Payment completed. Your subscription is active.'); res.redirect('/dashboard');
  } catch (e) { flash(req, 'Payment was received, but subscription update needs attention.'); res.redirect('/dashboard'); }
});
app.post('/usage/add', requireLogin, async (req, res) => {
  const quantity = Math.max(1, Math.min(100, Number(req.body.quantity) || 1));
  await pool.query('INSERT INTO usage_events(user_id,event_name,quantity) VALUES($1,$2,$3)', [req.session.user.id, req.body.event_name || 'Demo action', quantity]);
  flash(req, 'Usage activity added to your analytics.'); res.redirect('/dashboard');
});
app.get('/admin', requireAdmin, async (req, res) => {
  const [users, revenue, subscriptions] = await Promise.all([
    pool.query('SELECT id,name,email,role,created_at FROM users ORDER BY created_at DESC'),
    pool.query("SELECT COALESCE(SUM(amount),0) AS total FROM invoices WHERE status='paid'"),
    pool.query("SELECT p.name, COUNT(*)::int AS count FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.status='active' GROUP BY p.name ORDER BY count DESC")
  ]);
  res.render('admin', { title: 'Admin panel', users: users.rows, revenue: revenue.rows[0].total, subscriptions: subscriptions.rows });
});
app.post('/admin/users/:id/role', requireAdmin, async (req, res) => {
  const role = req.body.role === 'admin' ? 'admin' : 'user';
  if (Number(req.params.id) === req.session.user.id && role !== 'admin') { flash(req, 'You cannot remove your own admin access.'); return res.redirect('/admin'); }
  await pool.query('UPDATE users SET role=$1 WHERE id=$2', [role, req.params.id]); flash(req, 'User role updated.'); res.redirect('/admin');
});
app.use((req, res) => res.status(404).render('error', { title: 'Page not found', message: 'The page you are looking for does not exist.' }));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`SaaS platform running at http://localhost:${port}`));
