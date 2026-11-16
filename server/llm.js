/**
 * 大模型调用 —— 只有一个用途：上传时把缺的中文释义补上。
 * ==================================================================
 * 五个供应商都走 OpenAI 兼容的 /chat/completions，所以只需要一张表。
 * 按优先级依次尝试，第一个成功的就用；全都没配 key 就跳过（不是失败）。
 *
 * 【为什么补中文要单独一个模块】
 *   它是唯一会"花钱且慢"的路径。和存储、路由分开，才能一眼看出
 *   "哪些代码会在用户上传时产生外部费用"，也方便整块禁用。
 */
import { has, llmCandidates, get } from './config.js';

const TABLE = {
  deepseek: {
    url: process.env.DEEPSEEK_URL || 'https://api.deepseek.com/v1/chat/completions',
    model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    keyPath: 'deepseek.api.key',
  },
  gpt: {
    url: process.env.OPENAI_URL || 'https://api.openai.com/v1/chat/completions',
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    keyPath: 'gpt.api.key',
  },
  grok: {
    url: process.env.GROK_URL || 'https://api.x.ai/v1/chat/completions',
    model: process.env.GROK_MODEL || 'grok-2-latest',
    keyPath: 'grok.api.key',
  },
  gemini: {
    // Gemini 官方提供 OpenAI 兼容层，因此不用另写一套协议
    url: process.env.GEMINI_URL || 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    model: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
    keyPath: 'gemini.api.key',
  },
  doubao: {
    url: process.env.DOUBAO_URL || 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
    model: process.env.DOUBAO_MODEL || '',
    keyPath: 'doubao.api.key',
  },
};

/** 哪些 LLM 已配置 */
export function available() {
  const out = {};
  for (const name of Object.keys(TABLE)) out[name] = has(TABLE[name].keyPath);
  return out;
}

/** 至少有一个可用 */
export function anyAvailable() {
  return llmCandidates().length > 0;
}

async function chatOne(name, messages, { maxTokens = 2000, timeoutMs = 60000 } = {}) {
  const cfg = TABLE[name];
  if (!cfg) throw new Error('未知供应商: ' + name);
  const key = get(cfg.keyPath);
  if (!key) throw Object.assign(new Error(name + ' 未配置密钥'), { code: '<no-api-key>' });
  if (!cfg.model) throw Object.assign(new Error(name + ' 未指定模型（设 ' + name.toUpperCase() + '_MODEL）'), { code: '<no-model>' });

  const res = await fetch(cfg.url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: cfg.model, messages, temperature: 0.2, max_tokens: maxTokens }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw Object.assign(new Error(name + ' ' + res.status + ' ' + body.slice(0, 200)), { status: res.status });
  }
  const j = await res.json();
  const text = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  if (!text) throw new Error(name + ' 返回内容为空');
  return String(text);
}

/** 按优先级尝试，第一个成功即返回 */
export async function chat(messages, opt = {}) {
  const list = llmCandidates();
  if (!list.length) {
    throw Object.assign(new Error('没有可用的模型（请配置 deepseek / gpt / grok / gemini / doubao 任一 key）'), {
      code: '<no-llm>',
    });
  }
  let last = null;
  for (const name of list) {
    try {
      return { provider: name, text: await chatOne(name, messages, opt) };
    } catch (e) {
      last = e;
    }
  }
  throw last || new Error('所有模型都失败了');
}

/**
 * 给一批词补中文释义。
 * @param {string[]} words 英文词条
 * @returns {Promise<string[]>} 与输入等长；补不出来的位置为空串
 */
export async function translateWords(words) {
  const list = (words || []).map((w) => String(w == null ? '' : w).trim()).filter(Boolean);
  if (!list.length) return [];

  const sys = '你是英汉词典。用户给你一批英文词条，逐条给出最常用的中文释义（只给释义本身，不要例句、不要拼音、不要编号前缀）。';
  const ask = `请严格按顺序为下面每一行给出中文释义，输出**同样行数的纯文本**，每行格式为「序号|中文释义」，不要任何额外说明。\n\n${list
    .map((w, i) => `${i + 1}. ${w}`)
    .join('\n')}`;

  const { text } = await chat([
    { role: 'system', content: sys },
    { role: 'user', content: ask },
  ]);

  const out = new Array(list.length).fill('');
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*(\d+)\s*[|.、:：]\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    const idx = Number(m[1]) - 1;
    if (idx >= 0 && idx < out.length && !out[idx]) out[idx] = m[2].replace(/^[-–—:：\s]+/, '').trim();
  }
  return out;
}

export default { available, anyAvailable, chat, translateWords };
