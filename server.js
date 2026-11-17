const express = require('express');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function initDB() {
  if (!process.env.DATABASE_URL) {
    console.log('Warning: DATABASE_URL not set.');
    return;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS students (
      id SERIAL PRIMARY KEY,
      student_id VARCHAR(30) UNIQUE NOT NULL,
      full_name VARCHAR(120) NOT NULL,
      grade_section VARCHAR(60) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS attendance (
      id SERIAL PRIMARY KEY,
      student_db_id INT REFERENCES students(id) ON DELETE CASCADE,
      att_date DATE NOT NULL,
      status VARCHAR(20) NOT NULL,
      time_in VARCHAR(20),
      remarks TEXT DEFAULT '',
      UNIQUE(student_db_id, att_date)
    );
  `);

  // Seed sample students if the table is empty
  const countRes = await pool.query('SELECT COUNT(*) FROM students');
  if (parseInt(countRes.rows[0].count, 10) === 0) {
    await pool.query(`
      INSERT INTO students (student_id, full_name, grade_section) VALUES
      ('2026-001', 'Juan Dela Cruz', 'Grade 12 - Rizal'),
      ('2026-002', 'Maria Clara Santos', 'Grade 12 - Rizal'),
      ('2026-003', 'Gabriel Reyes', 'Grade 12 - Bonifacio'),
      ('2026-004', 'Andrea Mendoza', 'Grade 12 - Bonifacio')
    `);
  }

  console.log('School Attendance Postgres tables ready.');
}

// GET all students joined with attendance status for a specific date
app.get('/api/attendance', async (req, res) => {
  const date = req.query.date || new Date().toISOString().split('T')[0];
  try {
    const result = await pool.query(
      `SELECT 
         s.id,
         s.student_id,
         s.full_name,
         s.grade_section,
         COALESCE(a.status, 'Unmarked') AS status,
         COALESCE(a.time_in, '--:--') AS time_in,
         COALESCE(a.remarks, '') AS remarks
       FROM students s
       LEFT JOIN attendance a 
         ON s.id = a.student_db_id AND a.att_date = $1
       ORDER BY s.grade_section ASC, s.full_name ASC`,
      [date]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST add a new student
app.post('/api/students', async (req, res) => {
  const { student_id, full_name, grade_section } = req.body;
  if (!student_id || !full_name || !grade_section) {
    return res.status(400).json({ error: 'All fields are required.' });
  }
  try {
    const result = await pool.query(
      'INSERT INTO students (student_id, full_name, grade_section) VALUES ($1, $2, $3) RETURNING *',
      [student_id.trim(), full_name.trim(), grade_section.trim()]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE a student
app.delete('/api/students/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM students WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST mark or update attendance for a student on a specific date
app.post('/api/attendance', async (req, res) => {
  const { student_db_id, att_date, status, remarks } = req.body;
  const nowTime =
    status === 'Present' || status === 'Late'
      ? new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
      : '--:--';

  try {
    const result = await pool.query(
      `INSERT INTO attendance (student_db_id, att_date, status, time_in, remarks)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (student_db_id, att_date)
       DO UPDATE SET status = EXCLUDED.status, time_in = EXCLUDED.time_in, remarks = EXCLUDED.remarks
       RETURNING *`,
      [student_db_id, att_date, status, nowTime, remarks || '']
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`Attendance server running on port ${PORT}`);
  });
});