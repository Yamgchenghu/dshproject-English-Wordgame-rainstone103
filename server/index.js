/**
 * 三玖关 / 三玖课文关 —— 私服入口。
 * ==================================================================
 * 启动：node server/index.js
 *   默认 http://0.0.0.0:8787
 *   环境变量：PORT / HOST / DATA_DIR / ADMIN_TOKEN
 *
 * 设计取向：**零第三方依赖、零数据库、零构建步骤**。
 *   别人把这个目录拷走，node 一跑就是一个能玩的私服；
 *   手机 App 只要把 baseUrl 指过来就能连（接口见 docs/API.md）。
 */
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import {
  Router, HttpError, sendJson, sendText, clientIp, MAX_BODY,
} from './http.js';
import * as C from './config.js';
import * as S from './store.js';
import { registerGame } from './game.js';
import { registerMobile, isMobilePath } from './mobile.js';
import { serveStatic } from './static.js';
import { available as ttsAvailable } from './tts.js';
import { available as llmAvailable } from './llm.js';

const ROOT = C.ROOT;
const PUBLIC_DIR = path.join(ROOT, 'public');

const router = new Router();

/* ------------------------------ 路由 ------------------------------ */
registerGame(router, 'word');   // /api/wordgame/*
registerGame(router, 'text');   // /api/wordgame/text/*
registerMobile(router);         // /api/wordgame/m/* + /text/m/* + /tts

/** 密钥状态：只回答"配没配"，永远不回显 key */
router.get('/api/keys/status', (ctx) => {
  sendJson(ctx.res, 200, {
    ok: true,
    reserved: C.RESERVED_KEY_PATHS,
    keys: C.status(),
    tts: ttsAvailable(),
    llm: llmAvailable(),
  });
});

/** 规则常量，供客户端展示（避免前端各写一份） */
router.get('/api/wordgame/rules', (ctx) => {
  sendJson(ctx.res, 200, {
    ok: true,
    groupSize: 10,
    passRatio: 0.85,
    bigRewardPerWord: 0.1,
    bigRewardPerSentence: 0.5,
    first: 10, second: 7, borrowedSecond: 5,
  });
});

const staticHandler = serveStatic(PUBLIC_DIR);
// 让 /docs/API.md 这类链接直接可读（文档放在仓库 docs/，不在 public/ 里，
// 这样 GitHub 上浏览和本地浏览器打开始终是同一份文件，不会出现两份漂移）
const docsHandler = serveStatic(path.join(ROOT, 'docs'));

/* ---------------------------- CORS ---------------------------- */
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Auth, X-Device-Token, X-Player-Id, X-Admin-Token',
  'Access-Control-Max-Age': '86400',
};

function withCors(headers, mobile) {
  return mobile ? { ...CORS_HEADERS, ...(headers || {}) } : headers;
}

/* ---------------------------- 主处理 ---------------------------- */
const server = http.createServer(async (req, res) => {
  const started = Date.now();
  let pathname = '/';
  let query = new URLSearchParams();
  try {
    const u = new URL(req.url || '/', 'http://localhost');
    pathname = u.pathname;
    query = u.searchParams;
  } catch {
    sendJson(res, 400, { ok: false, code: '<bad-url>', message: 'URL 不合法' });
    return;
  }

  const mobile = isMobilePath(pathname);

  // 预检：宿主的通配不生效，这里对所有 /api/ 统一回 204，省得漏一个路径就挂
  if (req.method === 'OPTIONS' && pathname.startsWith('/api/')) {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  const hit = router.match(req.method, pathname);

  if (hit && hit.methodNotAllowed) {
    sendJson(res, 405, { ok: false, code: '<method-not-allowed>', message: '该路径不支持这个请求方法' }, withCors(null, mobile));
    return;
  }

  if (!hit) {
    // 文档：/docs/xxx -> 仓库 docs/ 目录
    if ((req.method === 'GET' || req.method === 'HEAD') && pathname.startsWith('/docs/')) {
      const done = docsHandler({ req, res, pathname: pathname.slice('/docs'.length), query });
      if (done) return;
    }
    // 非 /api 的 GET 交给静态文件；静态也找不到就是 404
    if ((req.method === 'GET' || req.method === 'HEAD') && !pathname.startsWith('/api/')) {
      const done = staticHandler({ req, res, pathname, query });
      if (done) return;
    }
    sendJson(res, 404, { ok: false, code: '<not-found>', message: '没有这个接口或页面' }, withCors(null, mobile));
    return;
  }

  const ctx = {
    req, res, pathname, query,
    params: hit.params || {},
    ip: clientIp(req),
    body: null,
  };

  try {
    // 顺序执行中间件，最后一个 handler 负责响应
    for (const fn of hit.route.handlers) {
      await fn(ctx);
      if (res.writableEnded) break;
    }
  } catch (e) {
    const status = e instanceof HttpError ? e.status : (Number(e && e.status) || 500);
    const code = (e && e.code) || (status === 500 ? '<server-error>' : '<error>');
    const message = String((e && e.message) || '服务器内部错误');
    if (status >= 500) {
      // 5xx 才打日志；4xx 是用户输入问题，不值得刷屏
      console.error('[error]', req.method, pathname, '->', status, code, message);
    }
    if (!res.headersSent) {
      sendJson(res, status, { ok: false, code, message }, withCors(null, mobile));
    }
  } finally {
    if (process.env.LOG !== '0') {
      const ms = Date.now() - started;
      console.log(`${req.method} ${pathname} ${res.statusCode} ${ms}ms`);
    }
  }
});

/* ---------------------------- 启动 ---------------------------- */
const PORT = C.port();
const HOST = C.host();

S.ensureDirs();

// 首次启动塞一份示例数据，避免"打开就是空白页"
(function seed() {
  try {
    if (S.listLevels('word').length === 0) {
      S.writeLevelFile('word', 100001, [
        { en: 'vocabulary', zh: 'n. 词汇；词汇量' },
        { en: 'suppress', zh: 'v. 抑制；压制' },
        { en: 'voluntary', zh: 'adj. 自愿的；志愿的' },
        { en: 'devote', zh: 'v. 把…奉献给' },
        { en: 'benefit', zh: 'v. 受益 n. 好处' },
        { en: 'precious', zh: 'adj. 宝贵的' },
        { en: 'improvement', zh: 'n. 改进；提升' },
        { en: 'centers on', zh: '以…为中心；围绕' },
        { en: 'in need', zh: '需要帮助的' },
        { en: 'first and foremost', zh: '首先；最重要的是' },
      ]);
    }
    if (S.listLevels('text').length === 0) {
      S.writeLevelFile('text', 100001, [
        {
          en: 'On hearing that our school will hold a voluntary activity during the summer holiday, I cannot suppress my urge to tell you my plan about it.',
          zh: '听说学校将在暑假举办一次志愿活动，我忍不住想告诉你我关于这件事的计划。',
        },
        {
          en: 'First and foremost, I have titled the program "Cares for others, Growth in ourselves", which centers on paying attention and offering help to those in need.',
          zh: '首先，我把这个项目命名为「关爱他人，成长自我」，它的核心是关注并帮助那些需要帮助的人。',
        },
        {
          en: 'When we devote our time and energy to helping others, we also benefit from the programme, gaining precious growth and self-improvement.',
          zh: '当我们把时间和精力投入到帮助他人时，我们自己也会从这个项目中受益，获得宝贵的成长与自我提升。',
        },
      ]);
    }
  } catch (e) {
    console.error('[seed] 写入示例数据失败:', e && e.message);
  }
})();

server.listen(PORT, HOST, () => {
  const tts = ttsAvailable();
  const llm = llmAvailable();
  const configured = C.RESERVED_KEY_PATHS.filter((p) => C.has(p));
  console.log('');
  console.log('  三玖关 · 三玖课文关  私服已启动');
  console.log('  --------------------------------------------------');
  console.log(`  网页      http://localhost:${PORT}/`);
  console.log(`  接口文档  http://localhost:${PORT}/docs/API.md`);
  console.log(`  密钥状态  http://localhost:${PORT}/api/keys/status`);
  console.log(`  数据目录  ${C.dataDir()}`);
  console.log('  --------------------------------------------------');
  console.log(`  语音  qwen=${tts.qwen ? '已配' : '未配'}  mimo=${tts.mimo ? '已配' : '未配'}`);
  console.log(`  模型  ${Object.entries(llm).filter(([, v]) => v).map(([k]) => k).join(', ') || '（都没配，上传时不会自动补中文）'}`);
  console.log(`  密钥  已配置 ${configured.length}/${C.RESERVED_KEY_PATHS.length} 个槽位`);
  console.log(`  管理  上传需要 ${C.adminToken() ? 'ADMIN_TOKEN（已设置）' : '仅限本机（未设 ADMIN_TOKEN）'}`);
  console.log('');
});

process.on('SIGINT', () => { console.log('\nbye'); process.exit(0); });
process.on('SIGTERM', () => { console.log('\nbye'); process.exit(0); });

export { server, router };
