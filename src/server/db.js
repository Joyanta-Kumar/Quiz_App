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

// Helper: Normalize registration number (remove hyphens, trim whitespace, lowercase)
const normalizeRegNo = (regNo) => {
  return String(regNo || '').replace(/-/g, '').trim().toLowerCase();
};

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
        // First, check if students table exists and if it has old columns
        const tableExists = await new Promise((res, rej) => {
          db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='students'", (err, row) => {
            if (err) rej(err);
            else res(!!row);
          });
        });

        if (tableExists) {
          // Existing table: check for all required columns, add missing ones
          const studentColumns = ['registration_number', 'roll_number', 'full_name', 'semester', 'session_year', 'department', 'batch', 'verified', 'deleted'];
          
          // Check if there's an old "name" column
          const hasNameColumn = await columnExists('students', 'name');
          
          for (const column of studentColumns) {
            const exists = await columnExists('students', column);
            if (!exists) {
              if (column === 'full_name' && hasNameColumn) {
                // If we have an old "name" column, copy its values to full_name first
                await new Promise((res, rej) => {
                  db.run(`ALTER TABLE students ADD COLUMN ${column} TEXT`, (err) => {
                    if (err) rej(err);
                    else res();
                  });
                });
                // Copy name to full_name
                await new Promise((res, rej) => {
                  db.run(`UPDATE students SET full_name = name WHERE full_name IS NULL`, (err) => {
                    if (err) rej(err);
                    else res();
                  });
                });
              } else if (column === 'verified' || column === 'deleted') {
                // Add verified/deleted column with default 0
                await new Promise((res, rej) => {
                  db.run(`ALTER TABLE students ADD COLUMN ${column} INTEGER DEFAULT 0`, (err) => {
                    if (err) rej(err);
                    else res();
                  });
                });
              } else {
                // Add column without NOT NULL constraint for existing rows
                await new Promise((res, rej) => {
                  db.run(`ALTER TABLE students ADD COLUMN ${column} TEXT`, (err) => {
                    if (err) rej(err);
                    else res();
                  });
                });
              }
            }
          }
        } else {
          // New table: create with all NOT NULL constraints
          await new Promise((res, rej) => {
            db.run(`CREATE TABLE students (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              registration_number TEXT NOT NULL UNIQUE,
              roll_number TEXT NOT NULL,
              full_name TEXT NOT NULL,
              semester TEXT NOT NULL,
              session_year TEXT NOT NULL,
              department TEXT NOT NULL,
              batch TEXT NOT NULL,
              verified INTEGER NOT NULL DEFAULT 1,
              deleted INTEGER NOT NULL DEFAULT 0
            )`, (err) => {
              if (err) rej(err);
              else res();
            });
          });
        }

        // Set all existing students to verified
        await new Promise((res, rej) => {
          db.run(`UPDATE students SET verified = 1 WHERE verified = 0`, (err) => {
            if (err) rej(err);
            else res();
          });
        });

        // Quizzes table
        await new Promise((res, rej) => {
          db.run(`CREATE TABLE IF NOT EXISTS quizzes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            duration INTEGER DEFAULT 60,
            semester TEXT,
            session TEXT,
            deleted INTEGER DEFAULT 0
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

        // Add session column to quizzes if not exists
        const quizSessionExists = await columnExists('quizzes', 'session');
        if (!quizSessionExists) {
          await new Promise((res, rej) => {
            db.run(`ALTER TABLE quizzes ADD COLUMN session TEXT`, (err) => {
              if (err) rej(err);
              else res();
            });
          });
        }
        
        // Add deleted column to quizzes if not exists
        const quizDeletedExists = await columnExists('quizzes', 'deleted');
        if (!quizDeletedExists) {
          await new Promise((res, rej) => {
            db.run(`ALTER TABLE quizzes ADD COLUMN deleted INTEGER DEFAULT 0`, (err) => {
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
            image TEXT,
            FOREIGN KEY(quiz_id) REFERENCES quizzes(id) ON DELETE CASCADE
          )`, (err) => {
            if (err) rej(err);
            else res();
          });
        });

        // Add image column to questions if not exists
        const questionImageExists = await columnExists('questions', 'image');
        if (!questionImageExists) {
          await new Promise((res, rej) => {
            db.run(`ALTER TABLE questions ADD COLUMN image TEXT`, (err) => {
              if (err) rej(err);
              else res();
            });
          });
        }

        // Sessions table
        await new Promise((res, rej) => {
          db.run(`CREATE TABLE IF NOT EXISTS sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            code TEXT NOT NULL UNIQUE,
            quiz_id INTEGER,
            status TEXT DEFAULT 'active',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            show_answers INTEGER DEFAULT 0,
            FOREIGN KEY(quiz_id) REFERENCES quizzes(id)
          )`, (err) => {
            if (err) rej(err);
            else res();
          });
        });

        // Add show_answers column to sessions if not exists
        const showAnswersExists = await columnExists('sessions', 'show_answers');
        if (!showAnswersExists) {
          await new Promise((res, rej) => {
            db.run(`ALTER TABLE sessions ADD COLUMN show_answers INTEGER DEFAULT 0`, (err) => {
              if (err) rej(err);
              else res();
            });
          });
        }

        // Submissions table
        await new Promise((res, rej) => {
          db.run(`CREATE TABLE IF NOT EXISTS submissions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id INTEGER,
            registration_number TEXT,
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

        // Add registration_number column to submissions if not exists
        const subRegNumExists = await columnExists('submissions', 'registration_number');
        if (!subRegNumExists) {
          await new Promise((res, rej) => {
            db.run(`ALTER TABLE submissions ADD COLUMN registration_number TEXT`, (err) => {
              if (err) rej(err);
              else res();
            });
          });
        }

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

        // Add registration_number column to submissions if not exists
        const subRegistrationNumberExists = await columnExists('submissions', 'registration_number');
        if (!subRegistrationNumberExists) {
          await new Promise((res, rej) => {
            db.run(`ALTER TABLE submissions ADD COLUMN registration_number TEXT`, (err) => {
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
  // Students
  createStudent: async (registrationNumber, rollNumber, fullName, semester, sessionYear, department, batch) => {
    return new Promise(async (resolve, reject) => {
      const hasNameColumn = await columnExists('students', 'name');
      
      let query, params;
      if (hasNameColumn) {
        // If old name column exists, include it in insert to avoid NOT NULL errors
        query = `INSERT INTO students (registration_number, roll_number, full_name, name, semester, session_year, department, batch, verified) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`;
        params = [registrationNumber, rollNumber, fullName, fullName, semester, sessionYear, department, batch];
      } else {
        query = `INSERT INTO students (registration_number, roll_number, full_name, semester, session_year, department, batch, verified) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`;
        params = [registrationNumber, rollNumber, fullName, semester, sessionYear, department, batch];
      }
      
      db.run(query, params, function(err) {
        if (err) reject(err);
        else resolve(this.lastID);
      });
    });
  },

  createStudents: async (students) => {
    return new Promise(async (resolve, reject) => {
      const hasNameColumn = await columnExists('students', 'name');
      let insertedCount = 0;
      let skippedCount = 0;
      let errors = [];
      let skippedStudents = [];
      
      for (const student of students) {
        const normalizedRegNo = normalizeRegNo(student.registration_number);
        
        // First check if a student with this normalized reg no already exists
        const existingStudent = await new Promise((res, rej) => {
          const checkQuery = hasNameColumn 
            ? `SELECT id FROM students WHERE REPLACE(REPLACE(LOWER(registration_number), '-', ''), ' ', '') = ?`
            : `SELECT id FROM students WHERE REPLACE(REPLACE(LOWER(registration_number), '-', ''), ' ', '') = ?`;
          db.get(checkQuery, [normalizedRegNo], (err, row) => {
            if (err) rej(err);
            else res(row);
          });
        });
        
        if (existingStudent) {
          skippedCount++;
          skippedStudents.push(student);
          continue;
        }
        
        let query, params;
        if (hasNameColumn) {
          query = `INSERT INTO students (registration_number, roll_number, full_name, name, semester, session_year, department, batch, verified) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`;
          params = [
            student.registration_number,
            student.roll_number,
            student.full_name,
            student.full_name,
            student.semester,
            student.session_year,
            student.department,
            student.batch
          ];
        } else {
          query = `INSERT INTO students (registration_number, roll_number, full_name, semester, session_year, department, batch, verified) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`;
          params = [
            student.registration_number,
            student.roll_number,
            student.full_name,
            student.semester,
            student.session_year,
            student.department,
            student.batch
          ];
        }
        
        await new Promise((res, rej) => {
          db.run(query, params, function(err) {
            if (err) {
              errors.push({ student, error: err.message });
            } else if (this.changes > 0) {
              insertedCount++;
            }
            res();
          });
        });
      }
      
      resolve({ inserted: insertedCount, skipped: skippedCount, skippedStudents, errors });
    });
  },

  getStudentByRegistrationAndSession: async (registrationNumber, sessionYear, department) => {
    return new Promise(async (resolve, reject) => {
      // First, check if "name" column exists
      const hasNameColumn = await columnExists('students', 'name');
      const normalizedInputRegNo = normalizeRegNo(registrationNumber);
      
      // Build the query - we'll normalize stored registration number in SQL
      const query = hasNameColumn 
        ? `SELECT id, registration_number, roll_number, COALESCE(full_name, name) as full_name, semester, session_year, department, batch, verified FROM students WHERE REPLACE(REPLACE(LOWER(registration_number), '-', ''), ' ', '') = ? AND session_year = ? AND department = ?`
        : `SELECT * FROM students WHERE REPLACE(REPLACE(LOWER(registration_number), '-', ''), ' ', '') = ? AND session_year = ? AND department = ?`;
      
      db.get(query, [normalizedInputRegNo, sessionYear, department], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  },

  getAllStudents: async () => {
    return new Promise(async (resolve, reject) => {
      const hasNameColumn = await columnExists('students', 'name');
      
      const query = hasNameColumn 
        ? `SELECT id, registration_number, roll_number, COALESCE(full_name, name) as full_name, semester, session_year, department, batch, verified FROM students WHERE deleted = 0 ORDER BY full_name`
        : `SELECT * FROM students WHERE deleted = 0 ORDER BY full_name`;
      
      db.all(query, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  },

  softDeleteStudent: (id) => {
    return new Promise((resolve, reject) => {
      db.run(`UPDATE students SET deleted = 1 WHERE id = ?`, [id], function(err) {
        if (err) reject(err);
        else resolve(this.changes);
      });
    });
  },

  softDeleteStudentsByGroup: (dept, batch, sessionYear) => {
    return new Promise((resolve, reject) => {
      db.run(
        `UPDATE students SET deleted = 1 WHERE department = ? AND batch = ? AND session_year = ?`,
        [dept, batch, sessionYear],
        function(err) {
          if (err) reject(err);
          else resolve(this.changes);
        }
      );
    });
  },
  
  restoreStudent: (id) => {
    return new Promise((resolve, reject) => {
      db.run(`UPDATE students SET deleted = 0 WHERE id = ?`, [id], function(err) {
        if (err) reject(err);
        else resolve(this.changes);
      });
    });
  },

  permanentDeleteStudent: (id) => {
    return new Promise((resolve, reject) => {
      db.run(`DELETE FROM students WHERE id = ?`, [id], function(err) {
        if (err) reject(err);
        else resolve(this.changes);
      });
    });
  },

  getQuizzes: () => {
    return new Promise((resolve, reject) => {
      db.all(`SELECT * FROM quizzes WHERE deleted = 0`, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  },

  createQuiz: (title, duration, semester, session) => {
    return new Promise((resolve, reject) => {
      db.run(`INSERT INTO quizzes (title, duration, semester, session) VALUES (?, ?, ?, ?)`, [title, duration, semester, session], function(err) {
        if (err) reject(err);
        else resolve(this.lastID);
      });
    });
  },

  softDeleteQuiz: (id) => {
    return new Promise((resolve, reject) => {
      db.run(`UPDATE quizzes SET deleted = 1 WHERE id = ?`, [id], function(err) {
        if (err) reject(err);
        else resolve(this.changes);
      });
    });
  },
  
  restoreQuiz: (id) => {
    return new Promise((resolve, reject) => {
      db.run(`UPDATE quizzes SET deleted = 0 WHERE id = ?`, [id], function(err) {
        if (err) reject(err);
        else resolve(this.changes);
      });
    });
  },

  permanentDeleteQuiz: (id) => {
    return new Promise((resolve, reject) => {
      db.serialize(() => {
        // First delete all submissions for sessions of this quiz
        db.run(`DELETE FROM submissions WHERE session_id IN (SELECT id FROM sessions WHERE quiz_id = ?)`, [id], (err) => {
          if (err) reject(err);
        });
        // Then delete all sessions for this quiz
        db.run(`DELETE FROM sessions WHERE quiz_id = ?`, [id], (err) => {
          if (err) reject(err);
        });
        // Then delete all questions for this quiz
        db.run(`DELETE FROM questions WHERE quiz_id = ?`, [id], (err) => {
          if (err) reject(err);
        });
        // Finally delete the quiz itself
        db.run(`DELETE FROM quizzes WHERE id = ?`, [id], function(err) {
          if (err) reject(err);
          else resolve(this.changes);
        });
      });
    });
  },

  getDeletedItems: async () => {
    return new Promise(async (resolve, reject) => {
      const hasNameColumn = await columnExists('students', 'name');
      const studentsQuery = hasNameColumn 
        ? `SELECT id, registration_number, roll_number, COALESCE(full_name, name) as full_name, semester, session_year, department, batch, verified, 'student' as type FROM students WHERE deleted = 1`
        : `SELECT id, registration_number, roll_number, full_name, semester, session_year, department, batch, verified, 'student' as type FROM students WHERE deleted = 1`;
      
      const quizzesQuery = `SELECT id, title, duration, semester, session, 'quiz' as type FROM quizzes WHERE deleted = 1`;
      
      const students = await new Promise((res, rej) => {
        db.all(studentsQuery, (err, rows) => {
          if (err) rej(err);
          else res(rows);
        });
      });
      
      const quizzes = await new Promise((res, rej) => {
        db.all(quizzesQuery, (err, rows) => {
          if (err) rej(err);
          else res(rows);
        });
      });
      
      resolve([...students, ...quizzes]);
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

  addQuestion: (quizId, text, opt_a, opt_b, opt_c, opt_d, correct_opt, image) => {
    return new Promise((resolve, reject) => {
      db.run(`INSERT INTO questions (quiz_id, text, opt_a, opt_b, opt_c, opt_d, correct_opt, image) 
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, 
              [quizId, text, opt_a, opt_b, opt_c, opt_d, correct_opt, image], function(err) {
        if (err) reject(err);
        else resolve(this.lastID);
      });
    });
  },

  updateQuestion: (id, text, opt_a, opt_b, opt_c, opt_d, correct_opt, image) => {
    return new Promise((resolve, reject) => {
      db.run(`UPDATE questions SET text = ?, opt_a = ?, opt_b = ?, opt_c = ?, opt_d = ?, correct_opt = ?, image = ? WHERE id = ?`,
        [text, opt_a, opt_b, opt_c, opt_d, correct_opt, image, id], function(err) {
          if (err) reject(err);
          else resolve(this.changes);
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

  addSubmission: (sessionId, registrationNumber, roll, name, semester, answersStr, score, timedOut) => {
    return new Promise((resolve, reject) => {
      db.run(`INSERT INTO submissions (session_id, registration_number, roll, name, semester, answers, score, timed_out) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [sessionId, registrationNumber, roll, name, semester, answersStr, score, timedOut], function(err) {
        if (err) reject(err);
        else resolve({
          id: this.lastID,
          session_id: sessionId,
          registration_number: registrationNumber,
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
  },

  deleteSession: (sessionId) => {
    return new Promise((resolve, reject) => {
      db.serialize(() => {
        // First delete all submissions for this session
        db.run(`DELETE FROM submissions WHERE session_id = ?`, [sessionId], (err) => {
          if (err) reject(err);
        });
        // Then delete the session itself
        db.run(`DELETE FROM sessions WHERE id = ?`, [sessionId], function(err) {
          if (err) reject(err);
          else resolve(this.changes);
        });
      });
    });
  },

  deleteSessions: (sessionIds) => {
    return new Promise((resolve, reject) => {
      if (sessionIds.length === 0) {
        resolve(0);
        return;
      }
      const placeholders = sessionIds.map(() => '?').join(',');
      db.serialize(() => {
        // First delete all submissions for these sessions
        db.run(`DELETE FROM submissions WHERE session_id IN (${placeholders})`, sessionIds, (err) => {
          if (err) reject(err);
        });
        // Then delete the sessions themselves
        db.run(`DELETE FROM sessions WHERE id IN (${placeholders})`, sessionIds, function(err) {
          if (err) reject(err);
          else resolve(this.changes);
        });
      });
    });
  },

  softDeleteQuizzes: (quizIds) => {
    return new Promise((resolve, reject) => {
      if (quizIds.length === 0) {
        resolve(0);
        return;
      }
      const placeholders = quizIds.map(() => '?').join(',');
      db.run(`UPDATE quizzes SET deleted = 1 WHERE id IN (${placeholders})`, quizIds, function(err) {
        if (err) reject(err);
        else resolve(this.changes);
      });
    });
  },

  restoreQuizzes: (quizIds) => {
    return new Promise((resolve, reject) => {
      if (quizIds.length === 0) {
        resolve(0);
        return;
      }
      const placeholders = quizIds.map(() => '?').join(',');
      db.run(`UPDATE quizzes SET deleted = 0 WHERE id IN (${placeholders})`, quizIds, function(err) {
        if (err) reject(err);
        else resolve(this.changes);
      });
    });
  },

  permanentDeleteQuizzes: (quizIds) => {
    return new Promise((resolve, reject) => {
      if (quizIds.length === 0) {
        resolve(0);
        return;
      }
      const placeholders = quizIds.map(() => '?').join(',');
      db.serialize(() => {
        // First delete all submissions for sessions of these quizzes
        db.run(`DELETE FROM submissions WHERE session_id IN (SELECT id FROM sessions WHERE quiz_id IN (${placeholders}))`, quizIds, (err) => {
          if (err) reject(err);
        });
        // Then delete all sessions for these quizzes
        db.run(`DELETE FROM sessions WHERE quiz_id IN (${placeholders})`, quizIds, (err) => {
          if (err) reject(err);
        });
        // Then delete all questions for these quizzes
        db.run(`DELETE FROM questions WHERE quiz_id IN (${placeholders})`, quizIds, (err) => {
          if (err) reject(err);
        });
        // Finally delete the quizzes themselves
        db.run(`DELETE FROM quizzes WHERE id IN (${placeholders})`, quizIds, function(err) {
          if (err) reject(err);
          else resolve(this.changes);
        });
      });
    });
  },

  getSessionById: (sessionId) => {
    return new Promise((resolve, reject) => {
      db.get(`SELECT * FROM sessions WHERE id = ?`, [sessionId], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  },

  toggleShowAnswers: (sessionId) => {
    return new Promise((resolve, reject) => {
      db.run(`UPDATE sessions SET show_answers = NOT show_answers WHERE id = ?`, [sessionId], function(err) {
        if (err) reject(err);
        else resolve(this.changes);
      });
    });
  },

  getSessionQuestionsAndAnswers: (sessionId) => {
    return new Promise((resolve, reject) => {
      db.all(`
        SELECT q.*, s.show_answers 
        FROM questions q
        JOIN quizzes qu ON q.quiz_id = qu.id
        JOIN sessions s ON s.quiz_id = qu.id
        WHERE s.id = ?
      `, [sessionId], (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  },

  getUniqueSessionYears: () => {
    return new Promise((resolve, reject) => {
      db.all(`SELECT DISTINCT session_year FROM students WHERE deleted = 0 AND session_year IS NOT NULL ORDER BY session_year`, (err, rows) => {
        if (err) reject(err);
        else resolve(rows.map(r => r.session_year));
      });
    });
  },

  getUniqueDepartments: () => {
    return new Promise((resolve, reject) => {
      db.all(`SELECT DISTINCT department FROM students WHERE deleted = 0 AND department IS NOT NULL ORDER BY department`, (err, rows) => {
        if (err) reject(err);
        else resolve(rows.map(r => r.department));
      });
    });
  }
};

module.exports = {
  db,
  initDb,
  dbApi
};
