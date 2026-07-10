const { ipcRenderer } = require('electron');

let serverIp = 'localhost';
let serverPort = 3000;
let ws = null;
let currentSessionId = null;
let currentQuizId = null;
let isJoinsClosed = false;
let isQuizStarted = false;
let showAnswersToStudents = false;
let showTeacherAnswers = false;

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
let allHistorySessions = [];
let deletedItems = [];
let isSelectModeRecycle = false;
let selectedRecycleItems = new Set();
let currentRecycleItem = null;

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

// Initialize server IP click handler
if (serverIpEl) {
  serverIpEl.addEventListener('click', async () => {
    // Only copy if server is running (text is not "Waiting..." or "Not Available")
    if (serverIpEl.textContent && serverIpEl.textContent !== 'Waiting...' && serverIpEl.textContent !== 'Not Available') {
      try {
        await navigator.clipboard.writeText(serverIpEl.textContent);
        const originalText = serverIpEl.textContent;
        serverIpEl.textContent = 'Copied!';
        setTimeout(() => {
          serverIpEl.textContent = originalText;
        }, 2000);
      } catch (err) {
        console.error('Failed to copy: ', err);
        alert('Failed to copy server info');
      }
    }
  });
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
  if (viewId === 'students') loadStudents();
  if (viewId === 'recycle') loadDeletedItems();
}

let allStudents = [];

async function loadStudents() {
  const container = document.getElementById('students-container');
  
  allStudents = await ipcRenderer.invoke('db:getAllStudents');
  
  if (allStudents.length === 0) {
    container.innerHTML = '<p class="text-muted">No students registered yet.</p>';
    return;
  }
  
  // Separate unverified and verified students
  const unverifiedStudents = allStudents.filter(s => !s.verified);
  const verifiedStudents = allStudents.filter(s => s.verified);
  
  // Group verified students by department + batch + session
  const grouped = {};
  verifiedStudents.forEach(student => {
    const key = `${student.department || 'Uncategorized'}-${student.batch || 'Uncategorized'}-${student.session_year || 'Uncategorized'}`;
    if (!grouped[key]) {
      grouped[key] = {
        dept: student.department || 'Uncategorized',
        batch: student.batch || 'Uncategorized',
        session: student.session_year || 'Uncategorized',
        students: []
      };
    }
    grouped[key].students.push(student);
  });
  
  // Sanitize helper
  const sanitize = (text) => {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  };
  
  let html = '';
  
  // Unverified students section
  if (unverifiedStudents.length > 0) {
    html += `
      <div style="margin-bottom: 24px;">
        <h2 style="margin-bottom: 16px; color: var(--danger);">Unverified Students (${unverifiedStudents.length})</h2>
        <div class="table-container">
          <table class="submissions-table">
            <thead>
              <tr>
                <th>Reg No</th>
                <th>Roll</th>
                <th>Name</th>
                <th>Semester</th>
                <th>Dept</th>
                <th>Batch</th>
                <th>Session</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              ${unverifiedStudents.sort((a,b) => a.full_name.localeCompare(b.full_name)).map(student => `
                <tr>
                  <td>${sanitize(student.registration_number || 'N/A')}</td>
                  <td>${sanitize(student.roll_number || 'N/A')}</td>
                  <td>${sanitize(student.full_name || 'N/A')}</td>
                  <td>${sanitize(student.semester || 'N/A')}</td>
                  <td>${sanitize(student.department || 'N/A')}</td>
                  <td>${sanitize(student.batch || 'N/A')}</td>
                  <td>${sanitize(student.session_year || 'N/A')}</td>
                  <td style="display: flex; gap: 8px;">
                    <button class="btn btn-success" onclick="window.verifyStudent(${student.id})" style="padding: 4px 8px;">Verify</button>
                    <button class="btn btn-danger" onclick="window.deleteStudent(${student.id})" style="padding: 4px 8px;">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="3 6 5 6 21 6"></polyline>
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                        <line x1="10" y1="11" x2="10" y2="17"></line>
                        <line x1="14" y1="11" x2="14" y2="17"></line>
                      </svg>
                    </button>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }
  
  // Verified groups section
  if (Object.keys(grouped).length > 0) {
    html += `
      <div>
        <h2 style="margin-bottom: 16px;">Verified Groups</h2>
        <div id="students-grid" class="quizzes-grid"></div>
      </div>
    `;
  }
  
  container.innerHTML = html;
  
  // Render verified groups
  if (Object.keys(grouped).length > 0) {
    const grid = document.getElementById('students-grid');
    Object.keys(grouped).sort().forEach(key => {
      const group = grouped[key];
      const card = document.createElement('div');
      card.className = 'quiz-card';
      
      card.innerHTML = `
        <div>
          <h3>${sanitize(group.dept)} - Batch ${sanitize(group.batch)}</h3>
          <p>Session: ${sanitize(group.session)}</p>
          <p>${group.students.length} student${group.students.length !== 1 ? 's' : ''}</p>
          <div class="card-actions">
            <button class="btn btn-primary" onclick="window.viewBatchStudents('${key}')">View Students</button>
          </div>
        </div>
      `;
      
      grid.appendChild(card);
    });
  }
}

window.viewBatchStudents = function(key) {
  const container = document.getElementById('students-container');
  const group = allStudents.reduce((acc, s) => {
    const sKey = `${s.department || 'Uncategorized'}-${s.batch || 'Uncategorized'}-${s.session_year || 'Uncategorized'}`;
    if (sKey === key) {
      acc.dept = s.department || 'Uncategorized';
      acc.batch = s.batch || 'Uncategorized';
      acc.session = s.session_year || 'Uncategorized';
      acc.students.push(s);
    }
    return acc;
  }, { dept: '', batch: '', session: '', students: [] });
  
  // Sanitize
  const sanitize = (text) => {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  };
  
  container.innerHTML = `
    <button class="btn btn-secondary" onclick="loadStudents()" style="margin-bottom: 16px;">
      ← Back to Batches
    </button>
    <h2 style="margin-bottom: 16px;">${sanitize(group.dept)} - Batch ${sanitize(group.batch)} (Session ${sanitize(group.session)})</h2>
    <div class="table-container">
      <table class="submissions-table">
        <thead>
          <tr>
            <th>Reg No</th>
            <th>Roll</th>
            <th>Name</th>
            <th>Semester</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${group.students.sort((a,b) => a.full_name.localeCompare(b.full_name)).map(student => `
            <tr>
              <td>${sanitize(student.registration_number || 'N/A')}</td>
              <td>${sanitize(student.roll_number || 'N/A')}</td>
              <td>${sanitize(student.full_name || 'N/A')}</td>
              <td>${sanitize(student.semester || 'N/A')}</td>
              <td>
                <button class="btn btn-danger" onclick="window.deleteStudent(${student.id})" style="padding: 4px 8px;">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="3 6 5 6 21 6"></polyline>
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                    <line x1="10" y1="11" x2="10" y2="17"></line>
                    <line x1="14" y1="11" x2="14" y2="17"></line>
                  </svg>
                </button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
};

window.verifyStudent = async function(id) {
  if (confirm('Are you sure you want to verify this student?')) {
    await ipcRenderer.invoke('db:verifyStudent', id);
    loadStudents();
  }
};

window.deleteStudent = async function(id) {
  if (confirm('Are you sure you want to delete this student?')) {
    await ipcRenderer.invoke('db:deleteStudent', id);
    loadStudents();
  }
};

// History functions
async function loadHistory() {
  const historyContainer = document.getElementById('history-container');
  const history = await ipcRenderer.invoke('db:getSessionsHistory');
  allHistorySessions = history;

  if (history.length === 0) {
    historyContainer.innerHTML = '<p class="text-muted">No quiz history found.</p>';
    updateHistorySelectAllButton(history);
    return;
  }

  historyContainer.innerHTML = '';
  
  history.forEach(session => {
    const card = document.createElement('div');
    card.className = 'quiz-card history-item';
    card.dataset.sessionId = session.id;
    const isSelected = selectedSessions.has(session.id);
    
    // Sanitize user inputs to prevent XSS
    const sanitize = (text) => {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    };
    
    const title = sanitize(session.title || 'Untitled');
    const semester = session.semester ? sanitize(session.semester) : '';
    const dateObj = new Date(session.created_at);
    const date = dateObj.toLocaleString('en-BD', { 
      timeZone: 'Asia/Dhaka',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    });
    
    if (isSelectModeHistory) {
      card.onclick = () => window.toggleSessionSelection(session.id);
    } else {
      card.onclick = () => card.classList.toggle('expanded');
    }
    
    // Create safe data attribute for session details
    card.dataset.sessionData = JSON.stringify(session);
    
    card.innerHTML = `
      <div style="display: flex; gap: 12px; align-items: flex-start; width: 100%;">
        ${isSelectModeHistory ? `
          <input type="checkbox" ${isSelected ? 'checked' : ''} 
            onclick="event.stopPropagation(); window.toggleSessionSelection(${session.id})"
            style="width: 18px; height: 18px; cursor: pointer; margin-top: 4px;">
        ` : ''}
        <div style="flex: 1; display: flex; justify-content: space-between; align-items: flex-start;">
          <div>
            <h3 style="margin: 0;">${title}${semester ? ` (${semester})` : ''}</h3>
            ${!isSelectModeHistory ? `
              <div class="history-item-actions">
                <button class="btn btn-secondary" onclick="event.stopPropagation(); window.viewSessionDetails(${session.id})">Details</button>
                <button class="btn btn-secondary" onclick="event.stopPropagation(); window.viewSessionResults(${session.id}, '${title.replace(/'/g, "\\'")}')">View Results</button>
                <button class="btn btn-secondary" onclick="event.stopPropagation(); window.openViewQuestionsModal(${session.quiz_id}, '${title.replace(/'/g, "\\'")}')">Questions</button>
                <button class="btn btn-secondary" onclick="event.stopPropagation(); window.exportSession(${session.id})">Export</button>
              </div>
            ` : ''}
          </div>
          <p style="color: var(--text-muted); font-size: 0.875rem; margin: 0; white-space: nowrap;">
            ${date}
          </p>
        </div>
      </div>
    `;
    historyContainer.appendChild(card);
  });

  // Update select all button text
  updateHistorySelectAllButton(history);
}

window.viewSessionDetails = function(sessionId) {
  const session = allHistorySessions.find(s => s.id === sessionId);
  if (!session) return;
  
  const modal = document.getElementById('session-details-modal');
  const body = document.getElementById('session-details-body');
  
  const dateObj = new Date(session.created_at);
  const date = dateObj.toLocaleString('en-BD', { 
    timeZone: 'Asia/Dhaka',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  });
  
  body.innerHTML = `
    <div style="display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid rgba(203, 166, 247, 0.12);">
      <span style="color: var(--text-muted);">ID:</span>
      <span style="color: var(--text-primary);">${session.id}</span>
    </div>
    <div style="display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid rgba(203, 166, 247, 0.12);">
      <span style="color: var(--text-muted);">Title:</span>
      <span style="color: var(--text-primary);">${session.title}</span>
    </div>
    <div style="display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid rgba(203, 166, 247, 0.12);">
      <span style="color: var(--text-muted);">Semester:</span>
      <span style="color: var(--text-primary);">${session.semester || 'N/A'}</span>
    </div>
    <div style="display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid rgba(203, 166, 247, 0.12);">
      <span style="color: var(--text-muted);">Date:</span>
      <span style="color: var(--text-primary);">${date}</span>
    </div>
    <div style="display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid rgba(203, 166, 247, 0.12);">
      <span style="color: var(--text-muted);">Submissions:</span>
      <span style="color: var(--text-primary);">${session.submission_count}</span>
    </div>
    <div style="display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid rgba(203, 166, 247, 0.12);">
      <span style="color: var(--text-muted);">Lowest Score:</span>
      <span style="color: var(--text-primary);">${session.lowest_score !== null ? session.lowest_score : 'N/A'}</span>
    </div>
    <div style="display: flex; justify-content: space-between; padding: 8px 0;">
      <span style="color: var(--text-muted);">Highest Score:</span>
      <span style="color: var(--text-primary);">${session.highest_score !== null ? session.highest_score : 'N/A'}</span>
    </div>
  `;
  
  modal.classList.add('active');
}

window.closeSessionDetailsModal = function() {
  document.getElementById('session-details-modal').classList.remove('active');
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
  let submissions = await ipcRenderer.invoke('db:getSubmissionsBySession', sessionId);
  const tbody = document.getElementById('view-results-body');
  tbody.innerHTML = '';
  
  if (submissions.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 20px;">No submissions found.</td></tr>';
  } else {
    // Sort submissions by score descending
    submissions.sort((a, b) => b.score - a.score);
    
    submissions.forEach((sub, index) => {
      const tr = document.createElement('tr');
      const statusClass = sub.timed_out ? 'status-timeout' : 'status-submitted';
      const statusText = sub.timed_out ? 'Timeout' : 'Submitted';
      const rank = index + 1;
      
      tr.innerHTML = `
        <td><strong>${rank}</strong></td>
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
  loadQuizzes();
};

window.toggleDashboardSelectAll = async function() {
  const allQuizzes = await ipcRenderer.invoke('db:getQuizzes');
  const allSelected = allQuizzes.every(quiz => selectedQuizzes.has(quiz.id));

  if (allSelected) {
    selectedQuizzes.clear();
  } else {
    selectedQuizzes = new Set(allQuizzes.map(quiz => quiz.id));
  }

  updateDashboardDeleteBtn();
  loadQuizzes();
};

function updateDashboardDeleteBtn() {
  const deleteBtn = document.getElementById('dashboard-delete-selected-btn');
  if (deleteBtn) {
    deleteBtn.style.display = selectedQuizzes.size > 0 ? 'flex' : 'none';
    deleteBtn.alignItems = 'center';
    deleteBtn.gap = '4px';
  }
}

function updateDashboardSelectAllButton() {
  const selectAllBtn = document.getElementById('dashboard-select-all-btn');
  if (!selectAllBtn) return;

  if (!isSelectModeDashboard) {
    selectAllBtn.style.display = 'none';
    return;
  }

  selectAllBtn.style.display = 'flex';
  selectAllBtn.style.alignItems = 'center';
  selectAllBtn.style.gap = '4px';
  
  const allSelected = quizzes.every(quiz => selectedQuizzes.has(quiz.id));
  selectAllBtn.textContent = allSelected ? 'Deselect All' : 'Select All';
}

function updateDashboardUI() {
  const selectBtn = document.getElementById('dashboard-select-btn');
  const deleteBtn = document.getElementById('dashboard-delete-selected-btn');
  const selectAllBtn = document.getElementById('dashboard-select-all-btn');
  const newQuizBtn = selectBtn?.parentElement?.querySelector('.btn-primary');

  if (isSelectModeDashboard) {
    selectBtn?.classList.add('btn-primary');
    selectBtn?.classList.remove('btn-secondary');
    if (newQuizBtn) newQuizBtn.style.display = 'none';
    if (selectAllBtn) selectAllBtn.style.display = 'flex';
  } else {
    selectBtn?.classList.remove('btn-primary');
    selectBtn?.classList.add('btn-secondary');
    if (newQuizBtn) newQuizBtn.style.display = 'flex';
    if (deleteBtn) deleteBtn.style.display = 'none';
    if (selectAllBtn) selectAllBtn.style.display = 'none';
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
  loadHistory();
};

window.toggleHistorySelectAll = async function() {
  const history = await ipcRenderer.invoke('db:getSessionsHistory');
  const allSelected = history.every(session => selectedSessions.has(session.id));

  if (allSelected) {
    selectedSessions.clear();
  } else {
    selectedSessions = new Set(history.map(session => session.id));
  }

  updateHistoryDeleteBtn();
  loadHistory();
};

function updateHistoryDeleteBtn() {
  const deleteBtn = document.getElementById('history-delete-selected-btn');
  if (deleteBtn) {
    deleteBtn.style.display = selectedSessions.size > 0 ? 'flex' : 'none';
    deleteBtn.alignItems = 'center';
    deleteBtn.gap = '4px';
  }
}

function updateHistorySelectAllButton(history) {
  const selectAllBtn = document.getElementById('history-select-all-btn');
  if (!selectAllBtn || !history) return;

  if (!isSelectModeHistory) {
    selectAllBtn.style.display = 'none';
    return;
  }

  selectAllBtn.style.display = 'flex';
  selectAllBtn.style.alignItems = 'center';
  selectAllBtn.style.gap = '4px';
  
  const allSelected = history.every(session => selectedSessions.has(session.id));
  selectAllBtn.textContent = allSelected ? 'Deselect All' : 'Select All';
}

function updateHistoryUI() {
  const selectBtn = document.getElementById('history-select-btn');
  const deleteBtn = document.getElementById('history-delete-selected-btn');
  const selectAllBtn = document.getElementById('history-select-all-btn');

  if (isSelectModeHistory) {
    selectBtn?.classList.add('btn-primary');
    selectBtn?.classList.remove('btn-secondary');
    if (selectAllBtn) selectAllBtn.style.display = 'flex';
  } else {
    selectBtn?.classList.remove('btn-primary');
    selectBtn?.classList.add('btn-secondary');
    if (deleteBtn) deleteBtn.style.display = 'none';
    if (selectAllBtn) selectAllBtn.style.display = 'none';
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
    updateDashboardSelectAllButton();
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
    
    if (isSelectModeDashboard) {
      card.onclick = () => window.toggleQuizSelection(quiz.id);
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
              <button class="btn btn-secondary" onclick="openViewQuestionsModal(${quiz.id}, '${title.replace(/'/g, "\\'")}')">View Questions</button>
              <button class="btn btn-primary" onclick="openStartSessionModal(${quiz.id}, '${title.replace(/'/g, "\\'")}')">Start Session</button>
            </div>
          ` : ''}
        </div>
      </div>
    `;
    quizzesGrid.appendChild(card);
  });
  
  updateDashboardSelectAllButton();
}

window.openViewQuestionsModal = async function(quizId, title) {
  document.getElementById('view-questions-title').textContent = title + ' - Questions';
  const body = document.getElementById('view-questions-body');
  
  const questions = await ipcRenderer.invoke('db:getQuestionsByQuiz', quizId);
  
  if (questions.length === 0) {
    body.innerHTML = '<p class="text-muted">No questions found for this quiz.</p>';
  } else {
    body.innerHTML = questions.map((q, i) => {
      const optLabels = { a: q.opt_a, b: q.opt_b, c: q.opt_c, d: q.opt_d };
      const correctLabel = optLabels[q.correct_opt];
      
      return `
        <div style="padding: 12px; border: 1px solid var(--panel-border); border-radius: 8px; margin-bottom: 12px;">
          <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px;">
            <h4 style="margin: 0;">${i + 1}. ${q.text}</h4>
            ${q.image ? `
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink: 0;">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                <circle cx="8.5" cy="8.5" r="1.5"></circle>
                <polyline points="21 15 16 10 5 21"></polyline>
              </svg>
            ` : ''}
          </div>
          ${q.image ? `<img src="${q.image}" style="max-width: 100%; max-height: 300px; border-radius: 8px; margin-bottom: 8px;">` : ''}
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 8px;">
            <div style="padding: 4px 8px; border-radius: 4px; background: ${q.correct_opt === 'a' ? 'var(--success-bg)' : 'var(--panel-bg)'};">A. ${q.opt_a}</div>
            <div style="padding: 4px 8px; border-radius: 4px; background: ${q.correct_opt === 'b' ? 'var(--success-bg)' : 'var(--panel-bg)'};">B. ${q.opt_b}</div>
            <div style="padding: 4px 8px; border-radius: 4px; background: ${q.correct_opt === 'c' ? 'var(--success-bg)' : 'var(--panel-bg)'};">C. ${q.opt_c}</div>
            <div style="padding: 4px 8px; border-radius: 4px; background: ${q.correct_opt === 'd' ? 'var(--success-bg)' : 'var(--panel-bg)'};">D. ${q.opt_d}</div>
          </div>
          <p style="margin: 0; font-weight: bold; color: var(--success);">Correct Answer: ${q.correct_opt.toUpperCase()}. ${correctLabel}</p>
        </div>
      `;
    }).join('');
  }
  
  document.getElementById('view-questions-modal').classList.add('active');
};

window.closeViewQuestionsModal = function() {
  document.getElementById('view-questions-modal').classList.remove('active');
};

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
    <div style="display: flex; align-items: flex-start; gap: 12px;">
      <div style="flex: 1;">
        <div class="form-group">
          <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 8px;">
            <label style="flex: 1;">Question Text</label>
            <div style="display: flex; gap: 6px;">
              <input type="file" class="q-image-input" accept="image/*" style="display: none;">
              <button type="button" class="btn btn-secondary" style="padding: 6px 8px; font-size: 12px; min-width: 32px; min-height: 32px; display: inline-flex; align-items: center; justify-content: center;" onclick="this.closest('.form-group').querySelector('.q-image-input').click()">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                  <circle cx="8.5" cy="8.5" r="1.5"></circle>
                  <polyline points="21 15 16 10 5 21"></polyline>
                </svg>
              </button>
              <button class="btn btn-danger" style="padding: 6px 8px; font-size: 12px; min-width: 32px; min-height: 32px; display: inline-flex; align-items: center; justify-content: center;" onclick="window.deleteQuestion(this)">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="3 6 5 6 21 6"></polyline>
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                  <line x1="10" y1="11" x2="10" y2="17"></line>
                  <line x1="14" y1="11" x2="14" y2="17"></line>
                </svg>
              </button>
            </div>
          </div>
          <input type="text" class="q-text" placeholder="What is 2 + 2?" autocomplete="off">
          <div class="q-image-preview" style="margin-top: 8px;"></div>
        </div>
        <div class="options-grid">
          <div class="option-input" onclick="this.querySelector('input[type=radio]').checked = true;">
            <input type="radio" name="correct-${index}" value="a" checked>
            <input type="text" class="q-opt-a" placeholder="Option A" autocomplete="off" onclick="event.stopPropagation();">
          </div>
          <div class="option-input" onclick="this.querySelector('input[type=radio]').checked = true;">
            <input type="radio" name="correct-${index}" value="b">
            <input type="text" class="q-opt-b" placeholder="Option B" autocomplete="off" onclick="event.stopPropagation();">
          </div>
          <div class="option-input" onclick="this.querySelector('input[type=radio]').checked = true;">
            <input type="radio" name="correct-${index}" value="c">
            <input type="text" class="q-opt-c" placeholder="Option C" autocomplete="off" onclick="event.stopPropagation();">
          </div>
          <div class="option-input" onclick="this.querySelector('input[type=radio]').checked = true;">
            <input type="radio" name="correct-${index}" value="d">
            <input type="text" class="q-opt-d" placeholder="Option D" autocomplete="off" onclick="event.stopPropagation();">
          </div>
        </div>
      </div>
    </div>
  `;
  container.appendChild(qDiv);
  
  // Add event listener to image input
  const imageInput = qDiv.querySelector('.q-image-input');
  const imagePreview = qDiv.querySelector('.q-image-preview');
  imageInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        const base64 = event.target.result;
        imagePreview.innerHTML = `
          <div style="display: flex; align-items: center; gap: 8px;">
            <img src="${base64}" style="max-width: 200px; max-height: 150px; border-radius: 8px;">
            <button type="button" class="btn btn-secondary" style="padding: 4px 8px; font-size: 12px;" onclick="this.closest('.q-image-preview').innerHTML = ''; this.closest('.question-item').querySelector('.q-image-input').value = '';">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle;">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>
        `;
        // Store base64 in a data attribute for easy access
        imagePreview.dataset.base64 = base64;
      };
      reader.readAsDataURL(file);
    }
  });
  
  // Ensure newly added inputs are interactive
  ensureFormInputsActive();
}

window.deleteQuestion = function(btn) {
  const questionItem = btn.closest('.question-item');
  if (questionItem) {
    questionItem.remove();
    reindexQuestions();
  }
};



function reindexQuestions() {
  const container = document.getElementById('questions-container');
  if (!container) return;
  const questionItems = container.querySelectorAll('.question-item');
  questionItems.forEach((item, index) => {
    const radios = item.querySelectorAll('input[type="radio"]');
    radios.forEach(radio => {
      radio.name = `correct-${index}`;
    });
  });
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
      const imagePreview = item.querySelector('.q-image-preview');
      const image = imagePreview && imagePreview.dataset.base64 ? imagePreview.dataset.base64 : null;
      
      if (text) {
        await ipcRenderer.invoke(
          'db:addQuestion', 
          quizId, 
          text, 
          opt_a, 
          opt_b, 
          opt_c, 
          opt_d, 
          correct_opt,
          image
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
  currentQuizId = quizId;
  document.getElementById('modal-quiz-title').textContent = `Starting: ${title}`;
  document.getElementById('start-session-modal').classList.add('active');
}

async function loadLiveQuestionsAndAnswers() {
  if (!currentQuizId) return;
  
  const questions = await ipcRenderer.invoke('db:getQuestionsByQuiz', currentQuizId);
  const container = document.getElementById('live-questions-container');
  
  if (questions.length === 0) {
    container.innerHTML = '<p class="text-muted">No questions found.</p>';
  } else {
    container.innerHTML = questions.map((q, i) => {
      return `
        <div style="padding: 12px; border: 1px solid var(--panel-border); border-radius: 8px; margin-bottom: 12px;">
          <h4 style="margin: 0 0 8px 0;">${i + 1}. ${q.text}</h4>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 8px;">
            <div style="padding: 4px 8px; border-radius: 4px; background: ${q.correct_opt === 'a' ? 'var(--success-bg)' : 'var(--panel-bg)'};">A. ${q.opt_a}</div>
            <div style="padding: 4px 8px; border-radius: 4px; background: ${q.correct_opt === 'b' ? 'var(--success-bg)' : 'var(--panel-bg)'};">B. ${q.opt_b}</div>
            <div style="padding: 4px 8px; border-radius: 4px; background: ${q.correct_opt === 'c' ? 'var(--success-bg)' : 'var(--panel-bg)'};">C. ${q.opt_c}</div>
            <div style="padding: 4px 8px; border-radius: 4px; background: ${q.correct_opt === 'd' ? 'var(--success-bg)' : 'var(--panel-bg)'};">D. ${q.opt_d}</div>
          </div>
          <p style="margin: 0; font-weight: bold; color: var(--success);">Correct Answer: ${q.correct_opt.toUpperCase()}</p>
        </div>
      `;
    }).join('');
  }
  
  // Show answers panel, hide submissions panel
  document.getElementById('live-submissions-panel').style.display = 'none';
  document.getElementById('live-answers-panel').style.display = 'flex';
  document.getElementById('live-answers-panel').style.flexDirection = 'column';
}

window.closeModal = function() {
  document.getElementById('start-session-modal').classList.remove('active');
}

document.getElementById('confirm-start-btn').addEventListener('click', () => {
  ws.send(JSON.stringify({
    type: 'session:start',
    payload: { quizId: pendingQuizId }
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
      showAnswersToStudents = false; // Reset show answers state for new session
      showTeacherAnswers = false;
      
      // Reset panels
      const studentsPanel = document.querySelector('.students-panel');
      studentsPanel.style.display = 'flex';
      studentsPanel.style.flexDirection = 'column';
      document.getElementById('live-submissions-panel').style.display = 'flex';
      document.getElementById('live-submissions-panel').style.flexDirection = 'column';
      document.getElementById('live-answers-panel').style.display = 'none';
    }
    exportBtn.disabled = true;
  } else if (status === 'stopped') {
    const showAnswersBtnClass = showAnswersToStudents ? 'btn-success' : 'btn-secondary';
    const showAnswersBtnText = showAnswersToStudents ? 'Hide Answers from Students' : 'Show Answers to Students';
    const viewAnswersBtnText = showTeacherAnswers ? 'Hide Questions and Answers' : 'View Questions and Answers';
    controls.innerHTML = `
      <div style="display: flex; gap: 16px; align-items: center;">
        <span style="color: var(--text-muted); font-weight: 600;">Session Completed</span>
        <button class="btn btn-secondary" onclick="window.toggleTeacherAnswers()">${viewAnswersBtnText}</button>
        <button class="btn ${showAnswersBtnClass}" onclick="window.toggleShowAnswersToStudents()">${showAnswersBtnText}</button>
      </div>
    `;
    exportBtn.disabled = false;
  }
}

window.toggleShowAnswersToStudents = async function() {
  if (!currentSessionId) return;
  
  showAnswersToStudents = !showAnswersToStudents;
  await ipcRenderer.invoke('db:toggleShowAnswers', currentSessionId);
  
  // Send WebSocket message to server
  ws.send(JSON.stringify({ 
    type: 'session:toggle_show_answers', 
    payload: { sessionId: currentSessionId, showAnswers: showAnswersToStudents } 
  }));
  
  updateLiveSessionUI('stopped');
}

window.toggleTeacherAnswers = async function() {
  showTeacherAnswers = !showTeacherAnswers;
  const studentsPanel = document.querySelector('.students-panel');
  
  if (showTeacherAnswers) {
    await loadLiveQuestionsAndAnswers();
    studentsPanel.style.display = 'none';
    document.getElementById('live-submissions-panel').style.display = 'none';
    document.getElementById('live-answers-panel').style.display = 'flex';
    document.getElementById('live-answers-panel').style.flexDirection = 'column';
  } else {
    studentsPanel.style.display = 'flex';
    studentsPanel.style.flexDirection = 'column';
    document.getElementById('live-answers-panel').style.display = 'none';
    document.getElementById('live-submissions-panel').style.display = 'flex';
    document.getElementById('live-submissions-panel').style.flexDirection = 'column';
  }
  
  updateLiveSessionUI('stopped');
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
    ws.send(JSON.stringify({ type: 'session:trigger_start', payload: {} }));
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

// Recycle Bin
async function loadDeletedItems() {
  const container = document.getElementById('recycle-container');
  
  deletedItems = await ipcRenderer.invoke('db:getDeletedItems');
  
  if (deletedItems.length === 0) {
    container.innerHTML = '<p class="text-muted" style="text-align: center; padding: 40px;">Recycle bin is empty</p>';
    return;
  }
  
  container.innerHTML = deletedItems.map((item, index) => {
    let title, subtitle, typeIcon;
    
    if (item.type === 'quiz') {
      title = item.title;
      subtitle = `Duration: ${Math.floor(item.duration / 60)} min${item.semester ? ` • ${item.semester}` : ''}${item.session ? ` • ${item.session}` : ''}`;
      typeIcon = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"></polygon><polyline points="2 17 12 22 22 17"></polyline><polyline points="2 12 12 17 22 12"></polyline></svg>`;
    } else { // student
      title = item.full_name || item.name || 'Unknown';
      subtitle = `${item.registration_number} • ${item.roll_number} • ${item.department} • ${item.batch}`;
      typeIcon = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>`;
    }
    
    const isSelected = selectedRecycleItems.has(item.id);
    
    return `
      <div class="quiz-card ${isSelectModeRecycle ? 'selectable' : ''} ${isSelected ? 'selected' : ''}" onclick="window.handleRecycleItemClick(${item.id}, '${item.type}', event)" style="position: relative;">
        ${isSelectModeRecycle ? `
          <div class="quiz-checkbox ${isSelected ? 'checked' : ''}">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
          </div>
        ` : ''}
        <div style="display: flex; align-items: center; gap: 12px;">
          ${typeIcon}
          <div style="flex: 1; min-width: 0;">
            <h3 style="margin: 0 0 4px 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${title}</h3>
            <p style="margin: 0; color: var(--text-muted); font-size: 0.875rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${subtitle}</p>
          </div>
          ${!isSelectModeRecycle ? `
            <div style="display: flex; gap: 8px;">
              <button class="btn btn-primary" style="padding: 6px 12px;" onclick="event.stopPropagation(); window.restoreItem(${item.id}, '${item.type}')">Restore</button>
              <button class="btn btn-danger" style="padding: 6px 12px;" onclick="event.stopPropagation(); window.permanentDeleteItem(${item.id}, '${item.type}')">Delete Permanently</button>
            </div>
          ` : ''}
        </div>
      </div>
    `;
  }).join('');
  
  updateRecycleSelectAllButton();
}

window.handleRecycleItemClick = function(id, type, event) {
  if (isSelectModeRecycle) {
    if (selectedRecycleItems.has(id)) {
      selectedRecycleItems.delete(id);
    } else {
      selectedRecycleItems.add(id);
    }
    loadDeletedItems();
  } else {
    openRecycleDetailsModal(id, type);
  }
}

window.openRecycleDetailsModal = async function(id, type) {
  const modal = document.getElementById('recycle-details-modal');
  const titleEl = document.getElementById('recycle-details-title');
  const bodyEl = document.getElementById('recycle-details-body');
  const restoreBtn = document.getElementById('recycle-details-restore-btn');
  const deleteBtn = document.getElementById('recycle-details-delete-btn');
  
  const item = deletedItems.find(i => i.id === id && i.type === type);
  if (!item) return;
  
  currentRecycleItem = item;
  
  if (type === 'quiz') {
    titleEl.textContent = item.title;
    // Fetch questions for the quiz to show in details
    const questions = await ipcRenderer.invoke('db:getQuestionsByQuiz', id);
    bodyEl.innerHTML = `
      <div style="padding: 12px; background: var(--panel-bg); border-radius: 8px;">
        <p style="margin: 0 0 8px 0; font-weight: 500;">Duration: ${Math.floor(item.duration / 60)} minutes</p>
        ${item.semester ? `<p style="margin: 0 0 8px 0;">Semester: ${item.semester}</p>` : ''}
        ${item.session ? `<p style="margin: 0 0 8px 0;">Session: ${item.session}</p>` : ''}
        <p style="margin: 0;">Number of questions: ${questions.length}</p>
      </div>
      ${questions.length > 0 ? `
        <h3 style="margin: 16px 0 8px 0;">Questions</h3>
        <div style="display: flex; flex-direction: column; gap: 12px;">
          ${questions.map((q, i) => `
            <div style="padding: 12px; border: 1px solid var(--panel-border); border-radius: 8px;">
              <h4 style="margin: 0 0 8px 0;">${i + 1}. ${q.text}</h4>
              ${q.image ? `<img src="${q.image}" style="max-width: 100%; max-height: 200px; border-radius: 8px; margin-bottom: 8px;" />` : ''}
              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 8px;">
                <div style="padding: 4px 8px; border-radius: 4px; background: ${q.correct_opt === 'a' ? 'var(--success-bg)' : 'var(--panel-bg)'};">A. ${q.opt_a}</div>
                <div style="padding: 4px 8px; border-radius: 4px; background: ${q.correct_opt === 'b' ? 'var(--success-bg)' : 'var(--panel-bg)'};">B. ${q.opt_b}</div>
                <div style="padding: 4px 8px; border-radius: 4px; background: ${q.correct_opt === 'c' ? 'var(--success-bg)' : 'var(--panel-bg)'};">C. ${q.opt_c}</div>
                <div style="padding: 4px 8px; border-radius: 4px; background: ${q.correct_opt === 'd' ? 'var(--success-bg)' : 'var(--panel-bg)'};">D. ${q.opt_d}</div>
              </div>
              <p style="margin: 0; font-weight: 500; color: var(--success);">Correct Answer: ${q.correct_opt.toUpperCase()}</p>
            </div>
          `).join('')}
        </div>
      ` : ''}
    `;
  } else { // student
    titleEl.textContent = item.full_name || item.name || 'Unknown';
    bodyEl.innerHTML = `
      <div style="padding: 12px; background: var(--panel-bg); border-radius: 8px; display: flex; flex-direction: column; gap: 8px;">
        <p style="margin: 0;"><strong>Registration Number:</strong> ${item.registration_number}</p>
        <p style="margin: 0;"><strong>Roll Number:</strong> ${item.roll_number}</p>
        <p style="margin: 0;"><strong>Department:</strong> ${item.department}</p>
        <p style="margin: 0;"><strong>Batch:</strong> ${item.batch}</p>
        <p style="margin: 0;"><strong>Session:</strong> ${item.session_year}</p>
        <p style="margin: 0;"><strong>Semester:</strong> ${item.semester}</p>
        <p style="margin: 0;"><strong>Verified:</strong> ${item.verified ? 'Yes' : 'No'}</p>
      </div>
    `;
  }
  
  // Set button click handlers
  restoreBtn.onclick = async () => {
    await window.restoreItem(id, type);
    closeRecycleDetailsModal();
  };
  
  deleteBtn.onclick = async () => {
    await window.permanentDeleteItem(id, type);
    closeRecycleDetailsModal();
  };
  
  modal.classList.add('active');
}

window.closeRecycleDetailsModal = function() {
  document.getElementById('recycle-details-modal').classList.remove('active');
  currentRecycleItem = null;
}

window.toggleRecycleSelectMode = function() {
  isSelectModeRecycle = !isSelectModeRecycle;
  selectedRecycleItems.clear();
  loadDeletedItems();
  
  const selectBtn = document.getElementById('recycle-select-btn');
  const selectAllBtn = document.getElementById('recycle-select-all-btn');
  const restoreBtn = document.getElementById('recycle-restore-selected-btn');
  const deleteBtn = document.getElementById('recycle-permanent-delete-selected-btn');
  
  if (isSelectModeRecycle) {
    selectBtn.classList.add('active');
    selectAllBtn.style.display = 'inline-flex';
    restoreBtn.style.display = 'inline-flex';
    deleteBtn.style.display = 'inline-flex';
  } else {
    selectBtn.classList.remove('active');
    selectAllBtn.style.display = 'none';
    restoreBtn.style.display = 'none';
    deleteBtn.style.display = 'none';
  }
}

window.toggleRecycleSelectAll = function() {
  const allIds = deletedItems.map(item => item.id);
  const allSelected = allIds.every(id => selectedRecycleItems.has(id));
  
  if (allSelected) {
    selectedRecycleItems.clear();
  } else {
    allIds.forEach(id => selectedRecycleItems.add(id));
  }
  
  loadDeletedItems();
}

function updateRecycleSelectAllButton() {
  const btn = document.getElementById('recycle-select-all-btn');
  if (!btn) return;
  
  const allIds = deletedItems.map(item => item.id);
  const allSelected = allIds.length > 0 && allIds.every(id => selectedRecycleItems.has(id));
  
  btn.textContent = allSelected ? 'Deselect All' : 'Select All';
}

window.restoreItem = async function(id, type) {
  try {
    if (type === 'quiz') {
      await ipcRenderer.invoke('db:restoreQuiz', id);
    } else {
      await ipcRenderer.invoke('db:restoreStudent', id);
    }
    
    loadDeletedItems();
  } catch (err) {
    console.error('Error restoring item:', err);
    alert('Error restoring item');
  }
}

window.permanentDeleteItem = async function(id, type) {
  if (!confirm('Are you sure you want to delete this permanently? This cannot be undone.')) return;
  
  try {
    if (type === 'quiz') {
      await ipcRenderer.invoke('db:permanentDeleteQuiz', id);
    } else {
      await ipcRenderer.invoke('db:permanentDeleteStudent', id);
    }
    
    loadDeletedItems();
  } catch (err) {
    console.error('Error deleting item:', err);
    alert('Error deleting item');
  }
}

window.restoreSelectedItems = async function() {
  if (selectedRecycleItems.size === 0) return;
  
  try {
    const quizIds = Array.from(selectedRecycleItems).filter(id => deletedItems.find(item => item.id === id && item.type === 'quiz')).map(Number);
    const studentIds = Array.from(selectedRecycleItems).filter(id => deletedItems.find(item => item.id === id && item.type === 'student')).map(Number);
    
    if (quizIds.length > 0) {
      await ipcRenderer.invoke('db:restoreQuizzes', quizIds);
    }
    
    for (const id of studentIds) {
      await ipcRenderer.invoke('db:restoreStudent', id);
    }
    
    selectedRecycleItems.clear();
    isSelectModeRecycle = false;
    loadDeletedItems();
    
    const selectBtn = document.getElementById('recycle-select-btn');
    const selectAllBtn = document.getElementById('recycle-select-all-btn');
    const restoreBtn = document.getElementById('recycle-restore-selected-btn');
    const deleteBtn = document.getElementById('recycle-permanent-delete-selected-btn');
    
    selectBtn.classList.remove('active');
    selectAllBtn.style.display = 'none';
    restoreBtn.style.display = 'none';
    deleteBtn.style.display = 'none';
  } catch (err) {
    console.error('Error restoring items:', err);
    alert('Error restoring items');
  }
}

window.permanentDeleteSelectedItems = async function() {
  if (selectedRecycleItems.size === 0) return;
  if (!confirm('Are you sure you want to permanently delete these items? This cannot be undone.')) return;
  
  try {
    const quizIds = Array.from(selectedRecycleItems).filter(id => deletedItems.find(item => item.id === id && item.type === 'quiz')).map(Number);
    const studentIds = Array.from(selectedRecycleItems).filter(id => deletedItems.find(item => item.id === id && item.type === 'student')).map(Number);
    
    if (quizIds.length > 0) {
      await ipcRenderer.invoke('db:permanentDeleteQuizzes', quizIds);
    }
    
    for (const id of studentIds) {
      await ipcRenderer.invoke('db:permanentDeleteStudent', id);
    }
    
    selectedRecycleItems.clear();
    isSelectModeRecycle = false;
    loadDeletedItems();
    
    const selectBtn = document.getElementById('recycle-select-btn');
    const selectAllBtn = document.getElementById('recycle-select-all-btn');
    const restoreBtn = document.getElementById('recycle-restore-selected-btn');
    const deleteBtn = document.getElementById('recycle-permanent-delete-selected-btn');
    
    selectBtn.classList.remove('active');
    selectAllBtn.style.display = 'none';
    restoreBtn.style.display = 'none';
    deleteBtn.style.display = 'none';
  } catch (err) {
    console.error('Error deleting items:', err);
    alert('Error deleting items');
  }
}

// Update deleteQuiz and deleteStudent to use soft delete
async function deleteQuiz(id) {
  if (!confirm('Are you sure you want to delete this quiz?')) return;
  await ipcRenderer.invoke('db:deleteQuiz', id);
  loadQuizzes();
}

// Update deleteSelectedQuizzes
window.deleteSelectedQuizzes = async function() {
  if (selectedQuizzes.size === 0) return;
  if (!confirm('Are you sure you want to delete these quizzes?')) return;
  
  const ids = Array.from(selectedQuizzes).map(Number);
  await ipcRenderer.invoke('db:deleteQuizzes', ids);
  
  selectedQuizzes.clear();
  isSelectModeDashboard = false;
  document.getElementById('dashboard-select-btn').classList.remove('active');
  document.getElementById('dashboard-select-all-btn').style.display = 'none';
  document.getElementById('dashboard-delete-selected-btn').style.display = 'none';
  
  loadQuizzes();
}

// Start
init();
