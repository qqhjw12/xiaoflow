#!/usr/bin/env node
/* ============================================================
 * 小流 XiaoFlow — 投递服务（手机"随时扔"入口）
 * 零依赖：node tools/inbox-server.js 即可运行
 *
 * 提供两个真实入口（都不碰任何平台私有 API）：
 *   1. 手机网页：同一 WiFi 下浏览器打开 http://<电脑IP>:8787
 *   2. 系统分享直达：iOS 快捷指令 / 安卓分享菜单 POST 到 /api/drop
 *      （微信里长按消息 → 共享 → 快捷指令，内容直达电脑收集箱）
 *
 * 数据落在 data/inbox.json，小流页面通过 /api/inbox 读取。
 * 仅设计用于家庭/办公网络：无认证，不要暴露到公网。
 * ============================================================ */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA_FILE = path.resolve(__dirname, '..', 'data', 'inbox.json');
const DEFAULT_PORT = 8787;

/* ---------- 存储 ---------- */
function readInbox() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data.items) ? data.items : [];
  } catch (e) {
    return [];
  }
}
function writeInbox(items) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify({ app: 'xiaoflow-inbox', items }, null, 2), 'utf8');
}

/* ---------- 纯逻辑（可单测） ---------- */
const inbox = {
  /** 投递一条，返回新条目 */
  drop(text, source) {
    const t = String(text == null ? '' : text).trim();
    if (!t) return null;
    const item = { id: 'i_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), ts: Date.now(), text: t, source: source || 'web' };
    writeInbox([...readInbox(), item]);
    return item;
  },
  /** 待扔列表（最新在前） */
  list() { return readInbox().slice().reverse(); },
  /** 条数 */
  count() { return readInbox().length; },
  /** 消费：清空（小流读入后调用） */
  clear() { writeInbox([]); }
};

/* ---------- 手机网页 ---------- */
function mobilePage() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>扔进小流 📮</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
  html { background: #f0fdfa; }
  body {
    font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
    background: linear-gradient(160deg, #f0fdfa, #eff6ff);
    min-height: 100vh; padding: 24px 20px calc(24px + env(safe-area-inset-bottom));
    display: flex; flex-direction: column; gap: 16px;
  }
  h1 { font-size: 22px; color: #0f766e; display: flex; align-items: center; gap: 8px; }
  .sub { font-size: 13px; color: #6b7280; margin-top: -8px; }
  textarea {
    width: 100%; min-height: 45vh; border: 1.5px solid #99f6e4; border-radius: 16px;
    padding: 16px; font-size: 17px; line-height: 1.6; background: #fff; resize: none;
    font-family: inherit;
  }
  textarea:focus { outline: none; border-color: #14b8a6; box-shadow: 0 0 0 4px rgba(20,184,166,.15); }
  button {
    width: 100%; padding: 18px; border: none; border-radius: 16px;
    background: #0d9488; color: #fff; font-size: 19px; font-weight: 600;
    box-shadow: 0 6px 16px rgba(13,148,136,.3);
  }
  button:active { transform: scale(.98); }
  button:disabled { opacity: .6; }
  .recent { background: #fff; border: 1px solid #ccfbf1; border-radius: 14px; padding: 14px 16px; }
  .recent h2 { font-size: 13px; color: #0f766e; margin-bottom: 8px; }
  .recent li { font-size: 13px; color: #4b5563; padding: 4px 0; list-style: none;
    display: flex; gap: 8px; align-items: baseline; }
  .recent li b { color: #9ca3af; font-weight: 400; font-size: 11px; flex: none; }
  .tip { font-size: 12px; color: #9ca3af; text-align: center; }
</style>
</head>
<body>
  <h1>📮 扔进小流</h1>
  <p class="sub">写点什么，扔进电脑的收集箱。到了电脑前，让小流帮你整理。</p>
  <textarea id="t" placeholder="今天的工作记录 / 链接 / 灵感…&#10;长按微信消息→共享→快捷指令，也能直接扔进来"></textarea>
  <button id="go">扔进去 📨</button>
  <div class="recent" id="recent" hidden><h2>最近扔的</h2><ul id="recent-list"></ul></div>
  <p class="tip">小流 · 本地优先 · 内容只存在你自己的电脑上</p>
<script>
  var $ = function (id) { return document.getElementById(id); };
  function loadRecent() {
    fetch('/api/inbox').then(function (r) { return r.json(); }).then(function (d) {
      var items = (d.items || []).slice(0, 3);
      if (!items.length) { $('recent').hidden = true; return; }
      $('recent').hidden = false;
      $('recent-list').innerHTML = items.map(function (x) {
        var d2 = new Date(x.ts);
        var hm = ('0'+d2.getHours()).slice(-2) + ':' + ('0'+d2.getMinutes()).slice(-2);
        return '<li><b>' + hm + '</b><span>' + x.text.replace(/[<>&]/g, function (c) {
          return {'<':'&lt;','>':'&gt;','&':'&amp;'}[c];
        }).slice(0, 60) + '</span></li>';
      }).join('');
    }).catch(function () {});
  }
  $('go').onclick = function () {
    var text = $('t').value.trim();
    if (!text) { $('t').focus(); return; }
    $('go').disabled = true;
    fetch('/api/drop', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text, source: 'mobile-web' })
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (d.ok) {
        $('go').textContent = '✓ 已扔进收集箱（今天第 ' + d.total + ' 条）';
        $('t').value = '';
        loadRecent();
        setTimeout(function () { $('go').textContent = '扔进去 📨'; $('go').disabled = false; }, 2000);
      }
    }).catch(function () {
      $('go').textContent = '✗ 没连上，检查 WiFi 或电脑服务';
      $('go').disabled = false;
    });
  };
  loadRecent();
</script>
</body>
</html>`;
}

/* ---------- HTTP 服务 ---------- */
function send(res, code, body, headers) {
  const h = Object.assign({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  }, headers || {});
  res.writeHead(code, h);
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); } catch (e) { resolve({ text: raw }); }
    });
    req.on('error', () => resolve({}));
  });
}

function createHandler() {
  return async function handler(req, res) {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'OPTIONS') return send(res, 204, '');

    if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) {
      return send(res, 200, mobilePage(), { 'Content-Type': 'text/html; charset=utf-8' });
    }
    if (req.method === 'GET' && u.pathname === '/api/inbox') {
      return send(res, 200, { ok: true, total: inbox.count(), items: inbox.list() });
    }
    // GET 投递（安卓分享 / 简单快捷指令用）：/drop?text=...&source=...
    if (req.method === 'GET' && u.pathname === '/drop') {
      const item = inbox.drop(u.searchParams.get('text'), u.searchParams.get('source') || 'share');
      if (!item) return send(res, 400, { ok: false, error: '内容是空的' });
      return send(res, 200, { ok: true, total: inbox.count(), id: item.id });
    }
    // POST 投递（iOS 快捷指令推荐）：/api/drop {text, source}
    if (req.method === 'POST' && u.pathname === '/api/drop') {
      const body = await readBody(req);
      const item = inbox.drop(body.text, body.source || 'share');
      if (!item) return send(res, 400, { ok: false, error: '内容是空的' });
      return send(res, 200, { ok: true, total: inbox.count(), id: item.id });
    }
    if (req.method === 'POST' && u.pathname === '/api/clear') {
      inbox.clear();
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { ok: false, error: '没有这个页面' });
  };
}

function lanAddresses() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const ni of ifs[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out.length ? out : ['127.0.0.1'];
}

function start(port) {
  const p = Number(port) || DEFAULT_PORT;
  const server = http.createServer(createHandler());
  server.listen(p, () => {
    console.log('');
    console.log('  💧 小流投递服务已启动');
    console.log('  ─────────────────────────────────────────');
    console.log('  本机打开：    http://127.0.0.1:' + p);
    for (const ip of lanAddresses()) {
      console.log('  手机打开：    http://' + ip + ':' + p + '  （同一 WiFi）');
    }
    console.log('  分享直达：    见 README「手机随时扔」配置快捷指令');
    console.log('  数据文件：    ' + DATA_FILE);
    console.log('  按 Ctrl+C 停止');
    console.log('');
  });
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error('端口 ' + p + ' 被占用了。换一个：node tools/inbox-server.js 9000');
    } else {
      console.error('启动失败：' + e.message);
    }
    process.exit(1);
  });
  return server;
}

module.exports = { inbox, createHandler, start, DATA_FILE, DEFAULT_PORT };

if (require.main === module) {
  start(Number(process.argv[2]) || DEFAULT_PORT);
}
