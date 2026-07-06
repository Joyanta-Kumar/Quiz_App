// State
let sessionData = null;
let ws = null;
let roll = '';
let name = '';
let semester = '';
let sessionId = null;
let timerInterval = null;
let quizStartTime = 0;
let quizDuration = 0;
let answers = {}; // { qId: option }
let hasSubmitted = false;

// DOM Elements
const views = document.querySelectorAll('.view');
const joinForm = document.getElementById('join-form');
const joinCodeInput = document.getElementById('join-code');
const joinError = document.getElementById('join-error');
const quizTitleEl = document.getElementById('quiz-title');
const studentInfoEl = document.getElementById('student-info');
const timerEl = document.getElementById('timer');
const timerBox = document.querySelector('.timer-box');
const questionsContainer = document.getElementById('questions-container');
const submitQuizBtn = document.getElementById('submit-quiz-btn');
const finalScoreEl = document.getElementById('final-score');

// Init
function init() {
  // Extract code from URL if present (e.g. /join/1234)
  const pathParts = window.location.pathname.split('/');
  if (pathParts.length >= 3 && pathParts[1] === 'join') {
    joinCodeInput.value = pathParts[2];
  }
}

function switchView(viewId) {
  views.forEach(v => v.classList.remove('active'));
  document.getElementById(`view-${viewId}`).classList.add('active');
}

// Join Flow
joinForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = joinCodeInput.value.trim();
  roll = document.getElementById('join-roll').value.trim();
  name = document.getElementById('join-name').value.trim();
  semester = document.getElementById('join-semester').value.trim();
  
  if (!code || !roll || !name || !semester) return;
  
  try {
    // Fetch session details
    const res = await fetch(`/api/sessions/${code}`);
    const data = await res.json();
    
    if (res.ok) {
      sessionData = data;
      sessionId = data.id;
      
      // Connect WS
      connectWS();
    } else {
      joinError.textContent = data.error || 'Failed to join session';
    }
  } catch (err) {
    joinError.textContent = 'Server connection error';
  }
});

function connectWS() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}`;
  ws = new WebSocket(wsUrl);
  
  ws.onopen = () => {
    ws.send(JSON.stringify({
      type: 'client:join',
      payload: { roll, name, semester }
    }));
  };
  
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    
    if (msg.type === 'server:join_accepted') {
      switchView('lobby');
    } else if (msg.type === 'server:join_rejected') {
      // Show error to student and go back to join screen
      joinError.textContent = msg.message;
      switchView('join');
    } else if (msg.type === 'session:start' && msg.payload.code === sessionData.code) {
      startQuiz(msg.payload.startTime, msg.payload.duration);
    } else if (msg.type === 'session:stop') {
      submitQuiz(true); // force submit if teacher stops
    } else if (msg.type === 'server:submitted') {
      showResult(msg.payload.score);
    }
  };
  
  ws.onclose = () => {
    // handle disconnect
  };
}

// Quiz Flow
function startQuiz(startTime, duration) {
  switchView('quiz');
  quizTitleEl.textContent = sessionData.title;
  studentInfoEl.textContent = `Roll: ${roll} | ${name}`;
  
  renderQuestions();
  
  // Store synchronized start time and duration
  quizStartTime = startTime;
  quizDuration = duration;
  
  // Initialize and start timer
  updateTimerDisplay();
  
  timerInterval = setInterval(() => {
    updateTimerDisplay();
    const elapsed = Math.floor((Date.now() - quizStartTime) / 1000);
    const remaining = Math.max(0, quizDuration - elapsed);
    
    if (remaining <= 0) {
      clearInterval(timerInterval);
      timerInterval = null;
      submitQuiz(true); // timed out
    }
  }, 1000);
}

function calculateRemainingTime() {
  const elapsed = Math.floor((Date.now() - quizStartTime) / 1000);
  return Math.max(0, quizDuration - elapsed);
}

function renderQuestions() {
  questionsContainer.innerHTML = '';
  sessionData.questions.forEach((q, index) => {
    const qCard = document.createElement('div');
    qCard.className = 'question-card';
    qCard.innerHTML = `
      <div class="q-text">${index + 1}. ${q.text}</div>
      <div class="options-list">
        <label class="option-label">
          <input type="radio" name="q-${q.id}" value="a" onchange="recordAnswer(${q.id}, 'a')">
          <span class="option-text">${q.opt_a}</span>
        </label>
        <label class="option-label">
          <input type="radio" name="q-${q.id}" value="b" onchange="recordAnswer(${q.id}, 'b')">
          <span class="option-text">${q.opt_b}</span>
        </label>
        <label class="option-label">
          <input type="radio" name="q-${q.id}" value="c" onchange="recordAnswer(${q.id}, 'c')">
          <span class="option-text">${q.opt_c}</span>
        </label>
        <label class="option-label">
          <input type="radio" name="q-${q.id}" value="d" onchange="recordAnswer(${q.id}, 'd')">
          <span class="option-text">${q.opt_d}</span>
        </label>
      </div>
    `;
    questionsContainer.appendChild(qCard);
  });
}

window.recordAnswer = function(qId, opt) {
  answers[qId] = opt;
}

function updateTimerDisplay() {
  const remaining = calculateRemainingTime();
  const m = Math.floor(remaining / 60).toString().padStart(2, '0');
  const s = (remaining % 60).toString().padStart(2, '0');
  timerEl.textContent = `${m}:${s}`;
  
  if (remaining <= 60 && remaining > 0) {
    timerBox.classList.add('warning');
  } else if (remaining === 0) {
    timerBox.classList.remove('warning');
  }
}

submitQuizBtn.addEventListener('click', () => submitQuiz(false));

function submitQuiz(timedOut) {
  if (hasSubmitted) return; // Prevent duplicate submissions
  hasSubmitted = true;
  
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = null;
  
  submitQuizBtn.disabled = true;
  submitQuizBtn.textContent = 'Submitting...';
  
  // Only mark as timed out if remaining time is actually ≤ 0
  const actualTimedOut = timedOut && calculateRemainingTime() <= 0;
  
  const payload = {
    sessionId,
    roll,
    name,
    semester,
    answers,
    timedOut: actualTimedOut
  };
  
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'client:submit', payload }));
  } else {
    // Fallback HTTP
    fetch('/api/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(res => res.json())
      .then(data => showResult(data.score))
      .catch(err => alert('Failed to submit'));
  }
}

function showResult(score) {
  switchView('result');
  finalScoreEl.textContent = score;
}

init();
