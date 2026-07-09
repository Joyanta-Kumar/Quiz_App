const { ipcRenderer } = require('electron');

let serverIp = 'localhost';
let serverPort = 3000;
let ws = null;
let currentSessionId = null;
let currentSessionCode = null;
let isJoinsClosed = false;
let isQuizStarted = false;

// DOM Elements
const views = document.querySelectorAll('.view');
const navItems = document.querySelectorAll('.nav-item');
const serverIpEl = document.getElementById('server-ip');
const serverTitleEl = document.getElementById('server-title');
const serverStatusDotEl = document.getElementById('server-status-dot');
const quizzesGrid = document.getElementById('quizzes-grid');
const serverStatusEl = document.getElementById('server-status');
const serverToggleBtn = document.getElementById('server-toggle-btn');

// State
let quizzes = [];
let questions = []; // For the builder
let isSelectModeDashboard = false;
let selectedQuizzes = new Set();
let isSelectModeHistory = false;
let selectedSessions = new Set();

// Update server status UI
function updateServerStatusUI(isRunning) {
  if (isRunning) {
    // Sidebar controls
    serverStatusEl.textContent = 'Server On';
    serverStatusEl.className = 'status-badge status-submitted';
    serverToggleBtn.textContent = 'Stop Server';
    serverToggleBtn.className = 'btn btn-secondary';
    
    // Bottom-left server info
    serverTitleEl.textContent = 'Server Running';
    serverStatusDotEl.style.background = 'var(--success)';
    serverIpEl.textContent = `${serverIp}:${serverPort}`;
  } else {
    // Sidebar controls
    serverStatusEl.textContent = 'Server Off';
    serverStatusEl.className = 'status-badge status-timeout';
    serverToggleBtn.textContent = 'Start Server';
    serverToggleBtn.className = 'btn btn-primary';
    
    // Bottom-left server info
    serverTitleEl.textContent = 'Server Off';
    serverStatusDotEl.style.background = 'var(--text-muted)';
    serverIpEl.textContent = 'Not Available';
  }
}

// Initialize
async function init() {
  try {
    const info = await ipcRenderer.invoke('get-server-info');
    serverIp = info.ip;
    serverPort = info.port;
  } catch (err) {
    console.error('Failed to get server info:', err);
  }
  
  // Reset session state
  currentSessionId = null;
  currentSessionCode = null;
  isJoinsClosed = false;
  isQuizStarted = false;
  
  // Get initial server status
  try {
    const serverStatus = await ipcRenderer.invoke('get-server-status');
    updateServerStatusUI(serverStatus);
    
    // Only connect WebSocket if server is already running
    if (serverStatus) {
      connectWebSocket();
    }
  } catch (err) {
    console.error('Failed to get server status:', err);
    updateServerStatusUI(false);
  }
  
  loadQuizzes();
  setupNavigation();
  setupQuizBuilder();
}

// Toggle server
window.toggleServer = async function() {
  const newStatus = await ipcRenderer.invoke('toggle-server');
  updateServerStatusUI(newStatus);
  
  // Reconnect WebSocket if server was started
  if (newStatus) {
    connectWebSocket();
  } else {
    // Close WebSocket if server stopped
    if (ws) {
      ws.close();
      ws = null;
    }
  }
};

// WebSocket Connection
function connectWebSocket() {
  try {
    ws = new WebSocket(`ws://localhost:${serverPort}`);
  } catch (err) {
    console.error('Failed to create WebSocket:', err);
    setTimeout(connectWebSocket, 3000);
    return;
  }
  
  ws.onopen = () => {
    try {
      ws.send(JSON.stringify({ type: 'teacher:register' }));
      console.log('Teacher registered with server');
    } catch (err) {
      console.error('Failed to register teacher:', err);
    }
  };
  
  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'server:client_joined') {
      handleStudentJoined(data.payload);
    } else if (data.type === 'server:submission') {
      handleSubmission(data.payload);
    } else if (data.type === 'session:started') {
      currentSessionId = data.payload.sessionId;
      isJoinsClosed = false;
      isQuizStarted = false; // Explicitly reset quiz started state
      // Reset timer display
      const timerEl = document.getElementById('admin-timer');
      if (timerEl) timerEl.textContent = '--:--';
      updateLiveSessionUI('active', true);
    } else if (data.type === 'server:joins_closed') {
      isJoinsClosed = true;
      updateLiveSessionUI('active', false);
    } else if (data.type === 'server:joins_open') {
      isJoinsClosed = false;
      updateLiveSessionUI('active', false);
    } else if (data.type === 'server:timer_update') {
      updateAdminTimer(data.payload.remaining);
    } else if (data.type === 'server:session_stopped') {
      isQuizStarted = false; // Reset quiz started state when session stops
      updateLiveSessionUI('stopped');
    }
  };
  
  ws.onclose = () => {
    setTimeout(connectWebSocket, 3000); // Reconnect
  };
}

// Navigation
function setupNavigation() {
  navItems.forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const viewId = item.getAttribute('data-view');
      switchView(viewId);
    });
  });
}

window.switchView = function(viewId) {
  views.forEach(v => v.classList.remove('active'));
  navItems.forEach(n => n.classList.remove('active'));
  
  document.getElementById(`view-${viewId}`).classList.add('active');
  const navItem = document.querySelector(`.nav-item[data-view="${viewId}"]`);
  if (navItem) navItem.classList.add('active');
  
  if (viewId === 'dashboard') loadQuizzes();
  if (viewId === 'history') loadHistory();
}

// History functions
async function loadHistory() {
  const historyContainer = document.getElementById('history-container');
  const history = await ipcRenderer.invoke('db:getSessionsHistory');

  if (history.length === 0) {
    historyContainer.innerHTML = '<p class="text-muted">No quiz history found.</p>';
    return;
  }

  historyContainer.innerHTML = history.map(session => {
    console.log('Session:', session.id, 'Raw created_at:', session.created_at);
    const dateObj = new Date(session.created_at);
    console.log('Session:', session.id, 'Parsed date (UTC):', dateObj.toISOString());
    const date = dateObj.toLocaleString('en-BD', { 
      timeZone: 'Asia/Dhaka',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    });
    console.log('Session:', session.id, 'Formatted BDT:', date);
    const lowestScore = session.lowest_score !== null ? session.lowest_score : 'N/A';
    const highestScore = session.highest_score !== null ? session.highest_score : 'N/A';
    const isSelected = selectedSessions.has(session.id);
    return `
      <div class="history-item" style="padding: 16px; border-bottom: 1px solid var(--panel-border); display: flex; justify-content: space-between; align-items: center;">
        <div style="display: flex; gap: 12px; align-items: flex-start; flex: 1;">
          ${isSelectModeHistory ? `
            <input type="checkbox" ${isSelected ? 'checked' : ''} 
              onclick="event.stopPropagation(); window.toggleSessionSelection(${session.id})"
              style="width: 18px; height: 18px; cursor: pointer; margin-top: 4px;">
          ` : ''}
          <div>
            <h3 style="margin: 0;">${session.title}${session.semester ? ` (${session.semester})` : ''}</h3>
            <p style="margin: 4px 0 0 0; color: var(--text-muted); font-size: 0.875rem;">
              ${date} | ${session.submission_count} submissions | Low: ${lowestScore}, High: ${highestScore}
            </p>
          </div>
        </div>
        ${!isSelectModeHistory ? `
          <div style="display: flex; gap: 8px;">
            <button class="btn btn-secondary" onclick="window.viewSessionResults(${session.id}, '${session.title}')">View Results</button>
            <button class="btn btn-secondary" onclick="window.exportSession(${session.id})">Export CSV</button>
          </div>
        ` : ''}
      </div>
    `;
  }).join('');
}

window.deleteSession = async function(sessionId) {
  if (confirm('Are you sure you want to delete this session and all its submissions?')) {
    await ipcRenderer.invoke('db:deleteSession', sessionId);
    loadHistory();
  }
};

window.exportSession = async function(sessionId) {
  const success = await ipcRenderer.invoke('export-csv', sessionId);
  if (success) {
    alert('CSV exported successfully!');
  }
};

window.viewSessionResults = async function(sessionId, title) {
  // Set modal title
  document.getElementById('view-results-title').textContent = `${title} - Results`;
  
  // Fetch submissions
  const submissions = await ipcRenderer.invoke('db:getSubmissionsBySession', sessionId);
  const tbody = document.getElementById('view-results-body');
  tbody.innerHTML = '';
  
  if (submissions.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 20px;">No submissions found.</td></tr>';
  } else {
    submissions.forEach(sub => {
      const tr = document.createElement('tr');
      const statusClass = sub.timed_out ? 'status-timeout' : 'status-submitted';
      const statusText = sub.timed_out ? 'Timeout' : 'Submitted';
      
      tr.innerHTML = `
        <td>${sub.registration_number || 'N/A'}</td>
        <td>${sub.roll}</td>
        <td>${sub.name}${sub.semester ? ` (${sub.semester})` : ''}</td>
        <td>${sub.semester || 'N/A'}</td>
        <td><strong>${sub.score}</strong></td>
        <td><span class="status-badge ${statusClass}">${statusText}</span></td>
      `;
      tbody.appendChild(tr);
    });
  }
  
  // Show modal
  document.getElementById('view-results-modal').classList.add('active');
};

window.closeViewResultsModal = function() {
  document.getElementById('view-results-modal').classList.remove('active');
};

// Dashboard Select Mode
window.toggleDashboardSelectMode = function() {
  isSelectModeDashboard = !isSelectModeDashboard;
  if (!isSelectModeDashboard) {
    selectedQuizzes.clear();
  }
  updateDashboardUI();
};

window.toggleQuizSelection = function(quizId) {
  if (selectedQuizzes.has(quizId)) {
    selectedQuizzes.delete(quizId);
  } else {
    selectedQuizzes.add(quizId);
  }
  updateDashboardDeleteBtn();
};

function updateDashboardDeleteBtn() {
  const deleteBtn = document.getElementById('dashboard-delete-selected-btn');
  if (deleteBtn) {
    deleteBtn.style.display = selectedQuizzes.size > 0 ? 'flex' : 'none';
    deleteBtn.alignItems = 'center';
    deleteBtn.gap = '4px';
  }
}

function updateDashboardUI() {
  const selectBtn = document.getElementById('dashboard-select-btn');
  const deleteBtn = document.getElementById('dashboard-delete-selected-btn');
  const newQuizBtn = selectBtn?.parentElement?.querySelector('.btn-primary');

  if (isSelectModeDashboard) {
    selectBtn?.classList.add('btn-primary');
    selectBtn?.classList.remove('btn-secondary');
    if (newQuizBtn) newQuizBtn.style.display = 'none';
  } else {
    selectBtn?.classList.remove('btn-primary');
    selectBtn?.classList.add('btn-secondary');
    if (newQuizBtn) newQuizBtn.style.display = 'flex';
    if (deleteBtn) deleteBtn.style.display = 'none';
  }

  loadQuizzes();
}

window.deleteSelectedQuizzes = async function() {
  if (selectedQuizzes.size === 0) return;
  if (confirm(`Are you sure you want to delete ${selectedQuizzes.size} quiz(zes) and all their data?`)) {
    await ipcRenderer.invoke('db:deleteQuizzes', Array.from(selectedQuizzes));
    isSelectModeDashboard = false;
    selectedQuizzes.clear();
    loadQuizzes();
    updateDashboardUI();
  }
};

// History Select Mode
window.toggleHistorySelectMode = function() {
  isSelectModeHistory = !isSelectModeHistory;
  if (!isSelectModeHistory) {
    selectedSessions.clear();
  }
  updateHistoryUI();
};

window.toggleSessionSelection = function(sessionId) {
  if (selectedSessions.has(sessionId)) {
    selectedSessions.delete(sessionId);
  } else {
    selectedSessions.add(sessionId);
  }
  updateHistoryDeleteBtn();
};

function updateHistoryDeleteBtn() {
  const deleteBtn = document.getElementById('history-delete-selected-btn');
  if (deleteBtn) {
    deleteBtn.style.display = selectedSessions.size > 0 ? 'flex' : 'none';
    deleteBtn.alignItems = 'center';
    deleteBtn.gap = '4px';
  }
}

function updateHistoryUI() {
  const selectBtn = document.getElementById('history-select-btn');
  const deleteBtn = document.getElementById('history-delete-selected-btn');

  if (isSelectModeHistory) {
    selectBtn?.classList.add('btn-primary');
    selectBtn?.classList.remove('btn-secondary');
  } else {
    selectBtn?.classList.remove('btn-primary');
    selectBtn?.classList.add('btn-secondary');
    if (deleteBtn) deleteBtn.style.display = 'none';
  }

  loadHistory();
}

window.deleteSelectedSessions = async function() {
  if (selectedSessions.size === 0) return;
  if (confirm(`Are you sure you want to delete ${selectedSessions.size} session(s) and all their submissions?`)) {
    await ipcRenderer.invoke('db:deleteSessions', Array.from(selectedSessions));
    isSelectModeHistory = false;
    selectedSessions.clear();
    loadHistory();
    updateHistoryUI();
  }
};

// API Calls
async function apiGet(endpoint) {
  const res = await fetch(`http://localhost:${serverPort}/api${endpoint}`);
  return res.json();
}

async function apiPost(endpoint, data) {
  const res = await fetch(`http://localhost:${serverPort}/api${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  return res.json();
}

async function apiDelete(endpoint) {
  const res = await fetch(`http://localhost:${serverPort}/api${endpoint}`, {
    method: 'DELETE'
  });
  return res.json();
}

// Dashboard
async function loadQuizzes() {
  quizzes = await ipcRenderer.invoke('db:getQuizzes');
  quizzesGrid.innerHTML = '';
  
  if (quizzes.length === 0) {
    quizzesGrid.innerHTML = '<p class="text-muted">No quizzes found. Create one!</p>';
    return;
  }
  
  quizzes.forEach(quiz => {
    const card = document.createElement('div');
    card.className = 'quiz-card';
    const isSelected = selectedQuizzes.has(quiz.id);
    const durationMinutes = Math.round(quiz.duration / 60);
    
    // Sanitize user inputs to prevent XSS
    const sanitize = (text) => {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    };
    
    const title = sanitize(quiz.title || 'Untitled');
    const semester = quiz.semester ? sanitize(quiz.semester) : '';
    const session = quiz.session ? sanitize(quiz.session) : '';
    
    let detailsHtml = `<p>Duration: ${durationMinutes}m</p>`;
    if (semester) {
      detailsHtml += `<p><small>Semester: ${semester}</small></p>`;
    }
    if (session) {
      detailsHtml += `<p><small>Session: ${session}</small></p>`;
    }
    
    card.innerHTML = `
      <div style="display: flex; gap: 12px; align-items: flex-start; width: 100%;">
        ${isSelectModeDashboard ? `
          <input type="checkbox" ${isSelected ? 'checked' : ''} 
            onclick="event.stopPropagation(); window.toggleQuizSelection(${quiz.id})"
            style="width: 18px; height: 18px; cursor: pointer; margin-top: 4px;">
        ` : ''}
        <div style="flex: 1;">
          <h3>${title}</h3>
          ${detailsHtml}
          ${!isSelectModeDashboard ? `
            <div class="card-actions">
              <button class="btn btn-primary" onclick="openStartSessionModal(${quiz.id}, '${title.replace(/'/g, "\\'")}')">Start Session</button>
            </div>
          ` : ''}
        </div>
      </div>
    `;
    quizzesGrid.appendChild(card);
  });
}

async function deleteQuiz(id) {
  if (confirm('Are you sure?')) {
    await ipcRenderer.invoke('db:deleteQuiz', id);
    loadQuizzes();
  }
}

// Quiz Builder
function setupQuizBuilder() {
  const addBtn = document.getElementById('add-question-btn');
  const saveBtn = document.getElementById('save-quiz-btn');
  
  if (addBtn) addBtn.addEventListener('click', addQuestionUI);
  if (saveBtn) saveBtn.addEventListener('click', saveQuiz);
  
  // Add one default question
  addQuestionUI();
  
  // Ensure form inputs are interactive
  ensureFormInputsActive();
}

function addQuestionUI() {
  const container = document.getElementById('questions-container');
  if (!container) {
    console.error('Questions container not found');
    return;
  }
  
  const index = container.children.length;
  
  const qDiv = document.createElement('div');
  qDiv.className = 'question-item';
  qDiv.innerHTML = `
    <div class="form-group">
      <label>Question Text</label>
      <input type="text" class="q-text" placeholder="What is 2 + 2?" autocomplete="off">
    </div>
    <div class="options-grid">
      <div class="option-input">
        <input type="radio" name="correct-${index}" value="a" checked>
        <input type="text" class="q-opt-a" placeholder="Option A" autocomplete="off">
      </div>
      <div class="option-input">
        <input type="radio" name="correct-${index}" value="b">
        <input type="text" class="q-opt-b" placeholder="Option B" autocomplete="off">
      </div>
      <div class="option-input">
        <input type="radio" name="correct-${index}" value="c">
        <input type="text" class="q-opt-c" placeholder="Option C" autocomplete="off">
      </div>
      <div class="option-input">
        <input type="radio" name="correct-${index}" value="d">
        <input type="text" class="q-opt-d" placeholder="Option D" autocomplete="off">
      </div>
    </div>
  `;
  container.appendChild(qDiv);
  
  // Ensure newly added inputs are interactive
  ensureFormInputsActive();
}

// Helper function to ensure all form inputs are interactive
function ensureFormInputsActive() {
  const inputs = document.querySelectorAll('.question-item input[type="text"], #new-quiz-title, #new-quiz-duration, #new-quiz-semester, #new-quiz-session');
  inputs.forEach(input => {
    // Ensure inputs are not blocked by any overlay
    input.style.pointerEvents = 'auto';
    input.style.position = 'relative';
    input.style.zIndex = '1';
  });
}

async function saveQuiz() {
  const title = document.getElementById('new-quiz-title').value.trim();
  const durationMinutes = document.getElementById('new-quiz-duration').value;
  const semester = document.getElementById('new-quiz-semester').value.trim();
  const session = document.getElementById('new-quiz-session').value.trim();
  
  // Validation
  if (!title) {
    alert('Quiz title is required');
    return;
  }
  if (title.length > 200) {
    alert('Quiz title is too long (max 200 characters)');
    return;
  }
  if (!durationMinutes || parseInt(durationMinutes) < 1 || parseInt(durationMinutes) > 1440) {
    alert('Duration must be between 1 and 1440 minutes');
    return;
  }
  
  const items = document.querySelectorAll('.question-item');
  let hasValidQuestion = false;
  
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const text = item.querySelector('.q-text').value.trim();
    const opt_a = item.querySelector('.q-opt-a').value.trim();
    const opt_b = item.querySelector('.q-opt-b').value.trim();
    const opt_c = item.querySelector('.q-opt-c').value.trim();
    const opt_d = item.querySelector('.q-opt-d').value.trim();
    
    if (text) {
      // Validate question content
      if (text.length > 500) {
        alert(`Question ${i + 1} text is too long (max 500 characters)`);
        return;
      }
      if (!opt_a || !opt_b || !opt_c || !opt_d) {
        alert(`Question ${i + 1}: All options must be filled`);
        return;
      }
      const optionLength = Math.max(opt_a.length, opt_b.length, opt_c.length, opt_d.length);
      if (optionLength > 200) {
        alert(`Question ${i + 1}: Option text is too long (max 200 characters)`);
        return;
      }
      hasValidQuestion = true;
    }
  }
  
  if (!hasValidQuestion) {
    alert('Please add at least one valid question');
    return;
  }
  
  try {
    const quizId = await ipcRenderer.invoke(
      'db:createQuiz', 
      title, 
      parseInt(durationMinutes) * 60, 
      semester || null, 
      session || null
    );
    
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const text = item.querySelector('.q-text').value.trim();
      const opt_a = item.querySelector('.q-opt-a').value.trim();
      const opt_b = item.querySelector('.q-opt-b').value.trim();
      const opt_c = item.querySelector('.q-opt-c').value.trim();
      const opt_d = item.querySelector('.q-opt-d').value.trim();
      const correct_opt = item.querySelector(`input[name="correct-${i}"]:checked`).value;
      
      if (text) {
        await ipcRenderer.invoke(
          'db:addQuestion', 
          quizId, 
          text, 
          opt_a, 
          opt_b, 
          opt_c, 
          opt_d, 
          correct_opt
        );
      }
    }
    
    alert('Quiz saved successfully!');
    document.getElementById('new-quiz-title').value = '';
    document.getElementById('new-quiz-semester').value = '';
    document.getElementById('new-quiz-session').value = '';
    document.getElementById('new-quiz-duration').value = '5';
    document.getElementById('questions-container').innerHTML = '';
    addQuestionUI();
    loadQuizzes();
    window.switchView('dashboard');
  } catch (err) {
    console.error('Error saving quiz:', err);
    alert('Error saving quiz: ' + (err.message || 'Unknown error'));
  }
}

// Session Management
let pendingQuizId = null;

window.openStartSessionModal = function(quizId, title) {
  // Check if server is running
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    alert('Server is not running. Please click "Start Server" to begin.');
    return;
  }
  
  pendingQuizId = quizId;
  document.getElementById('modal-quiz-title').textContent = `Starting: ${title}`;
  document.getElementById('session-code-input').value = Math.floor(100000 + Math.random() * 900000).toString();
  document.getElementById('start-session-modal').classList.add('active');
}

window.closeModal = function() {
  document.getElementById('start-session-modal').classList.remove('active');
}

document.getElementById('confirm-start-btn').addEventListener('click', () => {
  const code = document.getElementById('session-code-input').value;
  currentSessionCode = code;
  ws.send(JSON.stringify({
    type: 'session:start',
    payload: { code, quizId: pendingQuizId }
  }));
  closeModal();
  window.switchView('live');
});

function updateLiveSessionUI(status, isNewSession = false) {
  const controls = document.getElementById('session-controls');
  const exportBtn = document.getElementById('export-csv-btn');
  
  if (status === 'active') {
    const joinToggleButton = isJoinsClosed 
      ? `<button class="btn btn-success" onclick="openJoins()">Open Joins</button>` 
      : `<button class="btn btn-secondary" onclick="closeJoins()">Close Joins</button>`;
    
    const quizButton = isQuizStarted 
      ? `<button class="btn btn-primary" disabled>Quiz Started</button>` 
      : `<button class="btn btn-primary" onclick="triggerQuizStart()">Start Quiz</button>`;
    
    const statusDot = isJoinsClosed 
      ? `<div class="status-dot" style="background: var(--secondary); box-shadow: none;"></div>` 
      : `<div class="status-dot"></div>`;
    
    const statusText = isJoinsClosed ? 'Joins Closed' : 'Joins Open';
    const statusColor = isJoinsClosed ? 'var(--text-muted)' : 'var(--success)';
    
    controls.innerHTML = `
      <div style="display: flex; gap: 16px; align-items: center;">
        <span style="color: ${statusColor}; font-weight: 600; display: flex; align-items: center; gap: 6px;">
          ${statusDot} ${statusText}
        </span>
        ${joinToggleButton}
        ${quizButton}
        <button class="btn btn-danger" onclick="stopSession()">Stop Session</button>
      </div>
    `;
    
    if (isNewSession) {
      document.getElementById('students-list').innerHTML = '';
      document.getElementById('submissions-body').innerHTML = '';
      document.getElementById('student-count').textContent = '0';
      isQuizStarted = false; // Reset quiz started state for new session
    }
    exportBtn.disabled = true;
  } else if (status === 'stopped') {
    controls.innerHTML = `<span style="color: var(--text-muted); font-weight: 600;">Session Completed</span>`;
    exportBtn.disabled = false;
  }
}

window.closeJoins = function() {
  if (!currentSessionId) return;
  ws.send(JSON.stringify({ type: 'session:close_joins' }));
}

window.openJoins = function() {
  if (!currentSessionId) return;
  ws.send(JSON.stringify({ type: 'session:open_joins' }));
}

window.stopSession = function() {
  if (!currentSessionId) return;
  ws.send(JSON.stringify({ type: 'session:stop', payload: { sessionId: currentSessionId } }));
  updateLiveSessionUI('stopped');
}

window.triggerQuizStart = function() {
  // Validate all required conditions
  if (!currentSessionId) {
    console.error('Start Quiz: No session ID');
    alert('No active session. Please start a session first.');
    return;
  }
  if (!currentSessionCode) {
    console.error('Start Quiz: No session code');
    alert('No session code. Please start a session first.');
    return;
  }
  if (isQuizStarted) {
    console.warn('Quiz already started');
    return;
  }
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.error('Start Quiz: WebSocket not connected', ws?.readyState);
    alert('Server connection lost. Please reconnect.');
    return;
  }
  
  try {
    ws.send(JSON.stringify({ type: 'session:trigger_start', payload: { code: currentSessionCode } }));
    isQuizStarted = true;
    updateLiveSessionUI('active'); // Refresh UI to show quiz started state
  } catch (err) {
    console.error('Error starting quiz:', err);
    alert('Failed to start quiz. ' + err.message);
    isQuizStarted = false;
  }
}

document.getElementById('export-csv-btn').addEventListener('click', async () => {
  if (!currentSessionId) return;
  const success = await ipcRenderer.invoke('export-csv', currentSessionId);
  if (success) {
    alert('CSV exported successfully!');
  }
});

// Real-time Updates
let studentCount = 0;
function handleStudentJoined(data) {
  const list = document.getElementById('students-list');
  const li = document.createElement('li');
  li.innerHTML = `<strong>${data.registrationNumber || 'N/A'}</strong> (${data.roll}) - ${data.name}${data.semester ? ` (${data.semester})` : ''}`;
  list.appendChild(li);
  
  studentCount++;
  document.getElementById('student-count').textContent = studentCount;
}

function updateAdminTimer(remainingSeconds) {
  const timerEl = document.getElementById('admin-timer');
  if (!timerEl) return;
  
  const m = Math.floor(remainingSeconds / 60).toString().padStart(2, '0');
  const s = (remainingSeconds % 60).toString().padStart(2, '0');
  timerEl.textContent = `${m}:${s}`;
  
  // Change color when time is low (like student client)
  if (remainingSeconds <= 60 && remainingSeconds > 0) {
    timerEl.style.color = 'var(--danger)';
  } else if (remainingSeconds === 0) {
    timerEl.style.color = 'var(--text-muted)';
  } else {
    timerEl.style.color = 'var(--text-primary)';
  }
}

function handleSubmission(sub) {
  const tbody = document.getElementById('submissions-body');
  const tr = document.createElement('tr');
  
  const statusClass = sub.timed_out ? 'status-timeout' : 'status-submitted';
  const statusText = sub.timed_out ? 'Timeout' : 'Submitted';
  
  tr.innerHTML = `
    <td>${sub.registration_number || 'N/A'}</td>
    <td>${sub.roll}</td>
    <td>${sub.name}</td>
    <td>${sub.semester || 'N/A'}</td>
    <td><strong>${sub.score}</strong></td>
    <td><span class="status-badge ${statusClass}">${statusText}</span></td>
  `;
  tbody.appendChild(tr);
}

// Start
init();
