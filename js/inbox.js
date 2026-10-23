/* ============================================================
 * 小流 XiaoFlow — 投递箱客户端（连接本机 inbox-server）
 * 手机网页/分享菜单扔进来的内容，通过这里读进小流。
 * 服务没开时所有调用都会失败，界面据此显示"未连接"。
 * 端口可在「设置」里改（默认 8787）。
 * ============================================================ */
(function (root) {
  const XF = root.XF || (root.XF = {});
  if (typeof module !== 'undefined' && module.exports) module.exports = XF;

  const KEY = 'xiaoflow.inbox.port';
  const HOST_KEY = 'xiaoflow.inbox.host';
  const DEF_PORT = 8787;
  let memoryPort = null; // 无 localStorage 环境（Node 测试）的回退
  let memoryHost = null;

  function getPort() {
    try {
      const ls = (typeof localStorage !== 'undefined') ? localStorage : null;
      const p = ls ? ls.getItem(KEY) : memoryPort;
      const n = parseInt(p, 10);
      return (n && n > 0 && n < 65536) ? n : DEF_PORT;
    } catch (e) { return DEF_PORT; }
  }
  function setPort(p) {
    const n = parseInt(p, 10);
    if (!(n && n > 0 && n < 65536)) return DEF_PORT;
    memoryPort = n;
    try {
      const ls = (typeof localStorage !== 'undefined') ? localStorage : null;
      if (ls) ls.setItem(KEY, String(n));
    } catch (e) { /* 忽略写入失败 */ }
    return n;
  }

  /**
   * 投递服务的主机地址。规则：
   *  · 设置里填了就用填的（高级用户）
   *  · 否则：从 http(s) 页面访问时（如手机连 WiFi 开 192.168.x.x）自动用当前页面的主机名
   *  · file:// 直接打开时用 127.0.0.1
   * 这样手机打开小流时，投递箱自动连到电脑上，无需任何配置。
   */
  function getHost() {
    try {
      const ls = (typeof localStorage !== 'undefined') ? localStorage : null;
      const saved = ls ? ls.getItem(HOST_KEY) : memoryHost;
      if (saved && saved.trim()) return saved.trim();
    } catch (e) { /* 忽略 */ }
    try {
      const loc = (typeof location !== 'undefined') ? location : null;
      if (loc && /^https?:$/.test(loc.protocol) && loc.hostname &&
          loc.hostname !== 'localhost' && loc.hostname !== '127.0.0.1') {
        return loc.hostname;
      }
    } catch (e) { /* 忽略 */ }
    return '127.0.0.1';
  }
  function setHost(h) {
    const v = (h || '').trim();
    memoryHost = v || null;
    try {
      const ls = (typeof localStorage !== 'undefined') ? localStorage : null;
      if (ls) {
        if (v) ls.setItem(HOST_KEY, v);
        else ls.removeItem(HOST_KEY);
      }
    } catch (e) { /* 忽略写入失败 */ }
    return v;
  }
  /** 用户显式设置过的主机（未设置过返回空串，设置框据此显示占位符） */
  function getSavedHost() {
    try {
      const ls = (typeof localStorage !== 'undefined') ? localStorage : null;
      return (ls ? ls.getItem(HOST_KEY) : memoryHost) || '';
    } catch (e) { return ''; }
  }

  function fmtTime(ts) {
    const d = new Date(ts);
    const p = n => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  const SRC_LABEL = { 'mobile-web': '📱 手机网页', 'share': '📤 系统分享', 'ios-shortcut': '🍎 快捷指令' };

  XF.inbox = {
    get DEF_PORT() { return DEF_PORT; },
    getPort,
    setPort,
    getHost,
    setHost,
    getSavedHost,
    base() { return 'http://' + getHost() + ':' + getPort(); },
    /** 拉取待扔列表（最新在前）。服务没开会抛错 */
    async list() {
      if (typeof fetch !== 'function') throw new Error('当前环境不支持网络请求');
      const r = await fetch(XF.inbox.base() + '/api/inbox');
      if (!r.ok) throw new Error('服务响应 ' + r.status);
      const d = await r.json();
      return Array.isArray(d.items) ? d.items : [];
    },
    /** 消费：清空服务端投递 */
    async clear() {
      if (typeof fetch !== 'function') throw new Error('当前环境不支持网络请求');
      await fetch(XF.inbox.base() + '/api/clear', { method: 'POST' });
    },
    label(item) { return (SRC_LABEL[item.source] || '📥 ' + (item.source || '未知')) + ' · ' + fmtTime(item.ts); },
    /** 把多条投递合并成一段可读文本（带入收集箱用） */
    mergeText(items) {
      return items.slice().reverse().map(x => `【${fmtTime(x.ts)}】${x.text}`).join('\n');
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
