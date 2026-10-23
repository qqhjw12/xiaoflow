#!/usr/bin/env node
/* ============================================================
 * 小流 XiaoFlow — 本地静态服务器（给手机/平板访问用）
 *
 * 用法：
 *   node tools/serve.js          # 默认 8000 端口
 *   node tools/serve.js 8080     # 指定端口
 *
 * 零依赖。启动后会打印：
 *   · 电脑访问地址  http://localhost:8000
 *   · 手机访问地址  http://<本机局域网IP>:8000   ← 手机连同一个 WiFi 后开这个
 *
 * 说明：手机访问时数据存在手机浏览器自己的存储里（按网站来源隔离），
 *       与电脑上 file:// 打开时的数据互不相通——各端独立，互不干扰。
 * ============================================================ */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const PORT = parseInt(process.argv[2], 10) || 8000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

/** 探测本机局域网 IPv4 地址（排除 VMware 等虚拟网卡优先取 WLAN/以太网） */
function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  // 优先真实网卡：名字里不含 vmware/virtualbox/veth/docker
  const preferred = [];
  const fallback = [];
  for (const name of Object.keys(ifaces)) {
    for (const it of ifaces[name] || []) {
      if (it.family !== 'IPv4' || it.internal) continue;
      const lower = name.toLowerCase();
      if (/vmware|virtualbox|veth|docker|hyper-v|loopback|pseudo/.test(lower)) fallback.push(it.address);
      else preferred.push(it.address);
    }
  }
  return preferred.concat(fallback);
}

const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch (e) {
    res.writeHead(400); res.end('bad request'); return;
  }
  if (urlPath === '/') urlPath = '/index.html';

  // 防目录穿越：解析后必须仍在 ROOT 内
  const filePath = path.normalize(path.join(ROOT, urlPath));
  if (!filePath.startsWith(ROOT + path.sep) && filePath !== ROOT) {
    res.writeHead(403); res.end('forbidden'); return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><body style="font-family:sans-serif;text-align:center;padding:60px">' +
        '<h2>404 · 没找到这个页面</h2><p><a href="/">回小流首页</a></p></body></html>');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
});

server.listen(PORT, () => {
  const bar = '─'.repeat(46);
  console.log('\n💧 小流已启动，让手机也能用：\n' + bar);
  console.log('  💻 电脑打开：  http://localhost:' + PORT);
  const ips = lanAddresses();
  if (ips.length) {
    console.log('  📱 手机打开（需连同一个 WiFi）：');
    ips.forEach(ip => console.log('      http://' + ip + ':' + PORT));
  } else {
    console.log('  📱 手机打开：  http://<电脑的局域网IP>:' + PORT + '（没能自动探测到 IP）');
  }
  console.log(bar);
  console.log('  ⚠ 手机访问到的数据存在手机浏览器里，与电脑端互不相通');
  console.log('  ⏹ 停止服务：Ctrl+C\n');
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n✗ 端口 ${PORT} 被占用了。换一个：node tools/serve.js ${PORT + 1}\n`);
  } else {
    console.error('\n✗ 启动失败：' + e.message + '\n');
  }
  process.exit(1);
});
