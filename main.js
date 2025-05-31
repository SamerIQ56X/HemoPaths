// main.js - Updated for frameless window, caching, full IPC handlers, and auto-updater setup

const { app, BrowserWindow, Menu, net, ipcMain, dialog } = require('electron');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');
const { autoUpdater } = require("electron-updater"); // For auto-updates
const log = require('electron-log'); // For logging, especially for auto-updater

// Configure electron-log
log.transports.file.level = "info";
autoUpdater.logger = log;
autoUpdater.autoDownload = false; // Optional: set to true to auto-download updates

let mainWindow;
const liveUrl = 'https://hemopaths.vercel.app'; // Your live site URL (if any)
const localCacheFileName = 'cached_index.html';
const localCacheDirPath = app.getPath('userData');
const localCachePath = path.join(localCacheDirPath, localCacheFileName);
const defaultErrorPageFileName = 'error_page.html';
const defaultErrorPagePath = path.join(__dirname, defaultErrorPageFileName);

// Ensure userData directory exists
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
                <meta charset="UTF-8">
                <title>Application Offline</title>
                <style>
                    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen-Sans, Ubuntu, Cantarell, "Helvetica Neue", sans-serif; text-align: center; padding: 40px; color: #333; background-color: #f8f9fa; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
                    .container { max-width: 600px; margin: auto; background-color: #fff; padding: 30px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
                    h1 { color: #d9534f; margin-bottom: 15px; font-size: 1.8em;}
                    p { font-size: 1.1em; line-height: 1.6; color: #555; margin-bottom: 10px;}
                    .suggestion { margin-top: 20px; font-size: 0.95em; color: #777;}
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>Oops, Content Could Not Be Loaded</h1>
                    <p>It seems the application is currently offline or encountered an issue retrieving the latest data.</p>
                    <p class="suggestion">Please check your internet connection and try again. If you've used the application before while online, a cached version of the content might be displayed if available.</p>
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
        const hostResolved = await new Promise(resolve => require('dns').lookup(hostname, err => resolve(!err)));
        
        if (hostResolved) {
            log.info(`[Main Process] Successfully resolved ${hostname}. Assuming online.`);
            isEffectivelyOnline = true;
        } else {
            log.warn(`[Main Process] DNS lookup for ${hostname} failed. Checking general internet connection...`);
            isEffectivelyOnline = await new Promise(resolve => require('dns').lookup('google.com', err => resolve(!err)));
            if(isEffectivelyOnline) {
                 log.info('[Main Process] General internet connection detected, but live URL host might be down.');
            } else {
                 log.warn('[Main Process] General internet connection also failed.');
            }
        }
    } catch (e) {
        log.error('[Main Process] Error during initial connectivity check:', e.message);
        isEffectivelyOnline = false;
    }

    if (isEffectivelyOnline) {
        log.info('[Main Process] Internet connection detected. Attempting to fetch live site and update cache.');
        try {
            const response = await new Promise((resolve, reject) => {
                const request = net.request({ method: 'GET', url: liveUrl, useSessionCookies: true });
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
                    res.on('error', (err) => reject(err));
                });
                request.on('error', (err) => reject(err));
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
                await mainWindow.loadFile(localCachePath);
            } else { 
                log.warn('[Main Process] Fetching live site failed. Loading from cache or error page.');
                await loadFromCacheOrErrorPage();
            }
        } catch (fetchError) {
            log.error('[Main Process] Error fetching live site. Loading from cache or error page:', fetchError.message);
            await loadFromCacheOrErrorPage();
        }
    } else {
        log.info('[Main Process] No internet connection detected. Loading from local cache or error page.');
        await loadFromCacheOrErrorPage();
    }
}

async function loadFromCacheOrErrorPage() {
    try {
        if (fsSync.existsSync(localCachePath)) {
            log.info('[Main Process] Loading from local cache:', localCachePath);
            await mainWindow.loadFile(localCachePath);
        } else {
            log.warn('[Main Process] Local cache not found. Loading default error page.');
            await mainWindow.loadFile(defaultErrorPagePath);
        }
    } catch (cacheOrErrorPageError) {
        log.error('[Main Process] Error loading from cache or default error page:', cacheOrErrorPageError);
        mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent('<h1>Critical Error</h1><p>Application could not load any content, and the default error page was also not found or failed to load.</p>')}`);
    }
}

function setupAutoUpdater(windowInstance) {
    log.info('Setting up auto-updater...');
    
    // Check for updates immediately if you want, or wait for user action
    // autoUpdater.checkForUpdatesAndNotify(); 

    ipcMain.on('check-for-updates', () => {
        log.info('Renderer requested update check.');
        if (windowInstance) {
             windowInstance.webContents.send('update-status-message', 'Checking for updates...');
        }
        autoUpdater.checkForUpdates();
    });

    autoUpdater.on('update-available', (info) => {
        log.info('Update available.', info);
        if (windowInstance) {
            windowInstance.webContents.send('update-status-message', `Update available (v${info.version}). Downloading...`);
            // If autoDownload is false, you might want to ask the user if they want to download
            // For now, assuming autoDownload = true or you trigger download here
            autoUpdater.downloadUpdate(); 
        }
    });

    autoUpdater.on('update-not-available', (info) => {
        log.info('Update not available.', info);
        if (windowInstance) {
            windowInstance.webContents.send('update-status-message', 'You are on the latest version.');
        }
    });

    autoUpdater.on('error', (err) => {
        log.error('Error in auto-updater. ' + err);
        if (windowInstance) {
            windowInstance.webContents.send('update-status-message', `Error checking for updates: ${err.message}`);
        }
    });

    autoUpdater.on('download-progress', (progressObj) => {
        let log_message = "Download speed: " + Math.round(progressObj.bytesPerSecond / 1024) + " KB/s";
        log_message = log_message + ' - Downloaded ' + Math.round(progressObj.percent) + '%';
        log_message = log_message + ' (' + Math.round(progressObj.transferred / (1024*1024)) + "MB/" + Math.round(progressObj.total / (1024*1024)) + 'MB)';
        log.info(log_message);
        if (windowInstance) {
            windowInstance.webContents.send('update-status-message', `Downloading update: ${Math.round(progressObj.percent)}%`);
        }
    });

    autoUpdater.on('update-downloaded', (info) => {
        log.info('Update downloaded.', info);
        if (windowInstance) {
            windowInstance.webContents.send('update-status-message', 'Update downloaded. Restart the app to install.');
            dialog.showMessageBox(windowInstance, {
                type: 'info',
                title: 'Update Ready',
                message: 'A new version has been downloaded. Restart the application to apply the updates.',
                buttons: ['Restart Now', 'Later']
            }).then(({response}) => { // Destructure to get response
                if (response === 0) { // Restart Now button
                    autoUpdater.quitAndInstall(true, true); // true for isSilent, true for isForceRunAfter
                }
            });
        }
    });
}


async function createWindow() {
 mainWindow = new BrowserWindow({
    width: 1300,
    height: 720,
    frame: false, 
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    }
 });

 Menu.setApplicationMenu(null);

 await createDefaultErrorPageIfMissing();
 await loadInitialContent();

 // After window is created and content loaded, setup auto-updater
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
ipcMain.on('minimize-window', () => { if (mainWindow) mainWindow.minimize(); });
ipcMain.on('close-window', () => { if (mainWindow) mainWindow.close(); });

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
