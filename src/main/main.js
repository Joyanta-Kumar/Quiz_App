const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { startServer, stopServer } = require('../server/server');
const os = require('os');
const { dbApi, initDb } = require('../server/db');

let mainWindow;
let isServerRunning = false;
const PORT = 3000;

function getLocalIPAddress() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false // For simplicity in LAN app, we'll allow nodeIntegration in renderer
    },
    title: "LAN Quiz System - Teacher Dashboard",
    icon: path.resolve(__dirname, '../assets/icon.ico') // Optional
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  
  // Optional: open dev tools for debugging
  // mainWindow.webContents.openDevTools();
}

app.whenReady().then(async () => {
  try {
    // Initialize database first
    await initDb();
    
    // DO NOT start server on app launch (default to OFF)
    isServerRunning = false;
    
    // Pass info to renderer once it loads
    ipcMain.handle('get-server-info', () => {
      return {
        ip: getLocalIPAddress(),
        port: PORT
      };
    });

    // IPC handlers for server toggle
    ipcMain.handle('get-server-status', () => {
      return isServerRunning;
    });

    ipcMain.handle('toggle-server', async () => {
      if (isServerRunning) {
        stopServer();
        isServerRunning = false;
      } else {
          await startServer(PORT);
          isServerRunning = true;
      }
      return isServerRunning;
    });
    
    // IPC handlers for database operations
    ipcMain.handle('db:getQuizzes', async () => {
      return await dbApi.getQuizzes();
    });
    
    ipcMain.handle('db:getQuizById', async (_, id) => {
      return await dbApi.getQuizById(id);
    });
    
    ipcMain.handle('db:createQuiz', async (_, title, duration, semester, session) => {
      return await dbApi.createQuiz(title, duration, semester, session);
    });
    
    ipcMain.handle('db:deleteQuiz', async (_, id) => {
      return await dbApi.softDeleteQuiz(id);
    });

    ipcMain.handle('db:addQuestion', async (_, quizId, text, opt_a, opt_b, opt_c, opt_d, correct_opt, image) => {
      return await dbApi.addQuestion(quizId, text, opt_a, opt_b, opt_c, opt_d, correct_opt, image);
    });

    ipcMain.handle('db:updateQuestion', async (_, id, text, opt_a, opt_b, opt_c, opt_d, correct_opt, image) => {
      return await dbApi.updateQuestion(id, text, opt_a, opt_b, opt_c, opt_d, correct_opt, image);
    });
    
    ipcMain.handle('db:getSessionsHistory', async () => {
      return await dbApi.getSessionsHistory();
    });
    
    ipcMain.handle('db:getSubmissionsBySession', async (_, sessionId) => {
      return await dbApi.getSubmissionsBySession(sessionId);
    });

    ipcMain.handle('db:deleteSession', async (_, sessionId) => {
      return await dbApi.deleteSession(sessionId);
    });

    ipcMain.handle('db:deleteSessions', async (_, sessionIds) => {
      return await dbApi.deleteSessions(sessionIds);
    });

    ipcMain.handle('db:deleteQuizzes', async (_, quizIds) => {
      return await dbApi.softDeleteQuizzes(quizIds);
    });

    ipcMain.handle('db:getAllStudents', async () => {
      return await dbApi.getAllStudents();
    });

    ipcMain.handle('db:createStudents', async (_, students) => {
      return await dbApi.createStudents(students);
    });

    ipcMain.handle('db:deleteStudent', async (_, id) => {
      return await dbApi.softDeleteStudent(id);
    });

    ipcMain.handle('db:deleteStudentsByGroup', async (_, dept, batch, sessionYear) => {
      return await dbApi.softDeleteStudentsByGroup(dept, batch, sessionYear);
    });
    
    ipcMain.handle('db:getDeletedItems', async () => {
      return await dbApi.getDeletedItems();
    });
    
    ipcMain.handle('db:restoreQuiz', async (_, id) => {
      return await dbApi.restoreQuiz(id);
    });
    
    ipcMain.handle('db:restoreQuizzes', async (_, quizIds) => {
      return await dbApi.restoreQuizzes(quizIds);
    });
    
    ipcMain.handle('db:restoreStudent', async (_, id) => {
      return await dbApi.restoreStudent(id);
    });
    
    ipcMain.handle('db:permanentDeleteQuiz', async (_, id) => {
      return await dbApi.permanentDeleteQuiz(id);
    });
    
    ipcMain.handle('db:permanentDeleteQuizzes', async (_, quizIds) => {
      return await dbApi.permanentDeleteQuizzes(quizIds);
    });
    
    ipcMain.handle('db:permanentDeleteStudent', async (_, id) => {
      return await dbApi.permanentDeleteStudent(id);
    });

    ipcMain.handle('db:restoreSession', async (_, id) => {
      return await dbApi.restoreSession(id);
    });

    ipcMain.handle('db:restoreSessions', async (_, sessionIds) => {
      return await dbApi.restoreSessions(sessionIds);
    });

    ipcMain.handle('db:permanentDeleteSession', async (_, id) => {
      return await dbApi.permanentDeleteSession(id);
    });

    ipcMain.handle('db:permanentDeleteSessions', async (_, sessionIds) => {
      return await dbApi.permanentDeleteSessions(sessionIds);
    });

    ipcMain.handle('db:getQuestionsByQuiz', async (_, quizId) => {
      return await dbApi.getQuestionsByQuiz(quizId);
    });

    ipcMain.handle('db:getSessionById', async (_, sessionId) => {
      return await dbApi.getSessionById(sessionId);
    });

    ipcMain.handle('db:toggleShowAnswers', async (_, sessionId) => {
      return await dbApi.toggleShowAnswers(sessionId);
    });

    ipcMain.handle('db:getSessionQuestionsAndAnswers', async (_, sessionId) => {
      return await dbApi.getSessionQuestionsAndAnswers(sessionId);
    });

    // CSV export handler
    ipcMain.handle('export-csv', async (_, sessionId) => {
      try {
        const submissions = await dbApi.getSubmissionsBySession(sessionId);
        
        // Create CSV content
        const headers = ['Registration Number', 'Roll Number', 'Name', 'Semester', 'Score'];
        const csvLines = [headers.join(',')];
        
        submissions.forEach(sub => {
          csvLines.push([
            sub.registration_number || '',
            sub.roll,
            `"${sub.name.replace(/"/g, '""')}"`, // Escape quotes in name
            sub.semester || '',
            sub.score
          ].join(','));
        });
        
        const csvContent = csvLines.join('\n');
        
        // Show save dialog
        const { filePath } = await dialog.showSaveDialog(mainWindow, {
          title: 'Save CSV',
          defaultPath: `session_${sessionId}_results.csv`,
          filters: [{ name: 'CSV Files', extensions: ['csv'] }]
        });
        
        if (!filePath) return false; // User cancelled
        
        fs.writeFileSync(filePath, csvContent);
        return true;
      } catch (err) {
        console.error('CSV export error:', err);
        return false;
      }
    });

    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  } catch (err) {
    console.error("Failed to initialize app", err);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (isServerRunning) {
    stopServer();
  }
  if (process.platform !== 'darwin') app.quit();
});
