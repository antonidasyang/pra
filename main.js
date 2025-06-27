const { app, BrowserWindow, ipcMain, session } = require('electron')
const fs = require('fs')
const path = require('path')
require('@electron/remote/main').initialize()

// 版本管理和更新清单
const VERSION_STORAGE_FILE = path.join(app.getPath('userData'), 'app-version.json')
const packageJson = require('./package.json')
const CURRENT_VERSION = packageJson.version

// 读取并解析 Markdown 格式的更新记录
function parseChangelog() {
  try {
    const changelogPath = path.join(__dirname, 'CHANGELOG.md')
    const changelogContent = fs.readFileSync(changelogPath, 'utf8')
    
    // 简单解析Markdown中的版本信息
    const versionSections = []
    const lines = changelogContent.split('\n')
    let currentVersion = null
    let currentChanges = []
    
    for (const line of lines) {
      // 匹配版本号行 (## 版本 x.x.x)
      const versionMatch = line.match(/^## 版本\s+(\d+\.\d+\.\d+)/)
      if (versionMatch) {
        // 保存前一个版本的信息
        if (currentVersion && currentChanges.length > 0) {
          versionSections.push({
            version: currentVersion,
            changes: currentChanges.slice()
          })
        }
        // 开始新版本
        currentVersion = versionMatch[1]
        currentChanges = []
      }
      // 匹配更新项 (- 内容)
      else if (line.trim().startsWith('-') && currentVersion) {
        const change = line.trim().substring(1).trim()
        if (change) {
          currentChanges.push(change)
        }
      }
    }
    
    // 添加最后一个版本
    if (currentVersion && currentChanges.length > 0) {
      versionSections.push({
        version: currentVersion,
        changes: currentChanges
      })
    }
    
    return versionSections
  } catch (error) {
    console.error('解析更新记录失败:', error)
    return []
  }
}

// 读取存储的版本信息
function getStoredVersion() {
  try {
    if (fs.existsSync(VERSION_STORAGE_FILE)) {
      const data = fs.readFileSync(VERSION_STORAGE_FILE, 'utf8')
      const versionData = JSON.parse(data)
      return versionData.version || null
    }
  } catch (error) {
    console.error('读取版本信息失败:', error)
  }
  return null
}

// 保存当前版本信息
function saveCurrentVersion() {
  try {
    const versionData = {
      version: CURRENT_VERSION,
      lastUpdated: new Date().toISOString()
    }
    fs.writeFileSync(VERSION_STORAGE_FILE, JSON.stringify(versionData, null, 2))
  } catch (error) {
    console.error('保存版本信息失败:', error)
  }
}

// 检查是否是首次运行或版本更新
function checkVersionUpdate() {
  const storedVersion = getStoredVersion()
  
  // 解析更新记录
  const allChangelogs = parseChangelog()
  
  if (!storedVersion) {
    // 首次运行
    saveCurrentVersion()
    return {
      isFirstRun: true,
      isUpdate: false,
      currentVersion: CURRENT_VERSION,
      previousVersion: null,
      allChangelogs,
      changelogMarkdown: getChangelogMarkdown()
    }
  }
  
  if (storedVersion !== CURRENT_VERSION) {
    // 版本更新
    saveCurrentVersion()
    return {
      isFirstRun: false,
      isUpdate: true,
      currentVersion: CURRENT_VERSION,
      previousVersion: storedVersion,
      allChangelogs,
      changelogMarkdown: getChangelogMarkdown()
    }
  }
  
  // 正常运行，无更新
  return {
    isFirstRun: false,
    isUpdate: false,
    currentVersion: CURRENT_VERSION,
    previousVersion: storedVersion,
    allChangelogs: [],
    changelogMarkdown: ''
  }
}

// 获取完整的 Markdown 内容
function getChangelogMarkdown() {
  try {
    const changelogPath = path.join(__dirname, 'CHANGELOG.md')
    const content = fs.readFileSync(changelogPath, 'utf8')
    
    // 提取版本历史部分（去掉底部的使用说明）
    const lines = content.split('\n')
    const endIndex = lines.findIndex(line => line.includes('## 如何添加新版本'))
    
    if (endIndex > 0) {
      return lines.slice(0, endIndex).join('\n').trim()
    }
    
    return content
  } catch (error) {
    console.error('读取更新记录失败:', error)
    return ''
  }
}

// 注册版本检查IPC处理器
ipcMain.handle('check-version-update', () => {
  return checkVersionUpdate()
})

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
    autoHideMenuBar: true, // 隐藏菜单栏
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