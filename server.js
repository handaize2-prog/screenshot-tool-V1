const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const workspace = path.resolve(process.env.WORKSPACE_DIR || path.resolve(__dirname, '..'));
const toolRoot = __dirname;
const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const port = Number(process.env.PORT || 8030);

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml; charset=utf-8'
};

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function safeWorkspacePath(relativePath) {
  const clean = String(relativePath || '').replace(/^[/\\]+/, '');
  const target = path.resolve(workspace, clean);
  if (!target.startsWith(workspace + path.sep) && target !== workspace) {
    throw new Error('路径超出工作目录');
  }
  return target;
}

function listHtmlFiles() {
  return fs.readdirSync(workspace)
    .filter(name => name.toLowerCase().endsWith('.html'))
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1024 * 1024) reject(new Error('请求内容过大'));
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function requestJson(targetPort, requestPath, method = 'GET') {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port: targetPort, path: requestPath, method }, response => {
      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on('error', reject);
    request.end();
  });
}

function connectWebSocket(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.onopen = () => resolve(ws);
    ws.onerror = reject;
  });
}

function sanitizeFileName(name) {
  return String(name || '截图')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || '截图';
}

function uniqueOutputDir(baseName) {
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    '-',
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0')
  ].join('');
  const dir = path.join(workspace, `${sanitizeFileName(baseName)}-模块截图-${stamp}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function withChrome(pageFile, options, callback) {
  const pagePort = 8100 + Math.floor(Math.random() * 500);
  const debugPort = 9300 + Math.floor(Math.random() * 500);
  const profile = path.join('C:\\tmp', `chrome-module-shot-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const pagePath = safeWorkspacePath(pageFile);
  if (!fs.existsSync(pagePath)) throw new Error(`找不到文件：${pageFile}`);

  const staticServer = http.createServer((req, res) => {
    try {
      const requestPath = decodeURIComponent(req.url.split('?')[0]);
      const filePath = requestPath === '/'
        ? pagePath
        : safeWorkspacePath(requestPath.slice(1));
      if (!fs.existsSync(filePath)) {
        sendText(res, 404, 'Not found');
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
      fs.createReadStream(filePath).pipe(res);
    } catch (error) {
      sendText(res, 403, error.message);
    }
  });

  await new Promise(resolve => staticServer.listen(pagePort, '127.0.0.1', resolve));
  const chrome = spawn(chromePath, [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    `http://127.0.0.1:${pagePort}/`
  ], { stdio: 'ignore' });

  try {
    for (let i = 0; i < 80; i++) {
      try {
        await requestJson(debugPort, '/json/version');
        break;
      } catch {
        await wait(250);
      }
    }

    const tab = await requestJson(debugPort, '/json/new?about:blank', 'PUT');
    const ws = await connectWebSocket(tab.webSocketDebuggerUrl);
    const state = { id: 0, callbacks: new Map(), ws };
    ws.onmessage = event => {
      const message = JSON.parse(event.data);
      const callbackItem = state.callbacks.get(message.id);
      if (!callbackItem) return;
      state.callbacks.delete(message.id);
      message.error ? callbackItem.reject(new Error(message.error.message)) : callbackItem.resolve(message.result);
    };
    const cdp = (method, params = {}) => new Promise((resolve, reject) => {
      state.id += 1;
      state.callbacks.set(state.id, { resolve, reject });
      ws.send(JSON.stringify({ id: state.id, method, params }));
    });

    const cssWidth = Number(options.cssWidth || 430);
    const outputWidth = Number(options.outputWidth || 1420);
    const scale = outputWidth / cssWidth;
    await cdp('Page.enable');
    await cdp('Runtime.enable');
    await cdp('Emulation.setDeviceMetricsOverride', {
      width: cssWidth,
      height: Number(options.viewportHeight || 1400),
      deviceScaleFactor: scale,
      mobile: true
    });
    await cdp('Page.navigate', { url: `http://127.0.0.1:${pagePort}/` });
    await wait(Number(options.waitMs || 1200));
    await cdp('Runtime.evaluate', {
      expression: `
        document.querySelectorAll('.fade-in').forEach(el => el.classList.add('visible'));
        document.querySelectorAll('.faq-item').forEach(item => item.classList.remove('active'));
        const style = document.createElement('style');
        style.textContent = '.nav,.header,.inland-security-footer{display:none!important} body{box-shadow:none!important}';
        document.head.appendChild(style);
        true;
      `
    });
    await wait(250);

    try {
      return await callback({ cdp, cssWidth, outputWidth, ws });
    } finally {
      ws.close();
    }
  } finally {
    chrome.kill();
    staticServer.close();
    await wait(400);
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

async function detectSections(file) {
  return withChrome(file, { cssWidth: 430, outputWidth: 1420 }, async ({ cdp }) => {
    const result = await cdp('Runtime.evaluate', {
      expression: `JSON.stringify(Array.from(document.querySelectorAll('section, footer')).map((el, index) => {
        const title = el.querySelector('h1,h2,h3,h4')?.textContent?.replace(/\\s+/g, ' ').trim() || el.id || el.className || el.tagName.toLowerCase();
        const id = el.id ? '#' + CSS.escape(el.id) : '';
        const classes = Array.from(el.classList || []).map(c => '.' + CSS.escape(c)).join('');
        const selector = id || (el.tagName.toLowerCase() + classes);
        const r = el.getBoundingClientRect();
        return { index: index + 1, title, selector, height: Math.round(r.height) };
      }))`,
      returnByValue: true
    });
    return JSON.parse(result.result.value);
  });
}

async function captureSections(file, sections, options) {
  const outputDir = uniqueOutputDir(path.basename(file, '.html'));
  const results = [];
  await withChrome(file, options, async ({ cdp, cssWidth }) => {
    for (let i = 0; i < sections.length; i++) {
      const item = sections[i];
      const selector = item.selector;
      const name = sanitizeFileName(item.name || `${i + 1}`);
      const rectResult = await cdp('Runtime.evaluate', {
        expression: `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: 0, y: Math.max(0, r.y + scrollY), width: ${cssWidth}, height: Math.ceil(r.height) };
        })()`,
        returnByValue: true
      });
      const rect = rectResult.result.value;
      if (!rect || rect.height <= 0) {
        results.push({ selector, skipped: true, reason: '没有找到模块或模块高度为 0' });
        continue;
      }
      const screenshot = await cdp('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: true,
        clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 }
      });
      const fileName = `${String(i + 1).padStart(2, '0')}-${name}.png`;
      const outputPath = path.join(outputDir, fileName);
      fs.writeFileSync(outputPath, Buffer.from(screenshot.data, 'base64'));
      results.push({ selector, fileName, outputPath, height: rect.height });
    }
  });
  return { outputDir, results };
}

async function handleApi(req, res) {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  try {
    if (url.pathname === '/api/files') {
      sendJson(res, 200, { files: listHtmlFiles() });
      return;
    }

    if (url.pathname === '/api/detect') {
      const file = url.searchParams.get('file');
      if (!file) throw new Error('缺少 file 参数');
      const sections = await detectSections(file);
      sendJson(res, 200, { sections });
      return;
    }

    if (url.pathname === '/api/capture' && req.method === 'POST') {
      const payload = JSON.parse(await readBody(req));
      if (!payload.file) throw new Error('请选择 HTML 文件');
      if (!Array.isArray(payload.sections) || payload.sections.length === 0) throw new Error('请至少选择一个模块');
      const result = await captureSections(payload.file, payload.sections, {
        cssWidth: payload.cssWidth || 430,
        outputWidth: payload.outputWidth || 1420,
        viewportHeight: payload.viewportHeight || 1400,
        waitMs: payload.waitMs || 1200
      });
      sendJson(res, 200, result);
      return;
    }

    sendJson(res, 404, { error: '接口不存在' });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res);
    return;
  }

  const fileName = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const filePath = path.resolve(toolRoot, fileName);
  if (!filePath.startsWith(toolRoot + path.sep) || !fs.existsSync(filePath)) {
    sendText(res, 404, 'Not found');
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`模块截图工具已启动：http://127.0.0.1:${port}`);
});
