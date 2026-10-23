/* ============================================================
 * 小流 XiaoFlow — 可视化画布
 * 原生 DOM 节点 + SVG 连线；支持拖拽节点、拉线连接、
 * 平移、缩放、选中删除。
 * ============================================================ */
(function (root) {
  const XF = root.XF || (root.XF = {});
  if (typeof module !== 'undefined' && module.exports) module.exports = XF;

  const NODE_W = 186;
  const OUT_OFFSETS = [0, -15, 15]; // 出口端口相对垂直中心的偏移

  function summarize(type, cfg) {
    cfg = cfg || {};
    switch (type) {
      case 'timer':
        return cfg.freq === '每隔一段时间' ? `每隔 ${cfg.minutes || 45} 分钟` : `${cfg.freq || '每天'} ${cfg.time || '08:00'}`;
      case 'rss': return trunc(cfg.url || '还没有填地址', 22);
      case 'weather': return `${cfg.city || '本地'} · ${cfg.when || '早上'}`;
      case 'condition': return `${cfg.op || '包含'}「${cfg.value || ''}」`;
      case 'delay': return `等 ${cfg.minutes || 25} 分钟`;
      case 'notify': return cfg.content ? trunc(cfg.content, 24) : '提醒内容用上一步的结果';
      case 'summary': return cfg.len || '几句话';
      case 'save': return `存入「${cfg.book || '默认笔记本'}」`;
      case 'openlink': return trunc(cfg.url || '', 24);
      case 'aichat': return trunc(cfg.q || '', 24);
      default: return '';
    }
  }
  function trunc(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; }

  /**
   * @param {HTMLElement} wrap 容器
   * @returns {object} controller
   */
  XF.createCanvas = function (wrap) {
    const defs = XF.NODE_DEFS;
    let wf = { nodes: [], edges: [] };
    let view = { x: 0, y: 0, scale: 1 };
    let selected = null;       // {kind:'node'|'edge', id}
    let listeners = { select: [], change: [] };

    /* ---------- DOM 骨架 ---------- */
    wrap.classList.add('xf-canvas-wrap');
    wrap.innerHTML = `
      <div class="xf-canvas-grid"></div>
      <div class="xf-viewport">
        <svg class="xf-edges"><defs>
          <marker id="xf-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 1 L 9 5 L 0 9 z" fill="#94a3b8"></path>
          </marker>
          <marker id="xf-arrow-sel" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 1 L 9 5 L 0 9 z" fill="#0d9488"></path>
          </marker>
        </defs><g class="xf-edge-layer"></g><path class="xf-temp-edge" d=""></path></svg>
        <div class="xf-node-layer"></div>
      </div>
      <div class="xf-canvas-zoom">
        <button data-z="in" title="放大">＋</button>
        <button data-z="out" title="缩小">－</button>
        <button data-z="reset" title="复位视图">⌂</button>
      </div>`;
    const viewport = wrap.querySelector('.xf-viewport');
    const nodeLayer = wrap.querySelector('.xf-node-layer');
    const svg = wrap.querySelector('.xf-edges');
    const edgeLayer = wrap.querySelector('.xf-edge-layer');
    const tempEdge = wrap.querySelector('.xf-temp-edge');
    const grid = wrap.querySelector('.xf-canvas-grid');

    const emit = (ev, arg) => (listeners[ev] || []).forEach(cb => cb(arg));
    const on = (ev, cb) => { (listeners[ev] = listeners[ev] || []).push(cb); };

    /* ---------- 坐标换算 ---------- */
    function toWorld(clientX, clientY) {
      const r = viewport.getBoundingClientRect();
      return { x: (clientX - r.left - view.x) / view.scale, y: (clientY - r.top - view.y) / view.scale };
    }
    function applyView() {
      viewport.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
      grid.style.backgroundSize = `${24 * view.scale}px ${24 * view.scale}px`;
      grid.style.backgroundPosition = `${view.x}px ${view.y}px`;
    }

    /* ---------- 渲染 ---------- */
    function nodeEl(id) { return nodeLayer.querySelector(`[data-id="${id}"]`); }

    function renderNode(n) {
      const def = defs[n.type];
      if (!def) return null;
      const el = document.createElement('div');
      el.className = 'xf-node';
      el.dataset.id = n.id;
      el.style.left = n.x + 'px';
      el.style.top = n.y + 'px';
      el.style.setProperty('--cat', def.cat);
      const outCount = def.outputs ? def.outputs.length : 1;
      let ports = `<div class="xf-port xf-port-in" data-port="in" title="入口"></div>`;
      if (def.cat !== 'trigger') ports = ports; else ports = '';
      for (let i = 0; i < outCount; i++) {
        const label = def.outputs ? def.outputs[i].label : '';
        ports += `<div class="xf-port xf-port-out" data-port="${i}" title="${label || '出口'}"></div>`;
      }
      el.innerHTML = `
        <div class="xf-node-head">
          <span class="xf-node-icon">${def.icon}</span>
          <span class="xf-node-name">${escapeHtml(n.name || def.name)}</span>
        </div>
        <div class="xf-node-body">${escapeHtml(summarize(n.type, n.cfg))}</div>
        ${ports}`;
      if (selected && selected.kind === 'node' && selected.id === n.id) el.classList.add('selected');
      return el;
    }

    function edgePath(e) {
      const a = nodeEl(e.from), b = nodeEl(e.to);
      if (!a || !b) return '';
      const ap = a.querySelector(`.xf-port-out[data-port="${e.fromPort || 0}"]`) || a.querySelector('.xf-port-out');
      const bp = b.querySelector('.xf-port-in');
      if (!ap || !bp) return '';
      const x1 = parseFloat(a.style.left) + ap.offsetLeft + ap.offsetWidth / 2;
      const y1 = parseFloat(a.style.top) + ap.offsetTop + ap.offsetHeight / 2;
      const x2 = parseFloat(b.style.left) + bp.offsetLeft + bp.offsetWidth / 2;
      const y2 = parseFloat(b.style.top) + bp.offsetTop + bp.offsetHeight / 2;
      const dx = Math.max(46, Math.abs(x2 - x1) * 0.5);
      return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
    }

    function renderEdges() {
      edgeLayer.innerHTML = '';
      wf.edges.forEach(e => {
        const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        p.setAttribute('d', edgePath(e));
        p.setAttribute('class', 'xf-edge' + (selected && selected.kind === 'edge' && selected.id === e.id ? ' selected' : ''));
        p.setAttribute('marker-end', selected && selected.kind === 'edge' && selected.id === e.id ? 'url(#xf-arrow-sel)' : 'url(#xf-arrow)');
        p.dataset.id = e.id;
        edgeLayer.appendChild(p);
      });
    }

    function render() {
      nodeLayer.innerHTML = '';
      wf.nodes.forEach(n => { const el = renderNode(n); if (el) nodeLayer.appendChild(el); });
      renderEdges();
    }

    /* ---------- 对外 API ---------- */
    const api = {
      on,
      setWorkflow(next) {
        wf = { nodes: next.nodes || [], edges: next.edges || [] };
        selected = null;
        render();
        emit('select', null);
      },
      getWorkflow() { return wf; },
      getView() { return { ...view }; },
      updateNode(id, patch) {
        const n = wf.nodes.find(x => x.id === id);
        if (!n) return;
        Object.assign(n, patch);
        const el = nodeEl(id);
        const fresh = renderNode(n);
        if (el && fresh) { el.replaceWith(fresh); }
        renderEdges();
        emit('change');
      },
      addNode(type, wx, wy) {
        const def = defs[type];
        if (!def) return null;
        if (wx == null) {
          const r = viewport.getBoundingClientRect();
          wx = (r.width / 2 - view.x) / view.scale - NODE_W / 2;
          wy = (r.height / 2 - view.y) / view.scale - 40;
        }
        const n = { id: XF.uid('n'), type, x: Math.round(wx), y: Math.round(wy), cfg: {}, name: def.name };
        wf.nodes.push(n);
        const el = renderNode(n);
        nodeLayer.appendChild(el);
        api.selectNode(n.id);
        emit('change');
        return n;
      },
      selectNode(id) {
        selected = id ? { kind: 'node', id } : null;
        nodeLayer.querySelectorAll('.xf-node').forEach(el => el.classList.toggle('selected', el.dataset.id === id));
        edgeLayer.querySelectorAll('.xf-edge').forEach(p => p.classList.remove('selected'));
        emit('select', selected);
      },
      deleteSelected() {
        if (!selected) return;
        if (selected.kind === 'node') {
          wf.nodes = wf.nodes.filter(n => n.id !== selected.id);
          wf.edges = wf.edges.filter(e => e.from !== selected.id && e.to !== selected.id);
        } else {
          wf.edges = wf.edges.filter(e => e.id !== selected.id);
        }
        selected = null;
        render();
        emit('select', null);
        emit('change');
      },
      zoomBy(f) {
        const r = viewport.getBoundingClientRect();
        const cx = r.width / 2, cy = r.height / 2;
        const wx = (cx - view.x) / view.scale, wy = (cy - view.y) / view.scale;
        view.scale = Math.min(1.6, Math.max(0.4, view.scale * f));
        view.x = cx - wx * view.scale;
        view.y = cy - wy * view.scale;
        applyView();
      },
      resetView() { view = { x: 0, y: 0, scale: 1 }; applyView(); }
    };

    /* ---------- 交互：拖拽 / 连线 / 平移 ---------- */
    let drag = null; // {mode:'node'|'edge'|'pan', ...}

    viewport.addEventListener('pointerdown', ev => {
      if (ev.button !== 0) return;
      const nodeDom = ev.target.closest('.xf-node');
      const port = ev.target.closest('.xf-port');
      const world = toWorld(ev.clientX, ev.clientY);

      if (port && port.classList.contains('xf-port-out') && nodeDom) {
        drag = { mode: 'edge', from: nodeDom.dataset.id, fromPort: parseInt(port.dataset.port, 10) || 0 };
        viewport.setPointerCapture(ev.pointerId);
        ev.preventDefault();
        return;
      }
      if (nodeDom) {
        const n = wf.nodes.find(x => x.id === nodeDom.dataset.id);
        if (!n) return;
        drag = { mode: 'node', id: n.id, dx: world.x - n.x, dy: world.y - n.y, moved: false };
        api.selectNode(n.id);
        viewport.setPointerCapture(ev.pointerId);
        ev.preventDefault();
        return;
      }
      // 点空白：取消选择 + 准备平移
      if (selected) { selected = null; render(); emit('select', null); }
      drag = { mode: 'pan', sx: ev.clientX, sy: ev.clientY, vx: view.x, vy: view.y, moved: false };
      viewport.setPointerCapture(ev.pointerId);
    });

    viewport.addEventListener('pointermove', ev => {
      if (!drag) return;
      const world = toWorld(ev.clientX, ev.clientY);
      if (drag.mode === 'node') {
        const n = wf.nodes.find(x => x.id === drag.id);
        if (!n) return;
        n.x = Math.round(world.x - drag.dx);
        n.y = Math.round(world.y - drag.dy);
        const el = nodeEl(n.id);
        if (el) { el.style.left = n.x + 'px'; el.style.top = n.y + 'px'; }
        renderEdges();
        drag.moved = true;
      } else if (drag.mode === 'edge') {
        const a = nodeEl(drag.from);
        if (!a) return;
        const ap = a.querySelector(`.xf-port-out[data-port="${drag.fromPort}"]`) || a.querySelector('.xf-port-out');
        const x1 = parseFloat(a.style.left) + ap.offsetLeft + ap.offsetWidth / 2;
        const y1 = parseFloat(a.style.top) + ap.offsetTop + ap.offsetHeight / 2;
        const dx = Math.max(46, Math.abs(world.x - x1) * 0.5);
        tempEdge.setAttribute('d', `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${world.x - dx} ${world.y}, ${world.x} ${world.y}`);
        tempEdge.classList.add('active');
        // 高亮可接入的入口
        const under = document.elementFromPoint(ev.clientX, ev.clientY);
        nodeLayer.querySelectorAll('.xf-port-in').forEach(p => p.classList.remove('hover'));
        const inPort = under && under.closest && under.closest('.xf-port-in');
        if (inPort) inPort.classList.add('hover');
        drag.moved = true;
      } else if (drag.mode === 'pan') {
        view.x = drag.vx + (ev.clientX - drag.sx);
        view.y = drag.vy + (ev.clientY - drag.sy);
        applyView();
        if (Math.abs(ev.clientX - drag.sx) + Math.abs(ev.clientY - drag.sy) > 4) drag.moved = true;
      }
    });

    function endDrag(ev) {
      if (!drag) return;
      if (drag.mode === 'edge') {
        const under = document.elementFromPoint(ev.clientX, ev.clientY);
        const inPort = under && under.closest && under.closest('.xf-port-in');
        const targetNode = inPort && inPort.closest('.xf-node');
        if (targetNode && targetNode.dataset.id !== drag.from) {
          const to = targetNode.dataset.id;
          const dup = wf.edges.some(e => e.from === drag.from && e.to === to && (e.fromPort || 0) === drag.fromPort);
          if (!dup) {
            wf.edges.push({ id: XF.uid('e'), from: drag.from, to, fromPort: drag.fromPort });
            renderEdges();
            emit('change');
          }
        }
        tempEdge.classList.remove('active');
        tempEdge.setAttribute('d', '');
        nodeLayer.querySelectorAll('.xf-port-in').forEach(p => p.classList.remove('hover'));
      } else if (drag.mode === 'node' && drag.moved) {
        emit('change');
      } else if (drag.mode === 'pan' && !drag.moved) {
        // 纯点击空白：已取消选择
      }
      drag = null;
    }
    viewport.addEventListener('pointerup', endDrag);
    viewport.addEventListener('pointercancel', endDrag);

    /* 点击连线选中 */
    edgeLayer.addEventListener('pointerdown', ev => {
      const p = ev.target.closest('.xf-edge');
      if (!p) return;
      ev.stopPropagation();
      selected = { kind: 'edge', id: p.dataset.id };
      renderEdges();
      nodeLayer.querySelectorAll('.xf-node').forEach(el => el.classList.remove('selected'));
      emit('select', selected);
    });

    /* Ctrl + 滚轮缩放 */
    viewport.addEventListener('wheel', ev => {
      if (!ev.ctrlKey) return;
      ev.preventDefault();
      const r = viewport.getBoundingClientRect();
      const mx = ev.clientX - r.left, my = ev.clientY - r.top;
      const wx = (mx - view.x) / view.scale, wy = (my - view.y) / view.scale;
      const f = ev.deltaY < 0 ? 1.1 : 0.9;
      view.scale = Math.min(1.6, Math.max(0.4, view.scale * f));
      view.x = mx - wx * view.scale;
      view.y = my - wy * view.scale;
      applyView();
    }, { passive: false });

    /* 缩放按钮 */
    wrap.querySelector('.xf-canvas-zoom').addEventListener('click', ev => {
      const z = ev.target.closest('button');
      if (!z) return;
      if (z.dataset.z === 'in') api.zoomBy(1.15);
      else if (z.dataset.z === 'out') api.zoomBy(0.87);
      else api.resetView();
    });

    /* 删除键 */
    document.addEventListener('keydown', ev => {
      const t = ev.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if ((ev.key === 'Delete' || ev.key === 'Backspace') && selected) {
        ev.preventDefault();
        api.deleteSelected();
      }
    });

    applyView();
    return api;
  };

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }
})(typeof window !== 'undefined' ? window : globalThis);
