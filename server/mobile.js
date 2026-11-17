/**
 * 手机端（App）接口 —— 让 App 能"连任何一台私服"。
 * ==================================================================
 * 身份模型只有"设备"一种：App 首启生成一个 deviceId，调一次
 * POST /m/device 换一个 token，之后所有请求带 X-Device-Token。
 *
 * 【为什么不用账号密码】
 *   私服的使用者是自己和几个朋友。账号系统意味着注册、找回密码、防撞库……
 *   收益极低。设备令牌足够区分"谁的进度"，而且换手机只要把 deviceId 抄过去
 *   就能接着玩。真正的写权限（上传关卡）单独用 ADMIN_TOKEN 保护。
 *
 * 【令牌为什么是无状态的】
 *   token = base64url(deviceId) + "." + HMAC(secret, deviceId)。
 *   校验时重算一遍即可，不需要设备表、不需要数据库。
 *   secret 首次启动生成并落盘在 data/.device-secret，重启后旧 token 仍然有效。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  sendJson, sendText, sendBuffer, badRequest, unauthorized, tooMany, notFound,
  Buckets, jsonBody,
} from './http.js';
import * as S from './store.js';
import * as T from './tts.js';
import { dirs, ensureDirs } from './store.js';

const GROUP_SIZE = 10;
const buckets = new Buckets();

let secretCache = null;

function secret() {
  if (secretCache) return secretCache;
  const d = ensureDirs();
  const f = path.join(d.root, '.device-secret');
  try {
    const v = fs.readFileSync(f, 'utf8').trim();
    if (v) { secretCache = v; return v; }
  } catch { /* 不存在就生成 */ }
  const v = crypto.randomBytes(32).toString('hex');
  try { fs.writeFileSync(f, v, { mode: 0o600 }); } catch { /* 只读盘就算了 */ }
  secretCache = v;
  return v;
}

function sign(deviceId) {
  return crypto.createHmac('sha256', secret()).update(deviceId).digest('base64url');
}

function issue(deviceId) {
  return Buffer.from(deviceId, 'utf8').toString('base64url') + '.' + sign(deviceId);
}

function verify(token) {
  const t = String(token || '');
  const i = t.lastIndexOf('.');
  if (i <= 0) return null;
  let deviceId = '';
  try { deviceId = Buffer.from(t.slice(0, i), 'base64url').toString('utf8'); } catch { return null; }
  if (!deviceId || deviceId.length > 64) return null;
  const got = t.slice(i + 1);
  const want = sign(deviceId);
  if (got.length !== want.length) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want))) return null;
  } catch { return null; }
  return deviceId;
}

function identity(ctx) {
  const dev = verify(ctx.req.headers['x-device-token']);
  if (dev) return { deviceId: dev, pid: 'dev:' + dev };
  const direct = String(ctx.req.headers['x-player-id'] || '').trim();
  if (direct) return { deviceId: null, pid: direct.slice(0, 64) };
  return null;
}

function requireIdentity(ctx) {
  const id = identity(ctx);
  if (!id) throw unauthorized('<unauthorized>', '需要 X-Device-Token（先调 POST /m/device 领取）');
  return id;
}

function guard(ctx, id, perMinute, bucket) {
  const key = id ? id.pid : 'ip:' + ctx.ip;
  if (!buckets.take(bucket + ':' + key, perMinute)) {
    throw tooMany('<rate-limited>', `请求太频繁（上限 ${perMinute} 次/分钟）`);
  }
}

/** 内容指纹：整关文本的 sha1 前 16 位。客户端带上 hash 就能省掉整包传输。 */
function hashOf(text) {
  return crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, 16);
}

function payloadOf(kind, list) {
  return list.map((w, i) => ({
    [kind === 'text' ? 'sid' : 'wid']: S.idOf(w.en),
    en: w.en,
    zh: w.zh || '',
    index: i,
    wordCount: String(w.en).trim().split(/\s+/).filter(Boolean).length,
    charCount: String(w.en).replace(/\s+/g, '').length,
  }));
}

export function registerMobile(router) {
  /* ------------------------------ 领取令牌 ------------------------------ */
  router.post('/api/wordgame/m/device', jsonBody, async (ctx) => {
    const b = ctx.body || {};
    const deviceId = String(b.deviceId || '').trim();
    if (!deviceId) throw badRequest('<no-device-id>', '缺少 deviceId');
    if (deviceId.length > 64) throw badRequest('<bad-device-id>', 'deviceId 太长（上限 64 字符）');
    if (!buckets.take('dev:ip:' + ctx.ip, 60)) throw tooMany('<rate-limited>', '注册太频繁');
    sendJson(ctx.res, 200, {
      ok: true,
      token: issue(deviceId),
      deviceId,
      hint: '之后每个请求都带 X-Device-Token；token 无状态，重启服务器不会失效',
    });
  });

  /* ------------------------------ 探活 ------------------------------ */
  for (const p of ['/api/wordgame/m/ping', '/api/wordgame/text/m/ping']) {
    router.get(p, (ctx) => {
      sendJson(ctx.res, 200, {
        ok: true,
        service: 'sanjian-wordgame',
        time: new Date().toISOString(),
        tts: T.available(),
      });
    });
  }

  /* ------------------------------ 目录 ------------------------------ */
  router.get('/api/wordgame/m/catalog', (ctx) => {
    const id = requireIdentity(ctx);
    guard(ctx, id, 120, 'catalog');
    const done = S.loadPlayer(id.pid).done;
    const out = { ok: true, deviceId: id.deviceId, sanj: null, text: null, history: {}, caps: {} };
    for (const kind of ['word', 'text']) {
      const lv = S.loadCurrent(kind);
      const key = kind === 'word' ? 'sanj' : 'text';
      out[key] = lv
        ? {
          num: lv.num,
          name: lv.name,
          count: lv.items.length,
          groups: Math.ceil(lv.items.length / GROUP_SIZE),
          completedCount: lv.items.filter((w) => done.includes(S.idOf(w.en))).length,
          updatedAt: new Date(lv.mtime).toISOString(),
        }
        : null;
      // 历史关列表：App 可以直接列出来让用户选着复习
      out.history[key] = S.listHistory(kind).map((x) => ({
        num: x.num,
        name: x.name,
        count: x.count,
        groups: Math.ceil(x.count / GROUP_SIZE),
        updatedAt: x.updatedAt ? new Date(x.updatedAt).toISOString() : null,
        saved: false,
      }));
    }
    out.caps = {
      sanj: !!out.sanj, text: !!out.text,
      history: (out.history.sanj.length + out.history.text.length) > 0,
      tts: T.available(), export: true, upload: true,
    };
    sendJson(ctx.res, 200, out);
  });

  /* --------------------------- 拉取一关 --------------------------- */
  for (const kind of ['word', 'text']) {
    const PREFIX = kind === 'text' ? '/api/wordgame/text/m' : '/api/wordgame/m';
    const NAME = kind === 'text' ? 'text' : 'sanj';

    router.get(PREFIX + '/level', (ctx) => {
      const id = requireIdentity(ctx);
      guard(ctx, id, 120, 'level');
      // scope=history 时按 num 取历史关；否则取现役关
      const history = ctx.query.get('scope') === 'history';
      const lv = history ? S.loadLevel(kind, Number(ctx.query.get('num'))) : S.loadCurrent(kind);
      if (!lv) {
        throw notFound(
          history ? '<no-history-level>' : '<no-level>',
          history
            ? `没有 ${ctx.query.get('num') || '?'} 这个历史` + (kind === 'text' ? '课文' : '关卡')
            : '这台私服还没有上传' + (kind === 'text' ? '课文' : '关卡'),
        );
      }

      const fmt = String(ctx.query.get('format') || 'json');
      const txt = kind === 'text' ? S.formatText(lv.items) : S.formatWords(lv.items);
      const hash = hashOf(txt);

      if (String(ctx.query.get('hash') || '') === hash) {
        sendJson(ctx.res, 200, { ok: true, unchanged: true, hash, num: lv.num });
        return;
      }

      if (fmt === 'txt') {
        sendText(ctx.res, 200, txt, {
          'X-WG-Hash': hash,
          'X-WG-Count': String(lv.items.length),
          'X-WG-Num': String(lv.num),
          'X-WG-Saved': history ? '0' : '1',
          'Cache-Control': 'no-store',
        });
        return;
      }

      sendJson(ctx.res, 200, {
        ok: true,
        scope: history ? 'history' : NAME,
        num: lv.num,
        name: lv.name,
        count: lv.items.length,
        hash,
        groupSize: GROUP_SIZE,
        // 历史关不存档：客户端不要拿它去合并本地进度
        saved: !history,
        [kind === 'text' ? 'sentences' : 'words']: payloadOf(kind, lv.items),
      });
    });
  }

  /* --------------------------- 一次拿全部 --------------------------- */
  for (const p of ['/api/wordgame/m/export', '/api/wordgame/text/m/export']) {
    router.get(p, (ctx) => {
      const id = requireIdentity(ctx);
      guard(ctx, id, 20, 'export');
      const out = { ok: true, exportedAt: new Date().toISOString(), sanj: null, text: null, history: {} };
      for (const kind of ['word', 'text']) {
        const lv = S.loadCurrent(kind);
        const key = kind === 'word' ? 'sanj' : 'text';
        out[key] = lv
          ? {
            num: lv.num,
            name: lv.name,
            count: lv.items.length,
            hash: hashOf(kind === 'text' ? S.formatText(lv.items) : S.formatWords(lv.items)),
            [kind === 'text' ? 'sentences' : 'words']: payloadOf(kind, lv.items),
          }
          : null;
        // 历史关默认一并导出（离线包里想复习旧关就不用再发一次请求）
        out.history[key] = S.listHistory(kind).map((x) => {
          const hlv = S.loadLevel(kind, x.num);
          return hlv
            ? {
              num: hlv.num,
              name: hlv.name,
              count: hlv.items.length,
              hash: hashOf(kind === 'text' ? S.formatText(hlv.items) : S.formatWords(hlv.items)),
              saved: false,
              [kind === 'text' ? 'sentences' : 'words']: payloadOf(kind, hlv.items),
            }
            : null;
        }).filter(Boolean);
      }
      sendJson(ctx.res, 200, out);
    });
  }

  /* ------------------------------ 语音 ------------------------------ */
  router.get('/api/wordgame/tts', async (ctx) => {
    const text = String(ctx.query.get('text') || '').trim();
    const provider = String(ctx.query.get('provider') || 'qwen');
    if (!text) throw badRequest('<no-text>', '缺少 text 参数');
    const id = identity(ctx);
    guard(ctx, id, 240, 'tts');
    try {
      const r = await T.synth(text, { provider });
      sendJson(ctx.res, 200, {
        ok: true, key: r.key, cached: r.cached, bytes: r.bytes, provider: r.provider,
        url: '/api/wordgame/tts/' + r.key + '.wav',
      });
    } catch (e) {
      sendJson(ctx.res, e.status || 502, { ok: false, code: e.code || '<tts-failed>', message: String(e.message || e) });
    }
  });

  router.post('/api/wordgame/tts/batch', jsonBody, async (ctx) => {
    const b = ctx.body || {};
    const texts = Array.isArray(b.texts) ? b.texts.slice(0, 20) : [];
    if (!texts.length) throw badRequest('<no-text>', 'texts 为空（最多 20 条）');
    const id = identity(ctx);
    guard(ctx, id, 60, 'ttsbatch');
    const items = await T.synthMany(texts, { provider: String(b.provider || 'qwen') });
    sendJson(ctx.res, 200, {
      ok: true,
      items: items.map((x) => (x.ok
        ? { text: x.text, ok: true, key: x.key, cached: x.cached, url: '/api/wordgame/tts/' + x.key + '.wav' }
        : { text: x.text, ok: false, code: x.code || '<tts-failed>', error: x.error })),
    });
  });

  router.get('/api/wordgame/tts/:key.wav', (ctx) => {
    const key = String(ctx.params.key || '');
    const buf = T.readCached(key);
    if (!buf) throw notFound('<no-audio>', '音频不存在或已被清理，请重新合成');
    sendBuffer(ctx.res, 200, buf, {
      'Content-Type': T.mimeOf(buf),
      'Cache-Control': 'public, max-age=604800',
    });
  });
}

/** 供 index.js 判断某个路径是否属于"手机端"（需要 CORS 头） */
export function isMobilePath(pathname) {
  return /^\/api\/wordgame\/(text\/)?m\//.test(pathname) || pathname.startsWith('/api/wordgame/tts');
}

export default { registerMobile, isMobilePath };
