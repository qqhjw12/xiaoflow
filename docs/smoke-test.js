/* 小流 XiaoFlow — 逻辑冒烟测试（Node 环境，不依赖浏览器）
 * 用法：node docs/smoke-test.js */
// 公网投喂箱数据已存云端数据库；测试收尾要用清空令牌清理云端测试数据，
// 该值须与云端 inbox_config.clear_token 一致（云服务接入时已播种）
process.env.CLEAR_TOKEN = 'smoke-test-token';
const XF = require('../js/data.js');
require('../js/ai.js');
require('../js/runner.js');
require('../js/store.js');
require('../js/notify.js');
require('../js/ollama.js');
require('../js/scheduler.js');
require('../js/inbox.js');
const publicInbox = require('../deploy/public-inbox/server.js');

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

  console.log('== 8. 投递服务（手机随时扔） ==');
  const http = require('http');
  const inboxServer = require('../tools/inbox-server.js');
  // 起一个随机端口的真实服务，避免占用默认 8787
  const server = http.createServer(inboxServer.createHandler());
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const api = (p, opts) => fetch('http://127.0.0.1:' + port + p, opts);

  inboxServer.inbox.clear();
  let r1 = await api('/api/drop', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '周一修了三个 bug', source: 'test' })
  });
  let j1 = await r1.json();
  check('POST /api/drop 投递成功', r1.status === 200 && j1.ok && j1.total === 1, JSON.stringify(j1));

  r1 = await api('/drop?text=' + encodeURIComponent('微信里分享的一条') + '&source=share');
  j1 = await r1.json();
  check('GET /drop 投递成功（快捷指令用）', r1.status === 200 && j1.ok && j1.total === 2);

  r1 = await api('/api/drop', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '   ' })
  });
  check('空内容返回 400', r1.status === 400);

  r1 = await api('/api/inbox');
  j1 = await r1.json();
  check('GET /api/inbox 返回全部（新的在前）',
    j1.total === 2 && j1.items[0].text === '微信里分享的一条' && j1.items[1].text === '周一修了三个 bug',
    JSON.stringify(j1.items.map(x => x.text)));

  r1 = await api('/');
  const html = await r1.text();
  check('GET / 返回手机网页', html.includes('扔进小流') && html.includes('viewport'));

  r1 = await api('/nope');
  check('未知路径 404', r1.status === 404);

  // CORS 头（file:// 页面读取需要）
  r1 = await api('/api/inbox');
  check('响应带 CORS 头', (r1.headers.get('access-control-allow-origin') || '') === '*');

  // 小流侧客户端模块（指向测试服务的随机端口）
  XF.inbox.setPort(port);
  const items = await XF.inbox.list();
  check('XF.inbox.list 拉到真实服务数据', items.length === 2 && items[0].text === '微信里分享的一条');
  const merged = XF.inbox.mergeText(items);
  check('mergeText 合并为可读文本', merged.includes('周一修了三个 bug') && merged.includes('微信里分享的一条'));
  check('inbox.label 标注来源', /test|未知/.test(XF.inbox.label(items[1])), XF.inbox.label(items[1]));

  await XF.inbox.clear();
  check('XF.inbox.clear 消费后为空', (await api('/api/inbox')).status === 200 && (await (await api('/api/inbox')).json()).total === 0);
  // 持久化文件可重复读取
  inboxServer.inbox.drop('第二条持久化测试', 'test');
  server.close();
  const inboxServer2 = require('../tools/inbox-server.js');
  check('重启后数据仍在（持久化）', inboxServer2.inbox.count() === 1 && inboxServer2.inbox.list()[0].text === '第二条持久化测试');
  inboxServer2.inbox.clear();

  console.log('== 9. 投递箱主机自动判断（手机访问） ==');
  // Node 环境无 location → 默认 127.0.0.1（电脑 file:// 场景）
  check('无 location 时默认 127.0.0.1', XF.inbox.getHost() === '127.0.0.1', XF.inbox.getHost());
  // 模拟 http 页面访问（手机连 WiFi 打开 192.168.x.x）
  global.location = { protocol: 'http:', hostname: '192.168.0.102' };
  check('http 页面自动用当前主机名（手机访问连到电脑）', XF.inbox.getHost() === '192.168.0.102', XF.inbox.getHost());
  check('base() 拼出可访问地址', XF.inbox.base() === 'http://192.168.0.102:' + XF.inbox.getPort(), XF.inbox.base());
  // localhost 访问不特殊化
  global.location = { protocol: 'http:', hostname: 'localhost' };
  check('localhost 访问仍走 127.0.0.1', XF.inbox.getHost() === '127.0.0.1', XF.inbox.getHost());
  // 显式设置优先
  XF.inbox.setHost('10.0.0.5');
  check('显式设置的主机优先', XF.inbox.getHost() === '10.0.0.5', XF.inbox.getHost());
  check('getSavedHost 返回显式值', XF.inbox.getSavedHost() === '10.0.0.5');
  XF.inbox.setHost('');
  check('清空后恢复自动判断', XF.inbox.getHost() === '127.0.0.1' && XF.inbox.getSavedHost() === '');
  delete global.location;

  console.log('== 10. 公网投喂箱（公开收集箱，云数据库） ==');
  const pub = publicInbox.inbox;
  await pub.clear('whatever-check'); // 令牌不对 = no-op 拒绝，先确保起点干净
  // 正确令牌清场：让下面的计数断言不受历史数据影响（测试专用令牌）
  const startClean = await pub.clear('smoke-test-token');
  check('正确令牌可清场（测试起点归零）', startClean.ok && (await pub.count()) === 0, startClean.error || ('剩余 ' + (await pub.count())));
  // 正常投喂
  const d1 = await pub.drop('今天修好了三个 bug', 'public-web', 'ip-a');
  check('公网箱正常投喂', d1.ok && d1.total >= 1 && d1.item.text === '今天修好了三个 bug');
  check('公网箱列表最新在前', (await pub.list())[0].text === '今天修好了三个 bug');
  // 空内容
  check('空内容被拒绝', !(await pub.drop('   ', 'web', 'ip-a')).ok);
  // 超长
  const long = '啊'.repeat(publicInbox.MAX_LEN + 1);
  check('超过 500 字被拒绝', !(await pub.drop(long, 'web', 'ip-a')).ok);
  // 限流（同 IP 30 秒内第二条）
  const d2 = await pub.drop('紧接着再扔一条', 'web', 'ip-a');
  check('同 IP 30 秒内限流', !d2.ok && /频繁/.test(d2.error || ''), d2.error);
  // 不同 IP 不受影响
  check('不同 IP 不受限流影响', (await pub.drop('另一台设备的投喂', 'web', 'ip-b')).ok);
  // 错误令牌时清空被拒
  check('错误令牌时清空被拒', !(await pub.clear('')).ok && !(await pub.clear('guess')).ok);
  // FIFO 淘汰：先一次批量播种 MAX_ITEMS 条（bulk 插入只需一次云端往返），
  // 再连续投喂验证「封顶 + 最旧被淘汰 + 最新在墙上」
  const cloudClient = require('../deploy/public-inbox/cloud.js');
  async function seedBulk(n, tag) {
    const rows = [];
    for (let i = 1; i <= n; i++) rows.push({ text: tag + '-' + i, source: 'smoke-bulk' });
    const r = await cloudClient.database.from('inbox_items').insert(rows).select();
    if (!r.success) throw new Error(r.error ? r.error.message : 'bulk seed failed');
    return (r.data || []).length;
  }
  // 播种前再清一次场：墙上只剩这批 bulk，计数断言才确定
  const preSeed = await pub.clear('smoke-test-token');
  check('FIFO 前清场归零', preSeed.ok && (await pub.count()) === 0, preSeed.error || ('剩余 ' + (await pub.count())));
  await seedBulk(publicInbox.MAX_ITEMS, 'bulk');
  check('批量播种 ' + publicInbox.MAX_ITEMS + ' 条', (await pub.count()) === publicInbox.MAX_ITEMS, '实际 ' + (await pub.count()));
  const dEvict = await pub.drop('淘汰验证-最新', 'web', 'ip-evict');
  check('超量投喂后仍封顶 ' + publicInbox.MAX_ITEMS + ' 条', dEvict.ok && (await pub.count()) === publicInbox.MAX_ITEMS, '实际 ' + (await pub.count()));
  const wallNow = await pub.list();
  check('最旧的一条被淘汰', !wallNow.some(x => x.text === 'bulk-1') && wallNow.some(x => x.text === 'bulk-' + publicInbox.MAX_ITEMS), '现有 ' + wallNow.length + ' 条');
  check('最新投喂排在墙上第一条', wallNow[0].text === '淘汰验证-最新');
  // 再连续投喂几条，确认持续封顶且逐批淘汰最旧的（bulk 行）
  for (let i = 0; i < 5; i++) await pub.drop('连投-' + i, 'web', 'ip-evict-' + i);
  check('连续投喂后依然封顶', (await pub.count()) === publicInbox.MAX_ITEMS, '实际 ' + (await pub.count()));
  const wallNow2 = await pub.list();
  check('最旧的 bulk 行逐批被淘汰', !wallNow2.some(x => x.text === 'bulk-1') && !wallNow2.some(x => x.text === 'bulk-6') && wallNow2.some(x => x.text === 'bulk-7'));
  check('连投批次全部在墙上', ['连投-0', '连投-1', '连投-2', '连投-3', '连投-4'].every(t => wallNow2.some(x => x.text === t)), '缺少连投条目');
  check('最新一条排在最前', wallNow2[0].text === '连投-4', wallNow2[0] && wallNow2[0].text);
  await pub.clear('x'); await pub.clear('x'); // 令牌不对，拒绝即可，数据保持
  // HTTP 层：真实起服务
  const pubServer = publicInbox.start(0);
  await new Promise(r => pubServer.once('listening', r));
  const pubPort = pubServer.address().port;
  const pubApi = async (path, opts) => {
    const r = await fetch('http://127.0.0.1:' + pubPort + path, opts);
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* 非 JSON（如 HTML） */ }
    return { status: r.status, json, text };
  };
  let pr = await pubApi('/');
  check('公网箱首页可访问', pr.status === 200 && pr.text.includes('给小流投喂') && pr.text.includes('公开'));
  pr = await pubApi('/api/inbox');
  check('公网箱 /api/inbox 返回列表', pr.status === 200 && pr.json.ok && Array.isArray(pr.json.items));
  pr = await pubApi('/api/drop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'HTTP 投喂测试', source: 'test' }) });
  check('公网箱 /api/drop 投喂成功', pr.status === 200 && pr.json.ok);
  pr = await pubApi('/api/drop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '' }) });
  check('公网箱空内容 HTTP 429', pr.status === 429 && !pr.json.ok);
  pr = await pubApi('/api/clear', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
  check('公网箱无令牌清空 HTTP 403', pr.status === 403 && !pr.json.ok);
  pr = await pubApi('/nope');
  check('未知路径 404', pr.status === 404);

  console.log('== 11. 投喂墙点赞（云数据库） ==');
  const dLike = await pub.drop('点赞功能冒烟', 'liketest', 'ip-like');
  check('点赞载体投喂成功', dLike.ok, dLike.error);
  if (dLike.ok) {
    const itemId = dLike.item.id;
    const visitor = 'smoke-visitor';
    const lk1 = await pub.toggleLike(itemId, visitor, 'ip-like-1');
    check('点赞后 liked=true 且计数为 1', lk1.ok && lk1.liked === true && lk1.count === 1, JSON.stringify(lk1));
    const lk2 = await pub.toggleLike(itemId, visitor, 'ip-like-2');
    check('同一访客再点一次取消点赞', lk2.ok && lk2.liked === false && lk2.count === 0, JSON.stringify(lk2));
    const lk3 = await pub.toggleLike(itemId, 'smoke-visitor-2', 'ip-like-3');
    check('另一访客点赞计数为 1', lk3.ok && lk3.liked === true && lk3.count === 1, JSON.stringify(lk3));
    check('无效 id 被拒绝', !(await pub.toggleLike(-1, visitor, 'ip-like-4')).ok);
    check('空访客被拒绝', !(await pub.toggleLike(itemId, '', 'ip-like-5')).ok);
    const meta1 = await pub.likesMeta(visitor);
    check('likesMeta：我的点赞已取消即为空', meta1.my.length === 0, JSON.stringify(meta1.my));
    const meta2 = await pub.likesMeta('smoke-visitor-2');
    check('likesMeta：返回另一访客的点赞', meta2.my.length === 1 && meta2.my[0] === itemId, JSON.stringify(meta2.my));
    check('likesMeta：返回各条点赞计数', meta2.counts[itemId] === 1, JSON.stringify(meta2.counts));
    // 同 IP 连续两次点赞：第二次应被限流（节流窗口 1 秒）。
    // 注意第一个调用不被限流、会真实点赞（race-visitor），所以放在计数断言之后测，
    // 它对计数的影响在后面 HTTP 断言的期望值里体现。
    const race = pub.toggleLike(itemId, 'race-visitor', 'ip-race'); // 先置节流时间戳（同步）
    const raced = await pub.toggleLike(itemId, 'race-visitor', 'ip-race');
    await race;
    check('同 IP 1 秒内连续点赞被限流', !raced.ok && raced.code === 'ratelimit', JSON.stringify(raced));
    // HTTP 层点赞（race-visitor 已点上，计数从 1 变 2，再算 http-visitor 这条 → 3）
    pr = await pubApi('/api/like', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: itemId, visitor: 'http-visitor' }) });
    check('HTTP 点赞成功', pr.status === 200 && pr.json.ok && pr.json.liked === true && pr.json.count === 3, JSON.stringify(pr.json));
    pr = await pubApi('/api/like', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'abc', visitor: 'http-visitor' }) });
    check('HTTP 无效 id 返回 400', pr.status === 400 && !pr.json.ok);
  }
  pubServer.close();
  // 云端测试数据清理：正确令牌清空（服务器 CLEAR_TOKEN 与数据库 clear_token 须为同一值）
  const cleaned = await pub.clear('smoke-test-token');
  check('测试后云端数据已清空', cleaned.ok && (await pub.count()) === 0, cleaned.error || ('剩余 ' + (await pub.count()) + ' 条'));
  // 页面渲染不含未转义的用户输入（防 XSS）：列表里 <script> 必须被转义
  const pageHtml = publicInbox.page();
  check('投喂墙页面含转义函数', pageHtml.includes('&lt;') || pageHtml.includes('esc('));
  check('投喂墙页面含搜索 / 排序 / 点赞等新功能', pageHtml.includes('id="q"') && pageHtml.includes('sortNew') && pageHtml.includes('api/like'), '功能标识缺失');

  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试崩溃:', e); process.exit(1); });
