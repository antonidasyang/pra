const { app, BrowserWindow, ipcMain, session } = require('electron')
require('@electron/remote/main').initialize()

// 设置全局代理
function setGlobalProxy(proxyUrl) {
  if (proxyUrl) {
    const url = new URL(proxyUrl);
    const proxyConfig = {
      proxyRules: `${url.protocol}//${url.hostname}:${url.port}`
    };
    
    // 设置默认session的代理
    session.defaultSession.setProxy(proxyConfig).then(() => {
      // 代理设置成功
    }).catch((error) => {
      console.error('设置代理失败:', error);
    });
    
    // 同时设置环境变量作为备用
    process.env.HTTP_PROXY = proxyUrl;
    process.env.HTTPS_PROXY = proxyUrl;
    process.env.http_proxy = proxyUrl;
    process.env.https_proxy = proxyUrl;
  } else {
    // 清除代理
    session.defaultSession.setProxy({}).then(() => {
      // 代理清除成功
    }).catch((error) => {
      console.error('清除代理失败:', error);
    });
    
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    delete process.env.http_proxy;
    delete process.env.https_proxy;
  }
}

// 注册IPC处理器
ipcMain.on('set-global-proxy', (event, { proxyUrl }) => {
  try {
    session.defaultSession.setProxy({
      proxyRules: proxyUrl
    });
    event.reply('proxy-set', { success: true });
  } catch (error) {
    event.reply('proxy-set', { success: false, error: error.message });
  }
});

ipcMain.on('clear-global-proxy', (event) => {
  try {
    session.defaultSession.setProxy({
      proxyRules: 'direct://'
    });
    event.reply('proxy-set', { success: true });
  } catch (error) {
    event.reply('proxy-set', { success: false, error: error.message });
  }
});

const createWindow = () => {
  const win = new BrowserWindow({
    width: 1600,
    height: 900,
    icon: './assets/icon.ico',
    show: false, // 先不显示窗口
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: false,
      enableRemoteModule: true
    }
  })

  require('@electron/remote/main').enable(win.webContents)
  win.loadFile('index.html')
  
  // 窗口准备好后最大化显示
  win.once('ready-to-show', () => {
    win.maximize()  // 最大化窗口
    win.show()      // 显示窗口
  })
  
  // 开发时打开开发者工具
  // win.webContents.openDevTools()
}

app.whenReady().then(() => {
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
})