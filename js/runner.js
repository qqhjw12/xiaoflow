/* ============================================================
 * 小流 XiaoFlow — 试运行引擎（模拟执行）
 * 从触发器出发逐条链执行，步骤回调。
 * ============================================================ */
(function (root) {
  const XF = root.XF || (root.XF = {});
  if (typeof module !== 'undefined' && module.exports) module.exports = XF;

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function stringify(v) {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) return v.map(x => (typeof x === 'string' ? x : x.title || '')).join('\n');
    return v.text || v.summary || v.answer || v.message || JSON.stringify(v);
  }
  function trunc(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…' : s; }

  /**
   * @param {object} wf 工作流
   * @param {(step:object)=>void} onStep 每步回调（开始与结束时各一次）
   * @param {{userInput?:string}} [opts] 用户随手扔进去的内容
   * @returns {Promise<{ok:boolean, steps:object[], error?:string}>}
   */
  XF.runWorkflow = async function (wf, onStep, opts) {
    const defs = XF.NODE_DEFS;
    const ctx = { userInput: (opts && opts.userInput) || '' };
    const map = {};
    wf.nodes.forEach(n => { map[n.id] = n; });
    const out = {};
    wf.edges.forEach(e => { (out[e.from] = out[e.from] || []).push(e); });
    const inbound = {};
    wf.edges.forEach(e => { (inbound[e.to] = inbound[e.to] || []).push(e); });

    const triggers = wf.nodes.filter(n => defs[n.type] && defs[n.type].cat === 'trigger');
    if (!triggers.length) {
      return { ok: false, steps: [], error: '还没有「当…的时候」节点。先从左边拖一个触发器进来吧！' };
    }

    /* 运行前检测环（Kahn 拓扑排序） */
    const indeg = {};
    wf.nodes.forEach(n => { indeg[n.id] = 0; });
    wf.edges.forEach(e => { if (indeg[e.to] != null) indeg[e.to]++; });
    const topo = wf.nodes.filter(n => indeg[n.id] === 0).map(n => n.id);
    let covered = 0;
    while (topo.length) {
      const id = topo.shift();
      covered++;
      wf.edges.forEach(e => {
        if (e.from === id && indeg[e.to] != null) {
          indeg[e.to]--;
          if (indeg[e.to] === 0) topo.push(e.to);
        }
      });
    }
    if (covered < wf.nodes.length) {
      return { ok: false, steps: [], error: '这个流程好像绕成了圈圈，检查一下连线哦' };
    }

    const steps = [];
    const executed = new Set();
    const results = {};
    let guard = 0;
    let failed = null;

    /* 逐条链执行：先跑完一条触发器引出的链，再跑下一条 */
    for (const t of triggers) {
      const queue = [t.id];
      while (queue.length && guard++ < 60 && !failed) {
        const id = queue.shift();
        if (executed.has(id)) continue;
        const node = map[id];
        if (!node) continue;
        const def = defs[node.type];
        if (!def) continue;

        // 取上游输出（第一条已执行的入边）
        let input = null, fromName = '';
        for (const e of (inbound[id] || [])) {
          if (executed.has(e.from)) { input = results[e.from]; fromName = map[e.from].name; break; }
        }

        const step = {
          nodeId: id, name: node.name, icon: def.icon, cat: def.cat,
          status: 'run',
          inText: fromName ? `来自「${fromName}」：${trunc(stringify(input), 80)}` : '（这是第一步，自己跑起来）',
          outText: '', ms: 0
        };
        steps.push(step);
        onStep && onStep(step, steps.length);

        const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        await sleep(320 + Math.random() * 280);
        try {
          const res = (await def.run(input || {}, node.cfg || {}, ctx)) || {};
          results[id] = res;
          const port = (def.cat === 'condition' && res.branch != null) ? res.branch : 0;
          step.outText = trunc(stringify(res), 220);
          step.ms = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0);
          step.status = 'ok';
          if (def.outputs && def.outputs[port]) step.via = def.outputs[port].label;
          if (res.ai) step.ai = res.ai === 'ollama' ? 'ollama' : 'local';
          onStep && onStep(step, steps.length);
          // 沿选中的出口继续往下走
          (out[id] || []).forEach(e => {
            if ((e.fromPort || 0) === port && !executed.has(e.to)) queue.push(e.to);
          });
        } catch (err) {
          step.status = 'error';
          step.outText = '出错了：' + (err && err.message ? err.message : String(err));
          onStep && onStep(step, steps.length);
          failed = step.outText;
        }
        executed.add(id);
      }
    }

    if (failed) return { ok: false, steps, error: failed };
    return { ok: true, steps };
  };
})(typeof window !== 'undefined' ? window : globalThis);
