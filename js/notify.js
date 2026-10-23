/* ============================================================
 * 小流 XiaoFlow — 真实系统通知（浏览器 Notification API）
 * 优先弹系统通知；不可用/未授权时回退为页面内提示。
 * ============================================================ */
(function (root) {
  const XF = root.XF || (root.XF = {});
  if (typeof module !== 'undefined' && module.exports) module.exports = XF;

  let fallbackHandler = null;

  function supported() {
    return typeof window !== 'undefined' && 'Notification' in window;
  }

  XF.notify = {
    /** 'unsupported' | 'default' | 'granted' | 'denied' */
    state() {
      if (!supported()) return 'unsupported';
      return Notification.permission;
    },
    /** 请求授权（需在用户手势中调用）。返回是否获得授权 */
    async request() {
      if (!supported()) return false;
      if (Notification.permission === 'granted') return true;
      if (Notification.permission === 'denied') return false;
      try { return await Notification.requestPermission(); } catch (e) { return false; }
    },
    /** 注册回退处理器（app 层用 toast 提示） */
    onFallback(fn) { fallbackHandler = fn; },
    /**
     * 发一条通知。能用系统通知就发，否则触发回退。
     * @returns {boolean} 是否走了系统通知
     */
    push(title, body, tag) {
      if (supported() && Notification.permission === 'granted') {
        try {
          const n = new Notification(title, { body: body || '', tag: tag || ('xf-' + Date.now()) });
          n.onclick = () => { try { window.focus(); } catch (e) {} n.close(); };
          return true;
        } catch (e) { /* 落到回退 */ }
      }
      if (fallbackHandler) fallbackHandler(title, body);
      return false;
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
