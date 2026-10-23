/* ============================================================
 * 小流 XiaoFlow — 自然语言创建工作流（规则解析引擎）
 * 输入大白话，输出工作流。原型期用关键词 + 时间表达式解析。
 * ============================================================ */
(function (root) {
  const XF = root.XF || (root.XF = {});
  if (typeof module !== 'undefined' && module.exports) module.exports = XF;

  const CN_NUM = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12 };
  const WEEK = { 一: '每周一', 二: '每周二', 三: '每周三', 四: '每周四', 五: '每周五', 六: '每周六', 日: '每周日', 天: '每周日' };

  function norm(s) {
    return (s || '')
      .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
      .replace(/[：]/g, ':').replace(/\s+/g, '');
  }

  /* 解析时间，如：每天早上八点 / 每周五下午三点半 / 每天8:00 */
  function parseTime(s) {
    let m = s.match(/每周([一二三四五六日天])/);
    const freq = m ? WEEK[m[1]] : (s.includes('每天') || /天天/.test(s) ? '每天' : null);

    let hh = null, mm = 0;
    m = s.match(/(\d{1,2}|[一二两三四五六七八九十]{1,3})点(半|\d{1,2}|[一二三四十]{1,3}分?)?/);
    if (m) {
      hh = CN_NUM[m[1]] != null ? CN_NUM[m[1]] : parseInt(m[1], 10);
      if (m[2]) {
        if (m[2] === '半') mm = 30;
        else {
          const mv = m[2].replace(/分/, '');
          mm = CN_NUM[mv] != null ? CN_NUM[mv] : parseInt(mv, 10);
        }
      }
    } else {
      m = s.match(/(\d{1,2}):(\d{2})/);
      if (m) { hh = parseInt(m[1], 10); mm = parseInt(m[2], 10); }
    }
    if (hh == null) return freq ? { freq, time: '08:00' } : null;
    if (/下午|傍晚/.test(s) && hh < 12) hh += 12;
    if (/晚上|夜里/.test(s) && hh < 12) hh += 12;
    if (/早上|上午|凌晨/.test(s) && hh === 12) hh = 0;
    hh = Math.max(0, Math.min(23, hh));
    return { freq: freq || '每天', time: String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0') };
  }

  XF.parsePrompt = function (rawText) {
    const text = norm(rawText);
    const notes = [];
    const nodes = [];
    const edges = [];
    let y = 120;
    const add = (type, cfg, name, opts) => {
      const def = XF.NODE_DEFS[type];
      const n = { id: XF.uid('n'), type, x: 40 + nodes.length * 260, y, cfg: cfg || {}, name: name || def.name };
      nodes.push(n);
      if (nodes.length > 1 && !(opts && opts.disconnect)) {
        edges.push({ id: XF.uid('e'), from: nodes[nodes.length - 2].id, to: n.id, fromPort: 0 });
      }
      return n;
    };

    /* ---- 1. 触发器（部分触发器自带结尾动作） ---- */
    const time = parseTime(text);
    const hasWeather = /天气|气温|下雨|冷不冷|热不热/.test(text);
    const hasNews = /新闻|资讯|头条|订阅|rss|文章|博客|更新/.test(text);
    const hasBirthday = /生日|纪念日|过节/.test(text);
    const interval = text.match(/(\d{1,3})分钟/) && /喝水|久坐|休息|起身|活动|放松/.test(text);
    const pomodoro = /番茄|专注|工作\d+分钟/.test(text);
    const weekly = /周报|汇报|本周总结|本周产出/.test(text);
    const hasNotes = /碎片|整理箱|灵感/.test(text) || (/收藏|链接/.test(text) && /整理|分类|笔记/.test(text));
    const decide = /吃什么|穿什么|帮我选|决策|几点出门|选一个/.test(text);
    let actionAdded = false; // 触发器分支里是否已经带了结尾动作

    if (pomodoro) {
      add('manual', {});
      add('delay', { minutes: 25 });
      add('notify', { content: '25 分钟到！休息一下吧～' });
      actionAdded = true;
      notes.push('点一下就开始，专注 25 分钟后提醒休息');
    } else if (interval) {
      const mins = parseInt(interval[1], 10) || 45;
      add('timer', { freq: '每隔一段时间', minutes: mins });
      add('notify', { content: mins >= 30 ? '该起身活动一下啦～' : '该喝口水休息一下～' });
      actionAdded = true;
      notes.push(`每隔 ${mins} 分钟提醒你一次`);
    } else if (weekly) {
      add('collect', { hint: '今天做了什么、遇到什么' });
      add('organize', { preset: '周报归拢' });
      add('save', { book: '本周记录' });
      add('timer', { freq: time ? time.freq : '每周五', time: time ? time.time : '17:00' }, null, { disconnect: true });
      add('organize', { preset: '周报初稿' });
      add('notify', { content: '周报初稿好啦，你只管删减和判断' });
      actionAdded = true;
      notes.push('随手扔记录 → AI 按「产出 / 问题 / 计划」归拢 → 存进本周记录');
      notes.push(time ? `${time.freq} ${time.time} 自动生成周报初稿` : '每周五 17:00 自动生成周报初稿');
    } else if (hasNotes) {
      if (time) add('timer', { freq: time.freq, time: time.time });
      add('collect', { hint: '链接 / 截图 / 灵感' });
      add('organize', { preset: '碎片整理' });
      add('save', { book: '碎片笔记' });
      actionAdded = true;
      notes.push('一次输入，自动分流：AI 分类、提炼要点、标记可以用在哪');
    } else if (decide) {
      add('timer', { freq: time ? time.freq : '每天', time: time ? time.time : '08:00' });
      add('organize', { preset: '决策参谋', q: '天气、日程、预算' });
      add('notify', { content: 'AI 给了几个选项，选一个吧' });
      actionAdded = true;
      notes.push('把约束条件固定成提示词，每天早上给你 2-3 个选项');
    } else if (hasBirthday) {
      add('timer', { freq: time ? time.freq : '每天', time: time ? time.time : '09:00' });
      add('aichat', { q: '看看最近一周有没有朋友生日或纪念日？', useInput: true });
      add('notify', { content: '' });
      actionAdded = true;
      notes.push('每天早上让 AI 翻翻日子，有生日就提醒你');
    } else if (hasWeather) {
      const cityM = text.match(/([\u4e00-\u9fa5]{2,4})(?:市)?(?:的)?天气/) || text.match(/我在([\u4e00-\u9fa5]{2,4})/);
      const city = cityM ? cityM[1] : '北京';
      const when = /晚上|傍晚/.test(text) ? '晚上' : '早上';
      if (time) add('timer', { freq: time.freq, time: time.time });
      add('weather', { city, when });
      notes.push(`看看${city}${when}的天气`);
    } else if (hasNews) {
      if (time) add('timer', { freq: time.freq, time: time.time });
      add('rss', { url: 'https://news.ycombinator.com/rss', count: 3 });
      notes.push('订阅源一有更新就帮你取回来');
    } else if (time) {
      add('timer', { freq: time.freq, time: time.time });
      notes.push(`到点自动开始：${time.freq} ${time.time}`);
    } else {
      add('manual', {});
      notes.push('点一下就开始执行');
    }

    /* ---- 2. 中间处理 ---- */
    if (/总结|摘要|太长|懒得看|浓缩|划重点/.test(text) && nodes.length) {
      add('summary', { len: '几句话' });
      notes.push('加了一步「帮我总结一下」');
    }

    /* ---- 3. 动作（触发器分支已带动作时不再重复添加） ---- */
    const urlM = text.match(/https?:\/\/[^\s，。]+/);
    if (!actionAdded) {
      if (/打开|访问|网站|网页/.test(text) && urlM) {
        add('openlink', { url: urlM[0] });
        notes.push('最后帮你打开网页');
      } else if (/保存|记下来|笔记|收藏|整理/.test(text)) {
        add('save', { book: '默认笔记本' });
        notes.push('最后存到你的笔记本');
      } else if (/提醒|别忘了|不要忘|通知我|喊我/.test(text)) {
        add('notify', { content: '' });
        notes.push('最后跳一条提醒给你');
      } else if (nodes.length) {
        add('notify', { content: '' });
        notes.push('最后跳一条提醒给你');
      }
    }

    /* ---- 4. 命名 ---- */
    let name = '我的小流程';
    if (pomodoro) name = '番茄专注钟';
    else if (interval) name = '定时休息提醒';
    else if (weekly) name = '职场周报流水线';
    else if (hasNotes) name = '碎片信息整理箱';
    else if (decide) name = '每天帮我选一个';
    else if (hasBirthday) name = '生日纪念日提醒';
    else if (hasWeather) name = (time ? '定时' : '') + '天气小助手';
    else if (hasNews) name = (time ? '每日' : '') + '新闻摘要';
    else if (time) name = '定时提醒';

    return { name, nodes, edges, notes };
  };
})(typeof window !== 'undefined' ? window : globalThis);
