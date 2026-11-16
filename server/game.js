/**
 * 三玖关（词）与三玖课文关（句）—— 两者共用一套答题内核。
 * ==================================================================
 * 差别只有四个：数据目录、题目单位（词/句）、id 字段名（wid/sid）、
 * 判对是否拆并列写法、大关奖励单价。所以这里用一个 registerGame(kind) 生成两套路由，
 * 而不是抄两份几乎一样的代码 —— 两份必然各自漂移。
 *
 * 公开接口（手机 App 也直连这套）：
 *   GET  /api/wordgame/info
 *   GET  /api/wordgame/level?study=1
 *   POST /api/wordgame/answer
 *   POST /api/wordgame/group/finish
 *   POST /api/wordgame/level/finish
 *   POST /api/wordgame/requiz
 *   POST /api/wordgame/reset
 *   GET  /api/wordgame/words          整关对照表
 *   POST /api/wordgame/upload         管理接口：替换现役关
 * 课文版把 /api/wordgame 换成 /api/wordgame/text（见 PREFIX）。
 */
import crypto from 'node:crypto';
import {
  Router, HttpError, badRequest, forbidden, notFound, sendJson, readJson, jsonBody, parseMultipart,
  isLocalIp, tooMany, Buckets,
} from './http.js';
import * as S from './store.js';
import {
  computeGroup, computeBigReward, isCorrect, isCorrectAny, makeHint, round2, RULES, norm,
} from './scoring.js';
import { available as ttsAvailable } from './tts.js';
import { translateWords, anyAvailable as llmAny } from './llm.js';
import { adminToken } from './config.js';

const GROUP_SIZE = 10;
const SESSION_TTL = 30 * 60 * 1000;
const MAX_SESSIONS = 500;

const sessions = new Map();
const buckets = new Buckets();

function sweep() {
  const now = Date.now();
  for (const [id, s] of sessions) if (now - s.at > SESSION_TTL) sessions.delete(id);
  while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
}

function newSession(data) {
  sweep();
  const id = 's_' + crypto.randomBytes(8).toString('base64url');
  sessions.set(id, { ...data, at: Date.now() });
  return id;
}

function getSession(id) {
  const s = sessions.get(String(id || ''));
  if (!s) throw notFound('<no-session>', '会话不存在或已过期，请重新进入这一关');
  if (Date.now() - s.at > SESSION_TTL) {
    sessions.delete(String(id));
    throw notFound('<no-session>', '会话已过期，请重新进入这一关');
  }
  s.at = Date.now();
  return s;
}

function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * 学习顺序位次：整组重洗，只在洗出原顺序时重来（≤20 次），兜底交换前两个。
 * 用户明确要求"学习顺序不能和考试顺序一样" —— 那会让"先学一遍"变成直接给答案。
 */
function studyRanks(n) {
  const identity = Array.from({ length: n }, (_, i) => i);
  if (n < 2) return identity;
  let order = identity;
  for (let t = 0; t < 20; t++) {
    order = shuffled(identity);
    if (order.some((v, i) => v !== i)) break;
  }
  if (!order.some((v, i) => v !== i)) { order = identity.slice(); order[0] = 1; order[1] = 0; }
  const rank = new Array(n);
  for (let k = 0; k < n; k++) rank[order[k]] = k;
  return rank;
}

/** 玩家标识：客户端自己生成并本地保存（网页放 localStorage，App 放偏好设置） */
function playerId(ctx) {
  const raw = String(ctx.req.headers['x-player-id'] || ctx.query.get('pid') || '').trim();
  if (!raw) return '';
  return raw.slice(0, 64).replace(/[^\w.:\-]/g, '');
}

/** 管理员校验：配了 ADMIN_TOKEN 就必须带对；没配则只允许本机 */
function requireAdmin(ctx) {
  const want = adminToken();
  if (want) {
    const got = String(ctx.req.headers['x-admin-token'] || '').trim();
    if (got && got.length === want.length) {
      try {
        if (crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want))) return;
      } catch { /* 长度不同直接落下去 */ }
    }
    throw forbidden('<forbidden>', '需要管理员口令（请求头 X-Admin-Token）');
  }
  if (isLocalIp(ctx.ip)) return;
  throw forbidden('<forbidden>', '未设置 ADMIN_TOKEN 时只允许本机（127.0.0.1）上传。请设置环境变量 ADMIN_TOKEN 后重启。');
}

/**
 * 生成一套路由。
 * kind = 'word' | 'text'
 */
export function registerGame(router, kind) {
  const isText = kind === 'text';
  const PREFIX = isText ? '/api/wordgame/text' : '/api/wordgame';
  const ID = isText ? 'sid' : 'wid';
  const UNIT = isText ? '句' : '词';
  const BIG_PER = isText ? RULES.BIG_REWARD_PER_SENTENCE : RULES.BIG_REWARD_PER_WORD;

  /** 判对：词允许 `a/b` 并列；课文不拆（散文里的 and/or 是字面写法） */
  const judge = (input, answer) => (isText ? isCorrect(input, answer) : isCorrectAny(input, answer));

  function currentLevel() {
    const lv = S.loadCurrent(kind);
    if (!lv) throw notFound('<no-level>', `还没有${isText ? '课文' : '关卡'}。管理员用 POST ${PREFIX}/upload 上传一份。`);
    return lv;
  }

  function mkItems(lv, doneIds) {
    const done = new Set(doneIds || []);
    const pending = shuffled(lv.items.filter((w) => !done.has(S.idOf(w.en))));
    const completed = lv.items.filter((w) => done.has(S.idOf(w.en)));
    const groups = [];
    const pool = pending.slice();
    while (pool.length > 0) {
      const chunk = pool.splice(0, GROUP_SIZE).map((w) => ({ ...w, borrowed: false }));
      // 不足一组时用已完成的题随机借满 —— 与线上版同一套借题规则
      if (chunk.length < GROUP_SIZE && completed.length > 0) {
        for (const w of shuffled(completed).slice(0, GROUP_SIZE - chunk.length)) {
          chunk.push({ ...w, borrowed: true });
        }
      }
      groups.push(chunk);
    }
    return groups;
  }

  function groupPayload(items, index, withEn) {
    const rank = withEn ? studyRanks(items.length) : null;
    return {
      index,
      items: items.map((w, i) => {
        const base = {
          [ID]: S.idOf(w.en),
          zh: w.zh || '',
          wordCount: isText
            ? String(w.en).trim().split(/\s+/).filter(Boolean).length
            : String(w.en).trim().split(/\s+/).filter(Boolean).length,
          charCount: String(w.en).replace(/\s+/g, '').length,
          borrowed: !!w.borrowed,
        };
        // 学习模式才下发答案；不带 study 时**绝不能**出现 en（防作弊）
        if (withEn) {
          base.en = w.en;
          base.studyPos = rank[i];
        }
        return base;
      }),
    };
  }

  /* ------------------------------ info ------------------------------ */
  router.get(PREFIX + '/info', (ctx) => {
    const pid = playerId(ctx);
    const done = S.loadPlayer(pid).done;
    let lv = null;
    try { lv = S.loadCurrent(kind); } catch { lv = null; }
    const total = lv ? lv.items.length : 0;
    const doneCount = lv ? lv.items.filter((w) => done.includes(S.idOf(w.en))).length : 0;
    sendJson(ctx.res, 200, {
      ok: true,
      player: pid || null,
      level: lv
        ? {
          num: lv.num, name: lv.name, total, completedCount: doneCount,
          groups: Math.ceil(total / GROUP_SIZE), groupSize: GROUP_SIZE,
          updatedAt: new Date(lv.mtime).toISOString(),
        }
        : null,
      // 前端据此决定要不要显示朗读按钮 / 上传时是否补中文
      capabilities: {
        tts: ttsAvailable(),
        llm: { available: llmAny() },
        upload: true,
      },
      rules: {
        groupSize: GROUP_SIZE, passRatio: RULES.PASS_RATIO,
        bigRewardPerUnit: BIG_PER, unit: UNIT,
      },
    });
  });

  /* ------------------------------ 开始 ------------------------------ */
  router.get(PREFIX + '/level', (ctx) => {
    const study = ctx.query.get('study') === '1' || ctx.query.get('study') === 'true';
    const pid = playerId(ctx);
    const player = S.loadPlayer(pid);
    const lv = currentLevel();

    // 换了关就清空这份进度（与线上版一致：换关后从头开始）
    let done = player.done;
    if (player.num !== lv.num) {
      done = [];
      if (pid) S.savePlayer(pid, { done: [], num: lv.num });
    }

    const groups = mkItems(lv, done);
    if (!groups.length) {
      // 全部做完了：仍然给一整组（全部按 borrowed 处理），让用户能重刷而不卡死
      const all = shuffled(lv.items).slice(0, GROUP_SIZE).map((w) => ({ ...w, borrowed: true }));
      groups.push(all);
    }

    const sessionId = newSession({
      kind, num: lv.num, pid,
      items: groups.flatMap((g, gi) => g.map((w) => ({ ...w, gi }))),
      answers: new Map(),
      wrong: new Map(),
      study,
    });

    sendJson(ctx.res, 200, {
      ok: true,
      sessionId,
      mode: 'sanj',
      levelNum: lv.num,
      levelName: lv.name,
      totalUnits: lv.items.length,
      completedUnits: done.length,
      groupSize: GROUP_SIZE,
      groups: groups.map((g, i) => groupPayload(g, i, study)),
    });
  });

  /* ------------------------------ 作答 ------------------------------ */
  router.post(PREFIX + '/answer', jsonBody, (ctx) => {
    const s = getSession((ctx.body || {}).sessionId);
    const id = String((ctx.body || {})[ID] || '');
    const attempt = Number((ctx.body || {}).attempt) || 1;
    const input = String((ctx.body || {}).input || '');
    if (attempt !== 1 && attempt !== 2) throw badRequest('<bad-attempt>', 'attempt 只能是 1 或 2');

    const item = s.items.find((w) => S.idOf(w.en) === id);
    if (!item) throw badRequest('<no-item>', '这一' + UNIT + '不在本会话里');

    const ok = judge(input, item.en);
    const prev = s.answers.get(id) || 0;

    if (ok) {
      const at = attempt === 1 ? 1 : 2;
      // 只记"第一次成功"的那次，第二次才对不能倒改成第一次对
      if (!prev || at < prev) s.answers.set(id, at);
      const earnedScore = attempt === 1 ? RULES.FIRST : (item.borrowed ? RULES.BORROWED_SECOND : RULES.SECOND);
      const completedNow = attempt === 1 && !item.borrowed;
      sendJson(ctx.res, 200, { ok: true, correct: true, attempt, earnedScore, completedNow });
      return;
    }

    // 答错：连续两次错就记满，供"错超过一次"的补考筛选
    s.wrong.set(id, (s.wrong.get(id) || 0) + 1);
    if (!prev) s.answers.set(id, 0);

    if (attempt === 1) {
      sendJson(ctx.res, 200, {
        ok: true, correct: false, attempt: 1,
        hint: makeHint(item.en, input),
        earnedScore: 0, completedNow: false,
      });
      return;
    }
    // 第二次仍错 -> 亮答案（学习目的，不给分也不计完成）
    sendJson(ctx.res, 200, {
      ok: true, correct: false, attempt: 2,
      reveal: { en: item.en, zh: item.zh || '' },
      earnedScore: 0, completedNow: false,
    });
  });

  /* ---------------------------- 组结算 ---------------------------- */
  router.post(PREFIX + '/group/finish', jsonBody, (ctx) => {
    const s = getSession((ctx.body || {}).sessionId);
    const gi = Number((ctx.body || {}).groupIndex);
    const items = s.items.filter((w) => w.gi === gi);
    if (!items.length) throw badRequest('<no-group>', '没有这一组');

    const answers = items.map((w) => ({ [ID]: S.idOf(w.en), correctAt: s.answers.get(S.idOf(w.en)) || 0 }));
    const r = computeGroup({ items: items.map((w) => ({ [ID]: S.idOf(w.en), borrowed: !!w.borrowed })), answers });

    // 达标才把"第一次就答对"的记入完成（借来的题不计）
    if (r.passed && s.pid) {
      const p = S.loadPlayer(s.pid);
      const set = new Set(p.done);
      for (const id of r.firstTry) set.add(id);
      S.savePlayer(s.pid, { done: [...set], num: s.num });
    }

    const total = s.items.length;
    const nextGi = gi + 1;
    sendJson(ctx.res, 200, {
      ok: true,
      score: r.score,
      fullMark: r.fullMark,
      passed: r.passed,
      [`firstTry${isText ? 'Sentences' : 'Words'}`]: r.firstTry,
      [`secondTry${isText ? 'Sentences' : 'Words'}`]: r.secondTry,
      points: r.points.total,
      isLast: !s.items.some((w) => w.gi === nextGi),
    });
  });

  /* ---------------------------- 整关结算 ---------------------------- */
  router.post(PREFIX + '/level/finish', jsonBody, (ctx) => {
    const s = getSession((ctx.body || {}).sessionId);
    const lv = currentLevel();
    const p = s.pid ? S.loadPlayer(s.pid) : { done: [] };
    const done = new Set(p.done);
    const completed = lv.items.filter((w) => done.has(S.idOf(w.en))).length;
    const r = computeBigReward({ total: lv.items.length, completed, per: BIG_PER });
    sendJson(ctx.res, 200, {
      ok: true,
      allCompleted: r.allCompleted,
      bigReward: r.bigReward,
      totalUnits: lv.items.length,
      completedUnits: completed,
    });
  });

  /* ---------------------- 补考（错超过一次的题） ---------------------- */
  router.post(PREFIX + '/requiz', jsonBody, (ctx) => {
    const s = getSession((ctx.body || {}).sessionId);
    const bad = [];
    for (const [id, n] of s.wrong) if (n > 1) bad.push(id);
    const items = s.items.filter((w) => bad.includes(S.idOf(w.en)));
    if (!items.length) {
      sendJson(ctx.res, 200, { ok: true, sessionId: null, groups: [], count: 0 });
      return;
    }
    const sessionId = newSession({
      kind, num: s.num, pid: s.pid,
      items: items.map((w) => ({ ...w, gi: 0 })),
      answers: new Map(), wrong: new Map(), study: false, requiz: true,
    });
    sendJson(ctx.res, 200, {
      ok: true,
      sessionId,
      count: items.length,
      groups: [{ index: 0, items: items.map((w) => groupPayload([w], 0, false).items[0]) }],
    });
  });

  /* ------------------------------ 重置 ------------------------------ */
  router.post(PREFIX + '/reset', jsonBody, (ctx) => {
    const pid = playerId(ctx);
    if (!pid) throw badRequest('<no-player>', '需要 X-Player-Id 才能清空进度');
    S.savePlayer(pid, { done: [], num: null });
    sendJson(ctx.res, 200, { ok: true });
  });

  /* ---------------------------- 整表对照 ---------------------------- */
  router.get(PREFIX + (isText ? '/sentences' : '/words'), (ctx) => {
    const lv = currentLevel();
    sendJson(ctx.res, 200, {
      ok: true,
      num: lv.num,
      name: lv.name,
      total: lv.items.length,
      items: lv.items.map((w) => ({ [ID]: S.idOf(w.en), en: w.en, zh: w.zh || '' })),
    });
  });

  /* ------------------------------ 上传 ------------------------------ */
  router.post(PREFIX + '/upload', async (ctx) => {
    requireAdmin(ctx);
    const ct = String(ctx.req.headers['content-type'] || '');
    let text = '';
    let numRaw = null;
    let fillChinese = false;

    if (ct.includes('multipart/form-data')) {
      const { readBody } = await import('./http.js');
      const buf = await readBody(ctx.req);
      const { fields, files } = parseMultipart(buf, ct);
      const f = files.file || files.upload || Object.values(files)[0];
      if (!f) throw badRequest('<no-file>', '没有收到文件（字段名用 file）');
      text = f.data.toString('utf8');
      numRaw = fields.num || null;
      fillChinese = fields.fillChinese === '1' || fields.fillChinese === 'true';
    } else {
      const b = await readJson(ctx.req);
      text = String(b.text || '');
      numRaw = b.num ?? null;
      fillChinese = !!b.fillChinese;
    }

    if (!String(text).trim()) throw badRequest('<empty>', `${isText ? '课文' : '词表'}内容为空`);

    let list = isText ? S.parseText(text) : S.parseWords(text);
    if (!list.length) {
      throw badRequest('<empty-level>', '没有解析到任何条目。请每行一条（英文<TAB>中文），或直接粘贴整段课文。');
    }

    // 可选：让大模型补上缺的中文（没有配置任何 key 就跳过，不报错）
    let filled = 0;
    if (fillChinese && !isText) {
      const missing = list.filter((w) => !w.zh).map((w) => w.en);
      if (missing.length && llmAny()) {
        try {
          const got = await translateWords(missing);
          const map = new Map(missing.map((w, i) => [w, got[i] || '']));
          list = list.map((w) => (w.zh ? w : { ...w, zh: map.get(w.en) || '' }));
          filled = list.filter((w) => w.zh).length - (list.length - missing.length);
        } catch { filled = 0; }
      }
    }

    const num = Number(numRaw) > 0 ? Number(numRaw) : S.nextLevelNum(kind);
    S.writeLevelFile(kind, num, list);
    // 换关就清空进度，避免"新关沿用旧关的完成记录"
    const pid = playerId(ctx);
    if (pid) S.savePlayer(pid, { done: [], num });

    sendJson(ctx.res, 200, {
      ok: true,
      num,
      total: list.length,
      filled,
      preview: list.slice(0, 3),
    });
  });

  return { PREFIX, kind };
}

/** 兼容旧路径：/api/wordgame/words 已在上面处理 */
export default { registerGame, Router };
