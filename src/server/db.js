const sqlite3 = require('sqlite3').verbose();
const path = require('path');
let app;
try {
  const electron = require('electron');
  app = electron.app;
} catch (e) {
  app = null;
}

// Use userData for persistence when built, otherwise local dir in dev
const dbDir = app ? app.getPath('userData') : path.join(__dirname, '../../');
const dbPath = path.join(dbDir, 'quiz_system.sqlite');

const db = new sqlite3.Database(dbPath);

// Helper function to check if a column exists in a table
function columnExists(tableName, columnName) {
  return new Promise((resolve, reject) => {
    db.all(`PRAGMA table_info(${tableName})`, (err, columns) => {
      if (err) return reject(err);
      const exists = columns.some(col => col.name === columnName);
      resolve(exists);
    });
  });
}

async function initDb() {
  return new Promise((resolve, reject) => {
    db.serialize(async () => {
      try {
        // Quizzes table
        await new Promise((res, rej) => {
          db.run(`CREATE TABLE IF NOT EXISTS quizzes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            duration INTEGER DEFAULT 60,
            semester TEXT
          )`, (err) => {
            if (err) rej(err);
            else res();
          });
        });

        // Add semester column to quizzes if not exists
        const quizSemesterExists = await columnExists('quizzes', 'semester');
        if (!quizSemesterExists) {
          await new Promise((res, rej) => {
            db.run(`ALTER TABLE quizzes ADD COLUMN semester TEXT`, (err) => {
              if (err) rej(err);
              else res();
            });
          });
        }

        // Questions table
        await new Promise((res, rej) => {
          db.run(`CREATE TABLE IF NOT EXISTS questions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            quiz_id INTEGER,
            text TEXT NOT NULL,
            opt_a TEXT NOT NULL,
            opt_b TEXT NOT NULL,
            opt_c TEXT NOT NULL,
            opt_d TEXT NOT NULL,
            correct_opt TEXT NOT NULL,
            FOREIGN KEY(quiz_id) REFERENCES quizzes(id) ON DELETE CASCADE
          )`, (err) => {
            if (err) rej(err);
            else res();
          });
        });

        // Sessions table
        await new Promise((res, rej) => {
          db.run(`CREATE TABLE IF NOT EXISTS sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            code TEXT NOT NULL UNIQUE,
            quiz_id INTEGER,
            status TEXT DEFAULT 'active',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(quiz_id) REFERENCES quizzes(id)
          )`, (err) => {
            if (err) rej(err);
            else res();
          });
        });

        // Submissions table
        await new Promise((res, rej) => {
          db.run(`CREATE TABLE IF NOT EXISTS submissions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id INTEGER,
            roll TEXT NOT NULL,
            name TEXT NOT NULL,
            semester TEXT,
            answers TEXT NOT NULL, 
            score INTEGER NOT NULL,
            timed_out BOOLEAN DEFAULT 0,
            FOREIGN KEY(session_id) REFERENCES sessions(id)
          )`, (err) => {
            if (err) rej(err);
            else res();
          });
        });

        // Add semester column to submissions if not exists
        const subSemesterExists = await columnExists('submissions', 'semester');
        if (!subSemesterExists) {
          await new Promise((res, rej) => {
            db.run(`ALTER TABLE submissions ADD COLUMN semester TEXT`, (err) => {
              if (err) rej(err);
              else res();
            });
          });
        }

        console.log('Database initialized successfully at', dbPath);
        resolve();
      } catch (err) {
        console.error('Error initializing DB:', err);
        reject(err);
      }
    });
  });
}

// CRUD operations
const dbApi = {
  getQuizzes: () => {
    return new Promise((resolve, reject) => {
      db.all(`SELECT * FROM quizzes`, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  },

  createQuiz: (title, duration, semester) => {
    return new Promise((resolve, reject) => {
      db.run(`INSERT INTO quizzes (title, duration, semester) VALUES (?, ?, ?)`, [title, duration, semester], function(err) {
        if (err) reject(err);
        else resolve(this.lastID);
      });
    });
  },

  deleteQuiz: (id) => {
    return new Promise((resolve, reject) => {
      db.run(`DELETE FROM quizzes WHERE id = ?`, [id], function(err) {
        if (err) reject(err);
        else resolve(this.changes);
      });
    });
  },

  getQuestionsByQuiz: (quizId) => {
    return new Promise((resolve, reject) => {
      db.all(`SELECT * FROM questions WHERE quiz_id = ?`, [quizId], (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  },

  addQuestion: (quizId, text, opt_a, opt_b, opt_c, opt_d, correct_opt) => {
    return new Promise((resolve, reject) => {
      db.run(`INSERT INTO questions (quiz_id, text, opt_a, opt_b, opt_c, opt_d, correct_opt) 
              VALUES (?, ?, ?, ?, ?, ?, ?)`, 
              [quizId, text, opt_a, opt_b, opt_c, opt_d, correct_opt], function(err) {
        if (err) reject(err);
        else resolve(this.lastID);
      });
    });
  },

  deleteQuestion: (id) => {
    return new Promise((resolve, reject) => {
      db.run(`DELETE FROM questions WHERE id = ?`, [id], function(err) {
        if (err) reject(err);
        else resolve(this.changes);
      });
    });
  },

  createSession: (code, quizId) => {
    return new Promise((resolve, reject) => {
      const now = new Date().toISOString(); // UTC ISO string
      db.run(`INSERT INTO sessions (code, quiz_id, status, created_at) VALUES (?, ?, 'active', ?)`, [code, quizId, now], function(err) {
        if (err) reject(err);
        else resolve(this.lastID);
      });
    });
  },

  getSessionByCode: (code) => {
    return new Promise((resolve, reject) => {
      db.get(`SELECT s.*, q.title, q.duration FROM sessions s 
              JOIN quizzes q ON s.quiz_id = q.id 
              WHERE s.code = ? AND s.status = 'active'`, [code], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  },

  stopSession: (sessionId) => {
    return new Promise((resolve, reject) => {
      db.run(`UPDATE sessions SET status = 'completed' WHERE id = ?`, [sessionId], function(err) {
        if (err) reject(err);
        else resolve(this.changes);
      });
    });
  },

  addSubmission: (sessionId, roll, name, semester, answersStr, score, timedOut) => {
    return new Promise((resolve, reject) => {
      db.run(`INSERT INTO submissions (session_id, roll, name, semester, answers, score, timed_out) VALUES (?, ?, ?, ?, ?, ?, ?)`, [sessionId, roll, name, semester, answersStr, score, timedOut], function(err) {
        if (err) reject(err);
        else resolve({
          id: this.lastID,
          session_id: sessionId,
          roll,
          name,
          semester,
          answers: answersStr,
          score,
          timed_out: timedOut
        });
      });
    });
  },

  getSubmissionsBySession: (sessionId) => {
    return new Promise((resolve, reject) => {
      db.all(`SELECT * FROM submissions WHERE session_id = ?`, [sessionId], (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  },
  getSessionsHistory: () => {
    return new Promise((resolve, reject) => {
      db.all(`
        SELECT s.*, q.title, q.semester, q.duration,
        (SELECT COUNT(*) FROM submissions WHERE session_id = s.id) as submission_count,
        (SELECT MIN(score) FROM submissions WHERE session_id = s.id) as lowest_score,
        (SELECT MAX(score) FROM submissions WHERE session_id = s.id) as highest_score
        FROM sessions s
        JOIN quizzes q ON s.quiz_id = q.id
        ORDER BY s.created_at DESC
      `, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  }
};

module.exports = {
  db,
  initDb,
  dbApi
};
