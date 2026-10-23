/* ============================================================
 * 小流 XiaoFlow — 本地存储（localStorage，本地优先）
 * ============================================================ */
(function (root) {
  const XF = root.XF || (root.XF = {});
  if (typeof module !== 'undefined' && module.exports) module.exports = XF;

  const KEY = 'xiaoflow.workflows.v1';
  let memoryFallback = null; // file:// 等 localStorage 不可用时的降级

  function readRaw() {
    try { return localStorage.getItem(KEY); }
    catch (e) { return memoryFallback; }
  }
  function writeRaw(v) {
    try { localStorage.setItem(KEY, v); }
    catch (e) { memoryFallback = v; }
  }

  XF.store = {
    list() {
      try {
        const raw = readRaw();
        const arr = raw ? JSON.parse(raw) : [];
        return Array.isArray(arr) ? arr : [];
      } catch (e) { return []; }
    },
    get(id) { return this.list().find(w => w.id === id) || null; },
    save(wf) {
      const all = this.list();
      wf.updatedAt = Date.now();
      const i = all.findIndex(w => w.id === wf.id);
      if (i >= 0) all[i] = wf; else all.unshift(wf);
      writeRaw(JSON.stringify(all));
      return wf;
    },
    remove(id) {
      const all = this.list().filter(w => w.id !== id);
      writeRaw(JSON.stringify(all));
    },
    exportJSON(wf) {
      return JSON.stringify({ app: 'xiaoflow', version: 1, workflow: wf }, null, 2);
    },
    importJSON(text) {
      const data = JSON.parse(text);
      const wf = data.workflow || data;
      if (!wf || !Array.isArray(wf.nodes) || !Array.isArray(wf.edges)) {
        throw new Error('文件格式不对，没找到工作流内容');
      }
      const now = Date.now();
      const idMap = {};
      const nodes = wf.nodes.map(n => {
        const newId = XF.uid('n');
        idMap[n.id] = newId;
        return { ...n, id: newId };
      });
      return {
        id: XF.uid('wf'), name: wf.name || '导入的小流程', icon: wf.icon || '🌱',
        desc: wf.desc || '', builtin: false,
        nodes,
        edges: wf.edges
          .filter(e => idMap[e.from] && idMap[e.to])
          .map(e => ({ ...e, id: XF.uid('e'), from: idMap[e.from], to: idMap[e.to] })),
        createdAt: now, updatedAt: now
      };
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
