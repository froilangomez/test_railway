const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Railway Postgres Connection (optional — falls back to in-memory store if unlinked)
const dbUrl = process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL;
const pool = dbUrl
  ? new Pool({
      connectionString: dbUrl,
      ssl: !dbUrl.includes('railway.internal') ? { rejectUnauthorized: false } : false
    })
  : null;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function getManilaDateTime() {
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
  const time24 = now.toLocaleTimeString('en-GB', { timeZone: 'Asia/Manila', hour12: false });
  const time12 = now.toLocaleTimeString('en-US', { timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit' });
  return { dateStr, time24, time12 };
}

function attachDefaultUser(req, res, next) {
  req.user = {
    id: 1,
    full_name: 'System Administrator',
    username: 'admin',
    role: 'Admin'
  };
  next();
}

// ==================== IN-MEMORY FALLBACK STORE ====================
const mem = {
  nextStudentId: 6,
  nextAttId: 1,
  nextUserId: 3,
  settings: {
    school_name: 'AttendPulse Academy',
    late_cutoff: '08:00:00'
  },
  users: [
    { id: 1, full_name: 'System Administrator', username: 'admin', role: 'Admin', created_at: new Date().toISOString() },
    { id: 2, full_name: 'Prof. Elena Cruz', username: 'teacher', role: 'Teacher', created_at: new Date().toISOString() }
  ],
  students: [
    { id: 1, student_id: '2026-1001', full_name: 'Juan Miguel Dela Cruz', course: 'BSIT', year_level: '3rd Year', section: 'A', contact: '0917-555-0101' },
    { id: 2, student_id: '2026-1002', full_name: 'Maria Clara Santos', course: 'BSCS', year_level: '3rd Year', section: 'A', contact: '0917-555-0102' },
    { id: 3, student_id: '2026-1003', full_name: 'Gabriel Lorenzo Reyes', course: 'BSIT', year_level: '2nd Year', section: 'B', contact: '0917-555-0103' },
    { id: 4, student_id: '2026-1004', full_name: 'Andrea Nicole Mendoza', course: 'BSIS', year_level: '4th Year', section: 'A', contact: '0917-555-0104' },
    { id: 5, student_id: '2026-1005', full_name: 'Rafael Antonio Navarro', course: 'BSCS', year_level: '1st Year', section: 'C', contact: '0917-555-0105' }
  ],
  attendance: []
};

let usePostgres = false;

async function initDB() {
  if (!pool) {
    console.log('Running in built-in memory mode (no DATABASE_URL set).');
    return;
  }

  try {
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

    usePostgres = true;
    console.log('Connected to Railway PostgreSQL.');
  } catch (err) {
    usePostgres = false;
    console.warn('Postgres unavailable, using in-memory fallback:', err.message);
  }
}

// ==================== DASHBOARD STATS ====================
app.get('/api/dashboard', attachDefaultUser, async (req, res) => {
  const { dateStr } = getManilaDateTime();
  try {
    if (usePostgres) {
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

      return res.json({ totalStudents, counts, percentage, weekly, recent: recentRes.rows });
    }

    // Memory mode
    const totalStudents = mem.students.length;
    const counts = { Present: 0, Absent: 0, Late: 0, Excused: 0 };
    mem.attendance.filter(a => a.att_date === dateStr).forEach(a => {
      if (counts[a.status] !== undefined) counts[a.status]++;
    });
    const attended = counts.Present + counts.Late;
    const percentage = totalStudents > 0 ? Math.round((attended / totalStudents) * 1000) / 10 : 0;

    const weekly = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      const iso = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
      const label = d.toLocaleDateString('en-US', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric' });
      const dayLogs = mem.attendance.filter(a => a.att_date === iso);
      weekly.push({
        date: label,
        present: dayLogs.filter(a => a.status === 'Present').length,
        late: dayLogs.filter(a => a.status === 'Late').length,
        absent: dayLogs.filter(a => a.status === 'Absent').length
      });
    }

    const recent = [...mem.attendance].reverse().slice(0, 8).map(a => {
      const st = mem.students.find(s => s.id === a.student_db_id) || {};
      return { ...a, student_id: st.student_id, full_name: st.full_name, course: st.course, section: st.section };
    });

    res.json({ totalStudents, counts, percentage, weekly, recent });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== STUDENTS CRUD ====================
app.get('/api/students', attachDefaultUser, async (req, res) => {
  try {
    if (usePostgres) {
      const result = await pool.query('SELECT * FROM ap_students ORDER BY id DESC');
      return res.json(result.rows);
    }
    res.json([...mem.students].reverse());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/students', attachDefaultUser, async (req, res) => {
  const { id, student_id, full_name, course, year_level, section, contact } = req.body;
  if (!student_id || !full_name || !course || !year_level || !section) {
    return res.status(400).json({ error: 'All student fields are required.' });
  }
  try {
    if (usePostgres) {
      if (Number(id) > 0) {
        await pool.query(
          'UPDATE ap_students SET student_id=$1, full_name=$2, course=$3, year_level=$4, section=$5, contact=$6 WHERE id=$7',
          [student_id.trim(), full_name.trim(), course.trim(), year_level.trim(), section.trim(), contact?.trim() || '', id]
        );
        return res.json({ message: 'Student record updated.' });
      } else {
        await pool.query(
          'INSERT INTO ap_students (student_id, full_name, course, year_level, section, contact) VALUES ($1, $2, $3, $4, $5, $6)',
          [student_id.trim(), full_name.trim(), course.trim(), year_level.trim(), section.trim(), contact?.trim() || '']
        );
        return res.json({ message: 'New student added successfully.' });
      }
    }

    if (Number(id) > 0) {
      const idx = mem.students.findIndex(s => s.id === Number(id));
      if (idx > -1) {
        mem.students[idx] = {
          ...mem.students[idx],
          student_id: student_id.trim(),
          full_name: full_name.trim(),
          course: course.trim(),
          year_level: year_level.trim(),
          section: section.trim(),
          contact: contact?.trim() || ''
        };
      }
      return res.json({ message: 'Student record updated.' });
    } else {
      if (mem.students.some(s => s.student_id === student_id.trim())) {
        return res.status(400).json({ error: 'Student ID already exists.' });
      }
      mem.students.push({
        id: mem.nextStudentId++,
        student_id: student_id.trim(),
        full_name: full_name.trim(),
        course: course.trim(),
        year_level: year_level.trim(),
        section: section.trim(),
        contact: contact?.trim() || ''
      });
      return res.json({ message: 'New student added successfully.' });
    }
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/students/:id', attachDefaultUser, async (req, res) => {
  try {
    if (usePostgres) {
      await pool.query('DELETE FROM ap_students WHERE id = $1', [req.params.id]);
      return res.json({ message: 'Student removed.' });
    }
    const targetId = Number(req.params.id);
    mem.students = mem.students.filter(s => s.id !== targetId);
    mem.attendance = mem.attendance.filter(a => a.student_db_id !== targetId);
    res.json({ message: 'Student removed.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== DAILY ATTENDANCE ====================
app.get('/api/attendance', attachDefaultUser, async (req, res) => {
  const date = req.query.date || getManilaDateTime().dateStr;
  try {
    if (usePostgres) {
      const result = await pool.query(`
        SELECT s.*,
               COALESCE(a.status, 'Unmarked') AS status,
               COALESCE(a.time_in, '--:--') AS formatted_time,
               COALESCE(a.method, '-') AS method
        FROM ap_students s
        LEFT JOIN ap_attendance a ON s.id = a.student_db_id AND a.att_date = $1
        ORDER BY s.course ASC, s.section ASC, s.full_name ASC
      `, [date]);
      return res.json(result.rows);
    }

    const rows = mem.students.map(s => {
      const rec = mem.attendance.find(a => a.student_db_id === s.id && a.att_date === date);
      return {
        ...s,
        status: rec ? rec.status : 'Unmarked',
        formatted_time: rec ? rec.time_in : '--:--',
        method: rec ? rec.method : '-'
      };
    });
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/attendance', attachDefaultUser, async (req, res) => {
  const { student_db_id, att_date, status } = req.body;
  const { time12 } = getManilaDateTime();
  const timeIn = ['Present', 'Late'].includes(status) ? time12 : '--:--';

  try {
    if (usePostgres) {
      await pool.query(`
        INSERT INTO ap_attendance (student_db_id, att_date, time_in, status, method, recorded_by)
        VALUES ($1, $2, $3, $4, 'Manual', $5)
        ON CONFLICT (student_db_id, att_date)
        DO UPDATE SET status = EXCLUDED.status, time_in = EXCLUDED.time_in, method = 'Manual', recorded_by = EXCLUDED.recorded_by
      `, [student_db_id, att_date, timeIn, status, req.user.full_name]);
      return res.json({ message: `Marked as ${status}` });
    }

    const existing = mem.attendance.find(a => a.student_db_id === Number(student_db_id) && a.att_date === att_date);
    if (existing) {
      existing.status = status;
      existing.time_in = timeIn;
      existing.method = 'Manual';
      existing.recorded_by = req.user.full_name;
    } else {
      mem.attendance.push({
        id: mem.nextAttId++,
        student_db_id: Number(student_db_id),
        att_date,
        time_in: timeIn,
        status,
        method: 'Manual',
        recorded_by: req.user.full_name
      });
    }
    res.json({ message: `Marked as ${status}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== QR SCAN CHECK-IN ====================
app.post('/api/qr-scan', attachDefaultUser, async (req, res) => {
  const code = (req.body.student_id || '').trim();
  const { dateStr, time24, time12 } = getManilaDateTime();

  try {
    if (usePostgres) {
      const stuRes = await pool.query('SELECT * FROM ap_students WHERE student_id = $1 LIMIT 1', [code]);
      const student = stuRes.rows[0];
      if (!student) return res.status(404).json({ error: `Student ID '${code}' not found in roster.` });

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

      return res.json({ message: `Attendance recorded for ${student.full_name} (${status})`, time: time12, status });
    }

    const student = mem.students.find(s => s.student_id === code);
    if (!student) return res.status(404).json({ error: `Student ID '${code}' not found in roster.` });

    const dup = mem.attendance.find(a => a.student_db_id === student.id && a.att_date === dateStr);
    if (dup) {
      return res.status(409).json({ error: `${student.full_name} already checked in today (${dup.status}).` });
    }

    const status = time24 > mem.settings.late_cutoff ? 'Late' : 'Present';
    mem.attendance.push({
      id: mem.nextAttId++,
      student_db_id: student.id,
      att_date: dateStr,
      time_in: time12,
      status,
      method: 'QR Scan',
      recorded_by: req.user.full_name
    });

    res.json({ message: `Attendance recorded for ${student.full_name} (${status})`, time: time12, status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== RECORDS HISTORY ====================
app.get('/api/records', attachDefaultUser, async (req, res) => {
  try {
    if (usePostgres) {
      const result = await pool.query(`
        SELECT a.id, TO_CHAR(a.att_date, 'YYYY-MM-DD') AS att_date, a.time_in, a.status, a.method, a.recorded_by,
               s.student_id, s.full_name, s.course, s.year_level, s.section
        FROM ap_attendance a
        JOIN ap_students s ON a.student_db_id = s.id
        ORDER BY a.att_date DESC, a.id DESC
      `);
      return res.json(result.rows);
    }

    const rows = [...mem.attendance].reverse().map(a => {
      const st = mem.students.find(s => s.id === a.student_db_id) || {};
      return {
        ...a,
        student_id: st.student_id,
        full_name: st.full_name,
        course: st.course,
        year_level: st.year_level,
        section: st.section
      };
    });
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== REPORTS & ANALYTICS ====================
app.get('/api/reports', attachDefaultUser, async (req, res) => {
  const period = req.query.period || 'monthly';
  const { dateStr } = getManilaDateTime();

  try {
    if (usePostgres) {
      let intervalSql = `a.att_date >= (DATE '${dateStr}' - INTERVAL '30 days')`;
      if (period === 'daily') intervalSql = `a.att_date = DATE '${dateStr}'`;
      if (period === 'weekly') intervalSql = `a.att_date >= (DATE '${dateStr}' - INTERVAL '7 days')`;

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

      return res.json(result.rows.map(r => {
        const attended = r.present_days + r.late_days;
        const rate = r.total_logged > 0 ? Math.round((attended / r.total_logged) * 1000) / 10 : 100;
        return { ...r, rate };
      }));
    }

    const days = period === 'daily' ? 0 : period === 'weekly' ? 7 : 30;
    const cutoffDate = new Date(Date.now() - days * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });

    const rows = mem.students.map(s => {
      const logs = mem.attendance.filter(a =>
        a.student_db_id === s.id && (period === 'daily' ? a.att_date === dateStr : a.att_date >= cutoffDate)
      );
      const present_days = logs.filter(l => l.status === 'Present').length;
      const late_days = logs.filter(l => l.status === 'Late').length;
      const absent_days = logs.filter(l => l.status === 'Absent').length;
      const excused_days = logs.filter(l => l.status === 'Excused').length;
      const total_logged = logs.length;
      const attended = present_days + late_days;
      const rate = total_logged > 0 ? Math.round((attended / total_logged) * 1000) / 10 : 100;
      return { ...s, present_days, late_days, absent_days, excused_days, total_logged, rate };
    });

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== USER MANAGEMENT ====================
app.get('/api/users', attachDefaultUser, async (req, res) => {
  try {
    if (usePostgres) {
      const result = await pool.query('SELECT id, full_name, username, role, created_at FROM ap_users ORDER BY id ASC');
      return res.json(result.rows);
    }
    res.json(mem.users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/users', attachDefaultUser, async (req, res) => {
  const { full_name, username, password, role } = req.body;
  if (!full_name || !username || !password || password.length < 4) {
    return res.status(400).json({ error: 'Provide name, username, and password (min 4 chars).' });
  }
  try {
    if (usePostgres) {
      await pool.query(
        'INSERT INTO ap_users (full_name, username, password_hash, role) VALUES ($1, $2, $3, $4)',
        [full_name.trim(), username.trim(), hashPassword(password), role === 'Admin' ? 'Admin' : 'Teacher']
      );
      return res.json({ message: 'User account created.' });
    }
    mem.users.push({
      id: mem.nextUserId++,
      full_name: full_name.trim(),
      username: username.trim(),
      role: role === 'Admin' ? 'Admin' : 'Teacher',
      created_at: new Date().toISOString()
    });
    res.json({ message: 'User account created.' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/users/:id', attachDefaultUser, async (req, res) => {
  try {
    if (usePostgres) {
      await pool.query('DELETE FROM ap_users WHERE id = $1', [req.params.id]);
      return res.json({ message: 'User removed.' });
    }
    mem.users = mem.users.filter(u => u.id !== Number(req.params.id));
    res.json({ message: 'User removed.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== SETTINGS ====================
app.get('/api/settings', attachDefaultUser, async (req, res) => {
  try {
    if (usePostgres) {
      const result = await pool.query('SELECT * FROM ap_settings');
      const map = {};
      result.rows.forEach(r => { map[r.setting_key] = r.setting_value; });
      return res.json(map);
    }
    res.json(mem.settings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/settings', attachDefaultUser, async (req, res) => {
  const { school_name, late_cutoff } = req.body;
  try {
    if (usePostgres) {
      await pool.query(
        `INSERT INTO ap_settings (setting_key, setting_value) VALUES ('school_name', $1), ('late_cutoff', $2)
         ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value`,
        [school_name?.trim() || 'AttendPulse Academy', late_cutoff?.trim() || '08:00:00']
      );
      return res.json({ message: 'Settings saved!' });
    }
    mem.settings.school_name = school_name?.trim() || 'AttendPulse Academy';
    mem.settings.late_cutoff = late_cutoff?.trim() || '08:00:00';
    res.json({ message: 'Settings saved!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`AttendPulse Node.js server running on port ${PORT}`);
  initDB();
});