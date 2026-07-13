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
let connectedStudents = [];

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
  
  // Add CSV import event listener
  const csvInput = document.getElementById('student-csv-input');
  if (csvInput) {
    csvInput.addEventListener('change', (e) => {
      if (e.target.files.length > 0) {
        importStudentsCSV(e.target.files[0]);
        e.target.value = '';
      }
    });
  }
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
  if (viewId === 'connected-students') {
    // Sort connected students by Class Roll ascending before rendering
    const sortedStudents = [...connectedStudents].sort((a, b) => {
      const rollA = isNaN(parseInt(a.roll)) ? a.roll : parseInt(a.roll);
      const rollB = isNaN(parseInt(b.roll)) ? b.roll : parseInt(b.roll);
      if (typeof rollA === 'number' && typeof rollB === 'number') {
        return rollA - rollB;
      }
      return String(rollA).localeCompare(String(rollB));
    });
    
    // Render connected students table when switching to view
    const list = document.getElementById('connected-students-list');
    list.innerHTML = sortedStudents.map((student, index) => 
      `<tr>
        <td>${index + 1}</td>
        <td>${student.registrationNumber || 'N/A'}</td>
        <td>${student.roll}</td>
        <td>${student.name}</td>
        <td>${student.semester || 'N/A'}</td>
        <td>${student.batch || 'N/A'}</td>
      </tr>`
    ).join('');
  }
}

let allStudents = [];

// Custom in-page dialogs.
// Native alert()/confirm() can steal focus from the BrowserWindow in Electron,
// leaving the window unresponsive (clicks/keystrokes ignored) afterwards.
// These custom modals avoid that problem.
function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function openDialog({ title = '', message = '', okText = 'OK', cancelText = null } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal';
    overlay.style.zIndex = '2000';
    overlay.innerHTML = `
      <div class="modal-content glass-panel">
        ${title ? `<h2>${escapeHtml(title)}</h2>` : ''}
        <p style="margin: 8px 0 20px; line-height: 1.5;">${escapeHtml(message)}</p>
        <div class="modal-actions" style="justify-content: flex-end;">
          ${cancelText ? `<button type="button" class="btn btn-secondary" data-act="cancel">${escapeHtml(cancelText)}</button>` : ''}
          <button type="button" class="btn btn-primary" data-act="ok">${escapeHtml(okText)}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('active'));

    const close = (value) => {
      overlay.classList.remove('active');
      setTimeout(() => overlay.remove(), 150);
      resolve(value);
    };

    overlay.querySelector('[data-act="ok"]').addEventListener('click', () => close(cancelText ? true : undefined));
    const cancelBtn = overlay.querySelector('[data-act="cancel"]');
    if (cancelBtn) cancelBtn.addEventListener('click', () => close(false));
  });
}

window.showAlert = (message) => openDialog({ message, okText: 'OK' });
window.showConfirm = (message) => openDialog({ message, okText: 'Yes', cancelText: 'Cancel' });

async function loadStudents() {
  const container = document.getElementById('students-container');
  
  allStudents = await ipcRenderer.invoke('db:getAllStudents');
  
  // Sanitize helper
  const sanitize = (text) => {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  };
  
  let html = `
    <header>
      <h1>Registered Students</h1>
      <div style="display: flex; gap: 8px;">
        <button class="btn btn-primary" id="import-csv-btn" onclick="document.getElementById('student-csv-input').click()">
          Import CSV
        </button>
      </div>
    </header>
  `;
  
  if (allStudents.length === 0) {
    html += '<p class="text-muted">No students registered yet.</p>';
    container.innerHTML = html;
    return;
  }
  
  // Group all students by department + batch + session
  const grouped = {};
  allStudents.forEach(student => {
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
  
  // Groups section
  if (Object.keys(grouped).length > 0) {
    html += `
      <div>
        <h2 style="margin-bottom: 16px;">Student Groups</h2>
        <div id="students-grid" class="quizzes-grid"></div>
      </div>
    `;
  }
  
  container.innerHTML = html;
  
  // Render groups
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
            <button class="btn btn-danger" onclick="window.deleteStudentsByGroup('${sanitize(group.dept)}', '${sanitize(group.batch)}', '${sanitize(group.session)}')">Delete Group</button>
          </div>
        </div>
      `;
      
      grid.appendChild(card);
    });
  }
}

// CSV Parser function
function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length === 0) return [];
  
  // Parse headers (keep original case for matching later)
  const headers = parseCSVLine(lines[0]).map(h => h.trim());
  const data = [];
  
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    const values = parseCSVLine(lines[i]);
    const row = {};
    headers.forEach((header, index) => {
      row[header] = values[index] || '';
    });
    data.push(row);
  }
  
  return data;
}

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);
  
  return result;
}

let currentCSVData = [];
let currentCSVHeaders = [];

// CSV Import function - open preview modal
async function importStudentsCSV(file) {
  const reader = new FileReader();
  
  reader.onload = async (e) => {
    try {
      const csvText = e.target.result;
      const lines = csvText.trim().split(/\r?\n/);
      currentCSVHeaders = parseCSVLine(lines[0]).map(h => h.trim());
      currentCSVData = parseCSV(csvText);
      
      if (currentCSVData.length === 0) {
        alert('No data found in CSV file!');
        return;
      }
      
      openCSVPreviewModal();
    } catch (err) {
      console.error('Import error:', err);
      alert('Failed to import students: ' + err.message);
    }
  };
  
  reader.onerror = () => {
    alert('Failed to read file!');
  };
  
  reader.readAsText(file);
}

// Helper to match column name with patterns
function findMatchingColumn(headers, patterns) {
  const normalizedHeaders = headers.map(h => h.toLowerCase().trim());
  
  for (const pattern of patterns) {
    const index = normalizedHeaders.findIndex(h => 
      h.includes(pattern.toLowerCase()) || 
      h === pattern.toLowerCase()
    );
    if (index !== -1) return headers[index];
  }
  return '--- Use Default ---';
}

let currentCSVStep = 1;

// Go to next step
function goToNextCSVStep() {
  // Validate current step
  if (currentCSVStep === 1) {
    // Validate step 1: all dropdowns have a value
    const regVal = document.getElementById('csv-map-reg').value;
    const rollVal = document.getElementById('csv-map-roll').value;
    const nameVal = document.getElementById('csv-map-name').value;
    if (!regVal || !rollVal || !nameVal) {
      alert('Please map all columns!');
      return;
    }
  } else if (currentCSVStep === 2) {
    // Validate step 2: all input fields are filled
    const semester = document.getElementById('csv-input-semester').value.trim();
    const session = document.getElementById('csv-input-session').value.trim();
    const dept = document.getElementById('csv-input-dept').value.trim();
    const batch = document.getElementById('csv-input-batch').value.trim();
    if (!semester || !session || !dept || !batch) {
      alert('Please fill in all batch info fields!');
      return;
    }
    // Render preview before going to step 3
    renderCSVPreviewTable();
  }
  
  // Go to next step
  if (currentCSVStep < 3) {
    document.getElementById(`csv-step-${currentCSVStep}`).style.display = 'none';
    currentCSVStep++;
    document.getElementById(`csv-step-${currentCSVStep}`).style.display = 'block';
    updateCSVModalButtons();
  }
}

// Go to previous step
function goToPrevCSVStep() {
  if (currentCSVStep > 1) {
    document.getElementById(`csv-step-${currentCSVStep}`).style.display = 'none';
    currentCSVStep--;
    document.getElementById(`csv-step-${currentCSVStep}`).style.display = 'block';
    updateCSVModalButtons();
  }
}

// Update modal button visibility
function updateCSVModalButtons() {
  const cancelBtn = document.getElementById('csv-cancel-btn');
  const backBtn = document.getElementById('csv-back-btn');
  const nextBtn = document.getElementById('csv-next-btn');
  const importBtn = document.getElementById('csv-import-btn');
  
  backBtn.style.display = currentCSVStep > 1 ? 'inline-block' : 'none';
  nextBtn.style.display = currentCSVStep < 3 ? 'inline-block' : 'none';
  importBtn.style.display = currentCSVStep === 3 ? 'inline-block' : 'none';
}

// Open Preview Modal
function openCSVPreviewModal() {
  const modal = document.getElementById('csv-preview-modal');
  currentCSVStep = 1;
  
  // Reset all steps
  document.getElementById('csv-step-1').style.display = 'block';
  document.getElementById('csv-step-2').style.display = 'none';
  document.getElementById('csv-step-3').style.display = 'none';
  updateCSVModalButtons();
  
  // Get dropdown elements
  const dropdowns = {
    reg: document.getElementById('csv-map-reg'),
    roll: document.getElementById('csv-map-roll'),
    name: document.getElementById('csv-map-name')
  };
  
  // Populate options
  Object.values(dropdowns).forEach(dropdown => {
    dropdown.innerHTML = currentCSVHeaders.map(opt => `<option value="${opt}">${opt}</option>`).join('');
  });
  
  // Auto-detect columns (especially for user's exact column names!)
  dropdowns.reg.value = findMatchingColumn(currentCSVHeaders, ['Reg No', 'Registration', 'Reg No.', 'reg no', 'registration_number', 'registration']);
  dropdowns.roll.value = findMatchingColumn(currentCSVHeaders, ['Class roll', 'Roll', 'Roll No', 'roll', 'class roll', 'roll_number']);
  dropdowns.name.value = findMatchingColumn(currentCSVHeaders, ['Name of Students', 'Student Name', 'Name', 'Full Name', 'name of students', 'student name', 'full_name']);
  
  // Add change listeners to inputs (for preview later)
  Object.values(dropdowns).forEach(dropdown => {
    dropdown.addEventListener('change', () => {
      if (currentCSVStep === 3) renderCSVPreviewTable();
    });
  });
  ['csv-input-semester', 'csv-input-session', 'csv-input-dept', 'csv-input-batch'].forEach(id => {
    document.getElementById(id).addEventListener('input', () => {
      if (currentCSVStep === 3) renderCSVPreviewTable();
    });
  });
  
  // Add button listeners
  document.getElementById('csv-next-btn').onclick = goToNextCSVStep;
  document.getElementById('csv-back-btn').onclick = goToPrevCSVStep;
  document.getElementById('csv-cancel-btn').onclick = closeCSVPreviewModal;
  document.getElementById('csv-import-btn').onclick = importStudentsFromPreview;
  
  modal.classList.add('active');
}

// Render Preview Table
function renderCSVPreviewTable() {
  const table = document.getElementById('csv-preview-table');
  
  // Get column mappings
  const mappings = {
    reg: document.getElementById('csv-map-reg').value,
    roll: document.getElementById('csv-map-roll').value,
    name: document.getElementById('csv-map-name').value
  };
  
  // Get input values (apply to all)
  const inputValues = {
    semester: document.getElementById('csv-input-semester').value,
    session: document.getElementById('csv-input-session').value,
    dept: document.getElementById('csv-input-dept').value,
    batch: document.getElementById('csv-input-batch').value
  };
  
  // Build table header
  let html = `
    <thead>
      <tr>
        <th>Reg No</th>
        <th>Class Roll</th>
        <th>Name</th>
        <th>Semester</th>
        <th>Session</th>
        <th>Department</th>
        <th>Batch</th>
      </tr>
    </thead>
    <tbody>
  `;
  
  // Add first 10 rows
  currentCSVData.slice(0,10).forEach(row => {
    html += `
      <tr>
        <td>${row[mappings.reg] || ''}</td>
        <td>${row[mappings.roll] || ''}</td>
        <td>${row[mappings.name] || ''}</td>
        <td>${inputValues.semester}</td>
        <td>${inputValues.session}</td>
        <td>${inputValues.dept}</td>
        <td>${inputValues.batch}</td>
      </tr>
    `;
  });
  
  html += '</tbody>';
  table.innerHTML = html;
}

// Close Preview Modal
window.closeCSVPreviewModal = function() {
  document.getElementById('csv-preview-modal').classList.remove('active');
  currentCSVData = [];
  currentCSVHeaders = [];
  // Clear inputs for next time
  document.getElementById('csv-input-semester').value = '';
  document.getElementById('csv-input-session').value = '';
  document.getElementById('csv-input-dept').value = '';
  document.getElementById('csv-input-batch').value = '';
};

// Import from Preview
async function importStudentsFromPreview() {
  // Get column mappings
  const mappings = {
    reg: document.getElementById('csv-map-reg').value,
    roll: document.getElementById('csv-map-roll').value,
    name: document.getElementById('csv-map-name').value
  };
  
  // Get input values
  const inputValues = {
    semester: document.getElementById('csv-input-semester').value,
    session: document.getElementById('csv-input-session').value,
    dept: document.getElementById('csv-input-dept').value,
    batch: document.getElementById('csv-input-batch').value
  };
  
  // Validate required fields
  if (!inputValues.semester || !inputValues.session || !inputValues.dept || !inputValues.batch) {
    alert('Please fill in all the "Additional Info" fields!');
    return;
  }
  
  // Build students array
  const students = currentCSVData.map(row => {
    return {
      registration_number: String(row[mappings.reg] || ''),
      roll_number: String(row[mappings.roll] || ''),
      full_name: String(row[mappings.name] || ''),
      semester: inputValues.semester,
      session_year: inputValues.session,
      department: inputValues.dept,
      batch: inputValues.batch
    };
  }).filter(student => 
    student.registration_number && 
    student.roll_number && 
    student.full_name
  );
  
  if (students.length === 0) {
    alert('No valid students found! Please ensure you have mapped all 3 CSV columns!');
    return;
  }
  
  try {
    const result = await ipcRenderer.invoke('db:createStudents', students);
    
    let message = '';
    if (result.inserted > 0) {
      message += `✅ Successfully imported ${result.inserted} student(s)!\n`;
    }
    if (result.skipped > 0) {
      message += `⚠️ Skipped ${result.skipped} student(s) (already registered with these registration numbers)\n`;
    }
    if (result.errors.length > 0) {
      message += `❌ ${result.errors.length} error(s) occurred!\n`;
      result.errors.forEach(err => {
        message += `  - ${err.student.full_name || err.student.registration_number}: ${err.error}\n`;
      });
    }
    if (message === '') {
      message = 'No students were imported.';
    }
    alert(message);
    
    // Close modal & reload students
    closeCSVPreviewModal();
    loadStudents();
  } catch (err) {
    console.error('Import error:', err);
    alert('Failed to import students: ' + err.message);
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
  
  // Sort students by roll number ascending
  group.students.sort((a, b) => {
    const rollA = parseFloat(a.roll_number);
    const rollB = parseFloat(b.roll_number);
    if (!isNaN(rollA) && !isNaN(rollB)) return rollA - rollB;
    return String(a.roll_number || '').localeCompare(String(b.roll_number || ''));
  });
  
  const sanitize = (text) => {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  };
  
  container.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
      <button class="btn btn-secondary" onclick="loadStudents()">← Back to Batches</button>
      <button class="btn btn-primary" id="add-student-btn">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle; margin-right: 4px;">
          <line x1="12" y1="5" x2="12" y2="19"></line>
          <line x1="5" y1="12" x2="19" y2="12"></line>
        </svg>
        Add Student
      </button>
    </div>
    <h2 style="margin-bottom: 16px;">${sanitize(group.dept)} - Batch ${sanitize(group.batch)} (Session ${sanitize(group.session)})</h2>
    
    <div class="table-container">
      <table class="submissions-table">
        <thead>
          <tr>
            <th>Sl No</th>
            <th>Reg No</th>
            <th>Roll</th>
            <th>Name</th>
            <th>Semester</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${group.students.map((student, index) => `
            <tr>
              <td>${index + 1}</td>
              <td>${sanitize(student.registration_number || 'N/A')}</td>
              <td>${sanitize(student.roll_number || 'N/A')}</td>
              <td>${sanitize(student.full_name || 'N/A')}</td>
              <td>${sanitize(student.semester || 'N/A')}</td>
              <td>
                <button class="btn btn-danger" onclick="window.deleteStudent(${student.id}, '${key}')" style="padding: 4px 8px;">
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
    
    <!-- Add Student Modal -->
    <div id="add-student-modal" class="modal" style="align-items: flex-start; padding-top: 40px;">
      <div class="modal-content glass-panel">
        <h2>Add New Student</h2>
        <form id="add-student-form">
          <div class="form-group">
            <label>Registration Number</label>
            <input type="text" id="new-student-reg" required placeholder="Reg No">
          </div>
          <div class="form-group">
            <label>Roll Number</label>
            <input type="text" id="new-student-roll" required placeholder="Roll">
          </div>
          <div class="form-group">
            <label>Student Name</label>
            <input type="text" id="new-student-name" required placeholder="Name">
          </div>
          <div class="form-group">
            <label>Semester</label>
            <input type="text" id="new-student-semester" required placeholder="Semester" value="${sanitize(group.students[0]?.semester || '')}">
          </div>
          <div class="modal-actions">
            <button type="button" class="btn btn-secondary" id="cancel-add-student">Cancel</button>
            <button type="submit" class="btn btn-primary">Add Student</button>
          </div>
        </form>
      </div>
    </div>
  `;
  
  // Modal handling
  const modal = document.getElementById('add-student-modal');
  const addBtn = document.getElementById('add-student-btn');
  const cancelBtn = document.getElementById('cancel-add-student');
  const form = document.getElementById('add-student-form');
  
  addBtn.addEventListener('click', () => modal.classList.add('active'));
  cancelBtn.addEventListener('click', () => modal.classList.remove('active'));
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.remove('active'); });
  
  // Form submission
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const regNo = document.getElementById('new-student-reg').value.trim();
    const rollNo = document.getElementById('new-student-roll').value.trim();
    const name = document.getElementById('new-student-name').value.trim();
    const semester = document.getElementById('new-student-semester').value.trim();
    
    try {
      const result = await ipcRenderer.invoke('db:createStudent', regNo, rollNo, name, semester, group.session, group.dept, group.batch);
      if (result.inserted) {
        await window.showAlert('Student added successfully!');
        modal.classList.remove('active');
        await loadStudents();
        window.viewBatchStudents(key);
      } else if (result.skipped) {
        await window.showAlert('Student with this registration number already exists!');
      }
    } catch (err) {
      console.error('Failed to add student:', err);
      await window.showAlert('Failed to add student: ' + (err.message || 'Unknown error'));
    }
  });
};

window.deleteStudent = async function(id, groupKey) {
  if (await window.showConfirm('Are you sure you want to delete this student?')) {
    await ipcRenderer.invoke('db:deleteStudent', id);
    await loadStudents();
    if (groupKey) window.viewBatchStudents(groupKey);
  }
};

window.deleteStudentsByGroup = async function(dept, batch, sessionYear) {
  if (await window.showConfirm(`Are you sure you want to delete all students in ${dept} - Batch ${batch} (Session ${sessionYear})?`)) {
    await ipcRenderer.invoke('db:deleteStudentsByGroup', dept, batch, sessionYear);
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
                <button class="btn btn-secondary" onclick="event.stopPropagation(); window.openViewQuestionsModal(${session.quiz_id}, '${title.replace(/'/g, "\\'")}', true)">Questions</button>
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
        <div style="flex: 1; display: flex; flex-direction: column; gap: 8px;">
          <div style="display: flex; justify-content: space-between; align-items: flex-start;">
            <h3 style="margin: 0;">${title}</h3>
            ${!isSelectModeDashboard ? `
              <div style="display: flex; gap: 8px;">
                <!-- View Questions (eye icon) -->
                <button class="quiz-card-icon-btn" title="View Questions" onclick="event.stopPropagation(); openViewQuestionsModal(${quiz.id}, '${title.replace(/'/g, "\\'")}', true)">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                    <circle cx="12" cy="12" r="3"></circle>
                  </svg>
                </button>
                <!-- Edit Questions (pencil icon) -->
                <button class="quiz-card-icon-btn" title="Edit Questions" onclick="event.stopPropagation(); openViewQuestionsModal(${quiz.id}, '${title.replace(/'/g, "\\'")}', false)">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path>
                  </svg>
                </button>
              </div>
            ` : ''}
          </div>
          ${detailsHtml}
          ${!isSelectModeDashboard ? `
            <div class="card-actions" style="margin-top: 8px;">
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

let currentEditQuizId = null;
let currentEditTitle = '';
let editQuestionImages = {}; // questionId -> base64 data URL or null
let newQuestionCounter = 0; // Counter for temporary new question IDs

function escapeAttr(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function eqImageBtnHtml(label) {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle; margin-right: 4px;">
    <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
    <circle cx="8.5" cy="8.5" r="1.5"></circle>
    <polyline points="21 15 16 10 5 21"></polyline>
  </svg> ${label}`;
}

function addEditQuestionUI() {
  const body = document.getElementById('view-questions-body');
  const qid = `new-${++newQuestionCounter}`;
  const optionLetters = ['a', 'b', 'c', 'd'];
  const questionItems = body.querySelectorAll('.edit-question-item');
  const index = questionItems.length;
  
  const qDiv = document.createElement('div');
  qDiv.className = 'edit-question-item';
  qDiv.dataset.qid = qid;
  
  const optionsHtml = optionLetters.map(opt => `
    <div class="option-input" onclick="this.querySelector('input[type=radio]').checked = true;">
      <input type="radio" name="eq-correct-${qid}" value="${opt}" ${opt === 'a' ? 'checked' : ''}>
      <input type="text" class="eq-opt-${opt}" placeholder="Option ${opt.toUpperCase()}" autocomplete="off" onclick="event.stopPropagation();">
    </div>
  `).join('');
  
  qDiv.innerHTML = `
    <div class="form-group">
      <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 8px;">
        <label>Question ${index + 1}</label>
        <button class="btn btn-danger" style="padding: 4px 8px; font-size: 12px;" onclick="window.removeEditQuestion('${qid}')">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            <line x1="10" y1="11" x2="10" y2="17"></line>
            <line x1="14" y1="11" x2="14" y2="17"></line>
          </svg>
        </button>
      </div>
      <div class="eq-image-preview" style="margin-bottom: 12px; display: none;"></div>
      <textarea class="eq-text" placeholder="Question text" autocomplete="off" style="width: 100%; padding: 8px 12px; border-radius: 8px; border: 1px solid var(--panel-border); background: rgba(255,255,255,0.4); font-family: inherit; font-size: inherit; resize: vertical; min-height: 60px;"></textarea>
    </div>
    <div style="margin-top: 8px; display: flex; gap: 8px;">
      <input type="file" class="eq-image-input" accept="image/*" style="display: none;">
      <button type="button" class="btn btn-secondary eq-image-btn" style="padding: 6px 8px; font-size: 12px;" onclick="this.previousElementSibling.click()">${eqImageBtnHtml('Add Image')}</button>
    </div>
    <div class="options-grid" style="margin-top: 12px;">
      ${optionsHtml}
    </div>
  `;
  
  // Add image listener for new question
  const imageInput = qDiv.querySelector('.eq-image-input');
  let imagePreview = qDiv.querySelector('.eq-image-preview');
  imageInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        editQuestionImages[qid] = event.target.result;
        imagePreview.style.display = 'block';
        imagePreview.innerHTML = `
          <div class="resizable-image-container">
            <img src="${event.target.result}">
          </div>
        `;
        const btnRow = imageInput.parentElement;
        const imgBtn = btnRow.querySelector('.eq-image-btn');
        if (imgBtn) imgBtn.innerHTML = eqImageBtnHtml('Change Image');
        // Add Remove Image button if not present
        if (!btnRow.querySelector('.eq-remove-btn')) {
          const removeBtn = document.createElement('button');
          removeBtn.type = 'button';
          removeBtn.className = 'btn btn-secondary eq-remove-btn';
          removeBtn.style.padding = '6px 8px';
          removeBtn.style.fontSize = '12px';
          removeBtn.textContent = 'Remove Image';
          removeBtn.onclick = () => window.removeEditQuestionImage(qid);
          btnRow.appendChild(removeBtn);
        }
      };
      reader.readAsDataURL(file);
    }
  });
  
  body.appendChild(qDiv);
}

window.openViewQuestionsModal = async function(quizId, title, isReadOnly = false) {
  currentEditQuizId = quizId;
  currentEditTitle = title;
  newQuestionCounter = 0;
  deletedQuestions = new Set();
  document.getElementById('view-questions-title').textContent = title + ' - Questions';
  const body = document.getElementById('view-questions-body');
  
  // Hide or show Save Changes button based on isReadOnly
  const saveBtn = document.querySelector('#view-questions-modal .modal-actions .btn-primary');
  if (saveBtn) {
    saveBtn.style.display = isReadOnly ? 'none' : 'inline-block';
  }
  
  // Add "Add Question" button above the questions (only if not read-only)
  let addButtonHtml = '';
  if (!isReadOnly) {
    addButtonHtml = `
      <div style="margin-bottom: 16px;">
        <button class="btn btn-secondary" onclick="window.addEditQuestionUI()">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle; margin-right: 4px;">
            <line x1="12" y1="5" x2="12" y2="19"></line>
            <line x1="5" y1="12" x2="19" y2="12"></line>
          </svg>
          Add Question
        </button>
      </div>
    `;
  }
  
  const questions = await ipcRenderer.invoke('db:getQuestionsByQuiz', quizId);
  
  editQuestionImages = {};
  questions.forEach(q => { editQuestionImages[q.id] = q.image || null; });
  
  const optionLetters = ['a', 'b', 'c', 'd'];
  
  body.innerHTML = questions.map((q, i) => {
    const optValues = { a: q.opt_a, b: q.opt_b, c: q.opt_c, d: q.opt_d };
    
    const optionsHtml = optionLetters.map(opt => `
      <div class="option-input" ${isReadOnly ? '' : 'onclick="this.querySelector(\'input[type=radio]\').checked = true;"'}>
        <input type="radio" name="eq-correct-${q.id}" value="${opt}" ${q.correct_opt === opt ? 'checked' : ''} ${isReadOnly ? 'disabled' : ''}>
        <input type="text" class="eq-opt-${opt}" value="${escapeAttr(optValues[opt])}" placeholder="Option ${opt.toUpperCase()}" autocomplete="off" ${isReadOnly ? 'disabled' : 'onclick="event.stopPropagation();"'}>
      </div>
    `).join('');
    
    return `
      <div class="edit-question-item" data-qid="${q.id}">
        <div class="form-group">
          <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 8px;">
            <label>Question ${i + 1}</label>
            ${!isReadOnly ? `
              <button class="btn btn-danger" style="padding: 4px 8px; font-size: 12px;" onclick="window.removeEditQuestion(${q.id})">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="3 6 5 6 21 6"></polyline>
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                  <line x1="10" y1="11" x2="10" y2="17"></line>
                  <line x1="14" y1="11" x2="14" y2="17"></line>
                </svg>
              </button>
            ` : ''}
          </div>
          ${q.image ? `
            <div class="resizable-image-container">
              <img src="${q.image}">
            </div>
          ` : ''}
          ${isReadOnly ? `
            <div style="word-wrap: break-word; overflow-wrap: break-word; padding: 8px 0; color: var(--text-primary); font-weight: 500;">${escapeAttr(q.text)}</div>
          ` : `
            <textarea class="eq-text" placeholder="Question text" autocomplete="off" style="width: 100%; padding: 8px 12px; border-radius: 8px; border: 1px solid var(--panel-border); background: rgba(255,255,255,0.4); font-family: inherit; font-size: inherit; resize: vertical; min-height: 60px;">${escapeAttr(q.text)}</textarea>
          `}
        </div>
        ${isReadOnly ? '' : `
          <div style="margin-top: 8px; display: flex; gap: 8px;">
            <input type="file" class="eq-image-input" accept="image/*" style="display: none;">
            <button type="button" class="btn btn-secondary eq-image-btn" style="padding: 6px 8px; font-size: 12px;" onclick="this.previousElementSibling.click()">${eqImageBtnHtml(q.image ? 'Change Image' : 'Add Image')}</button>
            ${q.image ? `<button type="button" class="btn btn-secondary eq-remove-btn" style="padding: 6px 8px; font-size: 12px;" onclick="window.removeEditQuestionImage(${q.id})">Remove Image</button>` : ''}
          </div>
        `}
        <div class="options-grid" style="margin-top: 12px;">
          ${isReadOnly ? optionLetters.map(opt => `
            <div class="option-input" style="cursor: default; background: ${q.correct_opt === opt ? 'rgba(64, 160, 43, 0.1)' : 'rgba(203, 166, 247, 0.05)'}; border-color: ${q.correct_opt === opt ? 'rgba(64, 160, 43, 0.3)' : 'rgba(203, 166, 247, 0.1)'};">
              <span style="font-weight: 600; margin-right: 8px;">${opt.toUpperCase()}.</span>
              <span style="word-wrap: break-word; overflow-wrap: break-word;">${escapeAttr(optValues[opt])}</span>
              ${q.correct_opt === opt ? '<span style="margin-left: auto; color: var(--success); font-weight: 600;">✓ Correct</span>' : ''}
            </div>
          `).join('') : optionsHtml}
        </div>
      </div>
    `;
  }).join('') + addButtonHtml;
  
  // If no questions and not read-only, still show add button
  if (questions.length === 0 && !isReadOnly) {
    body.innerHTML = addButtonHtml;
  } else if (questions.length === 0 && isReadOnly) {
    body.innerHTML = '<p class="text-muted">No questions found for this quiz.</p>';
  }
  
  // Only add image listeners if not read-only
  if (!isReadOnly) {
    body.querySelectorAll('.edit-question-item').forEach(item => {
      const qid = item.dataset.qid;
      const imageInput = item.querySelector('.eq-image-input');
      if (imageInput) { // Only if image input exists (i.e., not read-only)
        let imagePreview = item.querySelector('.eq-image-preview');
        imageInput.addEventListener('change', (e) => {
          const file = e.target.files[0];
          if (file) {
            const reader = new FileReader();
            reader.onload = (event) => {
              editQuestionImages[qid] = event.target.result;
              // If image preview div doesn't exist, create it and insert it after label
              if (!imagePreview) {
                const formGroup = item.querySelector('.form-group');
                const labelContainer = formGroup.querySelector('div'); // The div containing label and delete button
                imagePreview = document.createElement('div');
                imagePreview.className = 'eq-image-preview';
                imagePreview.style.marginBottom = '12px';
                formGroup.insertBefore(imagePreview, labelContainer.nextSibling);
              }
              imagePreview.style.display = 'block';
              imagePreview.innerHTML = `
                <div class="resizable-image-container">
                  <img src="${event.target.result}">
                </div>
              `;
              const btnRow = imageInput.parentElement;
              const imgBtn = btnRow.querySelector('.eq-image-btn');
              if (imgBtn) imgBtn.innerHTML = eqImageBtnHtml('Change Image');
              // Add Remove Image button if not present
              if (!btnRow.querySelector('.eq-remove-btn')) {
                const removeBtn = document.createElement('button');
                removeBtn.type = 'button';
                removeBtn.className = 'btn btn-secondary eq-remove-btn';
                removeBtn.style.padding = '6px 8px';
                removeBtn.style.fontSize = '12px';
                removeBtn.textContent = 'Remove Image';
                removeBtn.onclick = () => window.removeEditQuestionImage(qid);
                btnRow.appendChild(removeBtn);
              }
            };
            reader.readAsDataURL(file);
          }
        });
      }
    });
  }
  
  document.getElementById('view-questions-modal').classList.add('active');
};

window.removeEditQuestionImage = function(qid) {
  editQuestionImages[qid] = null;
  const item = document.querySelector(`.edit-question-item[data-qid="${qid}"]`);
  if (item) {
    const imagePreview = item.querySelector('.eq-image-preview');
    if (imagePreview) {
      if (String(qid).startsWith('new-')) {
        imagePreview.style.display = 'none';
        imagePreview.innerHTML = '';
      } else {
        imagePreview.remove();
      }
    }
    const imgBtn = item.querySelector('.eq-image-btn');
    if (imgBtn) imgBtn.innerHTML = eqImageBtnHtml('Add Image');
    const removeBtn = item.querySelector('.eq-remove-btn');
    if (removeBtn) removeBtn.remove();
  }
};

let deletedQuestions = new Set(); // Keep track of question IDs to delete
window.removeEditQuestion = async function(qid) {
  if (confirm('Are you sure you want to delete this question?')) {
    if (String(qid).startsWith('new-')) {
      // It's a new question, just remove from DOM
      const item = document.querySelector(`.edit-question-item[data-qid="${qid}"]`);
      if (item) item.remove();
    } else {
      // Existing question, add to deleted set and remove from DOM
      deletedQuestions.add(qid);
      const item = document.querySelector(`.edit-question-item[data-qid="${qid}"]`);
      if (item) item.remove();
    }
    // Reindex all question labels
    const body = document.getElementById('view-questions-body');
    const questionItems = body.querySelectorAll('.edit-question-item');
    questionItems.forEach((item, index) => {
      const label = item.querySelector('label');
      if (label) {
        label.textContent = `Question ${index + 1}`;
      }
    });
  }
};

window.saveQuestionEdits = async function() {
  if (!currentEditQuizId) return;
  const body = document.getElementById('view-questions-body');
  const items = body.querySelectorAll('.edit-question-item');
  
  try {
    // First delete any questions marked for deletion
    for (const qid of deletedQuestions) {
      await ipcRenderer.invoke('db:deleteQuestion', qid);
    }
    deletedQuestions.clear();
    
    // Now process each question item
    for (const item of items) {
      const qid = item.dataset.qid;
      const text = item.querySelector('.eq-text').value.trim();
      const opt_a = item.querySelector('.eq-opt-a').value.trim();
      const opt_b = item.querySelector('.eq-opt-b').value.trim();
      const opt_c = item.querySelector('.eq-opt-c').value.trim();
      const opt_d = item.querySelector('.eq-opt-d').value.trim();
      const correctRadio = item.querySelector(`input[name="eq-correct-${qid}"]:checked`);
      const correct_opt = correctRadio ? correctRadio.value : 'a';
      const image = editQuestionImages[qid] !== undefined ? editQuestionImages[qid] : null;
      
      if (!text || !opt_a || !opt_b || !opt_c || !opt_d) {
        alert('All fields (text and 4 options) are required for each question.');
        return;
      }
      
      if (String(qid).startsWith('new-')) {
        // New question, add to DB
        await ipcRenderer.invoke(
          'db:addQuestion',
          currentEditQuizId, text, opt_a, opt_b, opt_c, opt_d, correct_opt, image
        );
      } else {
        // Existing question, update in DB
        await ipcRenderer.invoke(
          'db:updateQuestion',
          Number(qid), text, opt_a, opt_b, opt_c, opt_d, correct_opt, image
        );
      }
    }
    alert('Changes saved successfully!');
    // Re-render to reflect saved values
    openViewQuestionsModal(currentEditQuizId, currentEditTitle, false);
  } catch (err) {
    console.error('Error saving question edits:', err);
    alert('Failed to save changes: ' + (err.message || 'Unknown error'));
  }
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
            <label style="flex: 1;">Question ${index + 1}</label>
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
          <div class="q-image-preview" style="margin-bottom: 8px;"></div>
          <input type="text" class="q-text" placeholder="What is 2 + 2?" autocomplete="off">
        </div>
        <div class="options-grid" style="margin-top: 12px;">
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
          <div class="resizable-image-container"">
            <img src="${base64}">
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
    const label = item.querySelector('label');
    if (label) {
      label.textContent = `Question ${index + 1}`;
    }
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

window.openStartSessionModal = async function(quizId, title) {
  // Check if server is running
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    alert('Server is not running. Please click "Start Server" to begin.');
    return;
  }
  
  pendingQuizId = quizId;
  currentQuizId = quizId;
  document.getElementById('modal-quiz-title').textContent = `Starting: ${title}`;
  
  // Fetch unique student groups and populate dropdown
  const groups = await ipcRenderer.invoke('db:getUniqueStudentGroups');
  
  const groupSelect = document.getElementById('filter-group');
  groupSelect.innerHTML = '<option value="">Select Student Group</option>' + groups.map(g => `<option value="${escapeAttr(JSON.stringify(g))}">Dept: ${g.department}, Session: ${g.session_year}, Semester: ${g.semester}, Batch: ${g.batch}</option>`).join('');
  
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
        <div style="padding: 16px; border: 1px solid var(--panel-border); border-radius: 12px; margin-bottom: 12px; background: rgba(255,255,255,0.35); backdrop-filter: blur(18px) saturate(160%); box-shadow: 0 4px 12px var(--shadow);">
          <h4 style="margin: 0 0 12px 0;">${i + 1}. ${q.text}</h4>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 8px;">
            <div style="padding: 10px 12px; border-radius: 8px; background: ${q.correct_opt === 'a' ? 'var(--success-bg)' : 'rgba(255,255,255,0.25)'}; border: 1px solid ${q.correct_opt === 'a' ? 'var(--success)' : 'var(--panel-border)'}; backdrop-filter: blur(12px);">A. ${q.opt_a}</div>
            <div style="padding: 10px 12px; border-radius: 8px; background: ${q.correct_opt === 'b' ? 'var(--success-bg)' : 'rgba(255,255,255,0.25)'}; border: 1px solid ${q.correct_opt === 'b' ? 'var(--success)' : 'var(--panel-border)'}; backdrop-filter: blur(12px);">B. ${q.opt_b}</div>
            <div style="padding: 10px 12px; border-radius: 8px; background: ${q.correct_opt === 'c' ? 'var(--success-bg)' : 'rgba(255,255,255,0.25)'}; border: 1px solid ${q.correct_opt === 'c' ? 'var(--success)' : 'var(--panel-border)'}; backdrop-filter: blur(12px);">C. ${q.opt_c}</div>
            <div style="padding: 10px 12px; border-radius: 8px; background: ${q.correct_opt === 'd' ? 'var(--success-bg)' : 'rgba(255,255,255,0.25)'}; border: 1px solid ${q.correct_opt === 'd' ? 'var(--success)' : 'var(--panel-border)'}; backdrop-filter: blur(12px);">D. ${q.opt_d}</div>
          </div>
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
  const groupSelect = document.getElementById('filter-group');
  let filterDepartment = null;
  let filterSessionYear = null;
  let filterSemester = null;
  let filterBatch = null;
  
  if (groupSelect.value) {
    const group = JSON.parse(groupSelect.value);
    filterDepartment = group.department;
    filterSessionYear = group.session_year;
    filterSemester = group.semester;
    filterBatch = group.batch;
  }
  
  ws.send(JSON.stringify({
    type: 'session:start',
    payload: { 
      quizId: pendingQuizId,
      filters: {
        department: filterDepartment,
        sessionYear: filterSessionYear,
        semester: filterSemester,
        batch: filterBatch
      }
    }
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
      connectedStudents = []; // Reset connected students
      document.getElementById('connected-students-list').innerHTML = ''; // Clear modal list
      document.getElementById('submissions-body').innerHTML = '';
      document.getElementById('student-count').textContent = '0';
      document.getElementById('connected-students-count').textContent = '0';
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
    const showAnswersBtnText = showAnswersToStudents ? 'Hide Answers' : 'Show Answers';
    const viewAnswersBtnText = showTeacherAnswers ? 'Hide Q&A' : 'View Q&A';
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
  // Check if student with same registration number is already in connectedStudents
  const existingStudentIndex = connectedStudents.findIndex(
    student => student.registrationNumber === data.registrationNumber
  );
  
  if (existingStudentIndex === -1) {
    // Not found, add new student
    connectedStudents.push(data);
  } else {
    // Already exists, maybe update the data just in case
    connectedStudents[existingStudentIndex] = data;
  }
  
  // Sort connected students by Class Roll ascending
  connectedStudents.sort((a, b) => {
    // Convert rolls to numbers for proper numeric sorting, fallback to string comparison if not numeric
    const rollA = isNaN(parseInt(a.roll)) ? a.roll : parseInt(a.roll);
    const rollB = isNaN(parseInt(b.roll)) ? b.roll : parseInt(b.roll);
    if (typeof rollA === 'number' && typeof rollB === 'number') {
      return rollA - rollB;
    }
    return String(rollA).localeCompare(String(rollB));
  });
  
  // Re-render the entire list when sorted
  const list = document.getElementById('connected-students-list');
  list.innerHTML = connectedStudents.map((student, index) => 
    `<tr>
      <td>${index + 1}</td>
      <td>${student.registrationNumber || 'N/A'}</td>
      <td>${student.roll}</td>
      <td>${student.name}</td>
      <td>${student.semester || 'N/A'}</td>
      <td>${student.batch || 'N/A'}</td>
    </tr>`
  ).join('');
   
  // Set student count to length of unique connected students
  studentCount = connectedStudents.length;
  document.getElementById('student-count').textContent = studentCount;
  document.getElementById('connected-students-count').textContent = studentCount;
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
  
  // Group items by type
  const groups = {
    students: deletedItems.filter(item => item.type === 'student'),
    quizzes: deletedItems.filter(item => item.type === 'quiz'),
    sessions: deletedItems.filter(item => item.type === 'session')
  };
  
  // Function to render a group
  const renderGroup = (items, title) => {
    if (items.length === 0) return '';
    
    const itemsHtml = items.map(item => {
      let itemTitle, subtitle, typeIcon;
      
      if (item.type === 'quiz') {
        itemTitle = item.title;
        subtitle = `Duration: ${Math.floor(item.duration / 60)} min${item.semester ? ` • ${item.semester}` : ''}${item.session ? ` • ${item.session}` : ''}`;
        typeIcon = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"></polygon><polyline points="2 17 12 22 22 17"></polyline><polyline points="2 12 12 17 22 12"></polyline></svg>`;
      } else if (item.type === 'session') {
        itemTitle = item.title;
        subtitle = `Code: ${item.code} • ${new Date(item.created_at).toLocaleString()}`;
        typeIcon = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>`;
      } else { // student
        itemTitle = item.full_name || item.name || 'Unknown';
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
              <h3 style="margin: 0 0 4px 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${itemTitle}</h3>
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
    
    return `
      <div style="margin-bottom: 24px;">
        <h2 style="margin: 0 0 12px 0; font-size: 1.25rem; color: var(--text-main);">${title}</h2>
        ${itemsHtml}
      </div>
    `;
  };
  
  // Render all groups
  container.innerHTML = `
    ${renderGroup(groups.quizzes, 'Quizzes')}
    ${renderGroup(groups.students, 'Students')}
    ${renderGroup(groups.sessions, 'History')}
  `;
  
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
  } else if (type === 'session') {
    titleEl.textContent = item.title;
    // Fetch submissions for the session
    const submissions = await ipcRenderer.invoke('db:getSubmissionsBySession', id);
    bodyEl.innerHTML = `
      <div style="padding: 12px; background: var(--panel-bg); border-radius: 8px;">
        <p style="margin: 0 0 8px 0;"><strong>Code:</strong> ${item.code}</p>
        <p style="margin: 0 0 8px 0;"><strong>Created At:</strong> ${new Date(item.created_at).toLocaleString()}</p>
        <p style="margin: 0;"><strong>Submissions:</strong> ${submissions.length}</p>
      </div>
      ${submissions.length > 0 ? `
        <h3 style="margin: 16px 0 8px 0;">Submissions</h3>
        <table style="width: 100%; border-collapse: collapse;">
          <thead>
            <tr style="background: var(--panel-bg);">
              <th style="padding: 8px; text-align: left; border-bottom: 1px solid var(--panel-border);">Reg. No</th>
              <th style="padding: 8px; text-align: left; border-bottom: 1px solid var(--panel-border);">Roll</th>
              <th style="padding: 8px; text-align: left; border-bottom: 1px solid var(--panel-border);">Name</th>
              <th style="padding: 8px; text-align: left; border-bottom: 1px solid var(--panel-border);">Score</th>
            </tr>
          </thead>
          <tbody>
            ${submissions.map(sub => `
              <tr>
                <td style="padding: 8px; border-bottom: 1px solid var(--panel-border);">${sub.registration_number || 'N/A'}</td>
                <td style="padding: 8px; border-bottom: 1px solid var(--panel-border);">${sub.roll}</td>
                <td style="padding: 8px; border-bottom: 1px solid var(--panel-border);">${sub.name}</td>
                <td style="padding: 8px; border-bottom: 1px solid var(--panel-border);"><strong>${sub.score}</strong></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
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
    } else if (type === 'session') {
      await ipcRenderer.invoke('db:restoreSession', id);
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
    } else if (type === 'session') {
      await ipcRenderer.invoke('db:permanentDeleteSession', id);
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
    const sessionIds = Array.from(selectedRecycleItems).filter(id => deletedItems.find(item => item.id === id && item.type === 'session')).map(Number);
    
    if (quizIds.length > 0) {
      await ipcRenderer.invoke('db:restoreQuizzes', quizIds);
    }
    if (sessionIds.length > 0) {
      await ipcRenderer.invoke('db:restoreSessions', sessionIds);
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
    const sessionIds = Array.from(selectedRecycleItems).filter(id => deletedItems.find(item => item.id === id && item.type === 'session')).map(Number);
    
    if (quizIds.length > 0) {
      await ipcRenderer.invoke('db:permanentDeleteQuizzes', quizIds);
    }
    if (sessionIds.length > 0) {
      await ipcRenderer.invoke('db:permanentDeleteSessions', sessionIds);
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
