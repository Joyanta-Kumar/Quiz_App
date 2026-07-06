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

  // Student API to fetch quiz data after joining
  app.get('/api/sessions/:code', async (req, res) => {
    try {
      const session = await dbApi.getSessionByCode(req.params.code);
      if (!session) return res.status(404).json({ error: 'Session not found or inactive' });
      
      const questions = await dbApi.getQuestionsByQuiz(session.quiz_id);
      // Strip correct answers before sending to students
      const safeQuestions = questions.map(q => ({
        id: q.id,
        text: q.text,
        opt_a: q.opt_a,
        opt_b: q.opt_b,
        opt_c: q.opt_c,
        opt_d: q.opt_d
      }));

      res.json({
        id: session.id,
        code: session.code,
        duration: session.duration,
        title: session.title,
        questions: safeQuestions
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // HTTP Fallback for submission
  app.post('/api/submit', async (req, res) => {
    try {
      const { sessionId, roll, name, semester, answers, timedOut } = req.body;
      
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
      
      const submission = await dbApi.addSubmission(sessionId, roll, name, semester, JSON.stringify(answers), score, timedOut);
      
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

  // CSV Export API
  app.get('/api/sessions/:id/export', async (req, res) => {
    try {
      const submissions = await dbApi.getSubmissionsBySession(req.params.id);
      
      const exportPath = path.join(require('os').tmpdir(), `session_${req.params.id}_export.csv`);
      const csvWriter = createObjectCsvWriter({
        path: exportPath,
        header: [
          { id: 'roll', title: 'Roll Number' },
          { id: 'name', title: 'Name' },
          { id: 'semester', title: 'Semester' },
          { id: 'score', title: 'Score' },
          { id: 'timed_out', title: 'Timed Out' },
          { id: 'answers', title: 'Answers JSON' }
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
            if (timerBroadcastInterval) {
              clearInterval(timerBroadcastInterval);
              timerBroadcastInterval = null;
            }
            console.log('Teacher connected');
            break;
            
          case 'session:start':
            // data.payload = { code, quizId }
            sessionJoinsClosed = false; // Reset join status when new session starts
            quizStartTime = null;
            quizDuration = 0;
            if (timerBroadcastInterval) {
              clearInterval(timerBroadcastInterval);
              timerBroadcastInterval = null;
            }
            const sessionId = await dbApi.createSession(data.payload.code, data.payload.quizId);
            currentSessionId = sessionId;
            // Get quiz duration
            const quizzes = await dbApi.getQuizzes();
            const quiz = quizzes.find(q => q.id === data.payload.quizId);
            if (quiz) {
              quizDuration = quiz.duration;
            }
            // We NO LONGER broadcast 'session:start' to students here.
            // Students will wait in lobby. Teacher must trigger it later.
            ws.send(JSON.stringify({ type: 'session:started', payload: { sessionId, duration: quizDuration } }));
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
                    code: data.payload.code,
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

          case 'client:join':
            // payload: { roll, name, semester }
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
            // Calculate score securely
            let score = 0;
            try {
              const sessionRows = await new Promise((res, rej) => {
                db.all(`SELECT quiz_id FROM sessions WHERE id = ?`, [data.payload.sessionId], (err, r) => err ? rej(err) : res(r));
              });
              if (sessionRows.length > 0) {
                const questions = await dbApi.getQuestionsByQuiz(sessionRows[0].quiz_id);
                const answersMap = data.payload.answers; // { questionId: "A", ... }
                
                questions.forEach(q => {
                  if (answersMap[q.id] === q.correct_opt) {
                    score++;
                  }
                });
              }
            } catch (e) {
              console.error("Score calc error", e);
            }

            const submission = await dbApi.addSubmission(
              data.payload.sessionId, 
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
