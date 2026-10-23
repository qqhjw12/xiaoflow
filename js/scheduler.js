/* ============================================================
 * 小流 XiaoFlow — 正式运行（常驻定时触发）
 * 页面保持打开时，标记为「已启用」的工作流会按真实时间触发：
 *   · 支持 每天 / 每周几 / 每隔一段时间 三种频率
 *   · 触发后真实执行工作流，结果走系统通知 + 运行记录
 *   · 刷新页面不补跑已经触发过的周期（lastFired 持久化）
 * ============================================================ */
(function (root) {
  const XF = root.XF || (root.XF = {});
  if (typeof module !== 'undefined' && module.exports) module.exports = XF;

  const LOG_KEY = 'xiaoflow.runlog.v1';
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  let tickTimer = null;
  const firedAt = {}; // wfId -> 本会话内最近触发时刻（防同一周期重复触发）

  function ls() {
    try { return (typeof localStorage !== 'undefined') ? localStorage : null; } catch (e) { return null; }
  }
  function trunc(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…' : s; }

  function enabledWfs() {
    return XF.store.list().filter(w => w.enabled);
  }

  /** 工作流里的 timer 触发器配置（取第一个），没有则返回 null */
  function timerCfg(wf) {
    const n = (wf.nodes || []).find(x => x.type === 'timer');
    return n ? (n.cfg || {}) : null;
  }

  /**
   * 计算下一次触发的时间戳。
   * 规则：目标时刻已过但本周期还没触发过 → 返回该时刻（到点即触发，含补跑一次）；
   *      本周期已触发过 → 返回下一个周期。
   * @returns {number|null} 无法定时时返回 null
   */
  function nextFire(wf, from) {
    const cfg = timerCfg(wf);
    if (!cfg) return null;
    const now = from || Date.now();
    const last = wf.lastFired || 0;

    if (cfg.freq === '每隔一段时间') {
      const mins = Math.max(1, Number(cfg.minutes) || 45);
      // 从上次触发时刻起算：页面关了一段时间再打开，超过一个间隔会立即补一次
      const base = last > 0 ? last : now;
      return base + mins * 60000;
    }

    const parts = String(cfg.time || '08:00').split(':');
    const h = parseInt(parts[0], 10) || 0;
    const m = parseInt(parts[1], 10) || 0;

    const dayMap = { '每周日': 0, '每周一': 1, '每周二': 2, '每周三': 3, '每周四': 4, '每周五': 5, '每周六': 6 };

    if (cfg.freq === '每天' || dayMap[cfg.freq] == null) {
      const t = new Date(now); t.setHours(h, m, 0, 0);
      if (t.getTime() > now) return t.getTime();          // 今天还没到点
      if (last < t.getTime()) return t.getTime();         // 今天已到点但还没跑过 → 触发
      t.setDate(t.getDate() + 1);
      return t.getTime();
    }

    // 每周几
    const want = dayMap[cfg.freq];
    const t = new Date(now); t.setHours(h, m, 0, 0);
    t.setDate(t.getDate() + ((want - t.getDay() + 7) % 7));
    if (t.getTime() <= now) {
      if (last < t.getTime()) return t.getTime();         // 本周这个点已过但没跑过 → 触发
      t.setDate(t.getDate() + 7);
    }
    return t.getTime();
  }

  /** 触发一次：真实执行 + 记日志 + 系统通知 */
  async function fire(wf) {
    const res = await XF.runWorkflow(wf, () => {});
    const steps = (res && res.steps) || [];
    const last = steps[steps.length - 1];
    const body = res && res.ok
      ? `${steps.length} 步执行完成：${last ? last.outText : ''}`
      : '出错了：' + (res && res.error);
    appendLog(wf.id, wf.name, !!(res && res.ok), body);
    wf.lastFired = Date.now();
    XF.store.save(wf);
    if (XF.notify) XF.notify.push('💧 小流 · ' + (wf.name || '小流程'), trunc(body, 120), 'xf-fire-' + wf.id);
    return res;
  }

  async function tick() {
    const now = Date.now();
    for (const wf of enabledWfs()) {
      if (!timerCfg(wf)) continue;
      const next = nextFire(wf, now);
      if (next == null || next > now) continue;
      if (firedAt[wf.id] && now - firedAt[wf.id] < 60000) continue; // 防抖
      firedAt[wf.id] = now;
      await fire(wf);
    }
  }

  /* ---------- 运行记录 ---------- */
  let memoryLogs = null; // 无 localStorage 环境（如 Node 测试）的内存回退
  function appendLog(wfId, name, ok, text) {
    const store = ls();
    if (!store) {
      memoryLogs = memoryLogs || [];
      memoryLogs.unshift({ ts: Date.now(), wfId, name, ok, text: trunc(text, 200) });
      if (memoryLogs.length > 50) memoryLogs = memoryLogs.slice(0, 50);
      return;
    }
    let all = [];
    try { all = JSON.parse(store.getItem(LOG_KEY) || '[]'); } catch (e) { all = []; }
    if (!Array.isArray(all)) all = [];
    all.unshift({ ts: Date.now(), wfId, name, ok, text: trunc(text, 200) });
    if (all.length > 50) all = all.slice(0, 50);
    try { store.setItem(LOG_KEY, JSON.stringify(all)); } catch (e) { /* 忽略 */ }
  }
  function logs(limit) {
    const store = ls();
    let all = [];
    if (store) {
      try { all = JSON.parse(store.getItem(LOG_KEY) || '[]'); } catch (e) { all = []; }
    } else {
      all = memoryLogs || [];
    }
    return Array.isArray(all) ? all.slice(0, limit || 20) : [];
  }
  function clearLogs() {
    try { const s = ls(); if (s) s.removeItem(LOG_KEY); } catch (e) { /* 忽略 */ }
  }

  function start() {
    if (tickTimer) return;
    tickTimer = setInterval(tick, 1000);
    setTimeout(tick, 800); // 启动后尽快检查一次（启用不久的流程不用等整秒）
  }
  function stop() {
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  }

  XF.scheduler = {
    nextFire, timerCfg, enabledWfs, fire, tick,
    logs, clearLogs, start, stop,
    isRunning() { return !!tickTimer; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
