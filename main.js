const { app, BrowserWindow } = require('electron');
const path = require('path');
const { spawn } = require('child_process');

let win, agentChild;

function startAgentServer() {
  const serverPath = path.join(__dirname, 'agent', 'server.js');
  agentChild = spawn(process.execPath, [serverPath], {
    env: { ...process.env },
    stdio: 'inherit'
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 720,
    height: 560,
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
  startAgentServer();
  createWindow();
});

app.on('before-quit', () => {
  if (agentChild) {
    try { agentChild.kill(); } catch(e){}
  }
});
