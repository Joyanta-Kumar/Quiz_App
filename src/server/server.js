const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const cors = require('cors');
const { initDb, dbApi, db } = require('./db');
const { createObjectCsvWriter } = require('csv-writer');
const fs = require('fs');

let server;
let wss;
let teacherWs = null; // We assume one local teacher for this LAN app
let sessionJoinsClosed = false; // Track whether new students can join
let quizStartTime = null; // Track when quiz started
let quizDuration = 0; // Quiz duration in seconds
let timerBroadcastInterval = null; // Interval to broadcast timer to admin
let currentSessionId = null; // Track active session ID
let activeSession = null; // Track the single active session

async function startServer(port = 3000) {
  await initDb();

  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Serve student client
  const staticPath = path.join(__dirname, '../static');
  app.use(express.static(staticPath));

  // Serve join route specifically to index.html for client-side parsing
  app.get('/join/:code', (req, res) => {
    res.sendFile(path.join(staticPath, 'index.html'));
  });

  // Student Auth API
  app.get('/api/students/sessions', async (req, res) => {
    try {
      const sessions = await dbApi.getUniqueSessionYears();
      res.json(sessions);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/students/departments', async (req, res) => {
    try {
      const departments = await dbApi.getUniqueDepartments();
      res.json(departments);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/students/login', async (req, res) => {
    try {
      const { registrationNumber, sessionYear, department } = req.body;
      
      if (!registrationNumber || !sessionYear || !department) {
        return res.status(400).json({ error: 'Registration number, session year, and department are required' });
      }

      const student = await dbApi.getStudentByRegistrationAndSession(registrationNumber, sessionYear, department);
      if (!student) {
        return res.status(404).json({ error: 'Student not found' });
      }

      res.json(student);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // REST API for Teacher GUI to manage DB
  app.get('/api/quizzes', async (req, res) => {
    try {
      const quizzes = await dbApi.getQuizzes();
      res.json(quizzes);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/quizzes', async (req, res) => {
    try {
      const { title, duration, semester } = req.body;
      const id = await dbApi.createQuiz(title, duration || 60, semester);
      res.json({ id, title, duration: duration || 60, semester });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/quizzes/:id', async (req, res) => {
    try {
      await dbApi.deleteQuiz(req.params.id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/quizzes/:id/questions', async (req, res) => {
    try {
      const questions = await dbApi.getQuestionsByQuiz(req.params.id);
      // Don't send correct answers back if not requested by teacher, but since it's local LAN, it's fine.
      res.json(questions);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/quizzes/:id/questions', async (req, res) => {
    try {
      const { text, opt_a, opt_b, opt_c, opt_d, correct_opt } = req.body;
      const id = await dbApi.addQuestion(req.params.id, text, opt_a, opt_b, opt_c, opt_d, correct_opt);
      res.json({ id });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/questions/:id', async (req, res) => {
    try {
      await dbApi.deleteQuestion(req.params.id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // New API: Get current active session
  app.get('/api/active-session', async (req, res) => {
    try {
      if (!activeSession) {
        return res.status(404).json({ error: 'No active session' });
      }
      
      const questions = await dbApi.getQuestionsByQuiz(activeSession.quiz_id);
      const safeQuestions = questions.map(q => ({
        id: q.id,
        text: q.text,
        opt_a: q.opt_a,
        opt_b: q.opt_b,
        opt_c: q.opt_c,
        opt_d: q.opt_d,
        image: q.image
      }));
      
      res.json({
        id: activeSession.id,
        duration: activeSession.duration,
        title: activeSession.title,
        questions: safeQuestions
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // HTTP Fallback for submission
  app.post('/api/submit', async (req, res) => {
    try {
      const { sessionId, registrationNumber, roll, name, semester, answers, timedOut } = req.body;
      
      // Calculate score server-side to prevent cheating
      let score = 0;
      try {
        const sessionRows = await new Promise((resolve, reject) => {
          db.all(`SELECT quiz_id FROM sessions WHERE id = ?`, [sessionId], (err, rows) => err ? reject(err) : resolve(rows));
        });
        if (sessionRows.length > 0) {
          const questions = await dbApi.getQuestionsByQuiz(sessionRows[0].quiz_id);
          const answersMap = answers;
          questions.forEach(q => {
            if (answersMap[q.id] === q.correct_opt) {
              score++;
            }
          });
        }
      } catch (e) {
        console.error("Score calc error in HTTP submit:", e);
      }
      
      const submission = await dbApi.addSubmission(sessionId, registrationNumber, roll, name, semester, JSON.stringify(answers), score, timedOut);
      
      if (teacherWs && teacherWs.readyState === WebSocket.OPEN) {
        teacherWs.send(JSON.stringify({ type: 'server:submission', payload: submission }));
      }
      
      res.json({ success: true, score });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // History API
  app.get('/api/history', async (req, res) => {
    try {
      const history = await dbApi.getSessionsHistory();
      res.json(history);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get submissions for a session
  app.get('/api/sessions/:id/submissions', async (req, res) => {
    try {
      const submissions = await dbApi.getSubmissionsBySession(req.params.id);
      res.json(submissions);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get session questions and answers (if enabled)
  app.get('/api/sessions/:id/questions', async (req, res) => {
    try {
      const session = await dbApi.getSessionById(req.params.id);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }
      if (!session.show_answers) {
        return res.status(403).json({ error: 'Answers not available yet' });
      }
      const questions = await dbApi.getSessionQuestionsAndAnswers(req.params.id);
      res.json(questions);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // CSV Export API
  app.get('/api/sessions/:id/export', async (req, res) => {
    try {
      const submissions = await dbApi.getSubmissionsBySession(req.params.id);
      
      const exportPath = path.join(require('os').tmpdir(), `session_${req.params.id}_export.csv`);
      const csvWriter = createObjectCsvWriter({
        path: exportPath,
        header: [
          { id: 'registration_number', title: 'Registration Number' },
          { id: 'roll', title: 'Roll Number' },
          { id: 'name', title: 'Name' },
          { id: 'semester', title: 'Semester' },
          { id: 'score', title: 'Score' }
        ]
      });

      await csvWriter.writeRecords(submissions);
      res.download(exportPath, `session_${req.params.id}_results.csv`);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  server = http.createServer(app);
  wss = new WebSocket.Server({ server });

  wss.on('connection', (ws) => {
    ws.on('message', async (message) => {
      try {
        const data = JSON.parse(message);
        switch (data.type) {
          case 'teacher:register':
            teacherWs = ws;
            // Reset all session state when teacher reconnects
            sessionJoinsClosed = false;
            quizStartTime = null;
            quizDuration = 0;
            currentSessionId = null;
            activeSession = null;
            if (timerBroadcastInterval) {
              clearInterval(timerBroadcastInterval);
              timerBroadcastInterval = null;
            }
            console.log('Teacher connected');
            break;
            
          case 'session:start':
            // data.payload = { quizId } (no code anymore!)
            // Validate input
            if (!data.payload || !data.payload.quizId) {
              console.error('Invalid session:start payload');
              ws.send(JSON.stringify({ type: 'error', message: 'Invalid session data' }));
              break;
            }
            
            try {
              // Validate quiz exists
              const allQuizzes = await dbApi.getQuizzes();
              const selectedQuiz = allQuizzes.find(q => q.id === data.payload.quizId);
              if (!selectedQuiz) {
                throw new Error('Quiz not found');
              }
              
              // Validate quiz has questions
              const quizQuestions = await dbApi.getQuestionsByQuiz(data.payload.quizId);
              if (quizQuestions.length === 0) {
                throw new Error('Quiz has no questions');
              }
              
              sessionJoinsClosed = false;
              quizStartTime = null;
              quizDuration = selectedQuiz.duration;
              if (timerBroadcastInterval) {
                clearInterval(timerBroadcastInterval);
                timerBroadcastInterval = null;
              }
              
              // Generate a dummy code (since DB still requires it)
              const dummyCode = Math.random().toString(36).substring(7);
              const sessionId = await dbApi.createSession(dummyCode, data.payload.quizId);
              currentSessionId = sessionId;
              activeSession = {
                id: sessionId,
                quiz_id: data.payload.quizId,
                title: selectedQuiz.title,
                duration: selectedQuiz.duration
              };
              
              ws.send(JSON.stringify({ type: 'session:started', payload: { sessionId, duration: quizDuration } }));
              console.log(`Session ${sessionId} started for quiz ${data.payload.quizId}`);
            } catch (err) {
              console.error('Error starting session:', err);
              ws.send(JSON.stringify({ type: 'error', message: err.message || 'Failed to start session' }));
            }
            break;

          case 'session:close_joins':
            sessionJoinsClosed = true;
            // Notify teacher UI that joins are closed
            if (teacherWs && teacherWs.readyState === WebSocket.OPEN) {
              teacherWs.send(JSON.stringify({ type: 'server:joins_closed' }));
            }
            break;
            
          case 'session:open_joins':
            sessionJoinsClosed = false;
            // Notify teacher UI that joins are open
            if (teacherWs && teacherWs.readyState === WebSocket.OPEN) {
              teacherWs.send(JSON.stringify({ type: 'server:joins_open' }));
            }
            break;

          case 'session:trigger_start':
            // Teacher clicked 'Start Quiz' in Live view
            quizStartTime = Date.now();
            // Broadcast start to students with timestamp and duration
            wss.clients.forEach(c => {
              if (c !== teacherWs && c.readyState === WebSocket.OPEN) {
                // Send 'session:start' to students to trigger startQuiz()
                c.send(JSON.stringify({ 
                  type: 'session:start', 
                  payload: { 
                    startTime: quizStartTime,
                    duration: quizDuration
                  }
                }));
              }
            });
            // Start broadcasting timer to admin
            if (timerBroadcastInterval) {
              clearInterval(timerBroadcastInterval);
            }
            timerBroadcastInterval = setInterval(async () => {
              if (teacherWs && teacherWs.readyState === WebSocket.OPEN && quizStartTime) {
                const elapsed = Math.floor((Date.now() - quizStartTime) / 1000);
                const remaining = Math.max(0, quizDuration - elapsed);
                teacherWs.send(JSON.stringify({ type: 'server:timer_update', payload: { remaining } }));
                if (remaining <= 0) {
                  clearInterval(timerBroadcastInterval);
                  timerBroadcastInterval = null;
                  // Automatically stop session when time is up
                  if (currentSessionId) {
                    await dbApi.stopSession(currentSessionId);
                    sessionJoinsClosed = false; // Reset for next session
                    quizStartTime = null;
                    quizDuration = 0;
                    currentSessionId = null;
                    activeSession = null;
                    wss.clients.forEach(c => {
                      if (c !== teacherWs && c.readyState === WebSocket.OPEN) {
                        c.send(JSON.stringify({ type: 'session:stop' }));
                      }
                    });
                    // Notify admin
                    if (teacherWs && teacherWs.readyState === WebSocket.OPEN) {
                      teacherWs.send(JSON.stringify({ type: 'server:session_stopped' }));
                    }
                  }
                }
              }
            }, 1000);
            // Send initial timer update
            if (teacherWs && teacherWs.readyState === WebSocket.OPEN) {
              teacherWs.send(JSON.stringify({ type: 'server:timer_update', payload: { remaining: quizDuration } }));
            }
            break;

          case 'session:stop':
            await dbApi.stopSession(data.payload.sessionId);
            sessionJoinsClosed = false; // Reset for next session
            quizStartTime = null;
            quizDuration = 0;
            currentSessionId = null;
            activeSession = null;
            if (timerBroadcastInterval) {
              clearInterval(timerBroadcastInterval);
              timerBroadcastInterval = null;
            }
            wss.clients.forEach(c => {
              if (c !== teacherWs && c.readyState === WebSocket.OPEN) {
                c.send(JSON.stringify({ type: 'session:stop' }));
              }
            });
            // Notify admin that session stopped
            if (teacherWs && teacherWs.readyState === WebSocket.OPEN) {
              teacherWs.send(JSON.stringify({ type: 'server:session_stopped' }));
            }
            break;

          case 'session:toggle_show_answers':
            // Broadcast to all connected students
            wss.clients.forEach(client => {
              if (client !== teacherWs && client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({ 
                  type: 'server:show_answers_updated', 
                  payload: { showAnswers: data.payload.showAnswers } 
                }));
              }
            });
            break;

          case 'client:join':
            // payload: { registrationNumber, roll, name, semester }
            // Validate input
            if (!data.payload || !data.payload.registrationNumber || !data.payload.roll || !data.payload.name) {
              ws.send(JSON.stringify({ type: 'server:join_rejected', message: 'Invalid student information.' }));
              break;
            }
            
            // Validate string lengths to prevent DoS (max 100 chars each)
            const MAX_FIELD_LENGTH = 100;
            if ((data.payload.roll && String(data.payload.roll).length > MAX_FIELD_LENGTH) ||
                (data.payload.name && String(data.payload.name).length > MAX_FIELD_LENGTH) ||
                (data.payload.semester && String(data.payload.semester).length > MAX_FIELD_LENGTH)) {
              ws.send(JSON.stringify({ type: 'server:join_rejected', message: 'Student information is too long.' }));
              break;
            }
            
            if (sessionJoinsClosed) {
              // Reject the student
              ws.send(JSON.stringify({ type: 'server:join_rejected', message: 'Joins are closed for this session.' }));
            } else {
              if (teacherWs && teacherWs.readyState === WebSocket.OPEN) {
                teacherWs.send(JSON.stringify({ type: 'server:client_joined', payload: data.payload }));
              }
              ws.send(JSON.stringify({ type: 'server:join_accepted' }));
            }
            break;

          case 'client:submit':
            // Validate payload structure
            if (!data.payload || !data.payload.sessionId || !data.payload.answers) {
              ws.send(JSON.stringify({ type: 'error', message: 'Invalid submission data' }));
              break;
            }
            
            // Calculate score securely (only count valid answers)
            let score = 0;
            try {
              const sessionRows = await new Promise((res, rej) => {
                db.all(`SELECT quiz_id FROM sessions WHERE id = ?`, [data.payload.sessionId], (err, r) => err ? rej(err) : res(r));
              });
              if (sessionRows.length > 0) {
                const questions = await dbApi.getQuestionsByQuiz(sessionRows[0].quiz_id);
                const validQuestionIds = new Set(questions.map(q => q.id));
                const answersMap = data.payload.answers; // { questionId: "A", ... }
                
                // Only count answers for valid questions with valid option values
                questions.forEach(q => {
                  const submittedAnswer = answersMap[q.id];
                  // Validate answer is one of the valid options (a,b,c,d)
                  if (submittedAnswer && ['a', 'b', 'c', 'd'].includes(submittedAnswer) && submittedAnswer === q.correct_opt) {
                    score++;
                  }
                });
              }
            } catch (e) {
              console.error("Score calc error", e);
            }

            try {
              const submission = await dbApi.addSubmission(
                data.payload.sessionId, 
                data.payload.registrationNumber,
                data.payload.roll, 
                data.payload.name, 
                data.payload.semester,
                JSON.stringify(data.payload.answers), 
                score, 
                data.payload.timedOut
              );
              
              // Notify teacher
              if (teacherWs && teacherWs.readyState === WebSocket.OPEN) {
                teacherWs.send(JSON.stringify({ type: 'server:submission', payload: submission }));
              }
              
              // Acknowledge student
              ws.send(JSON.stringify({ type: 'server:submitted', payload: { score } }));
            } catch (err) {
              console.error('Error processing submission:', err);
              ws.send(JSON.stringify({ type: 'error', message: 'Failed to process submission' }));
            }
            break;
        }
      } catch (err) {
        console.error('WS message error:', err);
      }
    });

    ws.on('close', () => {
      if (ws === teacherWs) {
        teacherWs = null;
        console.log('Teacher disconnected');
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(port, () => {
      console.log(`Server listening on port ${port}`);
      resolve(server);
    });
  });
}

function stopServer() {
  if (server) {
    server.close();
  }
}

module.exports = {
  startServer,
  stopServer
};
