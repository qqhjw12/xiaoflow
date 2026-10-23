/* ============================================================
 * 小流 XiaoFlow — 节点定义与内置模板
 * 节点分类（对用户说人话）：
 *   trigger   当…的时候
 *   condition 如果…
 *   action    就帮我…
 *   ai        AI 帮手
 * ============================================================ */
(function (root) {
  const XF = root.XF || (root.XF = {});
  if (typeof module !== 'undefined' && module.exports) module.exports = XF;

  /* ---------- 分类元信息 ---------- */
  XF.CATEGORIES = {
    trigger:   { label: '当…的时候', icon: '⚡', color: '#f59e0b', bg: '#fef3c7' },
    condition: { label: '如果…',     icon: '🔀', color: '#8b5cf6', bg: '#ede9fe' },
    action:    { label: '就帮我…',   icon: '✨', color: '#0d9488', bg: '#ccfbf1' },
    ai:        { label: 'AI 帮手',   icon: '🤖', color: '#ec4899', bg: '#fce7f3' }
  };

  /* ---------- 模拟数据 helpers ---------- */
  const WEATHER_POOL = [
    { text: '晴', temp: 22, tip: '阳光不错，适合出门走走' },
    { text: '多云', temp: 19, tip: '温度舒适，早晚温差大注意添衣' },
    { text: '小雨', temp: 15, tip: '记得带伞，路面湿滑慢点走' },
    { text: '阴', temp: 17, tip: '光线柔和，适合安静做事' }
  ];
  const NEWS_TITLES = [
    '研究团队发布新一代开源工具，性能提升 40%',
    '城市地铁新线路开通，通勤时间缩短 20 分钟',
    '本地周末市集回归，超过 60 家摊位参加',
    '健康专家建议：每工作一小时起身活动五分钟',
    '新版阅读应用上线，支持离线摘要功能'
  ];

  function pickTime() {
    const d = new Date();
    const week = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
    return `${d.getMonth() + 1}月${d.getDate()}日 星期${week}`;
  }
  function stringify(v) {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) return v.map(x => (typeof x === 'string' ? x : x.title || JSON.stringify(x))).join('\n');
    return v.text || v.summary || v.answer || v.message || JSON.stringify(v);
  }
  function trunc(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; }

  /* organize 节点各预设对应的本地 LLM 提示词 */
  function organizePrompt(preset, src, q) {
    const head = '你是用户的个人小助手，用简洁、口语化的中文输出，直接给结果，不要解释你的做法。\n';
    switch (preset) {
      case '周报归拢':
        return head + '把下面这些零散记录按【本周产出】【遇到的问题】【下周计划】三类归拢，保留关键信息，每条一行：\n' + src;
      case '周报初稿':
        return head + '基于下面本周记录生成一份周报初稿，分三部分：一、本周产出；二、遇到的问题；三、下周计划。语气平实务实，末尾提醒一句"请自行删减和判断"：\n' + src;
      case '碎片整理':
        return head + '把下面的碎片信息分类为「待读 / 可用素材 / 灵感」，每条提炼一句要点，并标注"可以用在什么场景"：\n' + src;
      case '决策参谋':
        return head + '结合约束条件（' + (q || '天气、日程、预算') + '），针对下面这条内容给 2-3 个具体选项，每个选项附一句话理由，最后让用户自己选一个：\n' + src;
      default:
        return head + (q || '请整理下面这些内容：') + '\n' + src;
    }
  }

  /* ---------- 节点定义 ---------- */
  XF.NODE_DEFS = {
    /* ===== 触发器 ===== */
    manual: {
      cat: 'trigger', name: '我点一下就跑', icon: '👆',
      desc: '随时手动开始，适合想起来就跑一次的流程',
      fields: [],
      run() { return { text: '好的，开始执行～' }; }
    },
    timer: {
      cat: 'trigger', name: '当到了某个时间', icon: '⏰',
      desc: '每天、每周固定时间，或每隔一段时间自动触发',
      fields: [
        { key: 'freq', label: '什么时候', type: 'select',
          options: ['每天', '每周一', '每周二', '每周三', '每周四', '每周五', '每周六', '每周日', '每隔一段时间'] },
        { key: 'time', label: '大概几点', type: 'time', def: '08:00',
          showIf: f => f.freq !== '每隔一段时间' },
        { key: 'minutes', label: '隔多久一次（分钟）', type: 'number', def: 45,
          showIf: f => f.freq === '每隔一段时间' }
      ],
      run(input, cfg) {
        if (cfg.freq === '每隔一段时间') return { text: `⏰ 每隔 ${cfg.minutes} 分钟提醒一次｜现在：${pickTime()}` };
        return { text: `⏰ 到点啦：${cfg.freq} ${cfg.time || '08:00'}｜${pickTime()}` };
      }
    },
    rss: {
      cat: 'trigger', name: '当订阅源更新时', icon: '📡',
      desc: '关注的博客、网站有新文章时自动开始',
      fields: [
        { key: 'url', label: '订阅地址', type: 'text', def: 'https://news.ycombinator.com/rss', placeholder: 'https://…' },
        { key: 'count', label: '看几条新的', type: 'number', def: 3 }
      ],
      run(input, cfg) {
        let site = '订阅源';
        try { site = new URL(cfg.url || 'https://example.com').hostname; } catch (e) {}
        const n = Math.max(1, Math.min(5, Number(cfg.count) || 3));
        const items = [];
        for (let i = 0; i < n; i++) {
          items.push({ title: NEWS_TITLES[(i + (site.length % 3)) % NEWS_TITLES.length], link: cfg.url || '' });
        }
        return { site, items, text: `📡 ${site} 更新了 ${n} 条：\n` + items.map(i => '· ' + i.title).join('\n') };
      }
    },
    weather: {
      cat: 'trigger', name: '当天气变化时', icon: '⛅',
      desc: '每天早晚看看天气，顺便带句话给你',
      fields: [
        { key: 'city', label: '哪个城市', type: 'text', def: '北京' },
        { key: 'when', label: '什么时候看', type: 'select', options: ['早上', '晚上'] }
      ],
      run(input, cfg) {
        const w = WEATHER_POOL[(cfg.city || '').length % WEATHER_POOL.length];
        return { city: cfg.city || '本地', when: cfg.when || '早上', temp: w.temp, sky: w.text, tip: w.tip,
          text: `⛅ ${cfg.city || '本地'}${cfg.when || '早上'}好：${w.text} ${w.temp}°C，${w.tip}` };
      }
    },
    collect: {
      cat: 'trigger', name: '我随手一扔', icon: '📮',
      desc: '把零散记录、链接、灵感扔进收集箱，试运行时会问你扔什么',
      fields: [
        { key: 'hint', label: '扔点什么', type: 'text', def: '今天的工作记录 / 链接 / 灵感' }
      ],
      run(input, cfg, ctx) {
        const t = (ctx && ctx.userInput || '').trim();
        return { text: t || `（示例）${cfg.hint || '随手扔点内容'}` };
      }
    },

    /* ===== 条件 ===== */
    condition: {
      cat: 'condition', name: '如果…就…', icon: '🔀',
      desc: '满足条件走一条路，不满足走另一条',
      outputs: [
        { label: '满足' }, { label: '不满足' }
      ],
      fields: [
        { key: 'field', label: '看看什么', type: 'select',
          options: ['上一步的文字', '标题里有没有'] },
        { key: 'op', label: '怎么比', type: 'select', options: ['包含', '等于', '数字大于'] },
        { key: 'value', label: '比的值', type: 'text', def: '' }
      ],
      run(input, cfg) {
        const raw = stringify(input);
        let ok = false;
        const op = cfg.op || '包含';
        if (op === '包含') ok = raw.includes(cfg.value || '');
        else if (op === '等于') ok = raw.trim() === (cfg.value || '').trim();
        else if (op === '数字大于') {
          const m = raw.match(/-?\d+(\.\d+)?/);
          ok = m ? parseFloat(m[0]) > parseFloat(cfg.value || '0') : false;
        }
        return { branch: ok ? 0 : 1, ok, text: ok ? `✅ 满足条件：「${cfg.value}」` : `➖ 不满足条件：「${cfg.value}」` };
      }
    },
    delay: {
      cat: 'condition', name: '先等一会儿', icon: '⏳',
      desc: '等一段时间再继续下一步',
      fields: [{ key: 'minutes', label: '等几分钟', type: 'number', def: 25 }],
      run(input, cfg) { return { text: `⏳ 已耐心等待 ${cfg.minutes} 分钟` }; }
    },

    /* ===== 动作 ===== */
    notify: {
      cat: 'action', name: '提醒我', icon: '🔔',
      desc: '跳一条真通知给你（系统通知，不支持时页面提醒）',
      fields: [
        { key: 'content', label: '提醒内容', type: 'textarea', def: '', placeholder: '留空则用上一步的结果' }
      ],
      run(input, cfg) {
        const msg = (cfg.content || '').trim() || stringify(input) || '该看看啦';
        if (XF.notify) XF.notify.push('💧 小流提醒', msg);
        return { notified: true, message: msg, text: `🔔 已提醒：${msg}` };
      }
    },
    summary: {
      cat: 'action', name: '帮我总结一下', icon: '📝',
      desc: '把一大段内容浓缩成几句话（原型为模拟摘要）',
      fields: [{ key: 'len', label: '总结多长', type: 'select', options: ['一小段', '几句话', '详细点'] }],
      run(input, cfg) {
        const src = stringify(input) || '（没有收到内容）';
        const firstLines = src.split('\n').filter(Boolean).slice(0, 3);
        const level = cfg.len || '几句话';
        let s;
        if (level === '一小段') s = firstLines.slice(0, 1).join('；') + '。';
        else if (level === '详细点') s = firstLines.join('。') + '。整体看下来信息量不小，建议挑感兴趣的部分细看。';
        else s = firstLines.slice(0, 2).join('；') + '。';
        return { summary: s, text: `📝 摘要：${s}` };
      }
    },
    save: {
      cat: 'action', name: '存到我的笔记本', icon: '📒',
      desc: '把内容保存到本地笔记本',
      fields: [{ key: 'book', label: '哪本笔记本', type: 'text', def: '默认笔记本' }],
      run(input, cfg) {
        const book = cfg.book || '默认笔记本';
        return { saved: true, book, note: stringify(input), text: `📒 已存入「${book}」` };
      }
    },
    openlink: {
      cat: 'action', name: '帮我打开网页', icon: '🌐',
      desc: '打开一个网页看看',
      fields: [{ key: 'url', label: '网址', type: 'text', def: 'https://www.baidu.com', placeholder: 'https://…' }],
      run(input, cfg) { return { opened: cfg.url || '', text: `🌐 已打开：${cfg.url || ''}` }; }
    },

    /* ===== AI ===== */
    aichat: {
      cat: 'ai', name: '问问 AI', icon: '🤖',
      desc: '向 AI 提个问题（设置里接入本机 Ollama 后为真实回答）',
      fields: [
        { key: 'q', label: '想问什么', type: 'textarea', def: '', placeholder: '例如：最近有没有朋友过生日？' },
        { key: 'useInput', label: '把上一步内容也发给 AI', type: 'checkbox', def: true }
      ],
      async run(input, cfg) {
        const q = (cfg.q || '').trim() || '帮我看看这些内容';
        const src = cfg.useInput === false ? '' : stringify(input);
        if (XF.ollama && XF.ollama.ready()) {
          try {
            const ans = await XF.ollama.generate(
              '你是用户的个人小助手，请用简洁、口语化的中文回答。\n用户的问题：' + q +
              (src ? '\n相关材料：' + src : '')
            );
            if (ans) return { answer: ans, ai: 'ollama', text: `🤖 AI 回答：${ans}` };
          } catch (e) { /* 落到模拟回答 */ }
        }
        const ans = `关于「${q}」——我看了一下：${src.slice(0, 60) || '暂无更多信息'}。建议：先记下来，抽空逐一处理，重要的优先。`;
        return { answer: ans, ai: 'local', text: `🤖 AI 回答：${ans}` };
      }
    },
    organize: {
      cat: 'ai', name: 'AI 帮我整理', icon: '🗂️',
      desc: '按固定结构归拢记录、提炼碎片要点，或者每天给你几个选项',
      fields: [
        { key: 'preset', label: '怎么整理', type: 'select',
          options: ['周报归拢', '周报初稿', '碎片整理', '决策参谋', '自定义'] },
        { key: 'q', label: '你的提示词 / 约束条件', type: 'textarea', def: '',
          placeholder: '例如：天气、日程、预算',
          showIf: f => f.preset === '自定义' || f.preset === '决策参谋' }
      ],
      async run(input, cfg) {
        const src = trunc(stringify(input), 200);
        const preset = cfg.preset || '周报归拢';
        if (XF.ollama && XF.ollama.ready()) {
          try {
            const ans = await XF.ollama.generate(organizePrompt(preset, src, cfg.q));
            if (ans) return { text: `🗂️ ${ans}`, ai: 'ollama' };
          } catch (e) { /* 落到模拟整理 */ }
        }
        switch (preset) {
          case '周报归拢':
            return { text: `🗂️ 已按结构归拢：\n【本周产出】${src}\n【遇到的问题】…\n【下周计划】…` };
          case '周报初稿':
            return { text: '📋 周报初稿已生成：\n\n一、本周产出\n1. …\n2. …\n\n二、遇到的问题\n…\n\n三、下周计划\n…\n\n（根据本周记录起草，你只管删减和判断）' };
          case '碎片整理':
            return { text: `🗂️ 整理完成：\n· 分类：待读 / 可用素材 / 灵感\n· 要点：${src}\n· 可以用在：正在进行的那件事上` };
          case '决策参谋':
            return { text: `🎯 结合「${trunc((cfg.q || '天气、日程、预算'), 30)}」给你 3 个选项：\nA. …\nB. …\nC. …\n选一个，剩下的交给我` };
          default:
            return { text: `🗂️ ${stringify(input) || '（没有收到内容）'}` };
        }
      }
    }
  };

  /* ---------- 内置模板 ---------- */
  function mkNode(id, type, x, y, cfg, name) {
    return { id, type, x, y, cfg: cfg || {}, name: name || XF.NODE_DEFS[type].name };
  }
  function mkEdge(id, from, to, fromPort) {
    return { id, from, to, fromPort: fromPort || 0 };
  }

  XF.TEMPLATES = [
    {
      id: 'tpl-weather', name: '每日天气早报', icon: '⛅',
      desc: '每天早上自动看一眼天气，总结成一句话提醒你',
      tags: ['天气', '每日'],
      nodes: [
        mkNode('n1', 'weather', 40, 100, { city: '北京', when: '早上' }),
        mkNode('n2', 'summary', 300, 100, { len: '一小段' }),
        mkNode('n3', 'notify', 560, 100, { content: '该出门啦，看看天气再说' })
      ],
      edges: [mkEdge('e1', 'n1', 'n2'), mkEdge('e2', 'n2', 'n3')]
    },
    {
      id: 'tpl-news', name: '每日新闻摘要', icon: '📰',
      desc: '每天早上把订阅源的新文章浓缩成几条，推送给你',
      tags: ['新闻', '每日'],
      nodes: [
        mkNode('n1', 'timer', 40, 100, { freq: '每天', time: '08:00' }),
        mkNode('n2', 'rss', 300, 100, { url: 'https://news.ycombinator.com/rss', count: 5 }),
        mkNode('n3', 'summary', 560, 100, { len: '几句话' }),
        mkNode('n4', 'notify', 820, 100, { content: '' })
      ],
      edges: [mkEdge('e1', 'n1', 'n2'), mkEdge('e2', 'n2', 'n3'), mkEdge('e3', 'n3', 'n4')]
    },
    {
      id: 'tpl-water', name: '喝水久坐提醒', icon: '💧',
      desc: '每隔一段时间提醒你喝水、起身活动一下',
      tags: ['健康', '提醒'],
      nodes: [
        mkNode('n1', 'timer', 40, 100, { freq: '每隔一段时间', minutes: 45 }),
        mkNode('n2', 'notify', 300, 100, { content: '起来喝口水，活动一下肩颈～' })
      ],
      edges: [mkEdge('e1', 'n1', 'n2')]
    },
    {
      id: 'tpl-birthday', name: '生日纪念日提醒', icon: '🎂',
      desc: '每天早上让 AI 翻翻最近的日子，有生日就提醒你',
      tags: ['提醒', 'AI'],
      nodes: [
        mkNode('n1', 'timer', 40, 100, { freq: '每天', time: '09:00' }),
        mkNode('n2', 'aichat', 300, 100, { q: '看看最近一周有没有朋友生日或纪念日？', useInput: true }),
        mkNode('n3', 'notify', 560, 100, { content: '' })
      ],
      edges: [mkEdge('e1', 'n1', 'n2'), mkEdge('e2', 'n2', 'n3')]
    },
    {
      id: 'tpl-friday', name: '周五收藏整理', icon: '⭐',
      desc: '每周五把这一周的收获整理进笔记本',
      tags: ['每周', '整理'],
      nodes: [
        mkNode('n1', 'timer', 40, 100, { freq: '每周五', time: '18:00' }),
        mkNode('n2', 'save', 300, 100, { book: '每周收藏' })
      ],
      edges: [mkEdge('e1', 'n1', 'n2')]
    },
    {
      id: 'tpl-pomodoro', name: '番茄专注钟', icon: '🍅',
      desc: '点一下开始专注 25 分钟，时间到了提醒你休息',
      tags: ['专注', '手动'],
      nodes: [
        mkNode('n1', 'manual', 40, 100, {}),
        mkNode('n2', 'delay', 300, 100, { minutes: 25 }),
        mkNode('n3', 'notify', 560, 100, { content: '25 分钟到！休息一下吧～' })
      ],
      edges: [mkEdge('e1', 'n1', 'n2'), mkEdge('e2', 'n2', 'n3')]
    },
    {
      id: 'tpl-rss', name: '订阅更新推送', icon: '📡',
      desc: '订阅的网站一更新，马上推送给你',
      tags: ['订阅', '即时'],
      nodes: [
        mkNode('n1', 'rss', 40, 100, { url: 'https://www.ruanyifeng.com/blog/atom.xml', count: 3 }),
        mkNode('n2', 'notify', 300, 100, { content: '' })
      ],
      edges: [mkEdge('e1', 'n1', 'n2')]
    },
    {
      id: 'tpl-weekly', name: '职场周报流水线', icon: '📋',
      desc: '平时随手扔记录，AI 按「产出/问题/计划」归拢；周五自动生成周报初稿，你只管删减和判断',
      tags: ['职场', '每周', 'AI'],
      nodes: [
        mkNode('n1', 'collect', 40, 40, { hint: '今天做了什么、遇到什么' }),
        mkNode('n2', 'organize', 300, 40, { preset: '周报归拢' }),
        mkNode('n3', 'save', 560, 40, { book: '本周记录' }),
        mkNode('n4', 'timer', 40, 240, { freq: '每周五', time: '17:00' }),
        mkNode('n5', 'organize', 300, 240, { preset: '周报初稿' }),
        mkNode('n6', 'notify', 560, 240, { content: '周报初稿好啦，你只管删减和判断' })
      ],
      edges: [mkEdge('e1', 'n1', 'n2'), mkEdge('e2', 'n2', 'n3'),
              mkEdge('e3', 'n4', 'n5'), mkEdge('e4', 'n5', 'n6')]
    },
    {
      id: 'tpl-notes', name: '碎片信息整理箱', icon: '🗂️',
      desc: '链接、截图、灵感都往收集箱扔，AI 自动分类、提炼要点、标记可以用在哪',
      tags: ['笔记', '整理', 'AI'],
      nodes: [
        mkNode('n1', 'collect', 40, 100, { hint: '链接 / 截图 / 灵感' }),
        mkNode('n2', 'organize', 300, 100, { preset: '碎片整理' }),
        mkNode('n3', 'save', 560, 100, { book: '碎片笔记' })
      ],
      edges: [mkEdge('e1', 'n1', 'n2'), mkEdge('e2', 'n2', 'n3')]
    },
    {
      id: 'tpl-decide', name: '每天帮我选一个', icon: '🎯',
      desc: '把约束条件（天气、日程、预算）固定成提示词，每天早上 AI 给你 2-3 个选项，你只负责选',
      tags: ['决策', '每天', 'AI'],
      nodes: [
        mkNode('n1', 'timer', 40, 100, { freq: '每天', time: '08:00' }),
        mkNode('n2', 'organize', 300, 100, { preset: '决策参谋', q: '天气、日程、预算' }),
        mkNode('n3', 'notify', 560, 100, { content: 'AI 给了几个选项，选一个吧' })
      ],
      edges: [mkEdge('e1', 'n1', 'n2'), mkEdge('e2', 'n2', 'n3')]
    }
  ];

  /* ---------- 工具 ---------- */
  XF.uid = function (prefix) {
    return (prefix || 'id') + '_' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
  };
  XF.newWorkflow = function (name) {
    const now = Date.now();
    return {
      id: XF.uid('wf'), name: name || '未命名小流程', icon: '🌱',
      desc: '', builtin: false,
      nodes: [mkNode(XF.uid('n'), 'manual', 80, 140, {})],
      edges: [], createdAt: now, updatedAt: now
    };
  };
})(typeof window !== 'undefined' ? window : globalThis);
