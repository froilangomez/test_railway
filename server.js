const express = require('express');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Connect using Railway's linked DATABASE_URL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Initialize database table on startup
async function initDB() {
  if (!process.env.DATABASE_URL) {
    console.log('No DATABASE_URL found; skipping Postgres init.');
    return;
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS posts (
      id SERIAL PRIMARY KEY,
      author TEXT NOT NULL,
      text TEXT,
      image TEXT,
      likes INT DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  console.log('Connected to Railway Postgres & verified posts table.');
}

// API: Fetch all posts
app.get('/api/posts', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM posts ORDER BY id DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Save a new post
app.post('/api/posts', async (req, res) => {
  const { author, text, image } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO posts (author, text, image) VALUES ($1, $2, $3) RETURNING *',
      [author || 'Froi', text, image || '']
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
});