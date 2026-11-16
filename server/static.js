/**
 * 静态文件服务 —— 把 public/ 目录当网站根目录。
 * 只做三件事：按扩展名给 Content-Type、防目录穿越、SPA 兜底回 index.html。
 */
import fs from 'node:fs';
import path from 'node:path';
import { sendBuffer, sendHtml } from './http.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
};

export function serveStatic(publicDir) {
  const root = path.resolve(publicDir);

  return function handle(ctx) {
    let rel = decodeURIComponent(ctx.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';

    // 防目录穿越：解析后必须仍在 root 之内
    const target = path.resolve(root, '.' + rel);
    if (!target.startsWith(root)) {
      sendHtml(ctx.res, 403, '<h1>403</h1>');
      return true;
    }

    let st = null;
    try { st = fs.statSync(target); } catch { st = null; }

    if (st && st.isFile()) {
      const buf = fs.readFileSync(target);
      const ext = path.extname(target).toLowerCase();
      /*
       * 代码与 HTML 一律 no-cache（每次回源验证），只有图片/字体才允许长缓存。
       *
       * 【为什么不像常规站点那样给 js/css 设 max-age】
       *   这是自建私服，用户随时会改 app.js / style.css 然后刷新看效果。
       *   设 max-age=300 意味着"改完要看五分钟后的世界"，还很难想到是缓存 ——
       *   我就被这个坑过一次（改了文案刷新仍是旧的）。这点带宽不值得。
       */
      const isCode = ext === '.html' || ext === '.js' || ext === '.mjs' || ext === '.css' || ext === '.json';
      sendBuffer(ctx.res, 200, buf, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': isCode ? 'no-cache' : 'public, max-age=86400',
      });
      return true;
    }

    // SPA 兜底：没有扩展名的路径都回 index.html，让前端自己路由
    if (!path.extname(rel)) {
      const indexPath = path.join(root, 'index.html');
      try {
        const buf = fs.readFileSync(indexPath);
        sendBuffer(ctx.res, 200, buf, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
        return true;
      } catch { /* 落到下面 404 */ }
    }

    return false;
  };
}

export default { serveStatic };
