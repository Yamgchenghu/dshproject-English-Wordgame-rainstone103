/**
 * 极简 HTTP 框架 —— 零第三方依赖。
 * ==================================================================
 * 只用 node:http。够用的部分：路径参数（:name）、错误类型、JSON 收发、
 * 静态文件、CORS 预检、按主体的令牌桶限流。
 *
 * 【为什么不用 express/koa】
 *   这是个"下载下来 node server/index.js 就能跑"的私服。只要有一个 npm 依赖，
 *   用户就得先 npm install，还会遇到锁文件、镜像源、Node 版本不兼容这些破事。
 *   这点路由功能自己写不到 200 行，换来"零安装"是划算的。
 */

/** 带 HTTP 状态与机器可读 code 的错误。message 是给人看的中文。 */
export class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message || code || 'error');
    this.status = status || 500;
    this.code = code || '<error>';
    this.extra = extra || null;
  }
}
export const badRequest = (code, msg, extra) => new HttpError(400, code, msg, extra);
export const unauthorized = (code, msg) => new HttpError(401, code, msg);
export const forbidden = (code, msg) => new HttpError(403, code, msg);
export const notFound = (code, msg) => new HttpError(404, code, msg);
export const tooMany = (code, msg) => new HttpError(429, code, msg);
export const serverError = (code, msg) => new HttpError(500, code, msg);

/**
 * 请求体上限。词表/课文是纯文本，2MB 已经能装下几万行；
 * 放太大等于给了一个不用认证的磁盘写入口子。
 */
export const MAX_BODY = 2 * 1024 * 1024;

export function sendJson(res, status, obj, headers) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ...(headers || {}),
  });
  res.end(body);
}

export function sendText(res, status, text, headers) {
  const body = Buffer.from(String(text), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': body.length,
    ...(headers || {}),
  });
  res.end(body);
}

export function sendBuffer(res, status, buf, headers) {
  res.writeHead(status, { 'Content-Length': buf.length, ...(headers || {}) });
  res.end(buf);
}

export function sendHtml(res, status, html, headers) {
  const body = Buffer.from(String(html), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.length,
    ...(headers || {}),
  });
  res.end(body);
}

/** 读原始请求体，超限直接 413，避免把内存吃穿 */
export function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, '<body-too-large>', '请求体过大（上限 2MB）'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try {
    const v = JSON.parse(buf.toString('utf8'));
    return v && typeof v === 'object' ? v : {};
  } catch {
    throw badRequest('<bad-json>', '请求体不是合法 JSON');
  }
}

/** 中间件：把 JSON body 读进 ctx.body，handler 里直接用 ctx.body */
export async function jsonBody(ctx) {
  ctx.body = await readJson(ctx.req);
}

/**
 * 解析 multipart/form-data —— 只支持"文本字段 + 单个文件"。
 * 上传词表/课文只需要这个，完整的 multipart 解析（多文件、嵌套）不值得写。
 */
export function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentType || ''));
  const boundary = (m && (m[1] || m[2])) || '';
  if (!boundary) throw badRequest('<bad-multipart>', '缺少 multipart boundary');
  const delim = Buffer.from('--' + boundary);
  const parts = [];
  let start = buf.indexOf(delim);
  if (start < 0) throw badRequest('<bad-multipart>', 'multipart 结构不合法');
  for (;;) {
    start += delim.length;
    if (buf.slice(start, start + 2).toString('latin1') === '--') break;
    if (buf.slice(start, start + 2).toString('latin1') === '\r\n') start += 2;
    const nextIdx = buf.indexOf(delim, start);
    if (nextIdx < 0) break;
    const chunk = buf.slice(start, nextIdx);
    const sepIdx = chunk.indexOf('\r\n\r\n');
    if (sepIdx > 0) {
      const head = chunk.slice(0, sepIdx).toString('utf8');
      let body = chunk.slice(sepIdx + 4);
      if (body.slice(-2).toString('latin1') === '\r\n') body = body.slice(0, -2);
      const nameM = /name="([^"]*)"/i.exec(head);
      const fileM = /filename="([^"]*)"/i.exec(head);
      parts.push({
        name: nameM ? nameM[1] : '',
        filename: fileM ? fileM[1] : null,
        data: body,
      });
    }
    start = nextIdx;
  }
  const fields = {};
  const files = {};
  for (const p of parts) {
    if (p.filename != null) files[p.name] = { filename: p.filename, data: p.data };
    else fields[p.name] = p.data.toString('utf8');
  }
  return { fields, files };
}

/* ------------------------------ 路由 ------------------------------ */

export class Router {
  constructor() {
    this.routes = [];
  }

  /**
   * 注册路由。path 支持 :name 占位符。
   *
   * 支持中间件：`router.post(path, jsonBody, handler)` —— 最后一个参数若是普通对象
   * 则当作选项，其余按顺序执行。这样"读 body"这类横切逻辑不用在每个 handler 里重写。
   */
  add(method, path, ...rest) {
    let opt = {};
    if (rest.length && rest[rest.length - 1] && typeof rest[rest.length - 1] === 'object') {
      opt = rest.pop();
    }
    const handlers = rest;
    if (!handlers.length) throw new Error('路由 ' + path + ' 没有 handler');

    const keys = [];
    const src = String(path)
      .split('/')
      .map((seg) => {
        if (seg.startsWith(':')) {
          keys.push(seg.slice(1));
          return '([^/]+)';
        }
        return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/');
    this.routes.push({
      method: method.toUpperCase(),
      path,
      keys,
      re: new RegExp('^' + src + '/?$'),
      handlers,
      cors: !!opt.cors,
    });
    return this;
  }

  get(p, ...r) { return this.add('GET', p, ...r); }
  post(p, ...r) { return this.add('POST', p, ...r); }
  put(p, ...r) { return this.add('PUT', p, ...r); }
  delete(p, ...r) { return this.add('DELETE', p, ...r); }
  options(p, ...r) { return this.add('OPTIONS', p, ...r); }

  /** 返回 {route, params} 或 null。路径参数做 decodeURIComponent。 */
  match(method, pathname) {
    const want = String(method || 'GET').toUpperCase();
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.re.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== want) continue;
      const params = {};
      for (let i = 0; i < r.keys.length; i++) {
        try { params[r.keys[i]] = decodeURIComponent(m[i + 1]); }
        catch { params[r.keys[i]] = m[i + 1]; }
      }
      return { route: r, params };
    }
    // 路径存在但方法不对 -> 让调用方回 405 而不是 404
    return pathMatched ? { route: null, methodNotAllowed: true } : null;
  }

  /** 某路径是否声明了 cors（决定 OPTIONS 要不要回 CORS 头） */
  corsOf(pathname) {
    return this.routes.some((r) => r.cors && r.re.test(pathname));
  }
}

/* ---------------------------- 限流 ---------------------------- */

/**
 * 令牌桶。按"主体"（账号/设备/IP）而不是只按 IP —— 手机走运营商 NAT 时
 * 一个出口 IP 后面可能有几百人，只按 IP 会误伤。
 */
export class Buckets {
  constructor(buckets = new Map()) {
    this.buckets = buckets;
  }

  /** 消耗一次配额；不够返回 false */
  take(key, perMinute) {
    const now = Date.now();
    const b = this.buckets.get(key) || { tokens: perMinute, at: now };
    const refill = ((now - b.at) / 60000) * perMinute;
    b.tokens = Math.min(perMinute, b.tokens + refill);
    b.at = now;
    if (b.tokens < 1) {
      this.buckets.set(key, b);
      return false;
    }
    b.tokens -= 1;
    this.buckets.set(key, b);
    // 防止桶无限增长：超过 5000 个主体就整体清空（限流精度换内存）
    if (this.buckets.size > 5000) this.buckets.clear();
    return true;
  }
}

/** 取客户端 IP：支持反向代理（X-Forwarded-For 取第一个） */
export function clientIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  if (xf) return xf;
  return String(req.socket && req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

export function isLocalIp(ip) {
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost';
}
