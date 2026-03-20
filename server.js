require('dotenv').config()
const express = require('express')
const { Pool } = require('pg')
const cors = require('cors')
const path = require('path')

const app = express()
const PORT = process.env.PORT || 3000

// ── DB ────────────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})

// ── Middleware ─────────────────────────────────────────────────────────────────
app.use(cors())
app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use(express.static(path.join(__dirname, 'public')))

// ── Analytics ──────────────────────────────────────────────────────────────────
app.post('/api/track', async (req, res) => {
  try {
    const { event_type, page, data } = req.body
    await pool.query(
      'INSERT INTO analytics_events (event_type, page, data) VALUES ($1, $2, $3)',
      [event_type || 'page_view', page || '/', JSON.stringify(data || {})]
    )
    res.json({ ok: true })
  } catch { res.json({ ok: false }) }
})

// ── Forms ──────────────────────────────────────────────────────────────────────
app.post('/api/forms/:name', async (req, res) => {
  try {
    const { name } = req.params
    const data = req.body
    const email = data.email || null
    await pool.query(
      'INSERT INTO form_submissions (form_name, data, email) VALUES ($1, $2, $3)',
      [name, JSON.stringify(data), email]
    )

    // Auto-subscribe if email provided
    if (email) {
      await pool.query(
        'INSERT INTO subscribers (email, name, source) VALUES ($1, $2, $3) ON CONFLICT (email) DO NOTHING',
        [email, data.name || null, name]
      ).catch(() => {})
    }

    res.json({ ok: true, message: 'Received!' })
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) })
  }
})

// ── Subscribers ────────────────────────────────────────────────────────────────
app.post('/api/subscribe', async (req, res) => {
  try {
    const { email, name } = req.body
    if (!email) return res.status(400).json({ error: 'Email required' })
    await pool.query(
      'INSERT INTO subscribers (email, name) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING',
      [email, name || null]
    )
    res.json({ ok: true, message: 'Subscribed!' })
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) })
  }
})

app.get('/api/subscribers', adminAuth, async (req, res) => {
  const r = await pool.query('SELECT * FROM subscribers ORDER BY created_at DESC')
  res.json({ subscribers: r.rows })
})

// ── Products ───────────────────────────────────────────────────────────────────
app.get('/api/products', async (req, res) => {
  const r = await pool.query('SELECT * FROM products WHERE active = true ORDER BY price_cents ASC')
  res.json({ products: r.rows })
})

// ── Orders / Stripe ────────────────────────────────────────────────────────────
app.post('/api/checkout', async (req, res) => {
  try {
    if (!process.env.STRIPE_SECRET_KEY) return res.status(503).json({ error: 'Payments not configured' })
    const Stripe = require('stripe')
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)
    const { product_id, email, success_url, cancel_url } = req.body

    let lineItems
    if (product_id) {
      const p = await pool.query('SELECT * FROM products WHERE id = $1', [product_id])
      if (!p.rows.length) return res.status(404).json({ error: 'Product not found' })
      const product = p.rows[0]
      lineItems = [{ price_data: { currency: product.currency, product_data: { name: product.name }, unit_amount: product.price_cents }, quantity: 1 }]
    } else {
      const { name, amount, currency } = req.body
      lineItems = [{ price_data: { currency: currency || 'usd', product_data: { name: name || 'Order' }, unit_amount: amount }, quantity: 1 }]
    }

    const session = await stripe.checkout.sessions.create({
      customer_email: email,
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      success_url: success_url || `${process.env.SITE_URL || ''}/?payment=success`,
      cancel_url: cancel_url || `${process.env.SITE_URL || ''}/?payment=cancelled`,
    })

    // Save pending order
    await pool.query(
      'INSERT INTO orders (customer_email, amount_cents, stripe_session_id, status) VALUES ($1, $2, $3, $4)',
      [email || '', lineItems[0].price_data.unit_amount, session.id, 'pending']
    )

    res.json({ url: session.url })
  } catch (e) {
    res.status(500).json({ error: String(e) })
  }
})

app.post('/api/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    if (!process.env.STRIPE_SECRET_KEY) return res.json({ received: true })
    const Stripe = require('stripe')
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)
    const sig = req.headers['stripe-signature']
    const event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET || '')
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object
      await pool.query('UPDATE orders SET status = $1 WHERE stripe_session_id = $2', ['paid', session.id])
    }
    res.json({ received: true })
  } catch (e) {
    res.status(400).json({ error: String(e) })
  }
})

// ── Admin ──────────────────────────────────────────────────────────────────────
function adminAuth(req, res, next) {
  const token = req.headers['x-admin-key'] || req.query.key
  if (token !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' })
  next()
}

app.get('/api/admin/stats', adminAuth, async (req, res) => {
  const [subs, orders, forms, events] = await Promise.all([
    pool.query('SELECT COUNT(*) FROM subscribers'),
    pool.query("SELECT COUNT(*), COALESCE(SUM(amount_cents),0) as revenue FROM orders WHERE status='paid'"),
    pool.query('SELECT COUNT(*) FROM form_submissions'),
    pool.query("SELECT COUNT(*) FROM analytics_events WHERE event_type='page_view'"),
  ])
  res.json({
    subscribers: parseInt(subs.rows[0].count),
    orders: parseInt(orders.rows[0].count),
    revenue_cents: parseInt(orders.rows[0].revenue),
    form_submissions: parseInt(forms.rows[0].count),
    page_views: parseInt(events.rows[0].count),
  })
})

app.get('/api/admin/orders', adminAuth, async (req, res) => {
  const r = await pool.query('SELECT * FROM orders ORDER BY created_at DESC LIMIT 100')
  res.json({ orders: r.rows })
})

app.get('/api/admin/forms/:name', adminAuth, async (req, res) => {
  const r = await pool.query(
    'SELECT * FROM form_submissions WHERE form_name = $1 ORDER BY created_at DESC',
    [req.params.name]
  )
  res.json({ submissions: r.rows })
})

// ── Health ─────────────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ ok: true, company: process.env.COMPANY_NAME }))

// ── Catch-all → index.html ─────────────────────────────────────────────────────
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')))

app.listen(PORT, () => console.log(`${process.env.COMPANY_NAME || 'Client'} running on port ${PORT}`))
