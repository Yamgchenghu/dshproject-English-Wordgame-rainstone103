/**
 * 私服自检：跑完三玖关与三玖课文关的完整流程 + 手机端接口 + 密钥槽位。
 * 用法：node test/selfcheck.mjs [baseUrl]
 */
const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const H = { 'Content-Type': 'application/json', 'X-Player-Id': 'selfcheck-' + Date.now() };

let bad = 0;
const ok = (label, cond, extra = '') => {
  if (cond) console.log('  OK   ' + label + (extra ? '  ' + extra : ''));
  else { bad++; console.log('  FAIL ' + label + '  ' + extra); }
};
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

/* ============================ 密钥槽位 ============================ */
console.log('\n[1] 预留密钥槽位');
{
  const r = await j('/api/keys/status');
  ok('keys/status 200', r.status === 200);
  const need = ['qwen', 'mimo', 'deepseek', 'gpt', 'grok', 'gemini', 'genimi', 'doubao', 'qwentokenplan', 'mimotokenplan'];
  for (const n of need) {
    ok('槽位存在 ' + n + '.api.key', !!(r.body && r.body.keys && r.body.keys[n + '.api.key']));
  }
  const raw = JSON.stringify(r.body);
  ok('响应里不含任何 key 明文', !/sk-[A-Za-z0-9]{10,}/.test(raw));
  ok('未配置时 configured=false', need.every((n) => r.body.keys[n + '.api.key'].configured === false));
}

/* ============================ 三玖关 ============================ */
console.log('\n[2] 三玖关完整流程');
const wpaths = (() => {
  const info = null; void info;
  return null;
})();
void wpaths;
{
  const info = await j('/api/wordgame/info');
  ok('info 200', info.status === 200);
  ok('有现役关卡', !!info.body.level, 'num=' + (info.body.level || {}).num);
  const total = info.body.level.total;

  // 学习卷面必须带 en + studyPos
  const st = await j('/api/wordgame/level?study=1');
  ok('level(study) 200', st.status === 200);
  const stItems = st.body.groups.flatMap((g) => g.items);
  ok('study 带 en', stItems.every((x) => typeof x.en === 'string' && x.en));
  ok('study 带 studyPos', stItems.every((x) => Number.isFinite(x.studyPos)));
  // 学习顺序 ≠ 考试顺序（同一次响应内比较）
  const sorted = stItems.map((x, i) => ({ i, p: x.studyPos })).sort((a, b) => a.p - b.p).map((x) => x.i);
  ok('学习顺序 ≠ 卷面顺序', sorted.join(',') !== stItems.map((_, i) => i).join(','), sorted.join(','));

  // 考试卷面绝不能有 en
  const ex = await j('/api/wordgame/level');
  const exItems = ex.body.groups.flatMap((g) => g.items);
  ok('exam 不含 en（防作弊）', exItems.every((x) => x.en === undefined));
  ok('exam 不含 studyPos', exItems.every((x) => x.studyPos === undefined));

  // 取答案表，逐题作答
  const table = await j('/api/wordgame/words');
  const enOf = new Map(table.body.items.map((x) => [x.wid, x.en]));

  // 清进度，保证从头
  await j('/api/wordgame/reset', { method: 'POST', body: {} });
  const s2 = await j('/api/wordgame/level');
  const items2 = s2.body.groups.flatMap((g) => g.items);
  const sid = s2.body.sessionId;

  let totalScore = 0;
  for (const it of items2) {
    const r = await j('/api/wordgame/answer', {
      method: 'POST',
      body: { sessionId: sid, wid: it.wid, attempt: 1, input: enOf.get(it.wid) },
    });
    totalScore += r.body.earnedScore || 0;
  }
  ok('全部答对满分', totalScore === items2.length * 10, 'score=' + totalScore + '/' + items2.length * 10);

  const g = await j('/api/wordgame/group/finish', { method: 'POST', body: { sessionId: sid, groupIndex: 0 } });
  ok('组结算 200', g.status === 200);
  ok('组结算满分', g.body.score === g.body.fullMark, g.body.score + '/' + g.body.fullMark);
  ok('组结算达标', g.body.passed === true);

  const lv = await j('/api/wordgame/level/finish', { method: 'POST', body: { sessionId: sid } });
  ok('整关结算 200', lv.status === 200);
  ok('整关奖励 = 词数×0.1', Math.abs(lv.body.bigReward - Math.round(lv.body.totalUnits * 0.1 * 100) / 100) < 1e-9,
    'bigReward=' + lv.body.bigReward);

  // 答错 -> 提示 -> 再错 -> 亮答案
  const s3 = await j('/api/wordgame/level');
  const it3 = s3.body.groups.flatMap((x) => x.items)[0];
  const w1 = await j('/api/wordgame/answer', {
    method: 'POST', body: { sessionId: s3.body.sessionId, wid: it3.wid, attempt: 1, input: 'zzz' },
  });
  ok('第 1 次错给提示', w1.body.correct === false && typeof w1.body.hint === 'string' && w1.body.hint.length > 0, 'hint=' + w1.body.hint);
  const w2 = await j('/api/wordgame/answer', {
    method: 'POST', body: { sessionId: s3.body.sessionId, wid: it3.wid, attempt: 2, input: 'zzz' },
  });
  ok('第 2 次错亮答案', w2.body.correct === false && !!w2.body.reveal, 'reveal=' + (w2.body.reveal || {}).en);
  ok('两次都错得 0 分', w2.body.earnedScore === 0);

  const rq = await j('/api/wordgame/requiz', { method: 'POST', body: { sessionId: s3.body.sessionId } });
  ok('补考返回 1 题', rq.body.count === 1, 'count=' + rq.body.count);

  ok('关卡题数一致', total === info.body.level.total);
}

/* ========================= 三玖课文关 ========================= */
console.log('\n[3] 三玖课文关完整流程');
{
  const info = await j('/api/wordgame/text/info');
  ok('text info 200', info.status === 200);
  ok('有现役课文', !!info.body.level, 'num=' + (info.body.level || {}).num);
  ok('大关单价 0.5', info.body.rules.bigRewardPerUnit === 0.5);

  const st = await j('/api/wordgame/text/level?study=1');
  const stItems = st.body.groups.flatMap((g) => g.items);
  ok('课文 study 带 en', stItems.every((x) => !!x.en));

  const table = await j('/api/wordgame/text/sentences');
  const enOf = new Map(table.body.items.map((x) => [x.sid, x.en]));

  await j('/api/wordgame/text/reset', { method: 'POST', body: {} });
  const s2 = await j('/api/wordgame/text/level');
  const items2 = s2.body.groups.flatMap((g) => g.items);
  ok('课文 exam 不含 en', items2.every((x) => x.en === undefined));

  let score = 0;
  for (const it of items2) {
    const r = await j('/api/wordgame/text/answer', {
      method: 'POST',
      body: { sessionId: s2.body.sessionId, sid: it.sid, attempt: 1, input: enOf.get(it.sid) },
    });
    score += r.body.earnedScore || 0;
  }
  ok('课文全对满分', score === items2.length * 10, score + '/' + items2.length * 10);

  const g = await j('/api/wordgame/text/group/finish', { method: 'POST', body: { sessionId: s2.body.sessionId, groupIndex: 0 } });
  ok('课文组结算达标', g.body.passed === true, g.body.score + '/' + g.body.fullMark);
  ok('课文组结算字段名是 Sentences', Array.isArray(g.body.firstTrySentences));

  const lv = await j('/api/wordgame/text/level/finish', { method: 'POST', body: { sessionId: s2.body.sessionId } });
  ok('课文整篇奖励 = 句数×0.5', Math.abs(lv.body.bigReward - Math.round(lv.body.totalUnits * 0.5 * 100) / 100) < 1e-9,
    'bigReward=' + lv.body.bigReward);

  // 课文不拆斜杠：输入 and 不应命中 and/or
  const s3 = await j('/api/wordgame/text/level');
  const it3 = s3.body.groups.flatMap((x) => x.items)[0];
  const r = await j('/api/wordgame/text/answer', {
    method: 'POST', body: { sessionId: s3.body.sessionId, sid: it3.sid, attempt: 1, input: 'and' },
  });
  ok('课文不把 and 判成 and/or', r.body.correct === false);
}

/* ============================ 手机端 ============================ */
console.log('\n[4] 手机端接口');
{
  const dev = await j('/api/wordgame/m/device', {
    method: 'POST', body: { deviceId: 'selfcheck-phone', platform: 'android', appVersion: '1.0.0' },
  });
  ok('领令牌 200', dev.status === 200 && !!dev.body.token);
  const DT = { 'X-Device-Token': dev.body.token };

  const noId = await fetch(BASE + '/api/wordgame/m/catalog');
  ok('无身份 -> 401', noId.status === 401, 'status=' + noId.status);
  const badTok = await fetch(BASE + '/api/wordgame/m/catalog', { headers: { 'X-Device-Token': 'abc.def' } });
  ok('伪造令牌 -> 401', badTok.status === 401, 'status=' + badTok.status);

  const cat = await j('/api/wordgame/m/catalog', { headers: DT });
  ok('catalog 200', cat.status === 200);
  ok('catalog 有三玖关', !!cat.body.sanj);
  ok('catalog 有课文', !!cat.body.text);

  const wl = await j('/api/wordgame/m/level', { headers: DT });
  ok('单词 level 200', wl.status === 200);
  ok('单词 level 有 wid + en + zh', !!wl.body.words[0].wid && !!wl.body.words[0].en && 'zh' in wl.body.words[0]);
  const same = await j('/api/wordgame/m/level?hash=' + wl.body.hash, { headers: DT });
  ok('hash 命中返回 unchanged', same.body.unchanged === true);

  const txt = await fetch(BASE + '/api/wordgame/m/level?format=txt', { headers: { ...H, ...DT } });
  const txtBody = await txt.text();
  ok('format=txt 200', txt.status === 200);
  ok('txt 行数 = 条目数', txtBody.trim().split('\n').length === wl.body.count, 'lines=' + txtBody.trim().split('\n').length);
  ok('txt 是 TAB 分隔', txtBody.split('\n')[0].includes('\t'));
  ok('X-WG-Count 头', txt.headers.get('x-wg-count') === String(wl.body.count));

  const tl = await j('/api/wordgame/text/m/level', { headers: DT });
  ok('课文 level 200', tl.status === 200);
  ok('课文 level 有 sid', !!tl.body.sentences[0].sid);

  const ex = await j('/api/wordgame/m/export', { headers: DT });
  ok('export 200', ex.status === 200);
  ok('export 含三玖关与课文', !!ex.body.sanj && !!ex.body.text);

  // CORS 预检
  const pre = await fetch(BASE + '/api/wordgame/m/catalog', { method: 'OPTIONS' });
  ok('OPTIONS 204', pre.status === 204, 'status=' + pre.status);
  ok('CORS allow-origin *', pre.headers.get('access-control-allow-origin') === '*');
  ok('CORS 允许 X-Device-Token', (pre.headers.get('access-control-allow-headers') || '').includes('X-Device-Token'));
  ok('CORS 允许 X-Player-Id', (pre.headers.get('access-control-allow-headers') || '').includes('X-Player-Id'));

  // 语音未配 key -> 503 且 code 明确
  const tts = await j('/api/wordgame/tts?text=hello&provider=qwen');
  ok('未配语音 key -> 503 <no-api-key>', tts.status === 503 && tts.body.code === '<no-api-key>', 'status=' + tts.status + ' code=' + (tts.body || {}).code);
}

/* ============================ 上传 ============================ */
console.log('\n[5] 上传（本机免口令）');
{
  const r = await j('/api/wordgame/text/upload', {
    method: 'POST',
    body: {
      num: 900001,
      text: 'The morning train was late again. I walked to the office.\n早班火车又晚点了。我走路去了办公室。',
    },
  });
  ok('上传 200', r.status === 200, JSON.stringify(r.body).slice(0, 120));
  ok('整段散文切成 2 句', r.body.total === 2, 'total=' + r.body.total);
  ok('自动配对译文', (r.body.preview[0].zh || '').includes('早班火车'), JSON.stringify(r.body.preview[0]));

  const back = await j('/api/wordgame/text/sentences');
  ok('回读到第 2 句译文', (back.body.items[1] || {}).zh === '我走路去了办公室。', JSON.stringify((back.body.items[1] || {}).zh));

  const bad = await j('/api/wordgame/text/upload', { method: 'POST', body: { text: '   ' } });
  ok('空内容 -> 400', bad.status === 400, 'status=' + bad.status);
}

console.log('\n==========================================');
console.log(bad === 0 ? '  全部通过' : `  失败 ${bad} 项`);
console.log('==========================================');
process.exit(bad ? 1 : 0);
