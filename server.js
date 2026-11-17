const express = require('express');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const dbUrl = process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL;
const pool = new Pool({
  connectionString: dbUrl,
  ssl: dbUrl && !dbUrl.includes('railway.internal') ? { rejectUnauthorized: false } : false
});

async function initDB() {
  if (!dbUrl) {
    console.error('WARNING: DATABASE_URL is not linked in Railway Variables.');
    return;
  }

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        order_ref VARCHAR(20) UNIQUE NOT NULL,
        customer_name VARCHAR(120) NOT NULL,
        phone VARCHAR(40) NOT NULL,
        address TEXT NOT NULL,
        payment_method VARCHAR(60) NOT NULL,
        items JSONB NOT NULL,
        total_amount INT NOT NULL,
        status VARCHAR(30) DEFAULT 'Pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('Connected to Postgres & Clikcdown orders table ready.');
  } catch (err) {
    console.error('Database init error:', err.message);
  }
}

// POST: Save a new customer order
app.post('/api/orders', async (req, res) => {
  if (!dbUrl) {
    return res.status(500).json({ error: 'DATABASE_URL is not linked in Railway Variables.' });
  }
  const { order_ref, customer_name, phone, address, payment_method, items, total_amount } = req.body;

  try {
    const result = await pool.query(
      `INSERT INTO orders (order_ref, customer_name, phone, address, payment_method, items, total_amount)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [order_ref, customer_name, phone, address, payment_method, JSON.stringify(items), total_amount]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET: Fetch all orders
app.get('/api/orders', async (req, res) => {
  if (!dbUrl) {
    return res.status(500).json({ error: 'DATABASE_URL is not linked in Railway Variables.' });
  }
  try {
    const result = await pool.query('SELECT * FROM orders ORDER BY id DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH: Update order status (Pending -> Shipped -> Delivered)
app.patch('/api/orders/:id', async (req, res) => {
  const { status } = req.body;
  try {
    const result = await pool.query(
      'UPDATE orders SET status = $1 WHERE id = $2 RETURNING *',
      [status, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE: Remove an order
app.delete('/api/orders/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM orders WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`Clikcdown server running on port ${PORT}`);
  });
});