// main.js - Updated for frameless window, caching, full IPC handlers, and auto-updater setup

const { app, BrowserWindow, Menu, net, ipcMain, dialog } = require('electron');
const fs = require('fs').promises;
const fsSync = require('fs'); // For synchronous operations like existsSync
const path = require('path');
const crypto = require('crypto');
const { autoUpdater } = require("electron-updater"); 
const log = require('electron-log'); 

// Configure electron-log: Options: error, warn, info, verbose, debug, silly. Default: info
log.transports.file.level = "info";
// Ensure the path is correct based on your electron-log version.
// For v5.x log.transports.file.resolvePathFn is correct. For older v4.x it was resolvePath.
if (typeof log.transports.file.resolvePathFn === 'function') {
    log.transports.file.resolvePathFn = () => path.join(app.getPath('userData'), 'logs/main.log');
} else if (typeof log.transports.file.resolvePath === 'function') { // Fallback for older electron-log
    log.transports.file.resolvePath = () => path.join(app.getPath('userData'), 'logs/main.log');
} else {
    console.warn("[Main Process] Could not set custom log path for electron-log. Using default.");
    log.warn("[Main Process] Ensure electron-log is version 5.x for resolvePathFn or adjust accordingly for v4.x (resolvePath).");
}
autoUpdater.logger = log;
autoUpdater.autoDownload = false; // User will be prompted or it will download after 'update-available'
                                 // Set to true if you want silent auto-download

let mainWindow;
const liveUrl = 'https://hemopaths.vercel.app'; // Your live site URL
const localCacheFileName = 'cached_index.html';
const localCacheDirPath = app.getPath('userData');
const localCachePath = path.join(localCacheDirPath, localCacheFileName);
const defaultErrorPageFileName = 'error_page.html'; // This file should be in the same directory as main.js or adjust path
const defaultErrorPagePath = path.join(__dirname, defaultErrorPageFileName); 

if (!fsSync.existsSync(localCacheDirPath)) {
    try {
        fsSync.mkdirSync(localCacheDirPath, { recursive: true });
        log.info('[Main Process] User data directory created at:', localCacheDirPath);
    } catch (mkdirError) {
        log.error('[Main Process] Failed to create user data directory:', mkdirError);
    }
}

function calculateHash(content) {
    if (typeof content !== 'string') return '';
    return crypto.createHash('sha256').update(content).digest('hex');
}

async function createDefaultErrorPageIfMissing() {
    if (!fsSync.existsSync(defaultErrorPagePath)) {
        const defaultHtmlContent = `
            <!DOCTYPE html>
            <html lang="en" dir="ltr">
            <head>
                <meta charset="UTF-8"><title>Application Offline</title>
                <style>
                    body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; text-align: center; padding: 50px; background-color: #12121a; color: #e0e0e0; display: flex; flex-direction: column; justify-content: center; align-items: center; height: 100vh; margin: 0; }
                    .container { max-width: 500px; background-color: #1e1e2f; padding: 30px 40px; border-radius: 12px; box-shadow: 0 5px 25px rgba(0,0,0,0.3); }
                    h1 { color: #ff6b6b; margin-bottom: 20px; font-size: 1.8em;}
                    p { font-size: 1.1em; line-height: 1.6; color: #b0b8c0; margin-bottom: 15px;}
                    .suggestion { margin-top: 25px; font-size: 0.9em; color: #8892a0;}
                    a { color: #4fc3f7; text-decoration: none; }
                    a:hover { text-decoration: underline; }
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>Oops, Content Could Not Be Loaded</h1>
                    <p>The application is currently offline or had trouble fetching the latest data from the server.</p>
                    <p class="suggestion">Please check your internet connection. If you've used the app online before, a cached version might be available.</p>
                </div>
            </body>
            </html>`;
        try {
            await fs.writeFile(defaultErrorPagePath, defaultHtmlContent, 'utf-8');
            log.info('[Main Process] Default error page created at:', defaultErrorPagePath);
        } catch (error) {
            log.error('[Main Process] Could not create default error page:', error);
        }
    }
}

async function loadInitialContent() {
    let isEffectivelyOnline = false;
    try {
        const { hostname } = new URL(liveUrl);
        const hostResolved = await new Promise(resolve => {
            require('dns').lookup(hostname, (err) => {
                if (err && (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN')) { 
                    log.warn(`[Main Process] DNS lookup for ${hostname} failed (${err.code}).`);
                    resolve(false);
                } else if (err) {
                    log.warn(`[Main Process] DNS lookup for ${hostname} failed with other error: ${err.message}.`);
                    resolve(false);
                } else {
                    log.info(`[Main Process] Successfully resolved ${hostname}.`);
                    resolve(true);
                }
            });
        });
        
        if (hostResolved) {
            isEffectivelyOnline = true;
        } else {
            log.warn(`[Main Process] Host-specific DNS lookup failed for ${hostname}. Checking general internet connection...`);
            isEffectivelyOnline = await new Promise(resolve => {
                require('dns').lookup('google.com', (err) => { // Using google.com as a general check
                    if (err) {
                        log.warn('[Main Process] General internet connection check (google.com) failed.');
                        resolve(false);
                    } else {
                        log.info('[Main Process] General internet connection detected.');
                        resolve(true);
                    }
                });
            });
        }
    } catch (e) {
        log.error('[Main Process] Error during initial connectivity check (URL parsing or DNS module issue):', e.message);
        isEffectivelyOnline = false;
    }

    if (isEffectivelyOnline && mainWindow && !mainWindow.isDestroyed()) {
        log.info('[Main Process] Internet connection detected. Attempting to fetch live site and update cache.');
        try {
            const response = await new Promise((resolve, reject) => {
                const request = net.request({ method: 'GET', url: liveUrl, useSessionCookies: true, timeout: 15000 });
                let newContentBuffer = Buffer.alloc(0);
                request.on('response', (res) => {
                    log.info(`[Main Process] Live site response status: ${res.statusCode}`);
                    res.on('data', (chunk) => newContentBuffer = Buffer.concat([newContentBuffer, chunk]));
                    res.on('end', () => {
                        if (res.statusCode >= 200 && res.statusCode < 300) {
                            resolve({ success: true, content: newContentBuffer.toString('utf-8') });
                        } else {
                            reject(new Error(`Failed to fetch live content. Status: ${res.statusCode}`));
                        }
                    });
                    res.on('error', (err) => { log.error('[Main Process] Response error from live site:', err); reject(err);});
                });
                request.on('error', (err) => { log.error('[Main Process] Request error for live content:', err); reject(err); });
                request.on('timeout', () => { log.error('[Main Process] Request for live content timed out.'); reject(new Error('Request timed out')); });
                request.end();
            });

            if (response.success && response.content) {
                const newContent = response.content;
                log.info('[Main Process] Successfully fetched live content.');
                let oldContent = '';
                try {
                    if (fsSync.existsSync(localCachePath)) {
                        oldContent = await fs.readFile(localCachePath, 'utf-8');
                    }
                } catch (readError) {
                    log.warn('[Main Process] No local cache or error reading it:', readError.message);
                }

                if (calculateHash(newContent) !== calculateHash(oldContent)) {
                    log.info('[Main Process] Live content is different. Updating local cache.');
                    try {
                        await fs.writeFile(localCachePath, newContent, 'utf-8');
                        log.info('[Main Process] Local cache updated at:', localCachePath);
                    } catch (writeError) {
                        log.error('[Main Process] Failed to write to local cache:', writeError);
                        await loadFromCacheOrErrorPage(); return;
                    }
                } else {
                    log.info('[Main Process] Live content is same as local cache.');
                }
                log.info('[Main Process] Loading latest content (from cache after check):', localCachePath);
                if (mainWindow && !mainWindow.isDestroyed()) await mainWindow.loadFile(localCachePath);
            } else { 
                log.warn('[Main Process] Fetching live site failed. Loading from cache or error page.');
                await loadFromCacheOrErrorPage();
            }
        } catch (fetchError) {
            log.error('[Main Process] Error fetching live site. Loading from cache or error page:', fetchError.message);
            await loadFromCacheOrErrorPage();
        }
    } else if (mainWindow && !mainWindow.isDestroyed()) { 
        log.info('[Main Process] No internet connection detected or mainWindow not ready. Loading from local cache or error page.');
        await loadFromCacheOrErrorPage();
    }
}

async function loadFromCacheOrErrorPage() {
    if (!mainWindow || mainWindow.isDestroyed()) {
        log.warn('[Main Process] Cannot load from cache or error page: mainWindow is not available.');
        return;
    }
    try {
        if (fsSync.existsSync(localCachePath)) {
            log.info('[Main Process] Loading from local cache:', localCachePath);
            await mainWindow.loadFile(localCachePath);
        } else {
            log.warn('[Main Process] Local cache not found. Loading default error page.');
            if (fsSync.existsSync(defaultErrorPagePath)) {
                await mainWindow.loadFile(defaultErrorPagePath);
            } else {
                 log.error('[Main Process] CRITICAL: Default error page not found at', defaultErrorPagePath);
                 mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent('<h1>Critical Error</h1><p>Application could not load any content and the default error page was also not found.</p>')}`);
            }
        }
    } catch (cacheOrErrorPageError) {
        log.error('[Main Process] Error loading from cache or default error page:', cacheOrErrorPageError);
        mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent('<h1>Critical Error</h1><p>Application could not load any content, and the default error page was also not found or failed to load.</p>')}`);
    }
}

function setupAutoUpdater(windowInstance) {
    if (!windowInstance) {
        log.error('[AutoUpdater] Cannot setup: mainWindow is not defined.');
        return;
    }
    log.info('[AutoUpdater] Setting up auto-updater...');
    
    ipcMain.on('check-for-updates', () => {
        log.info('[AutoUpdater] Renderer requested update check.');
        if (!windowInstance || windowInstance.isDestroyed()) return;
        windowInstance.webContents.send('update-status-message', 'Checking for updates...');
        autoUpdater.checkForUpdates();
    });

    autoUpdater.on('update-available', (info) => {
        log.info('[AutoUpdater] Update available.', info);
        if (!windowInstance || windowInstance.isDestroyed()) return;
        windowInstance.webContents.send('update-status-message', `Update available (v${info.version}). Downloading...`);
        autoUpdater.downloadUpdate(); 
    });

    autoUpdater.on('update-not-available', (info) => {
        log.info('[AutoUpdater] Update not available.', info);
        if (!windowInstance || windowInstance.isDestroyed()) return;
        windowInstance.webContents.send('update-status-message', 'You are on the latest version.');
    });

    autoUpdater.on('error', (err) => {
        log.error('[AutoUpdater] Error: ' + (err.message || err));
        if (!windowInstance || windowInstance.isDestroyed()) return;
        windowInstance.webContents.send('update-status-message', `Error checking for updates: ${err.message || 'Unknown error'}`);
    });

    autoUpdater.on('download-progress', (progressObj) => {
        let log_message = "Download speed: " + Math.round(progressObj.bytesPerSecond / 1024) + " KB/s";
        log_message += ' - Downloaded ' + Math.round(progressObj.percent) + '%';
        log_message += ' (' + Math.round(progressObj.transferred / (1024*1024)) + "MB/" + Math.round(progressObj.total / (1024*1024)) + 'MB)';
        log.info(log_message);
        if (!windowInstance || windowInstance.isDestroyed()) return;
        windowInstance.webContents.send('update-status-message', `Downloading update: ${Math.round(progressObj.percent)}%`);
    });

    autoUpdater.on('update-downloaded', (info) => {
        log.info('[AutoUpdater] Update downloaded.', info);
        if (!windowInstance || windowInstance.isDestroyed()) return;
        windowInstance.webContents.send('update-status-message', 'Update downloaded. Restart the app to install.');
        dialog.showMessageBox(windowInstance, {
            type: 'info',
            title: 'Update Ready',
            message: 'A new version has been downloaded. Restart the application to apply the updates.',
            buttons: ['Restart Now', 'Later']
        }).then(({response}) => { 
            if (response === 0) { 
                autoUpdater.quitAndInstall(true, true); 
            }
        });
    });
}


async function createWindow() {
 mainWindow = new BrowserWindow({
    width: 1300,
    height: 1300,
    frame: true, 
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    }
 });

 Menu.setApplicationMenu(null);

 await createDefaultErrorPageIfMissing();
 await loadInitialContent();

 setupAutoUpdater(mainWindow);


 mainWindow.on('closed', function () {
    mainWindow = null;
 });
}

app.whenReady().then(() => {
    createWindow();
    app.on('activate', function () {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') app.quit();
});

// --- IPC Handlers ---

ipcMain.on('open-file-dialog-for-files', (event) => {
    if (!mainWindow) return;
    dialog.showOpenDialog(mainWindow, {
        properties: ['openFile', 'multiSelections'],
        filters: [ { name: 'Adobe Project Files', extensions: ['psd', 'aep', 'prproj'] }, { name: 'All Files', extensions: ['*'] } ]
    }).then(result => {
        event.sender.send('selected-files-for-files', (!result.canceled && result.filePaths.length > 0) ? result.filePaths : []);
    }).catch(err => { log.error('[IPC] Error opening file dialog (for files):', err); event.sender.send('selected-files-for-files', []); });
});

ipcMain.on('open-folder-dialog-for-link', (event) => {
    if (!mainWindow) return;
    dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'multiSelections'] })
    .then(result => {
        event.sender.send('selected-folder-for-link', (!result.canceled && result.filePaths.length > 0) ? result.filePaths : []);
    }).catch(err => { log.error('[IPC] Error opening folder dialog (for link):', err); event.sender.send('selected-folder-for-link', []); });
});

ipcMain.on('open-folder-dialog-for-import', (event) => {
    if (!mainWindow) return;
    dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] })
    .then(result => {
        if (!result.canceled && result.filePaths.length > 0) {
            const folderPath = result.filePaths[0];
            fs.readdir(folderPath, { withFileTypes: true })
              .then(dirents => {
                  const filesInFolder = dirents.filter(d => d.isFile()).map(d => ({ path: path.join(folderPath, d.name), name: d.name }));
                  event.sender.send('selected-folder-for-import', filesInFolder);
              }).catch(err => { log.error('[IPC] Error reading folder for import:', err); event.sender.send('selected-folder-for-import', []); });
        } else { event.sender.send('selected-folder-for-import', []); }
    }).catch(err => { log.error('[IPC] Error opening folder dialog for import:', err); event.sender.send('selected-folder-for-import', []); });
});

ipcMain.on('process-pasted-path', (event, pastedPath) => {
    if (!pastedPath || typeof pastedPath !== 'string' || pastedPath.trim() === '') {
        return event.sender.send('pasted-path-error', { message: 'Pasted path is invalid or empty.', originalPath: pastedPath });
    }
    if (pastedPath.toLowerCase().startsWith('http://') || pastedPath.toLowerCase().startsWith('https://')) {
        log.info('[Main Process] Pasted path is a URL:', pastedPath);
        const items = [{ path: pastedPath, name: pastedPath, entryType: 'websiteLink' }];
        event.sender.send('pasted-path-processed', { items: items, originalPath: pastedPath });
        return;
    }
    fs.stat(pastedPath)
      .then(stats => {
          const items = [];
          if (stats.isFile()) { items.push({ path: pastedPath, name: path.basename(pastedPath), entryType: 'file' }); }
          else if (stats.isDirectory()) { items.push({ path: pastedPath, name: path.basename(pastedPath), entryType: 'folderLink' }); }
          else { return event.sender.send('pasted-path-error', { message: 'Path is not a file or directory.', originalPath: pastedPath }); }
          event.sender.send('pasted-path-processed', { items: items, originalPath: pastedPath });
      })
      .catch(err => event.sender.send('pasted-path-error', { message: 'Path not found or inaccessible.', originalPath: pastedPath }));
});

// Window Controls IPC
ipcMain.on('minimize-window', () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize(); });
ipcMain.on('close-window', () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close(); });

// File Operations IPC Handlers
ipcMain.handle('save-dialog', async (event, data) => {
    if (!mainWindow) throw new Error('Main window not available for save dialog.');
    const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, {
        title: 'Save Project As',
        defaultPath: path.join(app.getPath('documents'), 'myProject.hpmt'),
        filters: [{ name: 'Hemo Paths Manager Files', extensions: ['hpmt'] }]
    });
    if (canceled || !filePath) return null;
    await fs.writeFile(filePath, data, 'utf-8');
    return filePath;
});

ipcMain.handle('save-file', async (event, { filePath, data }) => {
    if (!filePath) throw new Error('File path not provided for saving.');
    await fs.writeFile(filePath, data, 'utf-8');
    return filePath;
});

ipcMain.handle('open-dialog-for-hpmt', async (event) => {
    if (!mainWindow) throw new Error('Main window not available for open dialog.');
    const { filePaths, canceled } = await dialog.showOpenDialog(mainWindow, {
        title: 'Import Project File',
        properties: ['openFile'],
        filters: [{ name: 'Hemo Paths Manager Files', extensions: ['hpmt'] }]
    });
    if (canceled || filePaths.length === 0) return null;
    const filePath = filePaths[0];
    const content = await fs.readFile(filePath, 'utf-8');
    return { filePath, content };
});

ipcMain.handle('read-file', async (event, filePath) => {
    if (!filePath) throw new Error('File path not provided for reading.');
    return await fs.readFile(filePath, 'utf-8');
});
