/**
 * 语音合成（TTS）—— 朗读学习阶段的英文。
 * ==================================================================
 * 供应商：qwen（DashScope）/ mimo，各自还有一份「tokenplan（套餐）」密钥与端点。
 *
 * 【为什么必须落盘缓存】
 *   同一句话在一次学习、以及用户反复重进关卡时会重复请求。供应商按次计费，
 *   不缓存等于每次背课文都在烧钱。缓存键 = sha1(供应商+音色+文本)，
 *   文本或音色任一变化才重新合成 —— 这样换音色不会误用旧音频。
 *
 * 【没配 key 时怎么办】
 *   不崩、不报 500。available() 返回 false，前端就不显示朗读按钮；
 *   万一有人直接调接口，返回 503 + 明确的 code，告诉他是"没配置密钥"而不是"服务器坏了"。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { get, has, ttsCacheDir } from './config.js';

const DEFAULT_VOICE = {
  qwen: 'Ethan',
  mimo: '沉稳温柔的女声，语速正常，吐字清晰',
};

const QWEN_URL = process.env.QWEN_TTS_URL
  || 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
const QWEN_TOKENPLAN_URL = process.env.QWEN_TOKENPLAN_TTS_URL || QWEN_URL;
const MIMO_URL = process.env.MIMO_TTS_URL || 'https://api.xiaomimimo.com/v1/chat/completions';
const MIMO_TOKENPLAN_URL = process.env.MIMO_TOKENPLAN_TTS_URL || MIMO_URL;

/**
 * 供应商表：key 是外部传入的 provider 名。
 * tokenplan 变体与主供应商**同协议**，只是拿不同的 key、打不同的端点
 * （套餐版通常有独立的域名或额度池）。所以复用同一段请求代码。
 */
const PROVIDERS = {
  qwen: { kind: 'qwen', keyPath: 'qwen.api.key', url: QWEN_URL },
  qwentokenplan: { kind: 'qwen', keyPath: 'qwentokenplan.api.key', url: QWEN_TOKENPLAN_URL },
  mimo: { kind: 'mimo', keyPath: 'mimo.api.key', url: MIMO_URL },
  mimotokenplan: { kind: 'mimo', keyPath: 'mimotokenplan.api.key', url: MIMO_TOKENPLAN_URL },
};

export function providers() {
  return Object.keys(PROVIDERS);
}

/** 哪个供应商可用（前端据此决定显示不显示朗读按钮） */
export function available() {
  const out = {};
  for (const [name, p] of Object.entries(PROVIDERS)) out[name] = has(p.keyPath);
  return out;
}

function cacheDir() {
  const d = ttsCacheDir();
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export function cacheKey(text, provider = 'qwen', voice = null) {
  const v = voice || DEFAULT_VOICE[provider] || '';
  return crypto
    .createHash('sha1')
    .update(provider + '\u0000' + v + '\u0000' + String(text))
    .digest('hex');
}

function cachePath(key) {
  return path.join(cacheDir(), key + '.wav');
}

/* 缓存上限：800 个文件 / 120MB，超了按最久未用淘汰。语音可重算，淘汰是安全的。 */
const MAX_FILES = 800;
const MAX_BYTES = 120 * 1024 * 1024;

function sweepCache() {
  const d = cacheDir();
  let names;
  try { names = fs.readdirSync(d).filter((n) => n.endsWith('.wav')); } catch { return; }
  const stats = [];
  let total = 0;
  for (const n of names) {
    try {
      const st = fs.statSync(path.join(d, n));
      total += st.size;
      stats.push({ n, size: st.size, mtime: st.mtimeMs });
    } catch { /* 忽略 */ }
  }
  if (names.length <= MAX_FILES && total <= MAX_BYTES) return;
  stats.sort((a, b) => a.mtime - b.mtime);
  const tooMany = names.length > MAX_FILES;
  const targetCount = Math.floor(MAX_FILES * 0.8);
  for (let i = 0; i < stats.length; i++) {
    if (tooMany ? i < stats.length - targetCount : total > MAX_BYTES * 0.8) {
      try { fs.unlinkSync(path.join(d, stats[i].n)); total -= stats[i].size; } catch { /* 忽略 */ }
    } else break;
  }
}

export function hasCached(key) {
  if (!/^[a-f0-9]{40}$/.test(String(key))) return false;
  try { return fs.statSync(cachePath(key)).size > 1000; } catch { return false; }
}

export function readCached(key) {
  if (!hasCached(key)) return null;
  const p = cachePath(key);
  try {
    const buf = fs.readFileSync(p);
    // 命中就刷新 mtime，让淘汰算法真正按"最久未用"挑
    try { const now = new Date(); fs.utimesSync(p, now, now); } catch { /* 忽略 */ }
    return buf;
  } catch { return null; }
}

/** 音频容器格式由文件头判断，别信供应商声明的 content-type */
export function mimeOf(buf) {
  if (buf.length > 12 && buf.slice(0, 4).toString('latin1') === 'RIFF') return 'audio/wav';
  if (buf.length > 4 && buf.slice(0, 4).toString('latin1') === 'OggS') return 'audio/ogg';
  if (buf.length > 3 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'audio/mpeg';
  return 'audio/wav';
}

async function withRetry(fn, tries = 3) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      const st = Number(e && e.status) || 0;
      if (st && st !== 429 && st < 500) throw e; // 4xx 重试只会白等
      await new Promise((r) => setTimeout(r, 400 * Math.pow(2, i)));
    }
  }
  throw last;
}

/** qwen：返回的是音频链接（data 可能为空串），必须再取一次 */
async function synthQwen(cfg, text, voice) {
  const key = get(cfg.keyPath);
  return withRetry(async () => {
    const res = await fetch(cfg.url, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.QWEN_TTS_MODEL || 'qwen3-tts-flash',
        input: { text, voice: voice || DEFAULT_VOICE.qwen },
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw Object.assign(new Error('qwen ' + res.status + ' ' + body.slice(0, 200)), { status: res.status });
    }
    const j = await res.json();
    const audio = (j && j.output && j.output.audio) || {};
    if (audio.data) return Buffer.from(audio.data, 'base64');
    if (!audio.url) throw Object.assign(new Error('qwen 返回里没有音频'), { status: 0 });
    const r2 = await fetch(audio.url, { signal: AbortSignal.timeout(30000) });
    if (!r2.ok) throw Object.assign(new Error('qwen 音频下载失败 ' + r2.status), { status: r2.status });
    return Buffer.from(await r2.arrayBuffer());
  });
}

/** mimo：base64 WAV 直接内联在 choices[0].message.audio.data */
async function synthMimo(cfg, text, voice) {
  const key = get(cfg.keyPath);
  return withRetry(async () => {
    const res = await fetch(cfg.url, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.MIMO_TTS_MODEL || 'mimo-v2.5-tts-voicedesign',
        voice: voice || DEFAULT_VOICE.mimo,
        // 契约来自实测：assistant 放正文、user 放指令，不要 system 角色
        messages: [{ role: 'assistant', content: text }, { role: 'user', content: text }],
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw Object.assign(new Error('mimo ' + res.status + ' ' + body.slice(0, 200)), { status: res.status });
    }
    const j = await res.json();
    const b64 = j && j.choices && j.choices[0] && j.choices[0].message
      && j.choices[0].message.audio && j.choices[0].message.audio.data;
    if (!b64) throw Object.assign(new Error('mimo 返回里没有音频'), { status: 0 });
    return Buffer.from(b64, 'base64');
  });
}

/**
 * 合成一段文本并落盘。命中缓存直接返回，不碰网络。
 * @returns {Promise<{key:string, cached:boolean, bytes:number, provider:string}>}
 */
export async function synth(text, { provider = 'qwen', voice = null, force = false } = {}) {
  const t = String(text == null ? '' : text).trim();
  if (!t) throw Object.assign(new Error('文本为空'), { status: 400, code: '<empty-text>' });
  if (t.length > 300) throw Object.assign(new Error('文本过长（上限 300 字）'), { status: 400, code: '<text-too-long>' });

  const cfg = PROVIDERS[provider];
  if (!cfg) throw Object.assign(new Error('未知的语音供应商: ' + provider), { status: 400, code: '<unknown-provider>' });
  if (!has(cfg.keyPath)) {
    throw Object.assign(new Error(`供应商 ${provider} 未配置密钥（${cfg.keyPath}）`), {
      status: 503, code: '<no-api-key>',
    });
  }

  const key = cacheKey(t, provider, voice);
  if (!force && hasCached(key)) return { key, cached: true, bytes: fs.statSync(cachePath(key)).size, provider };

  const fn = cfg.kind === 'qwen' ? synthQwen : synthMimo;
  const buf = await fn(cfg, t, voice);
  if (!buf || buf.length < 1000) throw Object.assign(new Error('合成结果异常（音频过短）'), { status: 502, code: '<bad-audio>' });

  // 先写临时文件再 rename：中途失败不会留下半截 wav 被后续请求当成缓存命中
  const p = cachePath(key);
  const tmp = p + '.tmp' + process.pid;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, p);
  sweepCache();
  return { key, cached: false, bytes: buf.length, provider };
}

/**
 * 批量合成，最多 3 路并发。
 * 串行要 10 秒以上用户等不了；全部并发会吃到供应商 429。3 路是实测稳妥值。
 */
export async function synthMany(texts, opt = {}) {
  const list = (Array.isArray(texts) ? texts : []).map((x) => String(x == null ? '' : x).trim()).filter(Boolean);
  const out = new Array(list.length);
  let i = 0;
  const workers = new Array(Math.min(3, list.length || 1)).fill(0).map(async () => {
    for (;;) {
      const idx = i++;
      if (idx >= list.length) return;
      try {
        out[idx] = { text: list[idx], ok: true, ...(await synth(list[idx], opt)) };
      } catch (e) {
        out[idx] = { text: list[idx], ok: false, error: String((e && e.message) || e), code: (e && e.code) || null };
      }
    }
  });
  await Promise.all(workers);
  return out;
}

export default { available, providers, cacheKey, hasCached, readCached, mimeOf, synth, synthMany, DEFAULT_VOICE };
