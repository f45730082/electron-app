const { app, BrowserWindow, ipcMain, protocol, session } = require('electron')
const path = require('path')
const http = require('http')
const fs = require('fs')
const https = require('https')
const { HttpProxyAgent } = require('http-proxy-agent')
const { HttpsProxyAgent } = require('https-proxy-agent')
const netModule = require('net')

let mainWindow


let flashPluginName;
switch (process.platform) {
  case 'win32':
    flashPluginName = 'pepflashplayer.dll';
    break;
  case 'darwin':
    flashPluginName = 'PepperFlashPlayer.plugin';
    break;
  // linux 探索（20250215）：
  // 1. 环境：ubuntu 22.04 | electron 4.2.11
  // 2. 结果：无法显示赛尔号的 flash 内容，但可以显示奥奇的。。。
}

//var flashurl = process.resourcesPath
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('-no-sandbox')
app.commandLine.appendSwitch("--disable-http-cache")
app.commandLine.appendSwitch("ppapi-flash-version", "99.0.0.999")
app.commandLine.appendSwitch('ppapi-flash-path', path.join(currentPath, 'file', 'flash', flashPluginName));
//app.commandLine.appendSwitch('ppapi-flash-path', flashurl + '/pepflashplayer.dll')
app.commandLine.appendSwitch('ignore-gpu-blacklist')
app.commandLine.appendSwitch('enable-gpu-rasterization')
app.commandLine.appendSwitch('enable-webgl')
app.commandLine.appendSwitch('enable-zero-copy')
app.commandLine.appendSwitch('use-angle', 'd3d11')

const BrowserWindowDict = {}
let FdDict = []
let systemProxy = null

function AppWindow() {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 620,
    title: '雪村整合',
    frame: false,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegrationInSubFrames: true,
      webviewTag: true,
      nodeIntegration: true,
      plugins: true,
    },
  })
  
  ipcMain.on('main-clearcache', (event) => {
    mainWindow.webContents.session.clearCache()
    mainWindow.webContents.session.clearStorageData()
  })
  ipcMain.on('main-min', (event) => { mainWindow.minimize()})
  ipcMain.on('main-maximize', (event) => { mainWindow.maximize()})
  ipcMain.on('main-restore', (event) => { mainWindow.restore()})
  ipcMain.on('main-close', (event) => { mainWindow.close()})
  ipcMain.on('main-size', (event, arg) => { mainWindow.setSize(arg[0],arg[1])})
  
  ipcMain.on('FdSet', (event, arg) => {
    mainWindow.webContents.send('show', arg)
    FdDict = arg
  })
  
  ipcMain.on('message', (event, data) => {
    if (data['win'] == 'main') {
      mainWindow.webContents.send(data['channel'], data['data'])
    } else {
      if (!BrowserWindowDict[data['win']] || BrowserWindowDict[data['win']].isDestroyed()) {
        return;
      }
      BrowserWindowDict[data['win']].webContents.send(data['channel'], data['data'])
    }
  })
  ipcMain.on('NewBrowserWindow', (event, WinDict) => {
    if (BrowserWindowDict[WinDict['name']] && !BrowserWindowDict[WinDict['name']].isDestroyed()) {
      BrowserWindowDict[WinDict['name']].close()
    }
    NewBrowserWindow(WinDict)
  })
  
  //mainWindow.webContents.openDevTools()
  //mainWindow.setAlwaysOnTop(true)
  mainWindow.loadURL('http://sesson.ddns.net:5002/#/App')
  mainWindow.on('closed', function () {
    mainWindow = null;
    const windows = BrowserWindow.getAllWindows()
    windows.forEach(win => win.close())
  });
}

function NewBrowserWindow(WinDict) {
  BrowserWindowDict[WinDict['name']] = new BrowserWindow({
    width: WinDict['w'] ? WinDict['w'] : 500,
    height: WinDict['h'] ? WinDict['h'] : 500,
    resizable: WinDict['resizable'],
    title: WinDict['name'],
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegrationInSubFrames: true,
      experimentalFeatures: true,
      webgl: true,
      webviewTag: true,
      nodeIntegration: true,
      contextIsolation: false,
      plugins: true
    },
  })
  
  BrowserWindowDict[WinDict['name']].loadURL('http://sesson.ddns.net:5002/#/' + WinDict['url'])
  //BrowserWindowDict[WinDict['name']].webContents.openDevTools()
  //BrowserWindowDict[WinDict['name']].setAlwaysOnTop(true)
}

// 全面攔截 + Cookie 處理 + 代理支持
const interceptRequestRemote = (request, callback) => {
  let url = request.url
  
  if (BrowserWindowDict['FdWeb'] && !BrowserWindowDict['FdWeb'].isDestroyed() && !request.url.includes('sesson.ddns.net')) {
    try {
      BrowserWindowDict['FdWeb'].webContents.send('network-data', request)
    } catch (e) {}
  }
  
  let UrlFile = null
  for (let ia = 0; ia <= FdDict.length - 1; ia++) {
    if (request.url.includes(FdDict[ia].OldUrlFile)) {
      if (FdDict[ia].Enable) {
        const newPath = FdDict[ia].NewUrlFile
        if (newPath.startsWith('http://') || newPath.startsWith('https://')) {
          url = newPath
        } else if (/^(?:[a-zA-Z]:\\|\/)/.test(newPath)) {
          UrlFile = newPath
        } else {
          UrlFile = path.join(process.cwd(), 'FDfile', newPath)
        }
      }
      break;
    }
  }

  // 處理本地文件
  if (UrlFile) {
    try {
      callback({
        statusCode: 200,
        headers: {
          'content-type': getContentType(UrlFile)
        },
        data: fs.createReadStream(UrlFile)
      })
      return  
    } catch (err) {
      console.error('[Local File Error]', UrlFile, err)
      callback({
        statusCode: 404,
        headers: {},
        data: Buffer.from('File not found: ' + UrlFile)
      })
      return
    }
  }

  // 先讀取 Cookie，然後再發送請求
  session.defaultSession.cookies.get({ url: url }).then(cookies => {
    const isHttps = url.startsWith('https')
    const client = isHttps ? https : http

    // 複製所有請求頭
    const requestHeaders = {}
    if (request.headers) {
      Object.keys(request.headers).forEach(key => {
        requestHeaders[key] = request.headers[key]
      })
    }

    // 添加 Cookie 到請求頭
    if (cookies.length > 0) {
      const cookieString = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
      requestHeaders['cookie'] = cookieString
    }

    if (request.referrer) {
      requestHeaders['referer'] = request.referrer
      
      if (!requestHeaders['origin']) {
        try {
          const refererUrl = new URL(request.referrer)
          requestHeaders['origin'] = `${refererUrl.protocol}//${refererUrl.host}`
        } catch (e) {}
      }
    }

    if (!requestHeaders['user-agent']) {
      requestHeaders['user-agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }

    if (request.method === 'POST' && !requestHeaders['content-type'] && request.uploadData) {
      let hasFormData = false
      if (request.uploadData) {
        for (const data of request.uploadData) {
          if (data.type === 'rawData') {
            hasFormData = true
            break
          }
        }
      }
      if (hasFormData) {
        requestHeaders['content-type'] = 'application/x-www-form-urlencoded'
      }
    }

    const requestOptions = {
      method: request.method,
      headers: requestHeaders,
      agent: systemProxy 
        ? (isHttps ? systemProxy.httpsAgent : systemProxy.httpAgent)
        : undefined
    }

    if (isHttps) {
      requestOptions.rejectUnauthorized = false
    }

    const req = client.request(url, requestOptions, (res) => {
      // 完整保留響應頭
      const responseHeaders = {}
      Object.keys(res.headers).forEach(key => {
        responseHeaders[key] = res.headers[key]
      })

      // 處理 Set-Cookie，保存到 Electron Session
      if (res.headers['set-cookie']) {
        const setCookieHeaders = Array.isArray(res.headers['set-cookie']) 
          ? res.headers['set-cookie'] 
          : [res.headers['set-cookie']]
        
        for (const cookieStr of setCookieHeaders) {
          try {
            const cookieParts = cookieStr.split(';')[0].split('=')
            const cookieName = cookieParts[0].trim()
            const cookieValue = cookieParts.slice(1).join('=').trim()
            
            const urlObj = new URL(url)
            let domain = urlObj.hostname
            
            const domainMatch = cookieStr.match(/domain=([^;]+)/i)
            if (domainMatch) {
              domain = domainMatch[1].trim()
              if (domain.startsWith('.')) {
                domain = domain.substring(1)
              }
            }
            
            const isSecure = /secure/i.test(cookieStr)
            const pathMatch = cookieStr.match(/path=([^;]+)/i)
            const cookiePath = pathMatch ? pathMatch[1].trim() : '/'
            
            // 檢查過期時間
            let expirationDate = undefined
            const expiresMatch = cookieStr.match(/expires=([^;]+)/i)
            const maxAgeMatch = cookieStr.match(/max-age=(\d+)/i)
            
            if (maxAgeMatch) {
              const maxAge = parseInt(maxAgeMatch[1])
              expirationDate = Math.floor(Date.now() / 1000) + maxAge
            } else if (expiresMatch) {
              const expiresDate = new Date(expiresMatch[1])
              if (!isNaN(expiresDate.getTime())) {
                expirationDate = Math.floor(expiresDate.getTime() / 1000)
              }
            }
            
            const cookie = {
              url: `${urlObj.protocol}//${domain}${cookiePath}`,
              name: cookieName,
              value: cookieValue,
              domain: domain,
              path: cookiePath,
              secure: isSecure,
              httpOnly: /httponly/i.test(cookieStr)
            }
            
            if (expirationDate !== undefined) {
              cookie.expirationDate = expirationDate
            }
            
            session.defaultSession.cookies.set(cookie).catch(err => {
              console.error('保存 Cookie 失敗:', err)
            })
          } catch (err) {
            console.error('解析 Cookie 失敗:', err)
          }
        }
      }

      // 確保 CORS 頭正確
      if (!responseHeaders['access-control-allow-origin']) {
        if (request.headers && request.headers.origin) {
          responseHeaders['access-control-allow-origin'] = request.headers.origin
          responseHeaders['access-control-allow-credentials'] = 'true'
        }
      }

      if (!responseHeaders['content-type']) {
        try {
          const ext = path.extname(new URL(url).pathname)
          const mimeMap = {
            '.swf': 'application/x-shockwave-flash',
            '.js': 'application/javascript',
            '.xml': 'text/xml',
            '.html': 'text/html',
            '.css': 'text/css',
            '.json': 'application/json'
          }
          responseHeaders['content-type'] = mimeMap[ext] || 'application/octet-stream'
        } catch (e) {
          responseHeaders['content-type'] = 'application/octet-stream'
        }
      }
      
      callback({
        statusCode: res.statusCode,
        headers: responseHeaders,
        data: res  
      })
    })

    req.on('error', (err) => {
      console.error('[Intercept Error]', url, err.message)
      callback({
        statusCode: 500,
        headers: {},
        data: Buffer.from(err.message)
      })
    })

    // POST 數據處理
    if (request.uploadData && request.uploadData.length > 0) {
      const chunks = []
      let totalLength = 0
      
      for (const data of request.uploadData) {
        if (data.type === 'rawData' && data.bytes) {
          chunks.push(data.bytes)
          totalLength += data.bytes.length
        } else if (data.type === 'file' && data.filePath) {
          try {
            const fileData = fs.readFileSync(data.filePath)
            chunks.push(fileData)
            totalLength += fileData.length
          } catch (e) {
            console.error('[File Upload Error]', data.filePath, e)
          }
        }
      }
      
      if (totalLength > 0 && !requestHeaders['content-length']) {
        req.setHeader('Content-Length', totalLength)
      }
      
      chunks.forEach(chunk => {
        req.write(chunk)
      })
    }

    req.end()
  }).catch(err => {
    console.error('讀取 Cookie 失敗:', err)
    callback({
      statusCode: 500,
      headers: {},
      data: Buffer.from('Cookie read error')
    })
  })
}

// 快速測試端口是否開放（300ms 超時）
function testPortOpen(host, port) {
  return new Promise((resolve) => {
    const socket = netModule.connect({
      host: host,
      port: port,
      timeout: 300
    })

    socket.on('connect', () => {
      socket.destroy()
      resolve(true)
    })

    socket.on('error', () => {
      resolve(false)
    })

    socket.on('timeout', () => {
      socket.destroy()
      resolve(false)
    })
  })
}

// 測試端口是否為 HTTP 代理
function testHttpProxy(host, port) {
  return new Promise((resolve) => {
    const proxyUrl = `http://${host}:${port}`
    const agent = new HttpProxyAgent(proxyUrl, { timeout: 2000 })

    const req = http.request({
      host: 'www.google.com',
      port: 80,
      path: '/',
      method: 'HEAD',
      agent: agent,
      timeout: 2000
    }, (res) => {
      agent.destroy()
      resolve(true)
    })

    req.on('error', () => {
      agent.destroy()
      resolve(false)
    })

    req.on('timeout', () => {
      req.destroy()
      agent.destroy()
      resolve(false)
    })

    req.end()
  })
}

// 掃描本地開放的端口
async function scanLocalPorts() {
  const startTime = Date.now()
  
  console.log('\n========================================')
  console.log('🔍 開始掃描本地端口...')
  console.log('========================================')
  
  const portRanges = [
    { start: 1080, end: 1090 },
    { start: 7890, end: 7900 },
    { start: 8080, end: 8090 },
    { start: 8888, end: 8900 },
    { start: 10800, end: 10820 },
    { start: 2080, end: 2090 },
    { start: 3128, end: 3130 },
    { start: 9090, end: 9100 }
  ]

  const portsToScan = []
  for (const range of portRanges) {
    for (let port = range.start; port <= range.end; port++) {
      portsToScan.push(port)
    }
  }

  console.log(`掃描 ${portsToScan.length} 個常見代理端口...`)

  const openPortTests = portsToScan.map(port => 
    testPortOpen('127.0.0.1', port).then(isOpen => ({ port, isOpen }))
  )

  const openPortResults = await Promise.all(openPortTests)
  const openPorts = openPortResults.filter(r => r.isOpen).map(r => r.port)

  console.log(`✅ 發現 ${openPorts.length} 個開放端口:`, openPorts.join(', '))

  if (openPorts.length === 0) {
    console.log('⚠️ 未發現任何開放端口')
    console.log(`⚡ 掃描耗時: ${Date.now() - startTime}ms`)
    console.log('========================================\n')
    return []
  }

  console.log('階段 2: 測試哪些端口是 HTTP 代理...')
  const proxyTests = openPorts.map(port =>
    testHttpProxy('127.0.0.1', port).then(isProxy => ({ port, isProxy }))
  )

  const proxyResults = await Promise.all(proxyTests)
  const httpProxyPorts = proxyResults.filter(r => r.isProxy).map(r => r.port)

  console.log(`✅ 發現 ${httpProxyPorts.length} 個 HTTP 代理端口:`, httpProxyPorts.join(', '))
  console.log(`⚡ 總掃描耗時: ${Date.now() - startTime}ms`)
  console.log('========================================\n')

  return httpProxyPorts
}

// 檢測並設置代理
async function detectAndSetProxy() {
  const startTime = Date.now()
  
  try {
    console.log('\n========================================')
    console.log('🔍 開始檢測代理設置...')
    console.log('========================================')
    
    try {
      const proxyUrl = await Promise.race([
        session.defaultSession.resolveProxy('https://www.google.com'),
        new Promise((resolve) => setTimeout(() => resolve('DIRECT'), 800))
      ])

      if (proxyUrl && proxyUrl !== 'DIRECT') {
        console.log('系統代理配置:', proxyUrl)
        const match = proxyUrl.match(/PROXY\s+([^:;]+):(\d+)/)
        if (match) {
          const proxyHost = match[1]
          const proxyPort = parseInt(match[2])
          await setupProxy(proxyHost, proxyPort)
          console.log(`⚡ 檢測耗時: ${Date.now() - startTime}ms`)
          console.log('========================================\n')
          return true
        }
      }
    } catch (err) {
      console.log('系統代理檢測失敗，繼續掃描本地端口...')
    }

    const proxyPorts = await scanLocalPorts()

    if (proxyPorts.length > 0) {
      const selectedPort = proxyPorts[0]
      console.log(`✅ 選擇端口 ${selectedPort} 作為代理`)
      await setupProxy('127.0.0.1', selectedPort)
      console.log(`⚡ 總檢測耗時: ${Date.now() - startTime}ms`)
      console.log('========================================\n')
      return true
    }

    console.log(`⚠️ 未檢測到任何 HTTP 代理 (耗時: ${Date.now() - startTime}ms)`)
    console.log('將使用直連模式')
    console.log('========================================\n')
    return false

  } catch (err) {
    console.error('❌ 代理檢測失敗:', err)
    console.log(`⚡ 檢測耗時: ${Date.now() - startTime}ms`)
    console.log('========================================\n')
    return false
  }
}

// 設置代理
async function setupProxy(proxyHost, proxyPort) {
  const proxyUrlStr = `http://${proxyHost}:${proxyPort}`

  systemProxy = {
    url: proxyUrlStr,
    httpAgent: new HttpProxyAgent(proxyUrlStr, {
      keepAlive: true,
      keepAliveMsecs: 30000,
      maxSockets: 100,
      maxFreeSockets: 10,
      timeout: 30000,
      scheduling: 'fifo'
    }),
    httpsAgent: new HttpsProxyAgent(proxyUrlStr, {
      keepAlive: true,
      keepAliveMsecs: 30000,
      maxSockets: 100,
      maxFreeSockets: 10,
      timeout: 30000,
      scheduling: 'fifo',
      rejectUnauthorized: false
    })
  }

  console.log('✅ 已配置代理:', proxyUrlStr)

  try {
    await session.defaultSession.setProxy({
      proxyRules: `http=${proxyHost}:${proxyPort};https=${proxyHost}:${proxyPort}`
    })
    console.log('✅ Electron session 代理已設置')
  } catch (err) {
    console.error('設置 Electron session 代理失敗:', err.message)
  }
  
  console.log('開始測試代理連接...')
  
  return new Promise((resolve) => {
    const testReq = https.get('https://www.google.com', {
      agent: systemProxy.httpsAgent,
      timeout: 5000
    }, (res) => {
      console.log('✅✅✅ 代理測試成功!')
      console.log('Google 返回狀態碼:', res.statusCode)
      resolve(true)
    })
    
    testReq.on('error', (err) => {
      console.error('❌ 代理測試失敗:', err.message)
      console.error('但仍會嘗試使用此代理')
      resolve(true)
    })
    
    testReq.on('timeout', () => {
      console.error('❌ 代理連接超時')
      console.error('但仍會嘗試使用此代理')
      testReq.destroy()
      resolve(true)
    })
  })
}

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  const mimeMap = {
    '.swf': 'application/x-shockwave-flash',
    '.js': 'application/javascript',
    '.xml': 'text/xml',
    '.html': 'text/html',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.mp3': 'audio/mpeg',
    '.mp4': 'video/mp4'
  }
  return mimeMap[ext] || 'application/octet-stream'
}

app.whenReady().then(async () => {
  console.log('=== 應用啟動 ===')
  
  await session.defaultSession.setProxy({
    mode: 'system'
  })
  
  // VPN 代理檢測
  await detectAndSetProxy()
  
  protocol.interceptStreamProtocol('http', interceptRequestRemote)
  protocol.interceptStreamProtocol('https', interceptRequestRemote)
  
  AppWindow()
  
  // 定期重新檢測（每 60 秒）
  setInterval(() => {
    console.log('🔄 定期重新檢測代理...')
    detectAndSetProxy()
  }, 60000)
})

app.on('window-all-closed', function () {
  app.quit()
})