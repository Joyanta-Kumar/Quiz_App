// State
let sessionData = null;
let ws = null;
let roll = '';
let name = '';
let semester = '';
let registrationNumber = '';
let sessionId = null;
let timerInterval = null;
let quizStartTime = 0;
let quizDuration = 0;
let answers = {}; // { qId: option }
let hasSubmitted = false;
let currentStudent = null;
let serverAddress = null;

// DOM Elements
const views = document.querySelectorAll('.view');
const loginForm = document.getElementById('login-form');
const joinBtn = document.getElementById('join-btn');
const loginError = document.getElementById('login-error');
const joinError = document.getElementById('join-error');
const quizTitleEl = document.getElementById('quiz-title');
const studentInfoEl = document.getElementById('student-info');
const studentGreetingEl = document.getElementById('student-greeting');
const timerEl = document.getElementById('timer');
const timerBox = document.querySelector('.timer-box');
const questionsContainer = document.getElementById('questions-container');
const submitQuizBtn = document.getElementById('submit-quiz-btn');
const finalScoreEl = document.getElementById('final-score');
const logoutBtn = document.getElementById('logout-btn');

// Helper function to get API base URL
function getApiBaseUrl() {
  if (serverAddress) {
    return `http://${serverAddress}`;
  }
  return ''; // Use current host
}

// Helper function to get WebSocket URL
function getWsUrl() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  if (serverAddress) {
    return `${protocol}//${serverAddress}`;
  }
  return `${protocol}//${window.location.host}`;
}

// Fetch unique session years and populate dropdown
async function loadSessionYears() {
  try {
    const res = await fetch(`${getApiBaseUrl()}/api/students/sessions`);
    const sessions = await res.json();
    const select = document.getElementById('login-session-year');
    select.innerHTML = '<option value="">Select session...</option>';
    sessions.forEach(session => {
      const option = document.createElement('option');
      option.value = session;
      option.textContent = session;
      select.appendChild(option);
    });
  } catch (err) {
    console.error('Failed to load session years:', err);
  }
}

// Fetch unique departments and populate dropdown
async function loadDepartments() {
  try {
    const res = await fetch(`${getApiBaseUrl()}/api/students/departments`);
    const departments = await res.json();
    const select = document.getElementById('login-department');
    select.innerHTML = '<option value="">Select department...</option>';
    departments.forEach(department => {
      const option = document.createElement('option');
      option.value = department;
      option.textContent = department;
      select.appendChild(option);
    });
  } catch (err) {
    console.error('Failed to load departments:', err);
  }
}

// Init
function init() {
  // Check if server address is stored in localStorage (for backward compatibility)
  const storedServerAddress = localStorage.getItem('quizmaster-server-address');
  if (storedServerAddress) {
    serverAddress = storedServerAddress;
  }
  
  // Load session years and departments when login view is shown
  loadSessionYears();
  loadDepartments();
  
  // Check if student is logged in from localStorage
  const storedStudent = localStorage.getItem('quizmaster-student');
  if (storedStudent) {
    currentStudent = JSON.parse(storedStudent);
    populateStudentInfo();
    switchView('join');
  }
}

function switchView(viewId) {
  views.forEach(v => v.classList.remove('active'));
  document.getElementById(`view-${viewId}`).classList.add('active');
}

function populateStudentInfo() {
  studentGreetingEl.textContent = `Welcome, ${currentStudent.full_name}!`;
}

// View Switching
logoutBtn.addEventListener('click', () => {
  currentStudent = null;
  localStorage.removeItem('quizmaster-student');
  switchView('login');
  loginError.textContent = '';
  loadSessionYears(); // Reload session years in case new ones were added
  loadDepartments(); // Reload departments in case new ones were added
});

// Helper: Normalize registration number (remove hyphens, trim whitespace, lowercase)
const normalizeRegNo = (regNo) => {
  return String(regNo || '').replace(/-/g, '').trim().toLowerCase();
};

// Login Flow
loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const registrationNumber = document.getElementById('login-registration-number').value.trim();
  const sessionYear = document.getElementById('login-session-year').value.trim();
  const department = document.getElementById('login-department').value.trim();

  if (!registrationNumber || !sessionYear || !department) return;

  try {
    const res = await fetch(`${getApiBaseUrl()}/api/students/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ registrationNumber, sessionYear, department }) // We send original to server, server normalizes
    });
    const data = await res.json();

    if (res.ok) {
      currentStudent = data;
      localStorage.setItem('quizmaster-student', JSON.stringify(currentStudent));
      populateStudentInfo();
      switchView('join');
    } else {
      loginError.textContent = data.error || 'Failed to login';
    }
  } catch (err) {
    loginError.textContent = 'Server connection error';
  }
});

// Join Flow
joinBtn.addEventListener('click', async () => {
  registrationNumber = currentStudent.registration_number;
  roll = currentStudent.roll_number;
  name = currentStudent.full_name;
  semester = currentStudent.semester;
  
  try {
    // Fetch active session details
    const res = await fetch(`${getApiBaseUrl()}/api/active-session`);
    const data = await res.json();
    
    if (res.ok) {
      sessionData = data;
      sessionId = data.id;
      
      // Connect WS
      connectWS();
    } else {
      joinError.textContent = data.error || 'No active quiz session available';
    }
  } catch (err) {
    joinError.textContent = 'Server connection error';
  }
});

function connectWS() {
  const wsUrl = getWsUrl();
  ws = new WebSocket(wsUrl);
  
  ws.onopen = () => {
    ws.send(JSON.stringify({
      type: 'client:join',
      payload: { registrationNumber, roll, name, semester }
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
    } else if (msg.type === 'session:start') {
      startQuiz(msg.payload.startTime, msg.payload.duration);
    } else if (msg.type === 'session:stop') {
      submitQuiz(true); // force submit if teacher stops
    } else if (msg.type === 'server:submitted') {
      showResult(msg.payload.score);
    } else if (msg.type === 'server:show_answers_updated') {
      if (msg.payload.showAnswers) {
        document.getElementById('view-answers-btn').style.display = 'block';
      } else {
        document.getElementById('view-answers-btn').style.display = 'none';
      }
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
      ${q.image ? `<img src="${q.image}" style="max-width: 100%; max-height: 300px; border-radius: 8px; margin: 12px 0;">` : ''}
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
    registrationNumber,
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
    fetch(`${getApiBaseUrl()}/api/submit`, {
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
  
  // Check if answers are available
  checkAnswersAvailable();
}

async function checkAnswersAvailable() {
  try {
    const res = await fetch(`${getApiBaseUrl()}/api/sessions/${sessionId}/questions`);
    if (res.ok) {
      document.getElementById('view-answers-btn').style.display = 'block';
    } else {
      // Retry every 5 seconds
      setTimeout(checkAnswersAvailable, 5000);
    }
  } catch (err) {
    setTimeout(checkAnswersAvailable, 5000);
  }
}

document.getElementById('view-answers-btn').addEventListener('click', async () => {
  try {
    const res = await fetch(`${getApiBaseUrl()}/api/sessions/${sessionId}/questions`);
    const questions = await res.json();
    renderAnswers(questions);
    switchView('answers');
  } catch (err) {
    alert('Failed to load answers');
  }
});

document.getElementById('go-back-to-result-btn').addEventListener('click', () => {
  switchView('result');
});

function renderAnswers(questions) {
  const container = document.getElementById('answers-container');
  container.innerHTML = '';
  
  questions.forEach((q, i) => {
    const studentAnswer = answers[q.id];
    const isCorrect = studentAnswer === q.correct_opt;
    
    const qCard = document.createElement('div');
    qCard.className = 'question-card';
    qCard.innerHTML = `
      <div class="q-text" style="margin-bottom: 12px;">${i + 1}. ${q.text}</div>
      ${q.image ? `<img src="${q.image}" style="max-width: 100%; max-height: 300px; border-radius: 8px; margin: 12px 0;">` : ''}
      <div class="options-list" style="margin-bottom: 12px;">
        <label class="option-label" style="background: ${q.correct_opt === 'a' ? 'var(--success-bg)' : (studentAnswer === 'a' ? 'var(--danger-bg)' : 'transparent')};">
          <span class="option-text">A. ${q.opt_a}</span>
          ${q.correct_opt === 'a' ? '<span style="color: var(--success); font-weight: bold;">✓ Correct</span>' : ''}
          ${studentAnswer === 'a' && q.correct_opt !== 'a' ? '<span style="color: var(--danger); font-weight: bold;">✗ Your Answer</span>' : ''}
        </label>
        <label class="option-label" style="background: ${q.correct_opt === 'b' ? 'var(--success-bg)' : (studentAnswer === 'b' ? 'var(--danger-bg)' : 'transparent')};">
          <span class="option-text">B. ${q.opt_b}</span>
          ${q.correct_opt === 'b' ? '<span style="color: var(--success); font-weight: bold;">✓ Correct</span>' : ''}
          ${studentAnswer === 'b' && q.correct_opt !== 'b' ? '<span style="color: var(--danger); font-weight: bold;">✗ Your Answer</span>' : ''}
        </label>
        <label class="option-label" style="background: ${q.correct_opt === 'c' ? 'var(--success-bg)' : (studentAnswer === 'c' ? 'var(--danger-bg)' : 'transparent')};">
          <span class="option-text">C. ${q.opt_c}</span>
          ${q.correct_opt === 'c' ? '<span style="color: var(--success); font-weight: bold;">✓ Correct</span>' : ''}
          ${studentAnswer === 'c' && q.correct_opt !== 'c' ? '<span style="color: var(--danger); font-weight: bold;">✗ Your Answer</span>' : ''}
        </label>
        <label class="option-label" style="background: ${q.correct_opt === 'd' ? 'var(--success-bg)' : (studentAnswer === 'd' ? 'var(--danger-bg)' : 'transparent')};">
          <span class="option-text">D. ${q.opt_d}</span>
          ${q.correct_opt === 'd' ? '<span style="color: var(--success); font-weight: bold;">✓ Correct</span>' : ''}
          ${studentAnswer === 'd' && q.correct_opt !== 'd' ? '<span style="color: var(--danger); font-weight: bold;">✗ Your Answer</span>' : ''}
        </label>
      </div>
      <p style="margin: 0; padding: 8px; border-radius: 4px; background: ${isCorrect ? 'var(--success-bg)' : 'var(--danger-bg)'};">
        ${isCorrect ? '✓ You got this right!' : '✗ You got this wrong.'}
      </p>
    `;
    container.appendChild(qCard);
  });
}

init();
