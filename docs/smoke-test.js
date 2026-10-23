/* 小流 XiaoFlow — 逻辑冒烟测试（Node 环境，不依赖浏览器） */
const XF = require('D:/personalization/js/data.js');
require('D:/personalization/js/ai.js');
require('D:/personalization/js/runner.js');
require('D:/personalization/js/store.js');
require('D:/personalization/js/notify.js');
require('D:/personalization/js/ollama.js');
require('D:/personalization/js/scheduler.js');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')); }
}

(async () => {
  console.log('== 1. 模板数据完整性 ==');
  for (const t of XF.TEMPLATES) {
    check(`模板「${t.name}」节点类型都存在`, t.nodes.every(n => XF.NODE_DEFS[n.type]));
    check(`模板「${t.name}」连线两端存在`, t.edges.every(e =>
      t.nodes.some(n => n.id === e.from) && t.nodes.some(n => n.id === e.to)));
  }

  console.log('== 2. 自然语言解析 ==');
  const cases = [
    ['每天早上八点提醒我喝水看天气', ['timer', 'weather', 'notify']],
    ['每天早八点把新闻摘要推给我', ['timer', 'rss', 'summary', 'notify']],
    ['每隔 45 分钟提醒我起身活动', ['timer', 'notify']],
    ['每周五下午六点把收藏整理成笔记', ['timer', 'collect', 'organize', 'save']],
    ['点一下开始番茄钟，25 分钟后提醒我休息', ['manual', 'delay', 'notify']],
    ['帮我看看最近有没有朋友生日', ['timer', 'aichat', 'notify']],
    ['打开 https://www.baidu.com 看看', ['manual', 'openlink']],
    ['平时把工作记录随手扔进去，周五生成周报初稿', ['collect', 'organize', 'save', 'timer', 'organize', 'notify']],
    ['每天早上帮我决定吃什么', ['timer', 'organize', 'notify']],
    ['把链接和灵感扔进整理箱', ['collect', 'organize', 'save']]
  ];
  for (const [text, expect] of cases) {
    const r = XF.parsePrompt(text);
    const types = r.nodes.map(n => n.type);
    check(`「${text}」→ ${types.join(',')}`, types.join(',') === expect.join(','), '期望: ' + expect.join(','));
    // 周报流水线是双链条（随手记一条 + 周五生成一条），其余为单链
    const expectEdges = text.includes('周报') ? 4 : r.nodes.length - 1;
    check(`「${text}」连线正确`, r.edges.length === expectEdges, `edges=${r.edges.length}`);
  }
  const tp = XF.parsePrompt('每周五下午三点半提醒我');
  check('时间解析：每周五 15:30', tp.nodes[0].cfg.freq === '每周五' && tp.nodes[0].cfg.time === '15:30',
    JSON.stringify(tp.nodes[0].cfg));

  console.log('== 3. 试运行引擎 ==');
  for (const t of XF.TEMPLATES) {
    const res = await XF.runWorkflow(t, () => {});
    check(`运行模板「${t.name}」`, res.ok && res.steps.length === t.nodes.length,
      res.error || `steps=${res.steps.length}`);
  }
  // 无触发器应报错
  const bad = await XF.runWorkflow({ nodes: [{ id: 'x', type: 'notify', cfg: {} }], edges: [] }, () => {});
  check('无触发器时友好报错', !bad.ok && /触发器/.test(bad.error));

  // 收集节点应接收用户随手输入
  const collectWF = {
    nodes: [{ id: 'c1', type: 'collect', cfg: { hint: '今天做了什么' } },
            { id: 's1', type: 'save', cfg: { book: '测试' } }],
    edges: [{ id: 'e1', from: 'c1', to: 's1', fromPort: 0 }]
  };
  const cres = await XF.runWorkflow(collectWF, () => {}, { userInput: '今天修了三个 bug，开了两个会' });
  check('收集节点透传用户输入', cres.ok && cres.steps[0].outText.includes('今天修了三个 bug'),
    cres.steps[0] && cres.steps[0].outText);
  const cres2 = await XF.runWorkflow(collectWF, () => {});
  check('无输入时用示例文案', cres2.ok && cres2.steps[0].outText.includes('今天做了什么'));
  // 环路检测
  const loop = await XF.runWorkflow({
    nodes: [{ id: 'a', type: 'manual', cfg: {} }, { id: 'b', type: 'delay', cfg: { minutes: 1 } }],
    edges: [{ id: 'e1', from: 'a', to: b(), fromPort: 0 }, { id: 'e2', from: 'b', to: 'a', fromPort: 0 }]
  }, () => {});
  function b() { return 'b'; }
  check('环路检测', !loop.ok && /圈圈/.test(loop.error), loop.error);

  console.log('== 4. 导入导出 ==');
  const tpl = XF.TEMPLATES[0];
  const wf = XF.store.importJSON(XF.store.exportJSON({ ...tpl, builtin: false }));
  check('导入后节点数一致', wf.nodes.length === tpl.nodes.length);
  check('导入后 id 已重新生成', wf.nodes[0].id !== tpl.nodes[0].id);
  check('导入后连线指向新 id', wf.edges.every(e => wf.nodes.some(n => n.id === e.from) && wf.nodes.some(n => n.id === e.to)));

  console.log('== 5. 真实系统通知 ==');
  check('无 Notification 环境状态为 unsupported', XF.notify.state() === 'unsupported', XF.notify.state());
  let fb = null;
  XF.notify.onFallback((title, body) => { fb = { title, body }; });
  const used = XF.notify.push('测试标题', '测试内容');
  check('不可用时自动回退页面提示', used === false && fb && fb.title === '测试标题' && fb.body === '测试内容');

  console.log('== 6. 本机 AI 接入（Ollama） ==');
  check('默认不启用，AI 节点走模拟', XF.ollama.getSettings().enabled === false && !XF.ollama.ready());
  const probeRes = await XF.ollama.probe('http://127.0.0.1:59999'); // 随机高端口，基本不会有服务
  check('探测不存在的服务返回 ok:false', probeRes.ok === false && !!probeRes.error, JSON.stringify(probeRes));
  const aiRes = await XF.NODE_DEFS.aichat.run({ text: '今天天气不错' }, { q: '今天适合出门吗', useInput: true });
  check('aichat 无 Ollama 时回退模拟回答', aiRes.ai === 'local' && aiRes.text.includes('AI 回答'));
  const orgRes = await XF.NODE_DEFS.organize.run(
    { text: '周一修 bug；周三对齐进度延了两天；周五写周报' }, { preset: '周报归拢' });
  check('organize 无 Ollama 时回退模拟整理', orgRes.text.includes('本周产出') && !orgRes.ai);

  console.log('== 7. 正式运行调度 ==');
  const water = XF.TEMPLATES.find(x => x.id === 'tpl-water');
  check('timerCfg 识别「每隔一段时间」', XF.scheduler.timerCfg(water).minutes === 45);
  check('无定时触发器时 timerCfg 为 null', XF.scheduler.timerCfg({ nodes: [{ type: 'manual' }] }) === null);

  const now = Date.now();
  const today8 = new Date(); today8.setHours(8, 0, 0, 0);
  const daily = { id: 'w1', name: '每日', enabled: true, lastFired: 0,
    nodes: [{ id: 'n1', type: 'timer', cfg: { freq: '每天', time: '08:00' } }], edges: [] };
  check('每天 08:00：已过点且本周期没跑过 → 今天 08:00 触发',
    XF.scheduler.nextFire(daily, now) === today8.getTime(), new Date(XF.scheduler.nextFire(daily, now)).toString());
  daily.lastFired = today8.getTime() + 1000;
  check('每天 08:00：今天已跑过 → 明天 08:00',
    XF.scheduler.nextFire(daily, now) === today8.getTime() + 86400000);

  const intervalWf = { id: 'w2', lastFired: now - 10 * 60000,
    nodes: [{ id: 'n1', type: 'timer', cfg: { freq: '每隔一段时间', minutes: 45 } }], edges: [] };
  check('每隔 45 分钟：从上次触发起算',
    XF.scheduler.nextFire(intervalWf, now) === (now - 10 * 60000) + 45 * 60000);

  const fri = { id: 'w3', lastFired: 0,
    nodes: [{ id: 'n1', type: 'timer', cfg: { freq: '每周五', time: '17:00' } }], edges: [] };
  const dFri = new Date(XF.scheduler.nextFire(fri, now));
  check('每周五 17:00：落点总是周五 17:00',
    dFri.getDay() === 5 && dFri.getHours() === 17 && dFri.getMinutes() === 0, dFri.toString());

  // fire：真实执行 + 通知 + 记日志 + 持久化 lastFired
  const weekly = JSON.parse(JSON.stringify(XF.TEMPLATES.find(x => x.id === 'tpl-weekly')));
  weekly.id = 'wf-test-live';
  weekly.enabled = true;
  XF.store.save(weekly);
  let fb2 = null;
  XF.notify.onFallback((title, body) => { fb2 = { title, body }; });
  const fireRes = await XF.scheduler.fire(weekly);
  check('fire 真实执行完整工作流', fireRes.ok && fireRes.steps.length === weekly.nodes.length,
    fireRes.error || `steps=${fireRes.steps.length}`);
  check('fire 后 lastFired 已持久化', weekly.lastFired > 0 && XF.store.get('wf-test-live').lastFired > 0);
  check('fire 触发通知（回退路径）', fb2 && fb2.title.includes('小流'), fb2 && fb2.title);
  const lg = XF.scheduler.logs(5);
  check('fire 写入运行记录', lg.length > 0 && lg[0].name === weekly.name && lg[0].ok === true);

  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试崩溃:', e); process.exit(1); });
