const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Railway Postgres Connection
const dbUrl = process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL;
const pool = new Pool({
  connectionString: dbUrl,
  ssl: dbUrl && !dbUrl.includes('railway.internal')
    ? { rejectUnauthorized: false }
    : false
});

// Helper: Password hashing & verification using built-in Node crypto
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, key] = stored.split(':');
  const hashBuffer = crypto.scryptSync(password, salt, 64);
  const keyBuffer = Buffer.from(key, 'hex');
  return crypto.timingSafeEqual(hashBuffer, keyBuffer);
}

// Helper: Philippine Timezone (Asia/Manila) current date & time
function getManilaDateTime() {
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
  const time24 = now.toLocaleTimeString('en-GB', { timeZone: 'Asia/Manila', hour12: false });
  const time12 = now.toLocaleTimeString('en-US', { timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit' });
  return { dateStr, time24, time12 };
}

// In-memory active session tokens
const sessions = new Map();

function requireAuth(req, res, next) {
  const token = req.headers['x-auth-token'];
  if (!token || !sessions.has(token)) {
    return res.status(401).json({ error: 'Unauthorized. Please sign in.' });
  }
  req.user = sessions.get(token);
  next();
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'Admin') {
    return res.status(403).json({ error: 'Admin privileges required.' });
  }
  next();
}

// Initialize PostgreSQL Tables & Seed Default Data
async function initDB() {
  if (!dbUrl) {
    console.error('WARNING: DATABASE_URL is not linked in Railway Variables.');
    return;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ap_users (
      id SERIAL PRIMARY KEY,
      full_name VARCHAR(120) NOT NULL,
      username VARCHAR(60) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role VARCHAR(20) NOT NULL DEFAULT 'Teacher',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ap_students (
      id SERIAL PRIMARY KEY,
      student_id VARCHAR(40) UNIQUE NOT NULL,
      full_name VARCHAR(120) NOT NULL,
      course VARCHAR(80) NOT NULL,
      year_level VARCHAR(30) NOT NULL,
      section VARCHAR(50) NOT NULL,
      contact VARCHAR(60) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ap_attendance (
      id SERIAL PRIMARY KEY,
      student_db_id INT NOT NULL REFERENCES ap_students(id) ON DELETE CASCADE,
      att_date DATE NOT NULL,
      time_in VARCHAR(20),
      status VARCHAR(20) NOT NULL,
      method VARCHAR(30) DEFAULT 'Manual',
      recorded_by VARCHAR(100) DEFAULT 'System',
      UNIQUE(student_db_id, att_date)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ap_settings (
      setting_key VARCHAR(60) PRIMARY KEY,
      setting_value VARCHAR(255) NOT NULL
    );
  `);

  await pool.query(`
    INSERT INTO ap_settings (setting_key, setting_value) VALUES
    ('school_name', 'AttendPulse Academy'),
    ('late_cutoff', '08:00:00')
    ON CONFLICT (setting_key) DO NOTHING;
  `);

  const userCount = parseInt((await pool.query('SELECT COUNT(*) FROM ap_users')).rows[0].count, 10);
  if (userCount === 0) {
    await pool.query(
      'INSERT INTO ap_users (full_name, username, password_hash, role) VALUES ($1, $2, $3, $4), ($5, $6, $7, $8)',
      [
        'System Administrator', 'admin', hashPassword('admin123'), 'Admin',
        'Prof. Elena Cruz', 'teacher', hashPassword('teacher123'), 'Teacher'
      ]
    );
  }

  const stuCount = parseInt((await pool.query('SELECT COUNT(*) FROM ap_students')).rows[0].count, 10);
  if (stuCount === 0) {
    await pool.query(`
      INSERT INTO ap_students (student_id, full_name, course, year_level, section, contact) VALUES
      ('2026-1001', 'Juan Miguel Dela Cruz', 'BSIT', '3rd Year', 'A', '0917-555-0101'),
      ('2026-1002', 'Maria Clara Santos', 'BSCS', '3rd Year', 'A', '0917-555-0102'),
      ('2026-1003', 'Gabriel Lorenzo Reyes', 'BSIT', '2nd Year', 'B', '0917-555-0103'),
      ('2026-1004', 'Andrea Nicole Mendoza', 'BSIS', '4th Year', 'A', '0917-555-0104'),
      ('2026-1005', 'Rafael Antonio Navarro', 'BSCS', '1st Year', 'C', '0917-555-0105')
    `);
  }

  console.log('AttendPulse PostgreSQL tables ready.');
}

// ==================== AUTH ROUTES ====================
app.post('/api/login', async (req, res) => {
  if (!dbUrl) {
    return res.status(500).json({ error: 'DATABASE_URL is not linked in Railway Variables.' });
  }
  const { username, password } = req.body;
  try {
    await initDB();
    const result = await pool.query(
      'SELECT * FROM ap_users WHERE LOWER(username) = LOWER($1) LIMIT 1',
      [username?.trim()]
    );
    const user = result.rows[0];
    if (!user || !verifyPassword(password || '', user.password_hash)) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }
    const token = crypto.randomBytes(24).toString('hex');
    const sessionUser = { id: user.id, full_name: user.full_name, username: user.username, role: user.role };
    sessions.set(token, sessionUser);
    res.json({ token, user: sessionUser });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: err.message || err.code || 'PostgreSQL connection failed' });
  }
});

app.post('/api/logout', (req, res) => {
  const token = req.headers['x-auth-token'];
  if (token) sessions.delete(token);
  res.json({ success: true });
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// ==================== DASHBOARD STATS ====================
app.get('/api/dashboard', requireAuth, async (req, res) => {
  const { dateStr } = getManilaDateTime();
  try {
    const totalStudents = parseInt((await pool.query('SELECT COUNT(*) FROM ap_students')).rows[0].count, 10);

    const todayRes = await pool.query(
      'SELECT status, COUNT(*)::int AS cnt FROM ap_attendance WHERE att_date = $1 GROUP BY status',
      [dateStr]
    );
    const counts = { Present: 0, Absent: 0, Late: 0, Excused: 0 };
    todayRes.rows.forEach(r => { counts[r.status] = r.cnt; });

    const attended = counts.Present + counts.Late;
    const percentage = totalStudents > 0 ? Math.round((attended / totalStudents) * 1000) / 10 : 0;

    const weekly = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      const iso = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
      const label = d.toLocaleDateString('en-US', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric' });
      const dayRes = await pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'Present')::int AS present,
          COUNT(*) FILTER (WHERE status = 'Late')::int AS late,
          COUNT(*) FILTER (WHERE status = 'Absent')::int AS absent
        FROM ap_attendance WHERE att_date = $1
      `, [iso]);
      weekly.push({ date: label, ...dayRes.rows[0] });
    }

    const recentRes = await pool.query(`
      SELECT a.id, TO_CHAR(a.att_date, 'YYYY-MM-DD') AS att_date, a.time_in, a.status, a.method,
             s.student_id, s.full_name, s.course, s.section
      FROM ap_attendance a
      JOIN ap_students s ON a.student_db_id = s.id
      ORDER BY a.id DESC
      LIMIT 8
    `);

    res.json({ totalStudents, counts, percentage, weekly, recent: recentRes.rows });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Dashboard query failed' });
  }
});

// ==================== STUDENTS CRUD ====================
app.get('/api/students', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM ap_students ORDER BY id DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/students', requireAuth, async (req, res) => {
  const { id, student_id, full_name, course, year_level, section, contact } = req.body;
  if (!student_id || !full_name || !course || !year_level || !section) {
    return res.status(400).json({ error: 'All student fields are required.' });
  }
  try {
    if (Number(id) > 0) {
      await pool.query(
        'UPDATE ap_students SET student_id=$1, full_name=$2, course=$3, year_level=$4, section=$5, contact=$6 WHERE id=$7',
        [student_id.trim(), full_name.trim(), course.trim(), year_level.trim(), section.trim(), contact?.trim() || '', id]
      );
      res.json({ message: 'Student record updated.' });
    } else {
      await pool.query(
        'INSERT INTO ap_students (student_id, full_name, course, year_level, section, contact) VALUES ($1, $2, $3, $4, $5, $6)',
        [student_id.trim(), full_name.trim(), course.trim(), year_level.trim(), section.trim(), contact?.trim() || '']
      );
      res.json({ message: 'New student added successfully.' });
    }
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/students/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM ap_students WHERE id = $1', [req.params.id]);
    res.json({ message: 'Student removed.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== DAILY ATTENDANCE ====================
app.get('/api/attendance', requireAuth, async (req, res) => {
  const date = req.query.date || getManilaDateTime().dateStr;
  try {
    const result = await pool.query(`
      SELECT s.*,
             COALESCE(a.status, 'Unmarked') AS status,
             COALESCE(a.time_in, '--:--') AS formatted_time,
             COALESCE(a.method, '-') AS method
      FROM ap_students s
      LEFT JOIN ap_attendance a ON s.id = a.student_db_id AND a.att_date = $1
      ORDER BY s.course ASC, s.section ASC, s.full_name ASC
    `, [date]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/attendance', requireAuth, async (req, res) => {
  const { student_db_id, att_date, status } = req.body;
  const { time12 } = getManilaDateTime();
  const timeIn = ['Present', 'Late'].includes(status) ? time12 : '--:--';

  try {
    await pool.query(`
      INSERT INTO ap_attendance (student_db_id, att_date, time_in, status, method, recorded_by)
      VALUES ($1, $2, $3, $4, 'Manual', $5)
      ON CONFLICT (student_db_id, att_date)
      DO UPDATE SET status = EXCLUDED.status, time_in = EXCLUDED.time_in, method = 'Manual', recorded_by = EXCLUDED.recorded_by
    `, [student_db_id, att_date, timeIn, status, req.user.full_name]);
    res.json({ message: `Marked as ${status}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== QR SCAN CHECK-IN ====================
app.post('/api/qr-scan', requireAuth, async (req, res) => {
  const code = (req.body.student_id || '').trim();
  const { dateStr, time24, time12 } = getManilaDateTime();

  try {
    const stuRes = await pool.query('SELECT * FROM ap_students WHERE student_id = $1 LIMIT 1', [code]);
    const student = stuRes.rows[0];
    if (!student) {
      return res.status(404).json({ error: `Student ID '${code}' not found in roster.` });
    }

    const dupRes = await pool.query(
      'SELECT * FROM ap_attendance WHERE student_db_id = $1 AND att_date = $2',
      [student.id, dateStr]
    );
    if (dupRes.rows.length > 0) {
      return res.status(409).json({
        error: `${student.full_name} already checked in today (${dupRes.rows[0].status}).`
      });
    }

    const setRes = await pool.query("SELECT setting_value FROM ap_settings WHERE setting_key = 'late_cutoff'");
    const cutoff = setRes.rows[0]?.setting_value || '08:00:00';
    const status = time24 > cutoff ? 'Late' : 'Present';

    await pool.query(
      `INSERT INTO ap_attendance (student_db_id, att_date, time_in, status, method, recorded_by)
       VALUES ($1, $2, $3, $4, 'QR Scan', $5)`,
      [student.id, dateStr, time12, status, req.user.full_name]
    );

    res.json({
      message: `Attendance recorded for ${student.full_name} (${status})`,
      time: time12,
      status
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== RECORDS HISTORY ====================
app.get('/api/records', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT a.id, TO_CHAR(a.att_date, 'YYYY-MM-DD') AS att_date, a.time_in, a.status, a.method, a.recorded_by,
             s.student_id, s.full_name, s.course, s.year_level, s.section
      FROM ap_attendance a
      JOIN ap_students s ON a.student_db_id = s.id
      ORDER BY a.att_date DESC, a.id DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== REPORTS & ANALYTICS ====================
app.get('/api/reports', requireAuth, async (req, res) => {
  const period = req.query.period || 'monthly';
  const { dateStr } = getManilaDateTime();

  let intervalSql = `a.att_date >= (DATE '${dateStr}' - INTERVAL '30 days')`;
  if (period === 'daily') intervalSql = `a.att_date = DATE '${dateStr}'`;
  if (period === 'weekly') intervalSql = `a.att_date >= (DATE '${dateStr}' - INTERVAL '7 days')`;

  try {
    const result = await pool.query(`
      SELECT s.id, s.student_id, s.full_name, s.course, s.year_level, s.section,
             COUNT(a.id) FILTER (WHERE a.status = 'Present')::int AS present_days,
             COUNT(a.id) FILTER (WHERE a.status = 'Late')::int AS late_days,
             COUNT(a.id) FILTER (WHERE a.status = 'Absent')::int AS absent_days,
             COUNT(a.id) FILTER (WHERE a.status = 'Excused')::int AS excused_days,
             COUNT(a.id)::int AS total_logged
      FROM ap_students s
      LEFT JOIN ap_attendance a ON s.id = a.student_db_id AND ${intervalSql}
      GROUP BY s.id
      ORDER BY absent_days DESC, late_days DESC, s.full_name ASC
    `);

    const rows = result.rows.map(r => {
      const attended = r.present_days + r.late_days;
      const rate = r.total_logged > 0 ? Math.round((attended / r.total_logged) * 1000) / 10 : 100;
      return { ...r, rate };
    });

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== USER MANAGEMENT (ADMIN) ====================
app.get('/api/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, full_name, username, role, created_at FROM ap_users ORDER BY id ASC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/users', requireAuth, requireAdmin, async (req, res) => {
  const { full_name, username, password, role } = req.body;
  if (!full_name || !username || !password || password.length < 4) {
    return res.status(400).json({ error: 'Provide name, username, and password (min 4 chars).' });
  }
  try {
    await pool.query(
      'INSERT INTO ap_users (full_name, username, password_hash, role) VALUES ($1, $2, $3, $4)',
      [full_name.trim(), username.trim(), hashPassword(password), role === 'Admin' ? 'Admin' : 'Teacher']
    );
    res.json({ message: 'User account created.' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/users/:id', requireAuth, requireAdmin, async (req, res) => {
  if (Number(req.params.id) === req.user.id) {
    return res.status(400).json({ error: 'Cannot delete your own active account.' });
  }
  try {
    await pool.query('DELETE FROM ap_users WHERE id = $1', [req.params.id]);
    res.json({ message: 'User removed.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== SETTINGS ====================
app.get('/api/debug', (req, res) => {
  const pgKeys = Object.keys(process.env).filter(
    k => k.includes('DATABASE') || k.includes('PG') || k.includes('RAILWAY')
  );
  res.json({
    has_DATABASE_URL: Boolean(process.env.DATABASE_URL),
    has_DATABASE_PUBLIC_URL: Boolean(process.env.DATABASE_PUBLIC_URL),
    detected_keys: pgKeys
  });
});

app.post('/api/settings', requireAuth, requireAdmin, async (req, res) => {
  const { school_name, late_cutoff } = req.body;
  try {
    await pool.query(
      `INSERT INTO ap_settings (setting_key, setting_value) VALUES ('school_name', $1), ('late_cutoff', $2)
       ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value`,
      [school_name?.trim() || 'AttendPulse Academy', late_cutoff?.trim() || '08:00:00']
    );
    res.json({ message: 'Settings saved!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start HTTP Server Immediately & Initialize DB
app.listen(PORT, '0.0.0.0', () => {
  console.log(`AttendPulse Node.js server running on port ${PORT}`);
  initDB().catch(err => console.error('Initial DB setup error:', err.message));
});