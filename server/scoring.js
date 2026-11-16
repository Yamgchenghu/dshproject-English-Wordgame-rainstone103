/**
 * 计分引擎 —— 纯函数、无 I/O。
 * ==================================================================
 * 输入本组题目与本组作答，输出分数、达标与否、完成项与积分奖励。
 * 单独成文件的意义：计分口径必须唯一，测试能直接打桩，前端也能照抄断言。
 *
 * 三玖关（词）与三玖课文关（句）共用这套骨架，只有"大关奖励单价"不同：
 * 背 10 句的劳动量远超背 10 个词，按词的 0.1 算整篇只值 1 分，没人有动力背完。
 */

export const RULES = {
  FIRST: 10,                 // 第一次就答对
  SECOND: 7,                 // 第二次答对
  BORROWED_SECOND: 5,        // 借来的题目（已完成的）第二次答对只给 5 分
  FIRST_REWARD: 0.15,        // 计入完成的题，每个 +0.15 积分
  SECOND_REWARD: 0.03,       // 第二次才对的题，每个 +0.03 积分
  PERFECT_BONUS: 0.5,        // 本组满分额外奖励
  PASS_RATIO: 0.85,          // 达标线：85%（恰好 85% 也算达标）
  BIG_REWARD_PER_WORD: 0.1,  // 三玖关：全部词完成后 总词数 × 0.1
  BIG_REWARD_PER_SENTENCE: 0.5, // 三玖课文关：全部句完成后 总句数 × 0.5
};

/** 两位小数 */
export function round2(x) {
  return Math.round((Number(x) || 0) * 100) / 100;
}

/**
 * 判分用的归一化。
 *
 * 【标点不算错】真实词表里满是 "sb. is always complaining." / "have difficulty (in) doing"
 *   —— 让用户把每个点和括号都敲出来太苛刻，而且这些符号对"是否记住"没有判别意义。
 *   规则：标点一律当空格，再压缩空白。
 *   保留：字母、数字、汉字、撇号（someone else's）、连字符（well-known）。
 */
export function norm(s) {
  if (typeof s !== 'string') return '';
  return s
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^a-z0-9\u3400-\u9fff'\-\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 比较答案；空答案不判对，避免空输入被当成正确 */
export function isCorrect(input, answer) {
  const target = norm(answer);
  if (!target) return false;
  return norm(input) === target;
}

/**
 * 把一条答案拆成"多种可接受写法"。
 * 词表里同一个词会用 / 或 = 并列给出（oppose= be opposed to=object to），
 * 用户要求"哪个都行"。括号里的可选成分（have difficulty (in) doing）也一并放宽。
 *
 * ⚠ 课文**不用**这个函数：散文里的 `and/or`、`km/h` 是字面写法，
 *   按并列拆开会让用户敲 `and` 也算对。见 text 路由里的说明。
 */
export function answerVariants(answer) {
  const raw = String(answer == null ? '' : answer);
  const out = [];
  const push = (s) => {
    const v = norm(s);
    if (v && !out.includes(v)) out.push(v);
  };
  for (const part of raw.split(/[\/=]/)) {
    push(part);
    /*
     * 括号可选成分：`have difficulty (in) doing` 要能接受 `have difficulty doing`。
     *
     * 【必须在这里去掉括号，不能等 norm 之后】
     *   norm 会把 `(` `)` 当成标点换成空格 —— 归一化之后就再也找不到括号了，
     *   后面的"去括号"步骤永远等于原串、永远不生效。这个坑真实存在过：
     *   代码看起来处理了括号，实际一条都没放宽。
     */
    const noParen = part.replace(/\([^)]*\)/g, ' ');
    if (noParen !== part) push(noParen);
  }
  return out;
}

/** input 是否命中任一可接受写法 */
export function isCorrectAny(input, answer) {
  const got = norm(input);
  if (!got) return false;
  return answerVariants(answer).includes(got);
}

/**
 * 第一次答错后的提示：给出"从头到第一个错误点所在单词末尾"的正确内容；
 * 答案只有一个词时只给首字母。
 */
export function makeHint(answer, typed) {
  if (typeof answer !== 'string') return '';
  const first = String(answer).split(/[\/=]/)[0].trim() || answer;
  const words = first.split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  if (words.length === 1) return words[0][0];

  const got = norm(typed == null ? '' : typed);
  if (!got) return words[0];

  const want = norm(first);
  let i = 0;
  while (i < got.length && i < want.length && got[i] === want[i]) i++;
  let end = i;
  while (end < want.length && want[end] !== ' ') end++;
  return want.slice(0, end).trimEnd() || words[0];
}

/**
 * 本组结算。
 * items:   [{ id, borrowed? }]
 * answers: [{ id, correctAt: 0|1|2 }]  0=两次都错（0 分、亮答案跳过），1=第一次对，2=第二次对
 */
export function computeGroup({ items = [], answers = [] } = {}) {
  const list = Array.isArray(items) ? items : [];
  const given = Array.isArray(answers) ? answers : [];
  // 词用 wid、句用 sid；两者都支持的代价只是这一行
  const firstItem = list[0] || {};
  const idKey = 'wid' in firstItem ? 'wid' : ('sid' in firstItem ? 'sid' : 'id');

  const byId = new Map();
  for (const a of given) {
    if (a && typeof a[idKey] === 'string') byId.set(a[idKey], a);
  }

  let score = 0;
  const firstTry = [];
  const secondTry = [];

  for (const item of list) {
    if (!item || typeof item[idKey] !== 'string') continue;
    const ans = byId.get(item[idKey]);
    const at = ans ? ans.correctAt : 0;
    const borrowed = item.borrowed === true;

    if (at === 1) {
      score += RULES.FIRST;
      if (!borrowed) firstTry.push(item[idKey]); // 借来的题早已完成，不计完成也不发奖励
    } else if (at === 2) {
      score += borrowed ? RULES.BORROWED_SECOND : RULES.SECOND;
      if (!borrowed) secondTry.push(item[idKey]);
    }
  }

  const fullMark = list.length * RULES.FIRST;
  // 先各自归一到两位再比，避免浮点尾差吃掉"恰好达标"这个边界
  const passed = fullMark > 0 && round2(score) >= round2(fullMark * RULES.PASS_RATIO);

  if (!passed) {
    return {
      score, fullMark, passed: false,
      firstTry: [], secondTry: [],
      points: { first: 0, second: 0, perfect: 0, total: 0 },
    };
  }

  const first = round2(firstTry.length * RULES.FIRST_REWARD);
  const second = round2(secondTry.length * RULES.SECOND_REWARD);
  const perfect = score === fullMark ? RULES.PERFECT_BONUS : 0;

  return {
    score, fullMark, passed: true,
    firstTry, secondTry,
    points: { first, second, perfect, total: round2(first + second + perfect) },
  };
}

/**
 * 大关结算：全部完成才一次性发奖。
 * @param {{total:number, completed:number, per:number}} o  per = 每题的积分单价
 */
export function computeBigReward({ total = 0, completed = 0, per = RULES.BIG_REWARD_PER_WORD } = {}) {
  const t = Number(total) || 0;
  const d = Number(completed) || 0;
  const allCompleted = t > 0 && d >= t;
  return {
    allCompleted,
    bigReward: allCompleted ? round2(t * per) : 0,
  };
}

export default {
  RULES, round2, norm, isCorrect, answerVariants, isCorrectAny, makeHint, computeGroup, computeBigReward,
};
