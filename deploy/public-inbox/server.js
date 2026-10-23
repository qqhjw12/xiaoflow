#!/usr/bin/env node
/* ============================================================
 * 小流 XiaoFlow — 公网投喂箱（公开收集箱）
 *
 * 让任何人（不只你自己的手机）都能给小流投喂内容：
 *   · 打开这个页面 → 写点什么 → 扔进投喂墙
 *   · 内容进入小流主人配置的工作流（如"把大家投喂的整理成摘要"）
 *
 * 与 tools/inbox-server.js（本地私人箱）的区别：
 *   · 公网可达，任何人可读可扔 —— 内容公开，不是隐私箱
 *   · 带防滥用：单条 500 字上限、同 IP 30 秒 1 条、总量 300 条 FIFO
 *   · 清空需要令牌（默认关闭），小流侧"只读消费"
 *
 * 本地运行：  node deploy/public-inbox/server.js 8787
 * 发布运行：  PORT=3000 node deploy/public-inbox/server.js   （沙箱注入 PORT）
 * 数据文件：  data/public-inbox.json（与应用同目录，沙箱内重启可能丢失，
 *            重要内容请及时在小流里消费/导出）
 * ============================================================ */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.resolve(__dirname, 'data', 'public-inbox.json');
const MAX_LEN = 500;          // 单条字数上限
const MAX_ITEMS = 300;        // 总量上限（FIFO 淘汰最旧的）
const RATE_LIMIT_MS = 30000;  // 同一 IP 两次投喂的最小间隔
const CLEAR_TOKEN = process.env.CLEAR_TOKEN || ''; // 设置了才允许清空

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
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify({ app: 'xiaoflow-public-inbox', items }, null, 2), 'utf8');
    return true;
  } catch (e) {
    return false; // 沙箱文件系统不可写等情况
  }
}

/* ---------- 纯逻辑（可单测） ---------- */
const lastDropAt = new Map(); // ip -> ts，限流用

const inbox = {
  /**
   * 投喂一条。
   * @returns {{ok:true, item, total} | {ok:false, error}}
   */
  drop(text, source, ip) {
    const t = String(text == null ? '' : text).trim();
    if (!t) return { ok: false, error: '内容是空的' };
    if (t.length > MAX_LEN) return { ok: false, error: '太长了，投喂请精简到 ' + MAX_LEN + ' 字以内' };
    const now = Date.now();
    const last = lastDropAt.get(ip || 'anon') || 0;
    if (now - last < RATE_LIMIT_MS) {
      const wait = Math.ceil((RATE_LIMIT_MS - (now - last)) / 1000);
      return { ok: false, error: '投喂太频繁啦，' + wait + ' 秒后再来' };
    }
    lastDropAt.set(ip || 'anon', now);
    const item = {
      id: 'p_' + now.toString(36) + Math.random().toString(36).slice(2, 6),
      ts: now, text: t, source: source || 'web'
    };
    const items = [...readInbox(), item];
    while (items.length > MAX_ITEMS) items.shift(); // FIFO 淘汰最旧
    writeInbox(items);
    return { ok: true, item, total: items.length };
  },
  /** 全部投喂（最新在前） */
  list() { return readInbox().slice().reverse(); },
  count() { return readInbox().length; },
  /** 清空（需要令牌；没配令牌时永远拒绝） */
  clear(token) {
    if (!CLEAR_TOKEN || token !== CLEAR_TOKEN) return { ok: false, error: '清空需要正确的令牌' };
    writeInbox([]);
    return { ok: true };
  },
  get maxLen() { return MAX_LEN; },
  get rateMs() { return RATE_LIMIT_MS; },
  get clearEnabled() { return !!CLEAR_TOKEN; }
};

/* ---------- 投喂墙页面 ---------- */
function page() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>给小流投喂 💧</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
  html { background: #f0fdfa; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    background: linear-gradient(160deg, #f0fdfa 0%, #eff6ff 100%);
    min-height: 100vh; padding: 28px 18px calc(28px + env(safe-area-inset-bottom));
    display: flex; flex-direction: column; gap: 16px; max-width: 640px; margin: 0 auto;
  }
  header h1 { font-size: 24px; color: #0f766e; display: flex; align-items: center; gap: 8px; }
  header p { font-size: 13px; color: #6b7280; margin-top: 8px; line-height: 1.7; }
  header .warn {
    margin-top: 10px; font-size: 12px; color: #92400e; background: #fffbeb;
    border: 1px solid #fde68a; border-radius: 10px; padding: 8px 12px; line-height: 1.6;
  }
  textarea {
    width: 100%; min-height: 30vh; border: 1.5px solid #99f6e4; border-radius: 16px;
    padding: 16px; font-size: 17px; line-height: 1.6; background: #fff; resize: none;
    font-family: inherit;
  }
  textarea:focus { outline: none; border-color: #14b8a6; box-shadow: 0 0 0 4px rgba(20,184,166,.15); }
  .counter { font-size: 11px; color: #9ca3af; text-align: right; margin-top: -10px; }
  button {
    width: 100%; padding: 17px; border: none; border-radius: 16px;
    background: #0d9488; color: #fff; font-size: 19px; font-weight: 600;
    box-shadow: 0 6px 16px rgba(13,148,136,.3); transition: transform .1s;
  }
  button:active { transform: scale(.98); }
  button:disabled { opacity: .6; }
  .wall { background: #fff; border: 1px solid #ccfbf1; border-radius: 14px; padding: 14px 16px; }
  .wall h2 { font-size: 13px; color: #0f766e; margin-bottom: 10px; display: flex; justify-content: space-between; }
  .wall h2 span { color: #9ca3af; font-weight: 400; }
  .wall li {
    font-size: 14px; color: #374151; padding: 9px 0; list-style: none;
    border-top: 1px dashed #e5e7eb; display: flex; gap: 10px; align-items: baseline;
  }
  .wall li:first-of-type { border-top: none; }
  .wall li b { color: #9ca3af; font-weight: 400; font-size: 11px; flex: none; }
  .wall li .txt { white-space: pre-wrap; word-break: break-word; }
  .empty { font-size: 13px; color: #9ca3af; text-align: center; padding: 18px 0; }
  footer { font-size: 12px; color: #9ca3af; text-align: center; line-height: 1.8; }
  footer a { color: #0d9488; text-decoration: none; }
</style>
</head>
<body>
  <header>
    <h1>💧 给小流投喂</h1>
    <p>你扔进来的内容，会进入「小流」主人搭建的工作流——<br>比如把大家的投喂整理成一份摘要、周报或灵感库。</p>
    <div class="warn">⚠️ 这是一个公开投喂墙：你扔的内容所有人可见。请不要投喂隐私信息（密码、证件、住址等）。</div>
  </header>
  <textarea id="t" maxlength="${MAX_LEN}" placeholder="今天的工作记录 / 一个链接 / 一条灵感…&#10;（最多 ${MAX_LEN} 字，30 秒内可投喂一次）"></textarea>
  <div class="counter" id="counter">0 / ${MAX_LEN}</div>
  <button id="go">扔进投喂墙 📨</button>
  <div class="wall">
    <h2>📋 投喂墙 <span id="total"></span></h2>
    <ul id="list"></ul>
    <div class="empty" id="empty" hidden>墙还空着，来扔第一条吧</div>
  </div>
  <footer>
    由 <b>小流 XiaoFlow</b> 驱动 · 给每个人的个性化工作流<br>
    内容公开可见 · 请勿投喂隐私
  </footer>
<script>
  var $ = function (id) { return document.getElementById(id); };
  function esc(s) {
    return String(s).replace(/[<>&]/g, function (c) {
      return {'<':'&lt;','>':'&gt;','&':'&amp;'}[c];
    });
  }
  function fmt(ts) {
    var d = new Date(ts);
    var p = function (n) { return ('0' + n).slice(-2); };
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function loadWall() {
    fetch('/api/inbox').then(function (r) { return r.json(); }).then(function (d) {
      var items = d.items || [];
      $('total').textContent = items.length ? '共 ' + d.total + ' 条' : '';
      if (!items.length) { $('empty').hidden = false; $('list').innerHTML = ''; return; }
      $('empty').hidden = true;
      $('list').innerHTML = items.map(function (x) {
        return '<li><b>' + fmt(x.ts) + '</b><span class="txt">' + esc(x.text) + '</span></li>';
      }).join('');
    }).catch(function () {});
  }
  $('t').addEventListener('input', function () {
    $('counter').textContent = $('t').value.length + ' / ${MAX_LEN}';
  });
  $('go').onclick = function () {
    var text = $('t').value.trim();
    if (!text) { $('t').focus(); return; }
    $('go').disabled = true;
    fetch('/api/drop', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text, source: 'public-web' })
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (d.ok) {
        $('go').textContent = '✓ 已扔进投喂墙（第 ' + d.total + ' 条）';
        $('t').value = ''; $('counter').textContent = '0 / ${MAX_LEN}';
        loadWall();
        setTimeout(function () { $('go').textContent = '扔进投喂墙 📨'; $('go').disabled = false; }, 2000);
      } else {
        $('go').textContent = '✗ ' + (d.error || '没扔成，稍后再试');
        setTimeout(function () { $('go').textContent = '扔进投喂墙 📨'; $('go').disabled = false; }, 2500);
      }
    }).catch(function () {
      $('go').textContent = '✗ 网络出了点问题';
      setTimeout(function () { $('go').textContent = '扔进投喂墙 📨'; $('go').disabled = false; }, 2000);
    });
  };
  loadWall();
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
function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'anon';
}

function createHandler() {
  return async function handler(req, res) {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'OPTIONS') return send(res, 204, '');

    if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) {
      return send(res, 200, page(), { 'Content-Type': 'text/html; charset=utf-8' });
    }
    if (req.method === 'GET' && u.pathname === '/api/inbox') {
      return send(res, 200, { ok: true, total: inbox.count(), items: inbox.list() });
    }
    // GET 投喂（快捷指令 / 简单分享用）：/drop?text=...&source=...
    if (req.method === 'GET' && u.pathname === '/drop') {
      const r = inbox.drop(u.searchParams.get('text'), u.searchParams.get('source') || 'share', clientIp(req));
      if (!r.ok) return send(res, 429, { ok: false, error: r.error });
      return send(res, 200, { ok: true, total: r.total, id: r.item.id });
    }
    // POST 投喂：/api/drop {text, source}
    if (req.method === 'POST' && u.pathname === '/api/drop') {
      const body = await readBody(req);
      const r = inbox.drop(body.text, body.source || 'share', clientIp(req));
      if (!r.ok) return send(res, 429, { ok: false, error: r.error });
      return send(res, 200, { ok: true, total: r.total, id: r.item.id });
    }
    // 清空：必须带正确令牌（未配置令牌时该功能关闭）
    if (req.method === 'POST' && u.pathname === '/api/clear') {
      const body = await readBody(req);
      const token = body.token || u.searchParams.get('token') || '';
      const r = inbox.clear(String(token));
      if (!r.ok) return send(res, 403, { ok: false, error: r.error });
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { ok: false, error: '没有这个页面' });
  };
}

function start(port) {
  // 显式传 0 = 随机端口（测试用）；没传则看 PORT 环境变量，再兜底 8787
  const p = (port !== undefined && port !== null && String(port) !== '')
    ? Number(port)
    : (Number(process.env.PORT) || 8787);
  const server = http.createServer(createHandler());
  server.listen(p, '0.0.0.0', () => {
    console.log('');
    console.log('  💧 小流公网投喂箱已启动');
    console.log('  ─────────────────────────────────────────');
    console.log('  打开：        http://127.0.0.1:' + p);
    console.log('  规则：        单条 ≤ ' + MAX_LEN + ' 字 · 同 IP ' + (RATE_LIMIT_MS / 1000) + ' 秒 1 条 · 总量 ' + MAX_ITEMS + ' 条');
    console.log('  清空令牌：    ' + (CLEAR_TOKEN ? '已配置' : '未配置（清空功能关闭）'));
    console.log('  数据文件：    ' + DATA_FILE);
    console.log('  按 Ctrl+C 停止');
    console.log('');
  });
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error('端口 ' + p + ' 被占用了。换一个：node deploy/public-inbox/server.js ' + (p + 1));
    } else {
      console.error('启动失败：' + e.message);
    }
    process.exit(1);
  });
  return server;
}

module.exports = { inbox, createHandler, start, page, DATA_FILE, MAX_LEN, MAX_ITEMS, RATE_LIMIT_MS };

if (require.main === module) {
  // 命令行给了端口就用它；没给则交给 start() 读 PORT 环境变量（发布沙箱会注入）
  start(process.argv[2]);
}
