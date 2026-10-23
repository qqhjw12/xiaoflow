/* ============================================================
 * 小流 XiaoFlow — 可选接入本机 Ollama（本地 LLM）
 * 默认关闭：没装 Ollama 的用户完全无感，AI 节点用模拟回答；
 * 在设置里开启且探测可达后，AI 节点改走真实本地模型。
 * ============================================================ */
(function (root) {
  const XF = root.XF || (root.XF = {});
  if (typeof module !== 'undefined' && module.exports) module.exports = XF;

  const KEY = 'xiaoflow.ollama.v1';
  const DEF = { url: 'http://localhost:11434', model: 'qwen2.5:3b', enabled: false };

  function getSettings() {
    try {
      const ls = (typeof localStorage !== 'undefined') ? localStorage : null;
      const raw = ls ? ls.getItem(KEY) : null;
      return raw ? { ...DEF, ...JSON.parse(raw) } : { ...DEF };
    } catch (e) { return { ...DEF }; }
  }
  function saveSettings(patch) {
    const next = { ...getSettings(), ...(patch || {}) };
    try {
      const ls = (typeof localStorage !== 'undefined') ? localStorage : null;
      if (ls) ls.setItem(KEY, JSON.stringify(next));
    } catch (e) { /* 忽略写入失败 */ }
    return next;
  }
  const hasFetch = () => typeof fetch === 'function';

  XF.ollama = {
    DEF,
    getSettings,
    saveSettings,
    /** 配置完整且已启用 */
    ready() { const s = getSettings(); return !!(s.enabled && s.url && s.model); },
    /** 探测 Ollama 是否可达（3 秒超时） */
    async probe(url) {
      const base = (url || getSettings().url || DEF.url).replace(/\/+$/, '');
      if (!hasFetch()) return { ok: false, error: '当前环境不支持网络请求' };
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3000);
      try {
        const r = await fetch(base + '/api/tags', { signal: ctrl.signal });
        if (!r.ok) return { ok: false, error: '服务响应 ' + r.status };
        const data = await r.json();
        return { ok: true, models: (data.models || []).map(m => m.name) };
      } catch (e) {
        const aborted = e && (e.name === 'AbortError');
        return { ok: false, error: aborted ? '连接超时（3 秒）' : String((e && e.message) || e) };
      } finally { clearTimeout(t); }
    },
    /** 让本地 LLM 生成回答；失败会抛错，由调用方负责回退到模拟回答 */
    async generate(prompt) {
      const s = getSettings();
      const base = (s.url || DEF.url).replace(/\/+$/, '');
      if (!hasFetch()) throw new Error('当前环境不支持网络请求');
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 30000);
      try {
        const r = await fetch(base + '/api/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: s.model, prompt, stream: false, options: { temperature: 0.7 } }),
          signal: ctrl.signal
        });
        if (!r.ok) throw new Error('Ollama 响应 ' + r.status);
        const data = await r.json();
        return (data.response || '').trim();
      } finally { clearTimeout(t); }
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
