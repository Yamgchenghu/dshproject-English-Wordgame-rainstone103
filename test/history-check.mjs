/**
 * 历史关自检：上传新关顶替现役 -> 旧关进历史 -> 复习一遍 -> 确认不写进度、不发整关奖励。
 */
const BASE = 'http://127.0.0.1:8787';
const H = { 'Content-Type': 'application/json', 'X-Player-Id': 'hist-check-' + Date.now() };

let bad = 0;
const ok = (l, c, e = '') => { if (c) console.log('  OK   ' + l + (e ? '  ' + e : '')); else { bad++; console.log('  FAIL ' + l + '  ' + e); } };
const j = async (p, o = {}) => {
  const r = await fetch(BASE + p, {
    method: o.method || 'GET',
    headers: { ...H, ...(o.headers || {}) },
    body: o.body ? JSON.stringify(o.body) : undefined,
  });
  const ct = r.headers.get('content-type') || '';
  const b = ct.includes('json') ? await r.json().catch(() => null) : await r.text();
  return { status: r.status, body: b, headers: r.headers };
};

console.log('\n[1] 准备：上传新关，把旧关顶进历史');
const ctx = {};
{
  const before = await j('/api/wordgame/info');
  const histBefore = (await j('/api/wordgame/history')).body.levels.length;
  const oldNum = before.body.level.num;
  ctx.oldNum = oldNum;
  console.log('  现役关:', oldNum, '词数:', before.body.level.total, '| 已有历史关:', histBefore);

  const up = await j('/api/wordgame/upload', {
    method: 'POST',
    body: { text: 'alpha\t甲\nbeta\t乙\ngamma\t丙', fillChinese: false },
  });
  ok('上传新关 200', up.status === 200, JSON.stringify(up.body).slice(0, 100));
  const newNum = up.body.num;
  ok('新关号 = 旧关号 + 1', newNum === oldNum + 1, `${oldNum} -> ${newNum}`);

  const after = await j('/api/wordgame/info');
  ok('现役关已切换', after.body.level.num === newNum, 'now=' + after.body.level.num);

  const hist = await j('/api/wordgame/history');
  // 相对断言：不管之前已经有多少历史关，本次上传只应该让它 +1
  ok('历史关条数 +1', hist.body.count === histBefore + 1, `${histBefore} -> ${hist.body.count}`);
  const hit = hist.body.levels.find((x) => x.num === oldNum);
  ok('历史关里能找到旧关', !!hit, 'num=' + oldNum);
  ok('历史关词数正确', hit && hit.count === before.body.level.total);
  ok('历史关标注 saved=false', hit && hit.saved === false);
  ok('info.capabilities.history 反映条数', after.body.capabilities.history === hist.body.count,
    `caps=${after.body.capabilities.history} list=${hist.body.count}`);
}

console.log('\n[2] 复习历史关：应拿到全部题、不跳过、不带存档语义');
{
  const num = ctx.oldNum;
  const hist = await j('/api/wordgame/history');
  const total = hist.body.levels.find((x) => x.num === num).count;

  const lv = await j(`/api/wordgame/level?mode=history&num=${num}`);
  ok('历史关开考 200', lv.status === 200);
  ok('mode=history', lv.body.mode === 'history', 'mode=' + lv.body.mode);
  ok('saved=false', lv.body.saved === false);
  ok('completedUnits=0（不沿用进度）', lv.body.completedUnits === 0, 'completed=' + lv.body.completedUnits);

  const items = lv.body.groups.flatMap((g) => g.items);
  ok('全部题都参与（不跳过）', items.length === total, `${items.length}/${total}`);
  ok('历史关不借题', items.every((x) => x.borrowed === false));
  ok('历史关卷面不含 en', items.every((x) => x.en === undefined));

  // 学习模式可以带 en
  const st = await j(`/api/wordgame/level?mode=history&num=${num}&study=1`);
  const stItems = st.body.groups.flatMap((g) => g.items);
  ok('历史关学习模式带 en', stItems.every((x) => !!x.en));
  ok('历史关学习模式带 studyPos', stItems.every((x) => Number.isFinite(x.studyPos)));

  const bad1 = await j(`/api/wordgame/level?mode=history&num=999999`);
  ok('不存在的历史关 -> 404', bad1.status === 404, 'status=' + bad1.status);
}

console.log('\n[3] 历史关作答与结算：绝不写进度、不发整关奖励');
{
  const num = ctx.oldNum;

  // 记录复习前的进度
  const infoBefore = await j('/api/wordgame/info');
  const doneBefore = infoBefore.body.level.completedCount;

  const table = await j(`/api/wordgame/words?mode=history&num=${num}`);
  ok('历史关整表可取', table.status === 200 && table.body.mode === 'history', 'mode=' + (table.body || {}).mode);
  const enOf = new Map(table.body.items.map((x) => [x.wid, x.en]));

  const s = await j(`/api/wordgame/level?mode=history&num=${num}`);
  const items = s.body.groups.flatMap((g) => g.items);
  for (const it of items) {
    await j('/api/wordgame/answer', {
      method: 'POST',
      body: { sessionId: s.body.sessionId, wid: it.wid, attempt: 1, input: enOf.get(it.wid) },
    });
  }

  const g = await j('/api/wordgame/group/finish', {
    method: 'POST', body: { sessionId: s.body.sessionId, groupIndex: 0 },
  });
  ok('历史关组结算达标', g.body.passed === true, g.body.score + '/' + g.body.fullMark);
  ok('组结算 saved=false', g.body.saved === false);

  const lv = await j('/api/wordgame/level/finish', { method: 'POST', body: { sessionId: s.body.sessionId } });
  ok('整关结算 saved=false', lv.body.saved === false);
  ok('历史关不发整关奖励', lv.body.bigReward === 0, 'bigReward=' + lv.body.bigReward);
  ok('历史关 allCompleted 恒为 false', lv.body.allCompleted === false);
  ok('历史关带 note 说明', typeof lv.body.note === 'string' && lv.body.note.length > 0, lv.body.note);
  ok('历史关仍统计本次完成数', lv.body.completedUnits === items.length, `${lv.body.completedUnits}/${items.length}`);

  // 关键：现役关的进度不能被历史关污染
  const infoAfter = await j('/api/wordgame/info');
  ok('现役关进度未被改动', infoAfter.body.level.completedCount === doneBefore,
    `before=${doneBefore} after=${infoAfter.body.level.completedCount}`);
}

console.log('\n[4] 课文历史关（同一套逻辑）');
{
  const histBefore = (await j('/api/wordgame/text/history')).body.levels.length;
  const curNum = (await j('/api/wordgame/text/info')).body.level.num;
  ctx.oldTextNum = curNum;

  const up = await j('/api/wordgame/text/upload', {
    method: 'POST',
    body: { text: 'A new sentence here.\t这里有一句新的。' },
  });
  ok('上传课文新关 200', up.status === 200, JSON.stringify(up.body).slice(0, 80));

  const hist = await j('/api/wordgame/text/history');
  ok('课文历史关条数 +1', hist.body.count === histBefore + 1, `${histBefore} -> ${hist.body.count}`);
  ok('课文历史关里有旧关', hist.body.levels.some((x) => x.num === curNum), 'num=' + curNum);

  const num = curNum;
  const lv = await j(`/api/wordgame/text/level?mode=history&num=${num}`);
  ok('课文历史关 200', lv.status === 200);
  ok('课文历史关 mode', lv.body.mode === 'history');
  ok('课文历史关 saved=false', lv.body.saved === false);
  ok('课文历史关有 sid', !!(lv.body.groups[0].items[0] || {}).sid);
}

console.log('\n[5] 手机端');
{
  const dev = await j('/api/wordgame/m/device', {
    method: 'POST', body: { deviceId: 'hist-phone', platform: 'android' },
  });
  const DT = { 'X-Device-Token': dev.body.token };

  const cat = await j('/api/wordgame/m/catalog', { headers: DT });
  ok('catalog 有 history 字段', !!cat.body.history);
  const hit = (cat.body.history.sanj || []).find((x) => x.num === ctx.oldNum);
  ok('catalog.history.sanj 含旧关', !!hit, 'n=' + (cat.body.history.sanj || []).length);
  ok('caps.history = true', cat.body.caps.history === true);

  const num = ctx.oldNum;
  const hl = await j(`/api/wordgame/m/level?scope=history&num=${num}`, { headers: DT });
  ok('App 能拉历史关', hl.status === 200 && hl.body.scope === 'history', 'scope=' + (hl.body || {}).scope);
  ok('App 拉历史关 saved=false', hl.body.saved === false);
  ok('App 拉历史关有词条', hl.body.words.length === hit.count);

  const txt = await fetch(`${BASE}/api/wordgame/m/level?scope=history&num=${num}&format=txt`, { headers: { ...H, ...DT } });
  ok('App 历史关 format=txt', txt.status === 200);
  ok('txt 头 X-WG-Saved=0', txt.headers.get('x-wg-saved') === '0');

  const ex = await j('/api/wordgame/m/export', { headers: DT });
  ok('export 含历史关', Array.isArray(ex.body.history.sanj)
    && ex.body.history.sanj.some((x) => x.num === ctx.oldNum));

  const bad = await j('/api/wordgame/m/level?scope=history&num=999999', { headers: DT });
  ok('不存在的历史关 -> 404', bad.status === 404, 'status=' + bad.status);
}

console.log('\n==========================================');
console.log(bad === 0 ? '  历史关全部通过' : `  失败 ${bad} 项`);
console.log('==========================================');
process.exit(bad ? 1 : 0);
