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
 * 数据存储：  云数据库（WorkBuddy Cloud Service，表 inbox_items，
 *            重启 / 重新发布都不丢数据；前端只能读和投，
 *            淘汰（inbox_trim）、清空（inbox_clear）、
 *            点赞（inbox_toggle_like）都走服务端 SECURITY DEFINER 函数）
 * ============================================================ */
'use strict';

const http = require('http');
const cloud = require('./cloud'); // 云服务客户端（publicConfig 初始化，全模块共用）

const MAX_LEN = 500;          // 单条字数上限
const MAX_ITEMS = 300;        // 总量上限（FIFO 淘汰最旧的）
const RATE_LIMIT_MS = 30000;  // 同一 IP 两次投喂的最小间隔
const CLEAR_TOKEN = process.env.CLEAR_TOKEN || ''; // 设置了才允许清空

/* ---------- 存储（云数据库） ---------- */
const TABLE = 'inbox_items';
const LIKE_TABLE = 'inbox_likes';
const LIKE_COUNT_TABLE = 'inbox_like_counts';
const LIKE_RATE_LIMIT_MS = 1000; // 同一 IP 两次点赞开关的最小间隔（防刷）
const lastLikeAt = new Map();    // ip -> ts，点赞限流用

/** 插入一条投喂，返回插入的行（id/ts 由数据库生成） */
async function dbInsert(text, source) {
  const { data, error } = await cloud.database
    .from(TABLE)
    .insert({ text: text, source: source || 'web' })
    .select();
  if (error) throw new Error(error.message || 'insert failed');
  return data && data[0];
}

/** FIFO 淘汰：只保留最新 MAX_ITEMS 条。
 *  淘汰在服务端函数 inbox_trim() 里原子完成（SECURITY DEFINER）；
 *  前端没有 DELETE 权限，从根上杜绝越界删除。
 *  淘汰失败不阻塞投喂（内容已落库），下次投喂会继续淘汰。 */
async function dbTrim() {
  await cloud.database.rpc('inbox_trim');
}

/** 全部投喂（最新在前） */
async function dbList() {
  const { data, error } = await cloud.database
    .from(TABLE)
    .select('id, ts, text, source')
    .order('ts', { ascending: false })
    .order('id', { ascending: false })
    .limit(MAX_ITEMS);
  if (error) throw new Error(error.message || 'select failed');
  return data || [];
}

/** 当前条数 */
async function dbCount() {
  const { data, error } = await cloud.database.from(TABLE).select('id');
  if (error) throw new Error(error.message || 'count failed');
  return data ? data.length : 0;
}

/** 清空（走 SECURITY DEFINER 函数，令牌在数据库侧校验） */
async function dbClearAll(token) {
  const { data, error } = await cloud.database.rpc('inbox_clear', { p_token: token });
  if (error) throw new Error(error.message || 'clear failed');
  return typeof data === 'number' ? data : 0;
}

/** 点赞 / 取消点赞（走 SECURITY DEFINER 函数，计数原子维护） */
async function dbToggleLike(itemId, visitor) {
  const { data, error } = await cloud.database.rpc('inbox_toggle_like', {
    p_item_id: itemId,
    p_visitor: visitor
  });
  if (error) throw new Error(error.message || 'toggle like failed');
  const row = Array.isArray(data) ? data[0] : data;
  return {
    liked: !!(row && row.liked),
    count: row && typeof row.n === 'number' ? row.n : 0
  };
}

/** 我的点赞 + 各条点赞数（visitor 非法时只回计数） */
async function dbLikesMeta(visitor) {
  const v = String(visitor == null ? '' : visitor).trim();
  const okVisitor = !!v && v.length <= 64;
  const [counts, mine] = await Promise.all([
    cloud.database.from(LIKE_COUNT_TABLE).select('item_id, n'),
    okVisitor
      ? cloud.database.from(LIKE_TABLE).select('item_id').eq('visitor', v)
      : Promise.resolve({ data: [], error: null })
  ]);
  if (counts.error) throw new Error(counts.error.message || 'like counts failed');
  if (mine.error) throw new Error(mine.error.message || 'my likes failed');
  const map = {};
  (counts.data || []).forEach(r => { map[Number(r.item_id)] = Number(r.n) || 0; });
  return {
    my: (mine.data || []).map(r => Number(r.item_id)).filter(n => Number.isInteger(n)),
    counts: map
  };
}

/* ---------- 纯逻辑（可单测） ---------- */
const lastDropAt = new Map(); // ip -> ts，投喂限流用

const inbox = {
  /**
   * 投喂一条。
   * @returns {{ok:true, item, total} | {ok:false, error, code}}
   *   code: 'validation' | 'ratelimit' | 'cloud'（云端故障）
   */
  async drop(text, source, ip) {
    const t = String(text == null ? '' : text).trim();
    if (!t) return { ok: false, error: '内容是空的', code: 'validation' };
    if (t.length > MAX_LEN) return { ok: false, error: '太长了，投喂请精简到 ' + MAX_LEN + ' 字以内', code: 'validation' };
    const now = Date.now();
    const last = lastDropAt.get(ip || 'anon') || 0;
    if (now - last < RATE_LIMIT_MS) {
      const wait = Math.ceil((RATE_LIMIT_MS - (now - last)) / 1000);
      return { ok: false, error: '投喂太频繁啦，' + wait + ' 秒后再来', code: 'ratelimit' };
    }
    lastDropAt.set(ip || 'anon', now);
    try {
      const item = await dbInsert(t, source);
      await dbTrim();
      const total = await dbCount();
      return { ok: true, item: item, total: total };
    } catch (e) {
      return { ok: false, error: '云端没接住，稍后再试', code: 'cloud' };
    }
  },
  /** 全部投喂（最新在前）；云故障时抛出，由 HTTP 层转成明确错误 */
  async list() { return dbList(); },
  async count() { return dbCount(); },
  /** 清空（需要令牌；服务器没配令牌时永远拒绝。
   *  令牌双重校验：服务器环境变量 CLEAR_TOKEN + 云端 inbox_config.clear_token） */
  async clear(token) {
    if (!CLEAR_TOKEN || token !== CLEAR_TOKEN) return { ok: false, error: '清空需要正确的令牌' };
    try {
      const cleared = await dbClearAll(String(token));
      return { ok: true, cleared: cleared };
    } catch (e) {
      return { ok: false, error: '云端拒绝了清空：请确认数据库 clear_token 与服务器 CLEAR_TOKEN 一致' };
    }
  },
  /**
   * 点赞 / 取消点赞。同一访客（visitor）对同一条再点一次即取消。
   * @returns {{ok:true, liked, count} | {ok:false, error, code}}
   */
  async toggleLike(itemId, visitor, ip) {
    const id = Number(itemId);
    if (!Number.isInteger(id) || id <= 0) return { ok: false, error: '无效的投喂', code: 'validation' };
    const v = String(visitor == null ? '' : visitor).trim();
    if (!v || v.length > 64) return { ok: false, error: '无效的访客标识', code: 'validation' };
    const now = Date.now();
    const last = lastLikeAt.get(ip || 'anon') || 0;
    if (now - last < LIKE_RATE_LIMIT_MS) {
      return { ok: false, error: '点得太快啦，慢一点点', code: 'ratelimit' };
    }
    lastLikeAt.set(ip || 'anon', now);
    try {
      const r = await dbToggleLike(id, v);
      return { ok: true, liked: r.liked, count: r.count };
    } catch (e) {
      return { ok: false, error: '云端没接住，稍后再试', code: 'cloud' };
    }
  },
  /** 我的点赞 + 各条点赞数 */
  async likesMeta(visitor) { return dbLikesMeta(visitor); },
  get maxLen() { return MAX_LEN; },
  get rateMs() { return RATE_LIMIT_MS; },
  get clearEnabled() { return !!CLEAR_TOKEN; }
};

/* ---------- 投喂墙页面 ---------- */
function page() {
  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="light">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="theme-color" content="#f0fdfa">
<meta name="description" content="给小流投喂——一个公开的投喂墙，打开链接就能扔入内容。">
<meta name="apple-mobile-web-app-capable" content="yes">
<title>给小流投喂 💧</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
  :root {
    --bg1: #f0fdfa; --bg2: #eff6ff;
    --blob1: rgba(45, 212, 191, .38); --blob2: rgba(96, 165, 250, .30);
    --card: rgba(255, 255, 255, .92);
    --card-line: #d5eff2;
    --field: #ffffff;
    --ink: #134e4a; --ink2: #4b6572; --ink3: #8ba0a8;
    --brand: #0d9488; --brand2: #14b8a6; --on-brand: #ffffff;
    --brand-soft: rgba(13, 148, 136, .12);
    --warn-bg: #fffbeb; --warn-line: #fde68a; --warn-ink: #92400e;
    --amber: #d97706; --red: #dc2626;
    --shadow: 0 8px 24px rgba(13, 148, 136, .10);
    --shadow-hover: 0 12px 28px rgba(13, 148, 136, .20);
    --radius: 16px;
  }
  [data-theme="dark"] {
    --bg1: #0a1420; --bg2: #0e1a2b;
    --blob1: rgba(45, 212, 191, .16); --blob2: rgba(96, 165, 250, .13);
    --card: rgba(22, 34, 52, .85);
    --card-line: #26394f;
    --field: rgba(10, 20, 32, .6);
    --ink: #dff5f1; --ink2: #a3bcc9; --ink3: #6b8494;
    --brand: #2dd4bf; --brand2: #2dd4bf; --on-brand: #062a27;
    --brand-soft: rgba(45, 212, 191, .15);
    --warn-bg: rgba(251, 191, 36, .12); --warn-line: rgba(251, 191, 36, .35); --warn-ink: #fcd34d;
    --shadow: 0 8px 24px rgba(0, 0, 0, .35);
    --shadow-hover: 0 12px 28px rgba(0, 0, 0, .45);
  }
  html { color-scheme: light dark; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Segoe UI", sans-serif;
    background: linear-gradient(165deg, var(--bg1), var(--bg2));
    color: var(--ink);
    min-height: 100vh;
    padding: 26px 16px calc(30px + env(safe-area-inset-bottom));
    transition: background .3s, color .3s;
  }
  .bg-blob { position: fixed; border-radius: 50%; filter: blur(70px); z-index: -1; pointer-events: none; }
  .b1 { width: 46vw; height: 46vw; min-width: 300px; min-height: 300px; background: var(--blob1); top: -12vw; right: -10vw; animation: float1 16s ease-in-out infinite alternate; }
  .b2 { width: 40vw; height: 40vw; min-width: 260px; min-height: 260px; background: var(--blob2); bottom: -10vw; left: -12vw; animation: float2 19s ease-in-out infinite alternate; }
  @keyframes float1 { from { transform: translate(0, 0) scale(1); } to { transform: translate(-4vw, 5vh) scale(1.08); } }
  @keyframes float2 { from { transform: translate(0, 0) scale(1); } to { transform: translate(5vw, -4vh) scale(1.1); } }
  .wrap { max-width: 680px; margin: 0 auto; display: flex; flex-direction: column; gap: 14px; position: relative; }

  .head { display: flex; flex-direction: column; gap: 12px; }
  .head-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
  .brand { display: flex; gap: 12px; align-items: center; }
  .logo { width: 46px; height: 46px; flex: none; border-radius: 14px; background: linear-gradient(135deg, var(--brand2), var(--brand)); display: grid; place-items: center; box-shadow: var(--shadow); }
  .logo svg { width: 26px; height: 26px; }
  h1 { font-size: 23px; letter-spacing: .5px; }
  .tagline { font-size: 12.5px; color: var(--ink2); margin-top: 4px; line-height: 1.6; max-width: 46ch; }
  .warn { font-size: 12px; color: var(--warn-ink); background: var(--warn-bg); border: 1px solid var(--warn-line); border-radius: 12px; padding: 9px 12px; line-height: 1.6; }

  .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
  .stat { background: var(--card); border: 1px solid var(--card-line); border-radius: 14px; padding: 10px 12px; backdrop-filter: blur(8px); display: flex; flex-direction: column; gap: 2px; }
  .stat b { font-size: 19px; color: var(--brand); font-variant-numeric: tabular-nums; }
  .stat span { font-size: 11px; color: var(--ink3); }

  .composer { background: var(--card); border: 1px solid var(--card-line); border-radius: 18px; padding: 14px; backdrop-filter: blur(8px); box-shadow: var(--shadow); display: flex; flex-direction: column; gap: 10px; }
  textarea {
    width: 100%; min-height: 92px; max-height: 40vh; border: 1.5px solid var(--card-line);
    border-radius: 14px; padding: 12px 14px; font-size: 16px; line-height: 1.65;
    background: var(--field); color: var(--ink); resize: none; font-family: inherit;
    transition: border-color .2s, box-shadow .2s;
  }
  textarea:focus { outline: none; border-color: var(--brand2); box-shadow: 0 0 0 4px var(--brand-soft); }
  textarea::placeholder { color: var(--ink3); }
  .composer-foot { display: flex; justify-content: space-between; align-items: center; font-size: 11.5px; color: var(--ink3); gap: 8px; }
  .counter { font-variant-numeric: tabular-nums; }
  .counter.warn { color: var(--amber); }
  .counter.over { color: var(--red); font-weight: 600; }
  .composer-actions { display: flex; gap: 10px; }
  .btn-primary {
    flex: 1; padding: 14px; border: none; border-radius: 14px; cursor: pointer;
    background: linear-gradient(135deg, var(--brand2), var(--brand)); color: var(--on-brand);
    font-size: 16.5px; font-weight: 600; font-family: inherit;
    box-shadow: 0 6px 16px rgba(13, 148, 136, .28);
    transition: transform .12s, box-shadow .2s, opacity .2s;
  }
  .btn-primary:hover { box-shadow: 0 8px 22px rgba(13, 148, 136, .38); }
  .btn-primary:active { transform: scale(.98); }
  .btn-primary:disabled { opacity: .65; cursor: default; }
  .btn-ghost {
    padding: 14px 15px; border: 1.5px solid var(--card-line); border-radius: 14px; cursor: pointer;
    background: transparent; color: var(--ink2); font-size: 14.5px; font-weight: 500; font-family: inherit;
    transition: border-color .2s, color .2s, transform .12s; white-space: nowrap;
  }
  .btn-ghost:hover { border-color: var(--brand2); color: var(--brand); }
  .btn-ghost:active { transform: scale(.98); }
  .icon-btn {
    width: 38px; height: 38px; flex: none; border: 1.5px solid var(--card-line); border-radius: 12px;
    background: var(--card); color: var(--ink2); font-size: 16px; cursor: pointer;
    display: grid; place-items: center; transition: border-color .2s, color .2s;
  }
  .icon-btn:hover { border-color: var(--brand2); color: var(--brand); }
  .icon-btn.spin svg { animation: spin .8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  .toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .search { flex: 1; min-width: 190px; position: relative; display: flex; align-items: center; }
  .search-ico { position: absolute; left: 11px; font-size: 13px; opacity: .55; pointer-events: none; }
  .search input {
    width: 100%; padding: 9px 32px 9px 32px; border: 1.5px solid var(--card-line); border-radius: 12px;
    background: var(--card); color: var(--ink); font-size: 14px; font-family: inherit;
  }
  .search input:focus { outline: none; border-color: var(--brand2); box-shadow: 0 0 0 4px var(--brand-soft); }
  .q-clear { position: absolute; right: 7px; width: 22px; height: 22px; border: none; border-radius: 50%; background: var(--brand-soft); color: var(--brand); cursor: pointer; font-size: 13px; line-height: 1; display: grid; place-items: center; }
  .sorts { display: flex; gap: 4px; background: var(--card); border: 1.5px solid var(--card-line); border-radius: 12px; padding: 3px; }
  .chip { border: none; background: transparent; color: var(--ink2); font-size: 13px; padding: 6px 12px; border-radius: 9px; cursor: pointer; font-family: inherit; transition: background .2s, color .2s; }
  .chip.active { background: var(--brand); color: var(--on-brand); font-weight: 600; }

  .list { display: flex; flex-direction: column; gap: 10px; }
  .card {
    background: var(--card); border: 1px solid var(--card-line); border-radius: var(--radius);
    padding: 13px 15px; backdrop-filter: blur(8px);
    transition: transform .18s, box-shadow .18s, border-color .18s;
  }
  .card:hover { transform: translateY(-2px); box-shadow: var(--shadow-hover); border-color: var(--brand2); }
  .card.fresh { animation: rise .4s ease both; }
  @keyframes rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
  .card.mine { border-left: 3px solid var(--brand2); }
  .card.pulse { animation: pulse 1.1s ease-out 2; }
  @keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(20, 184, 166, .5); } 100% { box-shadow: 0 0 0 16px rgba(20, 184, 166, 0); } }
  .txt { font-size: 14.5px; line-height: 1.7; color: var(--ink); white-space: pre-wrap; word-break: break-word; }
  .meta { display: flex; align-items: center; gap: 8px; margin-top: 9px; flex-wrap: wrap; }
  .time { font-size: 11.5px; color: var(--ink3); font-variant-numeric: tabular-nums; }
  .src { font-size: 10.5px; color: var(--brand); background: var(--brand-soft); border-radius: 6px; padding: 2px 7px; }
  .badge-mine { font-size: 10.5px; color: var(--on-brand); background: var(--brand); border-radius: 6px; padding: 2px 7px; font-weight: 600; }
  .acts { margin-left: auto; display: flex; gap: 6px; }
  .like, .copy {
    border: 1px solid var(--card-line); background: transparent; color: var(--ink2);
    font-size: 12px; padding: 4px 10px; border-radius: 8px; cursor: pointer; font-family: inherit;
    display: inline-flex; align-items: center; gap: 4px; transition: border-color .15s, color .15s, background .15s;
  }
  .like:hover, .copy:hover { border-color: var(--brand2); color: var(--brand); }
  .like.liked { color: var(--brand); border-color: var(--brand2); background: var(--brand-soft); font-weight: 600; }

  .empty { text-align: center; padding: 34px 0 26px; color: var(--ink3); }
  .empty svg { width: 44px; height: 44px; opacity: .45; margin-bottom: 10px; }
  .empty p { font-size: 14px; }
  .empty-sub { font-size: 12px; margin-top: 4px; }

  .foot { text-align: center; font-size: 11.5px; color: var(--ink3); line-height: 1.8; padding: 6px 0 2px; }

  .toast {
    position: fixed; left: 50%; bottom: 26px; transform: translate(-50%, 16px);
    background: rgba(15, 23, 42, .92); color: #fff; font-size: 13.5px;
    padding: 10px 18px; border-radius: 12px; box-shadow: 0 10px 30px rgba(0, 0, 0, .25);
    opacity: 0; pointer-events: none; transition: opacity .25s, transform .25s; z-index: 10;
    max-width: 86vw; text-align: center;
  }
  .toast.show { opacity: 1; transform: translate(-50%, 0); }
  .toast.err { background: rgba(153, 27, 27, .94); }

  button:focus-visible, input:focus-visible, textarea:focus-visible { outline: 2px solid var(--brand2); outline-offset: 2px; }
  @media (max-width: 420px) {
    h1 { font-size: 21px; }
    .btn-ghost { padding: 14px 12px; font-size: 13.5px; }
  }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation-duration: .01ms !important; animation-iteration-count: 1 !important; transition-duration: .01ms !important; }
  }
</style>
</head>
<body>
<div class="bg-blob b1"></div>
<div class="bg-blob b2"></div>
<main class="wrap">
  <header class="head">
    <div class="head-top">
      <div class="brand">
        <div class="logo" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none"><path d="M12 2.5c3.6 4.2 7 8.2 7 11.7a7 7 0 0 1-14 0c0-3.5 3.4-7.5 7-11.7z" fill="#fff"/><path d="M9.3 14.6a2.9 2.9 0 0 0 2.9 2.9" stroke="#0d9488" stroke-width="1.7" stroke-linecap="round"/></svg>
        </div>
        <div>
          <h1>给小流投喂</h1>
          <p class="tagline">扔进来的内容，会进入小流主人搭建的工作流——整理成摘要、周报或灵感库</p>
        </div>
      </div>
      <button id="themeBtn" class="icon-btn" type="button" title="切换深浅色" aria-label="切换深浅色">🌙</button>
    </div>
    <div class="warn">⚠️ 这是一个公开投喂墙：你扔的内容所有人可见。请不要投喂隐私信息（密码、证件、住址等）。</div>
  </header>

  <section class="stats" aria-label="投喂墙统计">
    <div class="stat"><b id="statTotal">0</b><span>墙上的投喂</span></div>
    <div class="stat"><b id="statToday">0</b><span>今日新增</span></div>
    <div class="stat"><b id="statMine">0</b><span>我扔的</span></div>
  </section>

  <section class="composer">
    <textarea id="t" maxlength="${MAX_LEN}" rows="3" placeholder="今天的工作记录 / 一个链接 / 一条灵感…&#10;（最多 ${MAX_LEN} 字，30 秒内可投喂一次）"></textarea>
    <div class="composer-foot">
      <span class="hint">Ctrl+Enter 快速发送</span>
      <span class="counter" id="counter">0 / ${MAX_LEN}</span>
    </div>
    <div class="composer-actions">
      <button id="go" class="btn-primary" type="button">扔进投喂墙 📨</button>
      <button id="lucky" class="btn-ghost" type="button" title="随机看一条墙上的内容">🎲 手气一条</button>
    </div>
  </section>

  <section class="toolbar">
    <div class="search">
      <span class="search-ico" aria-hidden="true">🔍</span>
      <input id="q" type="search" placeholder="搜索投喂内容…" autocomplete="off" aria-label="搜索投喂内容">
      <button id="qClear" class="q-clear" type="button" hidden title="清空搜索" aria-label="清空搜索">×</button>
    </div>
    <div class="sorts" role="group" aria-label="排序方式">
      <button id="sortNew" class="chip active" type="button">最新</button>
      <button id="sortOld" class="chip" type="button">最早</button>
    </div>
    <button id="refresh" class="icon-btn" type="button" title="刷新投喂墙" aria-label="刷新投喂墙">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/></svg>
    </button>
  </section>

  <section class="wall">
    <div id="list" class="list"></div>
    <div id="empty" class="empty" hidden>
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.5c3.6 4.2 7 8.2 7 11.7a7 7 0 0 1-14 0c0-3.5 3.4-7.5 7-11.7z"/></svg>
      <p id="emptyText">墙还空着，来扔第一条吧</p>
      <p id="emptySub" class="empty-sub">内容公开可见 · 30 秒可以投一次</p>
    </div>
  </section>

  <footer class="foot">
    由 <b>小流 XiaoFlow</b> 驱动 · 数据存于云端 · 内容公开可见 · 请勿投喂隐私
  </footer>
</main>
<div id="toast" class="toast" role="status" aria-live="polite"></div>
<script>
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var MAX_LEN = ${MAX_LEN};
  var state = { items: [], myLikes: {}, likeCounts: {}, myDrops: {}, seen: {}, sort: 'new', query: '', loading: false, pageTs: Date.now() };
  var toastTimer = null;

  /* ---------- 工具 ---------- */
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function absTime(ts) {
    var d = new Date(ts);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function relTime(ts) {
    var diff = Date.now() - ts;
    if (diff < 60e3) return '刚刚';
    if (diff < 3600e3) return Math.floor(diff / 60e3) + ' 分钟前';
    if (diff < 86400e3) return Math.floor(diff / 3600e3) + ' 小时前';
    var d = new Date(ts), now = new Date();
    var hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
    if (diff < 1728e5) return '昨天 ' + hm;
    var md = (d.getMonth() + 1) + '月' + d.getDate() + '日';
    return d.getFullYear() === now.getFullYear() ? md : d.getFullYear() + '年' + md;
  }
  var SRC_LABELS = { 'public-web': '网页', 'web': '网页', 'share': '分享', 'shortcut': '快捷指令' };
  function srcLabel(s) { return SRC_LABELS[s] || s || '未知'; }
  function store(key, val) {
    try {
      if (val === undefined) return localStorage.getItem(key);
      localStorage.setItem(key, val);
    } catch (e) { /* 隐私模式等场景下静默降级 */ }
    return null;
  }
  function getVisitor() {
    var v = store('xflow-visitor');
    if (!v) {
      v = 'v-' + Math.random().toString(36).slice(2, 10) + '-' + Date.now().toString(36);
      store('xflow-visitor', v);
    }
    return v;
  }
  function getMyDrops() {
    try { return JSON.parse(store('xflow-mydrops') || '{}'); } catch (e) { return {}; }
  }
  function addMyDrop(id) {
    var d = getMyDrops();
    d[id] = 1;
    store('xflow-mydrops', JSON.stringify(d));
  }
  function toast(msg, type) {
    var box = $('toast');
    box.textContent = (type === 'err' ? '✗ ' : type === 'ok' ? '✓ ' : '') + msg;
    box.className = 'toast show' + (type === 'err' ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { box.className = 'toast'; }, 2400);
  }

  /* ---------- 主题 ---------- */
  function getTheme() {
    var t = store('xflow-theme');
    if (t === 'dark' || t === 'light') return t;
    return (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
  }
  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    $('themeBtn').textContent = t === 'dark' ? '☀️' : '🌙';
    $('themeBtn').title = t === 'dark' ? '切换到浅色模式' : '切换到深色模式';
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', t === 'dark' ? '#0a1420' : '#f0fdfa');
    store('xflow-theme', t);
  }

  /* ---------- 输入框 ---------- */
  function updateCounter() {
    var len = $('t').value.length;
    var c = $('counter');
    c.textContent = len + ' / ' + MAX_LEN;
    var r = len / MAX_LEN;
    c.className = 'counter' + (r >= 0.95 ? ' over' : r >= 0.8 ? ' warn' : '');
  }
  function autoGrow() {
    var t = $('t');
    t.style.height = 'auto';
    t.style.height = Math.min(t.scrollHeight, window.innerHeight * 0.4) + 'px';
  }

  /* ---------- 渲染 ---------- */
  function visibleItems() {
    var q = state.query.trim().toLowerCase();
    var arr = state.items.filter(function (x) { return !q || String(x.text).toLowerCase().indexOf(q) >= 0; });
    arr.sort(function (a, b) {
      var d = (a.ts - b.ts) || (a.id - b.id);
      return state.sort === 'new' ? -d : d;
    });
    return arr;
  }
  function renderStats() {
    var dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    var today = 0, mine = 0;
    state.items.forEach(function (x) {
      if (x.ts >= dayStart.getTime()) today++;
      if (state.myDrops[x.id]) mine++;
    });
    $('statTotal').textContent = state.items.length;
    $('statToday').textContent = today;
    $('statMine').textContent = mine;
  }
  function renderWall() {
    var arr = visibleItems();
    var list = $('list');
    if (!arr.length) {
      list.innerHTML = '';
      $('empty').hidden = false;
      $('emptyText').textContent = state.query ? '没有找到包含「' + state.query + '」的投喂' : '墙还空着，来扔第一条吧';
      $('emptySub').textContent = state.query ? '换个关键词试试' : '内容公开可见 · 30 秒可以投一次';
      return;
    }
    $('empty').hidden = true;
    // 新条目（打开页面后出现的）只动画一次
    var fresh = {};
    arr.forEach(function (x) {
      if (!state.seen[x.id]) {
        state.seen[x.id] = true;
        if (x.ts > state.pageTs) fresh[x.id] = true;
      }
    });
    list.innerHTML = arr.map(function (x) {
      var liked = !!state.myLikes[x.id];
      var n = state.likeCounts[x.id] || 0;
      var cls = 'card' + (fresh[x.id] ? ' fresh' : '') + (state.myDrops[x.id] ? ' mine' : '');
      return '<article class="' + cls + '" data-id="' + x.id + '">' +
        '<p class="txt">' + esc(x.text) + '</p>' +
        '<div class="meta">' +
          '<span class="time" title="' + absTime(x.ts) + '">' + relTime(x.ts) + '</span>' +
          '<span class="src">' + esc(srcLabel(x.source)) + '</span>' +
          (state.myDrops[x.id] ? '<span class="badge-mine">我</span>' : '') +
          '<span class="acts">' +
            '<button type="button" class="like' + (liked ? ' liked' : '') + '" data-id="' + x.id + '" title="' + (liked ? '取消点赞' : '点赞') + '" aria-label="' + (liked ? '取消点赞' : '点赞') + '">👍 <b>' + n + '</b></button>' +
            '<button type="button" class="copy" data-id="' + x.id + '" title="复制这条内容" aria-label="复制这条内容">复制</button>' +
          '</span>' +
        '</div>' +
      '</article>';
    }).join('');
  }
  function paintLike(id) {
    var btn = document.querySelector('.like[data-id="' + id + '"]');
    if (!btn) return;
    var liked = !!state.myLikes[id];
    btn.classList.toggle('liked', liked);
    btn.innerHTML = '👍 <b>' + (state.likeCounts[id] || 0) + '</b>';
    btn.title = liked ? '取消点赞' : '点赞';
  }

  /* ---------- 数据 ---------- */
  function loadWall(silent) {
    if (state.loading) return;
    state.loading = true;
    if (!silent) $('refresh').classList.add('spin');
    fetch('/api/inbox?visitor=' + encodeURIComponent(getVisitor()))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) { if (!silent) toast('投喂墙读取失败', 'err'); return; }
        state.items = d.items || [];
        state.myLikes = {};
        (d.myLikes || []).forEach(function (id) { state.myLikes[id] = true; });
        state.likeCounts = d.likeCounts || {};
        state.myDrops = getMyDrops();
        renderStats();
        renderWall();
      })
      .catch(function () { if (!silent) toast('网络开了小差', 'err'); })
      .then(function () {
        state.loading = false;
        $('refresh').classList.remove('spin');
      });
  }
  function doDrop() {
    var text = $('t').value.trim();
    if (!text) { $('t').focus(); return; }
    $('go').disabled = true;
    $('go').textContent = '投喂中…';
    fetch('/api/drop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text, source: 'public-web' })
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.ok) {
          addMyDrop(d.id);
          $('t').value = '';
          updateCounter();
          autoGrow();
          toast('已扔进投喂墙', 'ok');
          loadWall();
        } else {
          toast(d.error || '没扔成，稍后再试', 'err');
        }
      })
      .catch(function () { toast('网络出了点问题', 'err'); })
      .then(function () {
        $('go').disabled = false;
        $('go').textContent = '扔进投喂墙 📨';
      });
  }
  function toggleLike(id) {
    var wasLiked = !!state.myLikes[id];
    var prevN = state.likeCounts[id] || 0;
    if (wasLiked) { delete state.myLikes[id]; state.likeCounts[id] = Math.max(0, prevN - 1); }
    else { state.myLikes[id] = true; state.likeCounts[id] = prevN + 1; }
    paintLike(id);
    fetch('/api/like', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: id, visitor: getVisitor() })
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.ok) {
          if (d.liked) state.myLikes[id] = true; else delete state.myLikes[id];
          state.likeCounts[id] = d.count;
        } else {
          if (wasLiked) state.myLikes[id] = true; else delete state.myLikes[id];
          state.likeCounts[id] = prevN;
          toast(d.error || '点赞失败', 'err');
        }
        paintLike(id);
      })
      .catch(function () {
        if (wasLiked) state.myLikes[id] = true; else delete state.myLikes[id];
        state.likeCounts[id] = prevN;
        paintLike(id);
        toast('网络出了点问题', 'err');
      });
  }
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast('已复制到剪贴板', 'ok'); }, function () { fallbackCopy(text); });
    } else {
      fallbackCopy(text);
    }
  }
  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { /* 老浏览器 */ }
    document.body.removeChild(ta);
    toast(ok ? '已复制到剪贴板' : '复制失败，长按文字手动复制吧', ok ? 'ok' : 'err');
  }
  function luckyPick() {
    var arr = visibleItems();
    if (!arr.length) { toast('墙还空着，先扔一条吧', 'err'); return; }
    var x = arr[Math.floor(Math.random() * arr.length)];
    var el = document.querySelector('.card[data-id="' + x.id + '"]');
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.remove('pulse');
    void el.offsetWidth;
    el.classList.add('pulse');
    setTimeout(function () { el.classList.remove('pulse'); }, 2400);
  }

  /* ---------- 事件 ---------- */
  $('t').addEventListener('input', function () { updateCounter(); autoGrow(); });
  $('t').addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); doDrop(); }
  });
  $('go').addEventListener('click', doDrop);
  $('lucky').addEventListener('click', luckyPick);
  $('refresh').addEventListener('click', function () { loadWall(); });
  $('themeBtn').addEventListener('click', function () { applyTheme(getTheme() === 'dark' ? 'light' : 'dark'); });
  $('sortNew').addEventListener('click', function () { setSort('new'); });
  $('sortOld').addEventListener('click', function () { setSort('old'); });
  function setSort(s) {
    state.sort = s;
    $('sortNew').classList.toggle('active', s === 'new');
    $('sortOld').classList.toggle('active', s === 'old');
    renderWall();
  }
  $('q').addEventListener('input', function () {
    state.query = this.value;
    $('qClear').hidden = !this.value;
    renderWall();
  });
  $('qClear').addEventListener('click', function () {
    $('q').value = '';
    state.query = '';
    this.hidden = true;
    renderWall();
    $('q').focus();
  });
  document.addEventListener('click', function (e) {
    var target = e.target;
    if (!target || !target.closest) return;
    var likeBtn = target.closest('.like');
    if (likeBtn) { toggleLike(Number(likeBtn.getAttribute('data-id'))); return; }
    var copyBtn = target.closest('.copy');
    if (copyBtn) {
      var id = Number(copyBtn.getAttribute('data-id'));
      var item = state.items.filter(function (x) { return x.id === id; })[0];
      if (item) copyText(item.text);
    }
  });
  setInterval(function () { if (!document.hidden) loadWall(true); }, 30000);

  /* ---------- 启动 ---------- */
  applyTheme(getTheme());
  var urlText = new URLSearchParams(location.search).get('text');
  if (urlText) {
    $('t').value = urlText;
    toast('已从链接预填内容', 'ok');
  }
  updateCounter();
  autoGrow();
  loadWall();
})();
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
      try {
        const visitor = u.searchParams.get('visitor') || '';
        // 三个取数并行；任一失败都不拖垮整墙（点赞数据降级为空）
        const settled = await Promise.allSettled([inbox.list(), inbox.count(), inbox.likesMeta(visitor)]);
        const items = settled[0].status === 'fulfilled' ? settled[0].value : null;
        if (!items) return send(res, 500, { ok: false, error: '投喂墙读取失败：云服务暂时不可用' });
        const total = settled[1].status === 'fulfilled' ? settled[1].value : items.length;
        let myLikes = [], likeCounts = {};
        if (settled[2].status === 'fulfilled') {
          myLikes = settled[2].value.my;
          likeCounts = settled[2].value.counts;
        }
        return send(res, 200, { ok: true, total: total, items: items, myLikes: myLikes, likeCounts: likeCounts });
      } catch (e) {
        return send(res, 500, { ok: false, error: '投喂墙读取失败：云服务暂时不可用' });
      }
    }
    // 点赞 / 取消点赞：POST /api/like {id, visitor}
    if (req.method === 'POST' && u.pathname === '/api/like') {
      const body = await readBody(req);
      const r = await inbox.toggleLike(body.id, body.visitor, clientIp(req));
      if (!r.ok) return send(res, r.code === 'cloud' ? 500 : r.code === 'validation' ? 400 : 429, { ok: false, error: r.error });
      return send(res, 200, { ok: true, liked: r.liked, count: r.count, id: Number(body.id) });
    }
    // GET 投喂（快捷指令 / 简单分享用）：/drop?text=...&source=...
    if (req.method === 'GET' && u.pathname === '/drop') {
      const r = await inbox.drop(u.searchParams.get('text'), u.searchParams.get('source') || 'share', clientIp(req));
      if (!r.ok) return send(res, r.code === 'cloud' ? 500 : 429, { ok: false, error: r.error });
      return send(res, 200, { ok: true, total: r.total, id: r.item.id });
    }
    // POST 投喂：/api/drop {text, source}
    if (req.method === 'POST' && u.pathname === '/api/drop') {
      const body = await readBody(req);
      const r = await inbox.drop(body.text, body.source || 'share', clientIp(req));
      if (!r.ok) return send(res, r.code === 'cloud' ? 500 : 429, { ok: false, error: r.error });
      return send(res, 200, { ok: true, total: r.total, id: r.item.id });
    }
    // 清空：必须带正确令牌（未配置令牌时该功能关闭）
    if (req.method === 'POST' && u.pathname === '/api/clear') {
      const body = await readBody(req);
      const token = body.token || u.searchParams.get('token') || '';
      const r = await inbox.clear(String(token));
      if (!r.ok) return send(res, 403, { ok: false, error: r.error });
      return send(res, 200, { ok: true, cleared: r.cleared });
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
    console.log('  规则：        单条 ≤ ' + MAX_LEN + ' 字 · 同 IP ' + (RATE_LIMIT_MS / 1000) + ' 秒 1 条 · 总量 ' + MAX_ITEMS + ' 条 · 可点赞');
    console.log('  清空令牌：    ' + (CLEAR_TOKEN ? '已配置' : '未配置（清空功能关闭）'));
    console.log('  数据存储：    云端数据库 inbox_items（重启不丢失）');
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

module.exports = { inbox, createHandler, start, page, MAX_LEN, MAX_ITEMS, RATE_LIMIT_MS };

if (require.main === module) {
  // 命令行给了端口就用它；没给则交给 start() 读 PORT 环境变量（发布沙箱会注入）
  start(process.argv[2]);
}
