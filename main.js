'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { Database } = require('./src/db');
const { PayrollService } = require('./src/service');

let svc;
let win;

const ALLOWED = new Set([
  'getSettings', 'saveSettings', 'listEmployees', 'saveEmployee', 'deleteEmployee', 'listBanks',
  'getWeek', 'setWeekClosed', 'syncFromGoogle', 'importFile', 'setShiftManual', 'setEvent',
  'calculate', 'preflight', 'confirm', 'unlock', 'history', 'importAccounts', 'exportAccountTemplate', 'transferQrs', 'markPaid', 'addEmployeesAndReimport',
]);

function dataDir() { return app.getPath('userData'); }

function log(...a) {
  try { fs.mkdirSync(dataDir(), { recursive: true }); fs.appendFileSync(path.join(dataDir(), 'log.txt'), `[${new Date().toISOString()}] ${a.join(' ')}\n`); } catch (_) { /* ignore */ }
}
process.on('uncaughtException', (e) => log('uncaught', e.stack || e));
process.on('unhandledRejection', (e) => log('unhandled', (e && e.stack) || e));

function backupDb(dbFile) {
  if (!fs.existsSync(dbFile)) return;
  const dir = path.join(dataDir(), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const d = new Date();
  const name = `payroll-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.db`;
  const target = path.join(dir, name);
  if (!fs.existsSync(target)) fs.copyFileSync(dbFile, target);
  const all = fs.readdirSync(dir).filter((f) => f.endsWith('.db')).sort();
  for (const f of all.slice(0, Math.max(0, all.length - 30))) fs.rmSync(path.join(dir, f), { force: true });
}

async function boot() {
  log('start', app.getVersion(), 'packaged=' + app.isPackaged);
  const dbFile = path.join(dataDir(), 'payroll.db');
  backupDb(dbFile);
  const bundledWasm = path.join(__dirname, 'sql-wasm.wasm');
  const db = await Database.open(dbFile, fs.existsSync(bundledWasm) ? { wasmPath: bundledWasm } : {});
  const templatePath = [
    path.join(process.resourcesPath, 'mau_thanh_toan.xlsx'),
    path.join(path.dirname(app.getAppPath()), 'mau_thanh_toan.xlsx'),
    path.join(__dirname, 'resources', 'mau_thanh_toan.xlsx'),
    path.join(__dirname, '..', 'resources', 'mau_thanh_toan.xlsx'),
  ].find((p) => fs.existsSync(p));
  if (!templatePath) log('KHÔNG tìm thấy mau_thanh_toan.xlsx');
  svc = new PayrollService(db, { templatePath, defaultExportFolder: path.join(app.getPath('documents'), 'TinhLuong') });
  await svc.init();
  log('ready');
}

function createWindow() {
  win = new BrowserWindow({
    width: 1360, height: 860, minWidth: 1100, minHeight: 680,
    title: 'Tính lương', backgroundColor: '#f6f5f2',
    icon: fs.existsSync(path.join(__dirname, 'icon.png')) ? path.join(__dirname, 'icon.png') : path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

ipcMain.handle('call', async (_e, method, args) => {
  if (!ALLOWED.has(method)) return { ok: false, error: 'Không hỗ trợ: ' + method };
  try {
    const value = await svc[method](...(args || []));
    return { ok: true, value };
  } catch (err) {
    return { ok: false, error: err.message, details: err.details || null };
  }
});

ipcMain.handle('pickFile', async (_e, opts = {}) => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: opts.filters || [] , title: opts.title });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('pickFolder', async (_e, opts = {}) => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], title: opts.title, defaultPath: opts.defaultPath });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('saveFile', async (_e, opts = {}) => {
  const r = await dialog.showSaveDialog(win, { defaultPath: opts.defaultPath ? path.join(app.getPath('documents'), opts.defaultPath) : undefined, filters: opts.filters || [] });
  return r.canceled ? null : r.filePath;
});
ipcMain.handle('openPath', async (_e, p) => shell.openPath(p));
ipcMain.handle('showInFolder', async (_e, p) => { shell.showItemInFolder(p); return true; });
ipcMain.handle('openDataFolder', async () => shell.openPath(dataDir()));
ipcMain.handle('appInfo', async () => ({ version: app.getVersion(), dataDir: dataDir(), packaged: app.isPackaged }));

// ---------- Tự cập nhật từ GitHub Releases ----------
let updater = null;
const updateState = { status: 'idle', version: null, percent: 0, error: null };
function setUpdate(patch) {
  Object.assign(updateState, patch);
  if (win && !win.isDestroyed()) win.webContents.send('update', { ...updateState });
}
function initUpdater() {
  if (!app.isPackaged) return;
  try {
    ({ autoUpdater: updater } = require('electron-updater'));
  } catch (e) { log('updater unavailable', e.message); return; }
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true; // tắt app là tự cài bản đã tải
  updater.on('checking-for-update', () => setUpdate({ status: 'checking', error: null }));
  updater.on('update-available', (i) => setUpdate({ status: 'downloading', version: i.version, percent: 0 }));
  updater.on('update-not-available', () => setUpdate({ status: 'none' }));
  updater.on('download-progress', (p) => setUpdate({ status: 'downloading', percent: Math.round(p.percent) }));
  updater.on('update-downloaded', (i) => { log('update downloaded', i.version); setUpdate({ status: 'downloaded', version: i.version, percent: 100 }); });
  updater.on('error', (e) => { log('update error', e.message); setUpdate({ status: 'error', error: e.message }); });
  setTimeout(() => updater.checkForUpdates().catch(() => {}), 5000);
  setInterval(() => updater.checkForUpdates().catch(() => {}), 6 * 60 * 60 * 1000);
}
ipcMain.handle('updateState', async () => ({ ...updateState, enabled: !!updater }));
ipcMain.handle('checkUpdate', async () => {
  if (!updater) return { ...updateState, enabled: false };
  try { await updater.checkForUpdates(); } catch (e) { setUpdate({ status: 'error', error: e.message }); }
  return { ...updateState, enabled: true };
});
ipcMain.handle('installUpdate', async () => {
  if (updater && updateState.status === 'downloaded') { log('installing update', updateState.version); setImmediate(() => updater.quitAndInstall(false, true)); }
  return true;
});

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

app.whenReady().then(async () => {
  try { await boot(); } catch (e) { log('boot failed', e.stack || e); dialog.showErrorBox('Không mở được dữ liệu', e.stack || String(e)); app.quit(); return; }
  createWindow();
  initUpdater();
});
app.on('window-all-closed', () => app.quit());
