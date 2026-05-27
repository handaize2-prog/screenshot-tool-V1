const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const { spawn } = require('child_process');

const workspace = path.resolve(process.env.WORKSPACE_DIR || __dirname);
const toolRoot = __dirname;
function defaultBrowserPath() {
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  ];
  return candidates.find(candidate => fs.existsSync(candidate)) || candidates[candidates.length - 1];
}

const chromePath = process.env.CHROME_PATH || defaultBrowserPath();
const port = Number(process.env.PORT || 8030);
const host = process.env.HOST || '0.0.0.0';
const uploadsDir = path.join(workspace, 'uploads');
const capturesDir = path.join(workspace, 'captures');

fs.mkdirSync(uploadsDir, { recursive: true });
fs.mkdirSync(capturesDir, { recursive: true });

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.zip': 'application/zip'
};

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function contentDisposition(fileName) {
  const safeName = sanitizeFileName(fileName || 'download');
  return `attachment; filename="${encodeURIComponent(safeName)}"; filename*=UTF-8''${encodeURIComponent(safeName)}`;
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
  const rootFiles = fs.readdirSync(workspace)
    .filter(name => name.toLowerCase().endsWith('.html'))
    .filter(name => name !== 'index.html');
  const uploadFiles = fs.readdirSync(uploadsDir)
    .filter(name => name.toLowerCase().endsWith('.html'))
    .map(name => `uploads/${name}`);
  return [...rootFiles, ...uploadFiles].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    req.on('data', chunk => {
      length += chunk.length;
      if (length > limit) {
        reject(new Error('请求内容过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
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

function uniqueCaptureDir(baseName) {
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
  const folderName = `${sanitizeFileName(baseName)}-模块截图-${stamp}`;
  const dir = path.join(capturesDir, folderName);
  fs.mkdirSync(dir, { recursive: true });
  return { dir, folderName };
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xFFFFFFFF;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(date.getFullYear(), 1980);
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

function makeZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const { time, day } = dosDateTime();

  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const data = file.data;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034B50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, data);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014B50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(time, 12);
    header.writeUInt16LE(day, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE(0, 38);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);

    offset += local.length + name.length + data.length;
  }

  const centralSize = central.reduce((sum, chunk) => sum + chunk.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054B50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, ...central, end]);
}

function zipCaptureFolder(folderName) {
  const cleanFolder = path.basename(String(folderName || ''));
  if (!cleanFolder) throw new Error('缺少截图文件夹');
  const folderPath = path.resolve(capturesDir, cleanFolder);
  if (!folderPath.startsWith(capturesDir + path.sep) || !fs.existsSync(folderPath)) {
    throw new Error('截图文件夹不存在');
  }
  const files = fs.readdirSync(folderPath)
    .filter(name => name.toLowerCase().endsWith('.png'))
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
    .map(name => ({
      name,
      data: fs.readFileSync(path.join(folderPath, name))
    }));
  if (!files.length) throw new Error('截图文件夹中没有 PNG 图片');
  return {
    fileName: `${cleanFolder}.zip`,
    data: makeZip(files)
  };
}

function parseMultipartUpload(req, body) {
  const contentType = req.headers['content-type'] || '';
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!match) throw new Error('上传格式错误：缺少 boundary');
  const boundary = Buffer.from(`--${match[1] || match[2]}`);
  const start = body.indexOf(boundary);
  if (start < 0) throw new Error('上传格式错误：找不到文件边界');
  const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), start);
  if (headerEnd < 0) throw new Error('上传格式错误：找不到文件头');
  const header = body.slice(start + boundary.length + 2, headerEnd).toString('utf8');
  const filenameMatch = header.match(/filename="([^"]+)"/i);
  if (!filenameMatch) throw new Error('请选择 HTML 文件');
  const nextBoundary = body.indexOf(Buffer.from(`\r\n--${match[1] || match[2]}`), headerEnd + 4);
  if (nextBoundary < 0) throw new Error('上传格式错误：找不到文件结尾');
  return {
    filename: sanitizeFileName(filenameMatch[1].replace(/\.html?$/i, '')) + '.html',
    content: body.slice(headerEnd + 4, nextBoundary)
  };
}

async function saveUploadedHtml(req) {
  const body = await readBody(req, 20 * 1024 * 1024);
  const upload = parseMultipartUpload(req, body);
  const finalName = `${Date.now()}-${upload.filename}`;
  const outputPath = path.join(uploadsDir, finalName);
  fs.writeFileSync(outputPath, upload.content);
  return `uploads/${finalName}`;
}

async function withChrome(pageFile, options, callback) {
  const pagePort = 8100 + Math.floor(Math.random() * 500);
  const debugPort = 9300 + Math.floor(Math.random() * 500);
  const profile = path.join(os.tmpdir(), `chrome-module-shot-${Date.now()}-${Math.random().toString(16).slice(2)}`);
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
  const chromeArgs = [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    `http://127.0.0.1:${pagePort}/`
  ];
  if (process.env.CHROME_NO_SANDBOX === '1' || process.platform !== 'win32') {
    chromeArgs.splice(5, 0, '--no-sandbox', '--disable-dev-shm-usage');
  }
  const chrome = spawn(chromePath, chromeArgs, { stdio: 'ignore' });

  try {
    let chromeReady = false;
    for (let i = 0; i < 80; i++) {
      try {
        await requestJson(debugPort, '/json/version');
        chromeReady = true;
        break;
      } catch {
        await wait(250);
      }
    }
    if (!chromeReady) {
      throw new Error(`浏览器启动失败，请检查浏览器路径：${chromePath}`);
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
        document.querySelectorAll('*').forEach(el => {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          const isVisible = rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
          const isFixedLayer = style.position === 'fixed' && isVisible;
          const isLikelyFloatingCta = isFixedLayer && (
            rect.bottom > window.innerHeight * 0.55 ||
            /float|fixed|sticky|consult|contact|phone|tel|call|chat|cta|bottom/i.test(el.className || '') ||
            /咨询|电话|拨打|联系/.test(el.textContent || '')
          );
          if (isLikelyFloatingCta) {
            el.setAttribute('data-module-shot-hidden-fixed', 'true');
          }
        });
        const style = document.createElement('style');
        style.textContent = [
          '.nav,.header,.inland-security-footer{display:none!important}',
          '[data-module-shot-hidden-fixed="true"]{display:none!important}',
          'body{box-shadow:none!important}'
        ].join(' ');
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
      expression: `JSON.stringify((() => {
        function simpleSelector(el) {
          if (el.id) return '#' + CSS.escape(el.id);
          let selector = el.tagName.toLowerCase();
          const classes = Array.from(el.classList || []).filter(Boolean);
          if (classes.length) {
            selector += classes.map(c => '.' + CSS.escape(c)).join('');
          }
          if (el.parentElement) {
            const sameTagSiblings = Array.from(el.parentElement.children)
              .filter(item => item.tagName === el.tagName);
            if (sameTagSiblings.length > 1) {
              selector += ':nth-of-type(' + (sameTagSiblings.indexOf(el) + 1) + ')';
            }
          }
          return selector;
        }

        function uniqueSelector(el) {
          if (el.id) return '#' + CSS.escape(el.id);
          const parts = [];
          let node = el;
          while (node && node.nodeType === 1 && node !== document.documentElement) {
            parts.unshift(simpleSelector(node));
            const selector = parts.join(' > ');
            if (document.querySelectorAll(selector).length === 1) {
              return selector;
            }
            node = node.parentElement;
          }
          return parts.join(' > ');
        }

        return Array.from(document.querySelectorAll('section, footer')).map((el, index) => {
          const title = el.querySelector('h1,h2,h3,h4')?.textContent?.replace(/\\s+/g, ' ').trim() || el.id || el.className || el.tagName.toLowerCase();
          const selector = uniqueSelector(el);
          const r = el.getBoundingClientRect();
          return {
            index: index + 1,
            title,
            selector,
            height: Math.round(r.height),
            matchCount: document.querySelectorAll(selector).length
          };
        });
      })())`,
      returnByValue: true
    });
    return JSON.parse(result.result.value);
  });
}

async function captureSections(file, sections, options) {
  const { dir: outputDir, folderName } = uniqueCaptureDir(path.basename(file, '.html'));
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
      results.push({
        selector,
        fileName,
        outputPath,
        downloadUrl: `/captures/${encodeURIComponent(folderName)}/${encodeURIComponent(fileName)}`,
        height: rect.height
      });
    }
  });
  return { outputDir, folderName, results };
}

async function handleApi(req, res) {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  try {
    if (url.pathname === '/api/files') {
      sendJson(res, 200, { files: listHtmlFiles() });
      return;
    }

    if (url.pathname === '/api/upload' && req.method === 'POST') {
      const file = await saveUploadedHtml(req);
      sendJson(res, 200, { file, files: listHtmlFiles() });
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
      const payload = JSON.parse((await readBody(req)).toString('utf8'));
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

    if (url.pathname === '/api/download-zip') {
      const folder = url.searchParams.get('folder');
      const zip = zipCaptureFolder(folder);
      res.writeHead(200, {
        'Content-Type': mimeTypes['.zip'],
        'Content-Disposition': contentDisposition(zip.fileName),
        'Content-Length': zip.data.length
      });
      res.end(zip.data);
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

  if (url.pathname.startsWith('/captures/')) {
    try {
      const target = path.resolve(capturesDir, decodeURIComponent(url.pathname.replace('/captures/', '')));
      if (!target.startsWith(capturesDir + path.sep) || !fs.existsSync(target)) {
        sendText(res, 404, 'Not found');
        return;
      }
      const ext = path.extname(target).toLowerCase();
      const headers = { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' };
      if (url.searchParams.get('download') === '1') {
        headers['Content-Disposition'] = contentDisposition(path.basename(target));
      }
      res.writeHead(200, headers);
      fs.createReadStream(target).pipe(res);
    } catch (error) {
      sendText(res, 404, 'Not found');
    }
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

server.listen(port, host, () => {
  console.log(`模块截图工具已启动：http://${host}:${port}`);
});
