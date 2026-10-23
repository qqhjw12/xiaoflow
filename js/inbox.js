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
  const DEF_PORT = 8787;
  let memoryPort = null; // 无 localStorage 环境（Node 测试）的回退

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
    base() { return 'http://127.0.0.1:' + getPort(); },
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
