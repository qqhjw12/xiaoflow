/* ============================================================
 * 小流 XiaoFlow — 主应用
 * ============================================================ */
(function () {
  const XF = window.XF;
  const { NODE_DEFS, CATEGORIES, TEMPLATES, store, parsePrompt, runWorkflow, createCanvas, newWorkflow } = XF;
  const { notify, scheduler, ollama, inbox } = XF;
  const app = document.getElementById('app');

  let current = null;   // 正在编辑的工作流
  let canvas = null;    // 画布控制器
  let saveTimer = null;
  let running = false;
  let pendingInbox = ''; // 从投递箱带入、待试运行消耗的内容

  /* ---------- 工具 ---------- */
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));

  function toast(msg) {
    let box = document.querySelector('.toast-box');
    if (!box) {
      box = document.createElement('div');
      box.className = 'toast-box';
      document.body.appendChild(box);
    }
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    box.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; }, 2200);
    setTimeout(() => t.remove(), 2600);
  }

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function trunc(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…' : s; }
  function fmtTime(ts) {
    const d = new Date(ts);
    const p = n => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  /* ---------- 路由 ---------- */
  function route() {
    const h = location.hash || '#/';
    const m = h.match(/^#\/edit\/(.+)$/);
    if (m) {
      const wf = store.get(decodeURIComponent(m[1]));
      if (!wf) { toast('没找到这个工作流'); location.hash = '#/'; return; }
      renderEditor(wf);
    } else {
      renderHome();
    }
  }
  window.addEventListener('hashchange', route);

  /* ============================================================
   * 首页
   * ============================================================ */
  function renderHome() {
    current = null; canvas = null;
    const mine = store.list();

    app.innerHTML = `
      <div class="topbar">
        <div class="brand"><span class="brand-logo">💧</span>小流 <small>XiaoFlow</small></div>
        <div class="spacer"></div>
        <button class="btn" id="btn-log">📋 运行记录</button>
        <button class="btn" id="btn-import">📥 导入</button>
        <button class="btn primary" id="btn-new">＋ 新建小流程</button>
      </div>
      <div class="home">
        <div class="hero">
          <h1>把重复的事交给<em>小流</em>，把时间还给自己</h1>
          <p>不会编程也能做自动化：选个模板改改，或者直接告诉小流你想干什么</p>
          <div class="hero-actions">
            <button class="btn primary lg" id="hero-new">✨ 从一句话开始</button>
            <button class="btn lg" id="hero-tpl">📚 逛逛模板库</button>
          </div>
          <div class="hero-hint">数据只存在你自己的电脑上 · 可随时导出备份</div>
        </div>

        <div class="section" id="sec-tpl">
          <div class="section-head"><h2>📚 模板库</h2><span>点一下就能用，改改就是你的</span></div>
          <div class="tpl-grid">
            ${TEMPLATES.map(t => `
              <button class="tpl-card" data-tpl="${t.id}">
                <div class="tpl-icon">${t.icon}</div>
                <h3>${esc(t.name)}</h3>
                <p>${esc(t.desc)}</p>
                <div class="tpl-tags">${t.tags.map(x => `<span class="tpl-tag">${esc(x)}</span>`).join('')}</div>
                <div class="tpl-flow">
                  ${t.nodes.map((n, i) => `
                    <span class="step">${NODE_DEFS[n.type].icon} ${esc(n.name)}</span>
                    ${i < t.nodes.length - 1 ? '<span class="arrow">→</span>' : ''}
                  `).join('')}
                </div>
              </button>`).join('')}
          </div>
        </div>

        <div class="section" id="sec-ladder">
          <div class="section-head"><h2>🧭 按学习成本选路线</h2><span>不用纠结哪个最强，愿意花多少学习时间就选哪条路</span></div>
          <div class="ladder">
            <div class="ladder-card now tappable" id="lv-1" title="点击去模板库选一个开始">
              <span class="lv-tag">你现在在这里</span>
              <div class="lv">第 1 站 · 零安装零配置</div>
              <h3>💧 先用小流把想法跑通</h3>
              <p>双击网页就能用：模板改改、说句话就生成。先看到东西跑起来，再谈工具强弱。</p>
              <div class="ladder-acts">
                <button class="btn primary" type="button">去模板库选一个 →</button>
              </div>
            </div>
            <div class="ladder-card">
              <div class="lv">第 2 站 · 稍微学一点</div>
              <h3>🔗 要串起真实工具 → Make / n8n</h3>
              <p>邮箱、日历、Notion、表格随便连。Make 界面对新手更友好；n8n 开源可自托管，上限更高、数据在自己手里。</p>
              <div class="ladder-acts">
                <a class="btn" href="https://www.make.com" target="_blank" rel="noopener">Make 官网 ↗</a>
                <a class="btn" href="https://n8n.io" target="_blank" rel="noopener">n8n 官网 ↗</a>
              </div>
            </div>
            <div class="ladder-card">
              <div class="lv">第 3 站 · 完全不想碰技术</div>
              <h3>📮 想发布到微信 / 飞书 → 扣子 Coze</h3>
              <p>注册即用、拖拽操作，30 分钟出 Bot。代价是灵活性有限、生态绑定平台——但「先跑起来」完全够用。</p>
              <div class="ladder-acts">
                <a class="btn" href="https://www.coze.cn" target="_blank" rel="noopener">扣子 Coze 官网 ↗</a>
              </div>
            </div>
            <div class="ladder-card">
              <div class="lv">支线 · 整理自己的文档笔记</div>
              <h3>📒 Obsidian + AI 助手</h3>
              <p>比一上来就上 Dify 更务实；Dify 适合要建 RAG 知识库并对外提供服务的场景。</p>
              <div class="ladder-acts">
                <a class="btn" href="https://obsidian.md" target="_blank" rel="noopener">Obsidian 官网 ↗</a>
                <a class="btn" href="https://dify.ai" target="_blank" rel="noopener">Dify 官网 ↗</a>
              </div>
            </div>
          </div>
        </div>

        <div class="section">
          <div class="section-head"><h2>🌱 我的小流程</h2><span>共 ${mine.length} 个</span></div>
          <div class="my-list">
            ${mine.length ? mine.map(w => `
              <div class="my-card" data-id="${w.id}">
                <div class="row1"><span class="ic">${w.icon || '🌱'}</span><h3>${esc(w.name)}</h3>
                  ${w.enabled ? '<span class="badge-live" title="正式运行中：页面开着就会按点自动跑">🟢 运行中</span>' : ''}</div>
                <div class="meta">${w.nodes.length} 个节点 · 更新于 ${fmtTime(w.updatedAt || w.createdAt)}
                  ${w.enabled && scheduler.timerCfg(w) ? ` · 下次 ${fmtFire(scheduler.nextFire(w))}` : ''}</div>
                <div class="ops">
                  <button class="btn primary" data-act="open">打开</button>
                  <button class="btn" data-act="export">导出</button>
                  <button class="btn ghost" data-act="del">删除</button>
                </div>
              </div>`).join('')
            : '<div class="empty">还没有你的小流程<br>从上面的模板库开始，或者「新建小流程」自己搭一个</div>'}
          </div>
        </div>
      </div>`;

    document.getElementById('btn-new').onclick = () => {
      const wf = store.save(newWorkflow());
      location.hash = '#/edit/' + wf.id;
    };
    document.getElementById('btn-import').onclick = showImport;
    document.getElementById('btn-log').onclick = showRunLog;
    document.getElementById('hero-new').onclick = () => {
      const wf = store.save(newWorkflow());
      location.hash = '#/edit/' + wf.id;
      setTimeout(() => openAI(), 350);
    };
    document.getElementById('hero-tpl').onclick = () =>
      document.getElementById('sec-tpl').scrollIntoView({ behavior: 'smooth' });

    app.querySelectorAll('[data-tpl]').forEach(el => el.onclick = () => {
      const tpl = TEMPLATES.find(t => t.id === el.dataset.tpl);
      if (!tpl) return;
      const wf = clone(tpl);
      wf.id = XF.uid('wf');
      wf.builtin = false;
      wf.createdAt = wf.updatedAt = Date.now();
      store.save(wf);
      toast(`已添加「${tpl.name}」，去画布看看吧`);
      location.hash = '#/edit/' + wf.id;
    });

    // 学习成本阶梯：第 1 站整卡可点 → 平滑滚到模板库（按钮点击会冒泡到这里，无需重复绑定）
    const lv1 = document.getElementById('lv-1');
    if (lv1) lv1.addEventListener('click', () =>
      document.getElementById('sec-tpl').scrollIntoView({ behavior: 'smooth' }));

    app.querySelectorAll('.my-card').forEach(card => {
      const id = card.dataset.id;
      card.querySelector('[data-act="open"]').onclick = () => { location.hash = '#/edit/' + id; };
      card.querySelector('[data-act="export"]').onclick = () => exportWF(store.get(id));
      card.querySelector('[data-act="del"]').onclick = () => {
        const wf = store.get(id);
        if (!wf) { toast('这个小流程已经不见了'); route(); return; }
        confirmDelete(wf, () => {
          store.remove(id);
          toast('已删除');
          route();
        });
      };
    });
  }

  /* ============================================================
   * 编辑器
   * ============================================================ */
  function renderEditor(wf) {
    current = wf;
    app.innerHTML = `
      <div class="editor">
        <div class="ed-toolbar">
          <button class="btn ghost" id="btn-back">← 返回</button>
          <input class="wf-name" id="wf-name" value="${esc(wf.name)}" maxlength="20" />
          <span class="save-hint" id="save-hint"></span>
          <div class="spacer" style="flex:1"></div>
          <button class="btn only-m" id="btn-pal" title="节点库">🧰 节点</button>
          <button class="btn only-m" id="btn-prop" title="属性">⚙️ 属性</button>
          <button class="live-chip" id="btn-live" title="开启后，只要页面开着，到时间就自动跑"></button>
          <button class="btn" id="btn-inbox">📬 投递箱</button>
          <button class="btn" id="btn-notify">🔔 通知</button>
          <button class="btn" id="btn-settings">⚙ 设置</button>
          <button class="btn" id="btn-export">📤 导出</button>
          <button class="btn" id="btn-ai">✨ AI 助手</button>
          <button class="btn primary" id="btn-run">▶ 试运行</button>
        </div>
        <div class="ed-body">
          <div class="palette" id="palette"></div>
          <div class="canvas-col">
            <div id="canvas-host"></div>
            <div class="canvas-tip">拖动节点摆放 · 从右侧圆点拉线到下一个节点 · Ctrl+滚轮缩放 · Delete 删除选中</div>
          </div>
          <div class="prop" id="prop"></div>
        </div>
      </div>`;

    /* 节点库 */
    const pal = document.getElementById('palette');
    pal.innerHTML = Object.keys(CATEGORIES).map(cat => {
      const c = CATEGORIES[cat];
      const items = Object.keys(NODE_DEFS).filter(k => NODE_DEFS[k].cat === cat)
        .map(k => {
          const d = NODE_DEFS[k];
          return `<button class="pal-item" data-type="${k}" style="--cat:${c.color};--catbg:${c.bg}">
            <span class="ic">${d.icon}</span>
            <span class="t">${esc(d.name)}<small>${esc(d.desc)}</small></span>
          </button>`;
        }).join('');
      return `<h4>${c.icon} ${c.label}</h4>${items}`;
    }).join('');
    pal.querySelectorAll('.pal-item').forEach(el => el.onclick = () => {
      const off = (Math.random() * 60) - 30;
      canvas.addNode(el.dataset.type, null, null);
      toast('已添加节点，拖我到喜欢的位置');
    });

    /* 画布 */
    canvas = createCanvas(document.getElementById('canvas-host'));
    canvas.setWorkflow(clone(wf));
    canvas.on('select', sel => { renderProp(sel); closeSheets(); });
    canvas.on('change', scheduleSave);

    /* 顶栏 */
    document.getElementById('btn-back').onclick = () => { location.hash = '#/'; };
    document.getElementById('wf-name').oninput = e => {
      current.name = e.target.value.trim() || '未命名小流程';
      scheduleSave();
    };
    document.getElementById('btn-export').onclick = () => exportWF(current);
    document.getElementById('btn-ai').onclick = openAI;
    document.getElementById('btn-run').onclick = openRun;
    document.getElementById('btn-settings').onclick = openSettings;
    document.getElementById('btn-inbox').onclick = openInbox;
    document.getElementById('btn-live').onclick = toggleLive;
    document.getElementById('btn-pal').onclick = () => toggleSheet('palette');
    document.getElementById('btn-prop').onclick = () => toggleSheet('prop');
    document.getElementById('btn-notify').onclick = async () => {
      const st = notify.state();
      if (st === 'granted') { toast('系统通知已经开着啦'); return; }
      if (st === 'denied') { toast('浏览器拒绝啦，去地址栏左边的网站权限里重新允许通知'); return; }
      const ok = await notify.request();
      toast(ok ? '✓ 通知已开启，到点会弹真通知' : '没能开启通知，将用页面内提醒（效果一样看得到）');
      updateNotifyBtn();
    };

    renderProp(null);
    updateSaveHint(true);
    updateNotifyBtn();
    updateLiveUI();
  }

  /* ---------- 移动端底部面板（节点库 / 属性） ---------- */
  function toggleSheet(which) {
    const pal = document.getElementById('palette');
    const prop = document.getElementById('prop');
    if (!pal || !prop) return;
    const target = which === 'palette' ? pal : prop;
    const willOpen = !target.classList.contains('open');
    pal.classList.remove('open');
    prop.classList.remove('open');
    document.getElementById('btn-pal').classList.toggle('active', willOpen && which === 'palette');
    document.getElementById('btn-prop').classList.toggle('active', willOpen && which === 'prop');
    if (willOpen) target.classList.add('open');
  }
  function closeSheets() {
    const pal = document.getElementById('palette');
    const prop = document.getElementById('prop');
    if (pal) pal.classList.remove('open');
    if (prop) prop.classList.remove('open');
    const b1 = document.getElementById('btn-pal');
    const b2 = document.getElementById('btn-prop');
    if (b1) b1.classList.remove('active');
    if (b2) b2.classList.remove('active');
  }

  /* ---------- 正式运行开关 ---------- */
  function updateLiveUI() {
    const chip = document.getElementById('btn-live');
    if (!chip || !current) return;
    const on = !!current.enabled;
    chip.className = 'live-chip' + (on ? ' on' : '');
    if (!on) {
      chip.innerHTML = '⚪ 正式运行：关';
      chip.title = '开启后，只要页面开着，到时间就自动跑';
      return;
    }
    const next = scheduler.nextFire(current);
    chip.innerHTML = next
      ? `🟢 正式运行：开 · 下次 ${fmtFire(next)}`
      : '🟢 正式运行：开（这个流程没有定时触发器，暂不会自动跑）';
    chip.title = '开启后，只要页面开着，到时间就自动跑';
  }
  function fmtFire(ts) {
    const d = new Date(ts);
    const now = new Date();
    const p = n => String(n).padStart(2, '0');
    const sameDay = d.toDateString() === now.toDateString();
    const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
    if (sameDay) return `今天 ${hm}`;
    const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
    if (d.toDateString() === tomorrow.toDateString()) return `明天 ${hm}`;
    return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
  }
  function toggleLive() {
    if (!current) return;
    if (!current.enabled && !scheduler.timerCfg(current)) {
      toast('正式运行需要「当到了某个时间」节点，先从左边拖一个进来');
      return;
    }
    current.enabled = !current.enabled;
    if (current.enabled && !current.lastFired) current.lastFired = 0;
    store.save(current);
    updateLiveUI();
    if (current.enabled) {
      toast('✓ 已开启正式运行：保持这个页面打开，到点自动跑，结果弹通知');
    } else {
      toast('已暂停正式运行');
    }
  }

  /* ---------- 通知按钮状态 ---------- */
  function updateNotifyBtn() {
    const btn = document.getElementById('btn-notify');
    if (!btn) return;
    const st = notify.state();
    if (st === 'unsupported') { btn.style.display = 'none'; return; }
    btn.style.display = '';
    btn.textContent = st === 'granted' ? '🔔 通知已开'
      : (st === 'denied' ? '🔔 通知被拒' : '🔔 开启通知');
  }

  /* ---------- 设置（本地 AI） ---------- */
  function openSettings() {
    const s = ollama.getSettings();
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `
      <div class="modal" style="max-width:520px">
        <div class="modal-head"><span>⚙</span><h3>设置</h3><button class="x">✕</button></div>
        <div class="modal-body">
          <div class="ai-hero">🤖 <b>接入本机 AI（可选）</b><br>
          装了什么都不会影响使用——不开这个，AI 节点用内置模拟回答；<br>
          开了之后，「问问 AI」「AI 帮我整理」会走你本机的 Ollama，数据不出电脑。</div>
          <div class="field">
            <label class="check"><input type="checkbox" id="set-ai-on" ${s.enabled ? 'checked' : ''}>
              启用本机 Ollama（需要先安装并 <code>ollama run qwen2.5:3b</code> 拉一个模型）</label>
          </div>
          <div class="field">
            <label>Ollama 地址</label>
            <input type="text" id="set-ai-url" value="${esc(s.url)}" placeholder="http://localhost:11434">
          </div>
          <div class="field">
            <label>模型名字</label>
            <input type="text" id="set-ai-model" value="${esc(s.model)}" placeholder="qwen2.5:3b">
          </div>
          <div class="field" style="display:flex;gap:10px;align-items:center">
            <button class="btn" id="set-probe">🔍 测一下连通性</button>
            <span id="set-probe-result" style="font-size:13px;color:var(--muted)"></span>
          </div>
          <div style="font-size:12px;color:var(--faint);margin-top:4px">
            提示：从网页连 Ollama 需要它允许跨域，若提示连不上，先用
            <code>OLLAMA_ORIGINS=* ollama serve</code> 重启 Ollama 再试。
          </div>
          <hr style="border:none;border-top:1px solid var(--line);margin:18px 0">
          <div class="field">
            <label>📬 投递服务端口</label>
            <div style="display:flex;gap:10px;align-items:center">
              <input type="number" id="set-inbox-port" value="${inbox.getPort()}" style="width:110px" min="1" max="65535">
              <span style="font-size:12px;color:var(--faint)">默认 8787；启动时用了别的端口就改这里</span>
            </div>
          </div>
          <div class="field">
            <label>📬 投递服务地址（高级）</label>
            <div style="display:flex;gap:10px;align-items:center">
              <input type="text" id="set-inbox-host" value="${esc(inbox.getSavedHost())}" style="width:150px" placeholder="留空 = 自动判断">
              <span style="font-size:12px;color:var(--faint)">电脑上打开留空即可；只有手动指定过才需要填</span>
            </div>
          </div>
          <hr style="border:none;border-top:1px solid var(--line);margin:18px 0">
          <div class="field">
            <label>📋 运行记录</label>
            <div style="font-size:13px;color:var(--muted)">正式运行触发过的工作流会记在这里（本机保存，最多 50 条）。</div>
            <div style="display:flex;gap:10px;margin-top:8px">
              <button class="btn" id="set-log-view">查看记录</button>
              <button class="btn ghost" id="set-log-clear">清空记录</button>
            </div>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn" id="set-cancel">取消</button>
          <button class="btn primary" id="set-save">保存</button>
        </div>
      </div>`;
    document.body.appendChild(mask);
    const close = () => mask.remove();
    mask.querySelector('.x').onclick = close;
    mask.querySelector('#set-cancel').onclick = close;
    mask.addEventListener('pointerdown', e => { if (e.target === mask) close(); });

    mask.querySelector('#set-probe').onclick = async () => {
      const r = mask.querySelector('#set-probe-result');
      r.textContent = '正在连接…';
      const res = await ollama.probe(mask.querySelector('#set-ai-url').value.trim());
      r.style.color = res.ok ? 'var(--primary)' : 'var(--danger)';
      r.textContent = res.ok
        ? `✓ 连上了，本机有 ${res.models.length} 个模型`
        : '✗ 连不上：' + res.error;
    };
    mask.querySelector('#set-log-view').onclick = () => { showRunLog(); };
    mask.querySelector('#set-log-clear').onclick = () => { scheduler.clearLogs(); toast('记录已清空'); };

    mask.querySelector('#set-save').onclick = () => {
      ollama.saveSettings({
        enabled: mask.querySelector('#set-ai-on').checked,
        url: mask.querySelector('#set-ai-url').value.trim() || ollama.DEF.url,
        model: mask.querySelector('#set-ai-model').value.trim() || ollama.DEF.model
      });
      inbox.setPort(mask.querySelector('#set-inbox-port').value);
      inbox.setHost(mask.querySelector('#set-inbox-host').value);
      close();
      toast(ollama.ready() ? '✓ 已保存，AI 节点会优先用本机模型' : '已保存（本机 AI 未启用，继续用模拟回答）');
    };
  }

  /* ---------- 删除确认（自定义模态，不依赖浏览器 confirm，
     保证在预览面板 iframe 等环境里也能正常使用） ---------- */
  function confirmDelete(wf, onOk) {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `
      <div class="modal" style="max-width:400px">
        <div class="modal-head"><span>🗑</span><h3>删除小流程</h3><button class="x">✕</button></div>
        <div class="modal-body">
          <div class="del-confirm">
            <div class="del-icon">${wf.icon || '🌱'}</div>
            <p class="del-name">「${esc(wf.name || '未命名小流程')}」</p>
            <p class="del-warn">删掉就找不回来了。<br>建议先「导出」留个备份。</p>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn" id="del-cancel">取消</button>
          <button class="btn danger" id="del-ok">确认删除</button>
        </div>
      </div>`;
    document.body.appendChild(mask);
    const close = () => mask.remove();
    mask.querySelector('.x').onclick = close;
    mask.querySelector('#del-cancel').onclick = close;
    mask.addEventListener('pointerdown', e => { if (e.target === mask) close(); });
    mask.querySelector('#del-ok').onclick = () => {
      close();
      onOk && onOk();
    };
  }

  /* ---------- 运行记录 ---------- */
  function showRunLog() {
    const logs = scheduler.logs(20);
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `
      <div class="modal" style="max-width:560px">
        <div class="modal-head"><span>📋</span><h3>运行记录</h3><button class="x">✕</button></div>
        <div class="modal-body">
          ${logs.length ? logs.map(l => `
            <div class="runlog ${l.ok ? '' : 'bad'}">
              <div class="rl-head">
                <span>${l.ok ? '✓' : '✗'} ${esc(l.name || '小流程')}</span>
                <span class="rl-time">${fmtTime(l.ts)}</span>
              </div>
              <div class="rl-text">${esc(l.text)}</div>
            </div>`).join('')
          : '<div class="prop-empty">还没有记录<br>开启「正式运行」后，每次自动触发都会记在这里</div>'}
        </div>
        <div class="modal-foot"><button class="btn" id="log-close">关闭</button></div>
      </div>`;
    document.body.appendChild(mask);
    const close = () => mask.remove();
    mask.querySelector('.x').onclick = close;
    mask.querySelector('#log-close').onclick = close;
    mask.addEventListener('pointerdown', e => { if (e.target === mask) close(); });
  }

  /* ---------- 属性面板 ---------- */
  function renderProp(sel) {
    const box = document.getElementById('prop');
    if (!box) return;
    if (!sel || sel.kind !== 'node') {
      box.innerHTML = `
        <h3>🛠 属性</h3>
        <div class="prop-empty">点一个节点<br>这里就能改它的设置</div>`;
      return;
    }
    const n = current.nodes.find(x => x.id === sel.id);
    if (!n) { box.innerHTML = ''; return; }
    const def = NODE_DEFS[n.type];
    const cat = CATEGORIES[def.cat];

    box.innerHTML = `
      <h3>${def.icon} ${esc(n.name)}</h3>
      <div class="prop-desc">${esc(def.desc)}</div>
      <div class="field">
        <label>节点名字（说人话）</label>
        <input type="text" id="p-name" value="${esc(n.name)}" maxlength="20">
      </div>
      ${def.fields.map(f => {
        const show = f.showIf ? f.showIf(n.cfg) : true;
        const val = n.cfg[f.key] != null ? n.cfg[f.key] : (f.def != null ? f.def : '');
        let ctrl = '';
        if (f.type === 'select') {
          ctrl = `<select id="p-${f.key}">${f.options.map(o =>
            `<option ${o === val ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
        } else if (f.type === 'textarea') {
          ctrl = `<textarea id="p-${f.key}" placeholder="${esc(f.placeholder || '')}">${esc(val)}</textarea>`;
        } else if (f.type === 'checkbox') {
          return `<div class="field"><label class="check"><input type="checkbox" id="p-${f.key}" ${val ? 'checked' : ''}> ${esc(f.label)}</label></div>`;
        } else {
          ctrl = `<input type="${f.type}" id="p-${f.key}" value="${esc(val)}" placeholder="${esc(f.placeholder || '')}">`;
        }
        return `<div class="field" data-show="${show ? '1' : '0'}" style="${show ? '' : 'display:none'}">
          <label>${esc(f.label)}</label>${ctrl}</div>`;
      }).join('')}
      <div class="prop-ops">
        <button class="btn block" id="p-del">🗑 删除这个节点</button>
      </div>`;

    const nameInput = box.querySelector('#p-name');
    nameInput.oninput = () => {
      canvas.updateNode(n.id, { name: nameInput.value.trim() || def.name });
    };
    def.fields.forEach(f => {
      const el = box.querySelector('#p-' + f.key);
      if (!el) return;
      const evt = (f.type === 'select' || f.type === 'checkbox') ? 'change' : 'input';
      el.addEventListener(evt, () => {
        const v = f.type === 'checkbox' ? el.checked : (f.type === 'number' ? Number(el.value) : el.value);
        n.cfg = { ...n.cfg, [f.key]: v };
        // 动态字段（如 timer 的频率切换）
        if (f.key === 'freq') {
          renderProp(sel);
        } else {
          canvas.updateNode(n.id, { cfg: n.cfg });
        }
      });
    });
    box.querySelector('#p-del').onclick = () => {
      canvas.selectNode(n.id);
      canvas.deleteSelected();
      toast('节点已删除');
    };
  }

  /* ---------- 自动保存 ---------- */
  function scheduleSave() {
    updateSaveHint(false);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!current) return;
      store.save(current);
      updateSaveHint(true);
    }, 500);
  }
  function updateSaveHint(saved) {
    const el = document.getElementById('save-hint');
    if (!el) return;
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    el.textContent = saved ? `✓ 已自动保存 ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` : '编辑中…';
  }

  /* ============================================================
   * AI 助手
   * ============================================================ */
  function openAI() {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `
      <div class="modal">
        <div class="modal-head"><span>✨</span><h3>告诉小流：你想自动做什么？</h3><button class="x">✕</button></div>
        <div class="modal-body">
          <div class="ai-hero">用大白话描述就行，比如「每天早上八点提醒我看天气，顺便总结一下今天的新闻」。小流帮你把工作流搭好。</div>
          <textarea class="ai-input" id="ai-text" placeholder="试着说说你的想法…"></textarea>
        <div class="ai-examples">
          <button class="ai-chip">每天早上八点提醒我喝水看天气</button>
          <button class="ai-chip">每天早八点把新闻摘要推给我</button>
          <button class="ai-chip">每隔 45 分钟提醒我起身活动</button>
          <button class="ai-chip">平时把工作记录随手扔进去，周五生成周报初稿</button>
          <button class="ai-chip">每天早上帮我决定吃什么</button>
        </div>
          <div id="ai-result"></div>
        </div>
        <div class="modal-foot">
          <button class="btn" id="ai-cancel">取消</button>
          <button class="btn primary" id="ai-go">🚀 帮我搭好</button>
        </div>
      </div>`;
    document.body.appendChild(mask);
    const close = () => mask.remove();
    mask.querySelector('.x').onclick = close;
    mask.querySelector('#ai-cancel').onclick = close;
    mask.addEventListener('pointerdown', e => { if (e.target === mask) close(); });
    mask.querySelector('.ai-input').focus();

    mask.querySelectorAll('.ai-chip').forEach(c => c.onclick = () => {
      mask.querySelector('#ai-text').value = c.textContent;
    });

    let parsed = null;
    const go = () => {
      const text = mask.querySelector('#ai-text').value.trim();
      if (!text) { toast('先写点什么吧'); return; }
      parsed = parsePrompt(text);
      const r = mask.querySelector('#ai-result');
      r.innerHTML = `
        <div class="ai-result">
          <h4>小流听懂了，准备这样做：</h4>
          <ul>${parsed.notes.map(x => `<li>${esc(x)}</li>`).join('')}</ul>
          <div class="ai-flow-preview">
            ${parsed.nodes.map((n, i) => `
              <span class="n">${NODE_DEFS[n.type].icon} ${esc(n.name)}</span>
              ${i < parsed.nodes.length - 1 ? '<span class="a">→</span>' : ''}`).join('')}
          </div>
        </div>`;
    };
    mask.querySelector('#ai-go').onclick = () => {
      const text = mask.querySelector('#ai-text').value.trim();
      if (!text) { toast('先写点什么吧'); return; }
      const result = parsePrompt(text);
      current.name = result.name;
      current.nodes = result.nodes;
      current.edges = result.edges;
      canvas.setWorkflow(clone(current));
      document.getElementById('wf-name').value = result.name;
      scheduleSave();
      close();
      toast('搭好了！点「试运行」看看效果');
    };
  }

  /* ============================================================
   * 投递箱（手机"随时扔"的入口）
   * ============================================================ */
  function openInbox() {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `
      <div class="modal" style="max-width:560px">
        <div class="modal-head"><span>📬</span><h3>投递箱</h3><button class="x">✕</button></div>
        <div class="modal-body" id="inbox-body"><div class="prop-empty">正在连接本机投递服务…</div></div>
        <div class="modal-foot">
          <span style="flex:1;font-size:12px;color:var(--faint)">正在连接 <code>${esc(inbox.base())}</code><br>服务未启动时：在项目目录运行 <code>node tools/inbox-server.js</code></span>
          <button class="btn" id="inbox-close">关闭</button>
        </div>
      </div>`;
    document.body.appendChild(mask);
    const close = () => mask.remove();
    mask.querySelector('.x').onclick = close;
    mask.querySelector('#inbox-close').onclick = close;
    mask.addEventListener('pointerdown', e => { if (e.target === mask) close(); });

    const box = mask.querySelector('#inbox-body');
    const render = async () => {
      let items = [];
      try {
        items = await inbox.list();
      } catch (e) {
        box.innerHTML = `
          <div class="prop-empty" style="padding:24px 0">
            📭 还没连上投递服务<br>
            <span style="font-size:12px">在项目目录运行 <code>node tools/inbox-server.js</code>，<br>
            然后手机连同一 WiFi 打开提示的地址，就能随时扔了</span>
          </div>`;
        return;
      }
      if (!items.length) {
        box.innerHTML = `
          <div class="prop-empty" style="padding:24px 0">
            ✅ 服务正常，收集箱空空如也<br>
            <span style="font-size:12px">手机网页或系统分享扔一条进来试试？</span>
          </div>`;
        return;
      }
      box.innerHTML = `
        <div class="ai-hero">📱 手机扔进来 <b>${items.length}</b> 条，读入小流一起处理吧</div>
        <div class="inbox-list">
          ${items.map(x => `
            <div class="inbox-item">
              <div class="ii-meta">${esc(inbox.label(x))}</div>
              <div class="ii-text">${esc(trunc(x.text, 120))}</div>
            </div>`).join('')}
        </div>`;
      const foot = document.createElement('div');
      foot.style.cssText = 'display:flex;gap:10px;margin-top:14px';
      foot.innerHTML = `
        <button class="btn primary" style="flex:1" id="inbox-take">↘ 带入试运行</button>
        <button class="btn ghost" id="inbox-clear">🗑 清空</button>`;
      box.appendChild(foot);
      mask.querySelector('#inbox-take').onclick = async () => {
        pendingInbox = inbox.mergeText(items);
        // 公网投喂墙是只读的（清空需令牌），clear 失败不影响带入
        try { await inbox.clear(); } catch (e) { /* 只读墙，跳过清空 */ }
        toast(`✓ 已带入 ${items.length} 条投递，去点「试运行」吧`);
        close();
      };
      mask.querySelector('#inbox-clear').onclick = async () => {
        try {
          await inbox.clear();
          toast('投递箱已清空');
          render();
        } catch (e) {
          toast('这个投递箱是只读的（公网投喂墙），内容会一直留着给大家看');
        }
      };
    };
    render();
  }

  /* ============================================================
   * 试运行
   * ============================================================ */
  function openRun() {
    if (running) return;
    const collects = current.nodes.filter(n => n.type === 'collect');
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `
      <div class="modal">
        <div class="modal-head"><span>▶</span><h3>试运行 · ${esc(current.name)}</h3><button class="x">✕</button></div>
        <div class="modal-body" id="run-steps"></div>
        <div class="modal-foot">
          <span style="flex:1;font-size:12px;color:var(--faint)" id="run-note">每一步的输入输出都摆在这里 · 开启「正式运行」后到点会自动跑并弹通知</span>
          <button class="btn" id="run-close">关闭</button>
        </div>
      </div>`;
    document.body.appendChild(mask);
    const close = () => mask.remove();
    mask.querySelector('.x').onclick = close;
    mask.querySelector('#run-close').onclick = close;
    mask.addEventListener('pointerdown', e => { if (e.target === mask) close(); });

    const box = mask.querySelector('#run-steps');
    const rendered = new Set();
    running = true;

    const draw = (step, idx) => {
      if (!rendered.has(idx)) {
        rendered.add(idx);
        const el = document.createElement('div');
        el.className = 'run-step run';
        el.id = 'step-' + idx;
        el.innerHTML = `
          <div class="st-ic">${step.icon}</div>
          <div class="st-body">
            <div class="st-title">第 ${idx} 步 · ${esc(step.name)}
              ${step.via ? `<span class="tag">走「${esc(step.via)}」</span>` : ''}</div>
            <div class="st-io"><b>输入</b> ${esc(step.inText)}</div>
            <div class="st-io out"></div>
          </div>
          <div class="st-status">⏳ 执行中</div>`;
        box.appendChild(el);
      }
      const el = document.getElementById('step-' + idx);
      if (!el) return;
      el.className = 'run-step ' + step.status;
      el.querySelector('.st-io.out').innerHTML = step.status === 'run'
        ? '' : `<b>输出</b> ${esc(step.outText)}${step.ms ? ` <span style="color:var(--faint)">(${step.ms}ms)</span>` : ''}`;
      el.querySelector('.st-status').textContent =
        step.status === 'ok' ? '✓ 完成' : (step.status === 'error' ? '✗ 出错' : '⏳ 执行中');
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    };

    const start = (userInput) => {
      box.innerHTML = '';
      rendered.clear();
      (async () => {
        const res = await runWorkflow(current, draw, { userInput });
        const sum = document.createElement('div');
        sum.className = 'run-summary' + (res.ok ? '' : ' bad');
        sum.textContent = res.ok
          ? `🎉 跑完啦！一共 ${res.steps.length} 步，全部顺利`
          : '😵 出错了：' + res.error;
        box.appendChild(sum);
        sum.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        running = false;
      })();
    };

    if (collects.length) {
      const c = collects[0];
      const prefill = pendingInbox;
      pendingInbox = '';
      box.innerHTML = `
        <div class="ai-hero">📮 这个流程要从「${esc(c.name)}」开始——先随手扔点内容进去吧
          ${prefill ? `<br><b>已带入 ${prefill.split('\\n').length} 条手机投递</b>，可以直接开始，也能再改改` : ''}</div>
        <textarea class="ai-input" id="run-input" placeholder="${esc(c.cfg.hint || '随手扔点内容…')}">${esc(prefill)}</textarea>
        <div style="display:flex;gap:10px;align-items:center;margin-top:12px">
          <label class="btn" for="run-file" title="支持 .txt / .md，内容会追加到上面">📎 从文件导入</label>
          <input type="file" id="run-file" accept=".txt,.md,text/plain,text/markdown" style="display:none">
          <span style="flex:1;font-size:12px;color:var(--faint)">电脑里的记录可以直接拖进来</span>
          <button class="btn primary" id="run-start">▶ 开始试运行</button>
        </div>`;
      const area = mask.querySelector('#run-input');
      mask.querySelector('#run-file').addEventListener('change', e => {
        const f = e.target.files[0];
        if (!f) return;
        const rd = new FileReader();
        rd.onload = () => {
          area.value = (area.value ? area.value + '\n' : '') + String(rd.result || '');
          toast(`已读入「${f.name}」`);
        };
        rd.readAsText(f);
      });
      mask.querySelector('#run-start').onclick = () => {
        start(area.value || '');
      };
      area.focus();
    } else {
      start('');
    }
  }

  /* ============================================================
   * 导入 / 导出
   * ============================================================ */
  function exportWF(wf) {
    if (!wf) return;
    const blob = new Blob([store.exportJSON(wf)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (wf.name || '小流工作流') + '.json';
    a.click();
    URL.revokeObjectURL(a.href);
    toast('已导出 JSON，收好它～');
  }

  function showImport() {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `
      <div class="modal" style="max-width:520px">
        <div class="modal-head"><span>📥</span><h3>导入工作流</h3><button class="x">✕</button></div>
        <div class="modal-body">
          <div class="import-drop">
            选择之前导出的 .json 文件
            <input type="file" id="imp-file" accept=".json,application/json">
          </div>
          <div style="font-size:13px;color:var(--muted);margin-bottom:8px">或者直接把 JSON 内容粘贴进来：</div>
          <textarea id="imp-text" placeholder='{"app":"xiaoflow",...}'></textarea>
        </div>
        <div class="modal-foot">
          <button class="btn" id="imp-cancel">取消</button>
          <button class="btn primary" id="imp-go">导入</button>
        </div>
      </div>`;
    document.body.appendChild(mask);
    const close = () => mask.remove();
    mask.querySelector('.x').onclick = close;
    mask.querySelector('#imp-cancel').onclick = close;
    mask.addEventListener('pointerdown', e => { if (e.target === mask) close(); });

    mask.querySelector('#imp-file').addEventListener('change', e => {
      const f = e.target.files[0];
      if (!f) return;
      const rd = new FileReader();
      rd.onload = () => { mask.querySelector('#imp-text').value = rd.result; };
      rd.readAsText(f);
    });

    mask.querySelector('#imp-go').onclick = () => {
      const text = mask.querySelector('#imp-text').value.trim();
      if (!text) { toast('先选择文件或粘贴内容'); return; }
      try {
        const wf = store.importJSON(text);
        store.save(wf);
        close();
        toast(`已导入「${wf.name}」`);
        if (location.hash === '#/' || !location.hash) route();
      } catch (err) {
        toast('导入失败：' + err.message);
      }
    };
  }

  /* ---------- 启动 ---------- */
  // 系统通知不可用时，回退成页面提示
  notify.onFallback((title, body) => toast(`🔔 ${title}：${trunc(body, 60)}`));
  scheduler.start(); // 正式运行：页面常开时按真实时间触发已启用的工作流
  route();
  setInterval(() => { if (document.getElementById('live-next')) updateLiveUI(); }, 1000);
})();
