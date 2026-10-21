/*
 * Bilingual Reader —— Obsidian 译读插件
 *
 * 一键把当前笔记译为指定语言，原文永不改动。
 * 核心能力：
 *   - 三种翻译引擎：Google / DeepL / OpenAI 兼容 LLM，请求由 Obsidian 主进程直接发出。
 *   - 按 Markdown 块解析 + 行内保护（链接 / 图片 / 行内代码不译）、译文首行回链原文。
 *   - 生成「左右对照」与「上下对照」两种副本，生成后主动左右分屏。
 *   - 常驻进度提示（翻译中 X%）。
 *   - 多 LLM 厂商：可配置多个 OpenAI 兼容厂商 / 模型，选择默认厂商，运行时可切换。
 */

const { Plugin, Notice, requestUrl, TFile, PluginSettingTab, Setting, SuggestModal, normalizePath } = require('obsidian');

// ribbon 图标沿用 Obsidian 内置 Lucide 图标集中的 languages（笔画 + A 的翻译通用符号），
// 无需自定义 SVG，描边与圆角天然与其他图标一致，且自动适配深色模式与各类主题。
const RIBBON_ICON = 'languages';

const DEFAULTS = {
  provider: 'llm',            // google | deepl | llm
  targetLang: 'zh-CN',        // 译文目标语言，取值见 LANGUAGES
  deeplKey: '',
  deeplPro: false,
  // 多 LLM 厂商列表。字段：id/name/endpoint/key/model/thinking
  providers: [],
  defaultProviderId: 'default',
  mode: 'both',               // both | zh | bilingual
  autoSplit: true,            // 生成后主动左右分屏（左原文 / 右译文）
  openMode: 'preview',        // 译文打开模式：preview(阅读) | source(源码) | current(沿用原文模式)
  concurrency: 4,             // 逐块并发数
};

const CONCURRENCY_MAX = 8;

// 首次安装时预置的厂商模板：仅填接口地址与模型，Key 留空由用户自行填写。
const PRESET_PROVIDER = {
  id: 'default',
  name: 'DeepSeek',
  endpoint: 'https://api.deepseek.com',
  key: '',
  model: 'deepseek-v4-flash',
  thinking: false,
};

// ---------------------------------------------------------------- 目标语言表
// key 为规范键（同时存入 settings.targetLang）；google/deepl 为各后端代码；label 用于 LLM 提示与 UI 展示。
const LANGUAGES = {
  'zh-CN': { label: '简体中文', google: 'zh-CN', deepl: 'ZH' },
  'zh-TW': { label: '繁體中文', google: 'zh-TW', deepl: 'ZH' },
  'en':    { label: 'English',  google: 'en',    deepl: 'EN' },
  'ja':    { label: '日本語',    google: 'ja',    deepl: 'JA' },
  'ko':    { label: '한국어',     google: 'ko',    deepl: 'KO' },
  'fr':    { label: 'Français',  google: 'fr',    deepl: 'FR' },
  'de':    { label: 'Deutsch',   google: 'de',    deepl: 'DE' },
  'es':    { label: 'Español',   google: 'es',    deepl: 'ES' },
  'ru':    { label: 'Русский',   google: 'ru',    deepl: 'RU' },
  'pt':    { label: 'Português', google: 'pt',    deepl: 'PT' },
  'it':    { label: 'Italiano',  google: 'it',    deepl: 'IT' },
};
function langLabel(key) { return (LANGUAGES[key] && LANGUAGES[key].label) || key || '简体中文'; }
function googleLang(key) { return (LANGUAGES[key] && LANGUAGES[key].google) || key || 'zh-CN'; }
function deeplLang(key) { return (LANGUAGES[key] && LANGUAGES[key].deepl) || (key || '').toUpperCase(); }
// 译文文件后缀：简体中文用简短的 zh（而非 zh-CN），其余语言直接用语言键（ja / en / fr …）。
function fileSuffix(key) { return key === 'zh-CN' ? 'zh' : (LANGUAGES[key] ? key : 'zh'); }

// ---------------------------------------------------------------- 厂商解析
function getProvider(s, id) {
  const list = s.providers || [];
  return list.find((p) => p.id === id) ||
    list.find((p) => p.id === s.defaultProviderId) ||
    list[0] || null;
}

// 译文文件打开时的视图模式：preview(默认阅读) / source(源码) / current(沿用原文 leaf 当前模式)
function fileOpenState(s, srcLeaf) {
  if (s.openMode === 'source') return { mode: 'source' };
  if (s.openMode === 'current' && srcLeaf && typeof srcLeaf.getViewState === 'function') {
    try {
      const st = srcLeaf.getViewState();
      const m = st && st.state && st.state.mode;
      if (m === 'source' || m === 'preview') return { mode: m };
    } catch (e) { /* 读取失败则回退预览 */ }
  }
  return { mode: 'preview' };
}

// ---------------------------------------------------------------- 行内保护
// 把链接 / 图片 / 行内代码替换成占位符，翻译完再还原，避免被机翻破坏。
//
// 占位符格式：⟦T0⟧ / ⟦T1⟧ …
// 之所以不用「空格 + 数字 + 空格」：原文里天然存在的数字（如 "index 0 is first"）
// 会被还原逻辑误判为占位符，把无关数字替换成链接内容，直接损坏正文。
// U+27E6/U+27E7 数学括号在正文中几乎不会出现，且多数翻译引擎会原样保留。
const PH_OPEN = '\u27E6';
const PH_CLOSE = '\u27E7';
// 还原时容忍引擎在括号 / 字母 / 数字之间插入空格（部分引擎会加空格）。
const PH_RESTORE_RE = new RegExp(PH_OPEN + '\\s*T\\s*(\\d+)\\s*' + PH_CLOSE, 'g');

function protectInline(text) {
  const store = [];
  const ph = (m) => { store.push(m); return PH_OPEN + 'T' + (store.length - 1) + PH_CLOSE; };
  // 顺序有讲究：图片 ![](...) 必须先于普通链接 [](...)，否则前缀 ! 会被留在正文里。
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, ph);
  text = text.replace(/\[[^\]]*\]\([^)]*\)/g, ph);
  // Obsidian 内链 [[note|alias]] / ![[embed]]：翻译会破坏笔记名导致链接失效，必须整体保护。
  text = text.replace(/!?\[\[[^\]]*\]\]/g, ph);
  // 行内代码：允许多重反引号定界（``a`b``），且不跨行匹配。
  text = text.replace(/(`+)[^`\n]*?\1/g, ph);
  return { text, store };
}

function restoreInline(translated, store) {
  return translated.replace(PH_RESTORE_RE, (m, k) => (store[+k] != null ? store[+k] : m));
}

// ---------------------------------------------------------------- 块解析
// 表格分隔行（含对齐语法）：|---|---| 、| :-: | ---: | 等。
// 注意不能只测 /---\|?/：对齐行 | :-: | :-: | 里没有连续三个减号，会漏判导致整张表被当成段落逐格机翻。
const TABLE_DELIM_RE = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/;
const LIST_ITEM_RE = /^(\s*)([-*+]|\d+\.)\s+/;

function parseBlocks(md) {
  const lines = md.split('\n');
  const blocks = [];
  let i = 0;
  if (lines[0] != null && lines[0].trim() === '---') {
    // 结束行同样按 trim 判定，容忍 '--- ' 这类尾随空格；找不到结束行则整篇视为 frontmatter 太激进，
    // 故回退为「只把首行当普通内容」，避免整篇不翻译。
    let end = -1;
    for (let k = 1; k < lines.length; k++) {
      if (lines[k].trim() === '---') { end = k; break; }
    }
    if (end !== -1) {
      blocks.push({ type: 'frontmatter', raw: lines.slice(0, end + 1).join('\n') });
      i = end + 1;
    }
  }
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') { blocks.push({ type: 'blank', raw: '' }); i++; continue; }
    const fence = line.match(/^(\s*)(```+|~~~+)/);
    if (fence) {
      const indent = fence[1];
      const closing = fence[2];
      let j = i + 1;
      // 关闭行可能带缩进（列表内的代码块），必须 trim 后再比对；
      // 只用 startsWith(closing) 会漏掉 '    ```'，导致代码块一路吞到文末。
      while (j < lines.length && !lines[j].trim().startsWith(closing)) j++;
      blocks.push({ type: 'code', indent, raw: lines.slice(i, Math.min(j + 1, lines.length)).join('\n') });
      i = j + 1; continue;
    }
    if (line.trim().startsWith('|') && TABLE_DELIM_RE.test(lines[i + 1] || '')) {
      let j = i;
      while (j < lines.length && lines[j].trim().startsWith('|')) j++;
      blocks.push({ type: 'table', raw: lines.slice(i, j).join('\n') });
      i = j; continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { blocks.push({ type: 'heading', prefix: h[1] + ' ', text: h[2] }); i++; continue; }
    if (/^\s*>/.test(line)) {
      let j = i;
      while (j < lines.length && /^\s*>/.test(lines[j])) j++;
      blocks.push({ type: 'quote', raw: lines.slice(i, j).join('\n') });
      i = j; continue;
    }
    if (LIST_ITEM_RE.test(line)) {
      let j = i + 1;
      // 列表项的续行（懒惰延续）没有 '- ' 前缀，只有缩进。若不并入，续行会被切成独立段落，
      // 翻译后插到列表中间破坏结构。遇到空行或新的块级起始才结束。
      while (j < lines.length) {
        const cur = lines[j];
        if (cur.trim() === '') break;
        if (LIST_ITEM_RE.test(cur)) { j++; continue; }
        if (/^(\s*)(```+|~~~+)/.test(cur) || /^#{1,6}\s/.test(cur) || /^\s*>/.test(cur)) break;
        if (/^\s+\S/.test(cur)) { j++; continue; } // 缩进续行
        break;
      }
      blocks.push({ type: 'list', raw: lines.slice(i, j).join('\n') });
      i = j; continue;
    }
    let j = i;
    while (j < lines.length && lines[j].trim() !== '' &&
      !/^(\s*)(```+|~~~+)/.test(lines[j]) && !/^#{1,6}\s/.test(lines[j]) &&
      !/^\s*>/.test(lines[j]) && !LIST_ITEM_RE.test(lines[j])) j++;
    blocks.push({ type: 'paragraph', raw: lines.slice(i, j).join('\n') });
    i = j; continue;
  }
  return blocks;
}

// ---------------------------------------------------------------- 翻译后端
// 网络层重试：长文档会把并发打到上游，429（限流）与 5xx（服务端抖动）是最常见的失败原因，
// 且都是可恢复的——不重试会让整篇翻译因为一个瞬时错误而失败。
const RETRY_MAX = 3;
const RETRY_BASE_MS = 800;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isRetryableStatus(status) {
  return status === 429 || status === 408 || (status >= 500 && status < 600);
}

// requestUrl 对非 2xx 默认会 throw，需 throw: false 才能自行判定状态码并决定是否重试。
async function requestWithRetry(options, label) {
  let lastErr = null;
  for (let attempt = 0; attempt <= RETRY_MAX; attempt++) {
    if (attempt > 0) await sleep(RETRY_BASE_MS * Math.pow(2, attempt - 1));
    try {
      const res = await requestUrl(Object.assign({}, options, { throw: false }));
      if (isRetryableStatus(res.status) && attempt < RETRY_MAX) {
        lastErr = new Error(label + ' HTTP ' + res.status);
        continue;
      }
      return res;
    } catch (e) {
      // 网络层异常（断网、DNS、超时）同样可重试
      lastErr = e;
      if (attempt >= RETRY_MAX) break;
    }
  }
  throw lastErr || new Error(label + ' 请求失败');
}

async function viaGoogle(text, tl) {
  const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=' + tl + '&dt=t&q=' + encodeURIComponent(text);
  const res = await requestWithRetry({ url, method: 'GET' }, 'Google');
  if (res.status !== 200) throw new Error('Google HTTP ' + res.status);
  const data = res.json;
  let out = '';
  if (Array.isArray(data) && Array.isArray(data[0])) for (const s of data[0]) if (s && s[0]) out += s[0];
  if (!out) throw new Error('Google 返回空');
  return out;
}

async function viaDeepl(text, s) {
  const host = s.deeplPro ? 'https://api.deepl.com' : 'https://api-free.deepl.com';
  const res = await requestWithRetry({
    url: host + '/v2/translate', method: 'POST',
    headers: { Authorization: 'DeepL-Auth-Key ' + s.deeplKey, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'target_lang=' + deeplLang(s.targetLang) + '&text=' + encodeURIComponent(text),
  }, 'DeepL');
  if (res.status !== 200) {
    // 456 是 DeepL 的配额耗尽，单独提示，避免用户误以为是 Key 错误
    if (res.status === 456) throw new Error('DeepL 本月免费额度已用尽 (456)');
    if (res.status === 403) throw new Error('DeepL 鉴权失败，请检查 API Key 与 Pro 开关 (403)');
    throw new Error('DeepL HTTP ' + res.status);
  }
  const t = res.json && res.json.translations && res.json.translations[0];
  if (!t || !t.text) throw new Error('DeepL 返回异常 (' + res.status + ')');
  return t.text;
}
function llmSystemFrag(label) {
  return '你是翻译引擎。把用户提供的英文（或其他语言）Markdown 片段翻译为' + label + '。硬性规则：' +
    '1) 仅输出译文本身，绝对不要输出任何解释、说明、思考过程、前缀（如『译文：』）或代码块包裹；' +
    '2) 保留所有 Markdown 语法符号（#、-、>、|、*、`、~ 等）不动；' +
    '3) 形如 ' + PH_OPEN + 'T0' + PH_CLOSE + '、' + PH_OPEN + 'T1' + PH_CLOSE +
    ' 的占位符是受保护内容，必须原样逐字符输出，不得翻译、改写、增删空格或调整其中的编号；' +
    '4) 链接 URL、图片路径、代码内容不翻译；' +
    '5) 如果输入已经是' + label + '或无实质内容，原样返回。';
}
async function viaLlm(text, lp, targetLabel) {
  const body = {
    model: lp.model,
    temperature: 0.2,
    messages: [
      { role: 'system', content: llmSystemFrag(targetLabel) },
      { role: 'user', content: text },
    ],
  };
  // 推理开关厂商字段不统一：阿里云 qwen 系用 enable_thinking，DeepSeek V4 系用 thinking.type。
  // 同时下发两个字段（都是 OpenAI 之外的扩展字段，不支持的厂商会忽略），避免用户不知道该开哪个。
  if (lp.thinking) {
    body.enable_thinking = true;
    body.thinking = { type: 'enabled' };
  }
  const res = await requestWithRetry({
    url: lp.endpoint.replace(/\/+$/, '') + '/chat/completions', method: 'POST',
    headers: { Authorization: 'Bearer ' + lp.key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, 'LLM');
  if (res.status !== 200) {
    let detail = '';
    try { detail = JSON.stringify(res.json || '').slice(0, 300); } catch (e) { /* 响应体不是 JSON 时忽略 */ }
    if (res.status === 401) throw new Error('LLM 鉴权失败，请检查 API Key (401)');
    if (res.status === 429) throw new Error('LLM 触发限流，已重试仍失败，建议降低并发数 (429)');
    throw new Error('LLM HTTP ' + res.status + ' ' + detail);
  }
  const j = res.json;
  if (!j || j.error) throw new Error('LLM 返回错误：' + (j && j.error && j.error.message ? j.error.message : JSON.stringify(j && j.error)));
  const out = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  if (!out) throw new Error('LLM 返回空 (' + res.status + ')');
  // 去掉模型偶发添加的「译文：」类前缀；字符类 [结果] 原为笔误（等价于 [结]|[果]|[]），此处改为分组
  return out.trim().replace(/^(翻译(结果)?[:：]|以下是翻译[:：]|译文[:：])\s*/i, '').trim() || text;
}

// 非 LLM 引擎：按长度分块，避免单次超长被拒。
// 三级降级：段落 -> 句子 -> 硬切，保证任何输入都不会产出超过 max 的分片
// （旧实现只按 \n\n 分段后重组，单个超长段落会原样返回，直接突破 Google/DeepL 的长度上限）。
function hardSplit(text, max) {
  const out = [];
  for (let i = 0; i < text.length; i += max) out.push(text.slice(i, i + max));
  return out;
}

// 中英文句末标点后切分，保留标点本身。
// 不用 lookbehind（/(?<=[。！？；.!?;])\s*/）：lookbehind 在 iOS 16.4 以下的 Safari 上不被支持，
// 而本插件 isDesktopOnly=false，移动端必须能跑，故改为逐字符扫描，语义等价且无兼容性风险。
const SENTENCE_END = '。！？；.!?;';

function splitBySentence(text, max) {
  if (text.length <= max) return [text];
  const sentences = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (SENTENCE_END.indexOf(text[i]) !== -1) {
      sentences.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) sentences.push(text.slice(start));
  const out = [];
  let cur = '';
  for (const sentence of sentences) {
    if (sentence.length > max) {
      if (cur) { out.push(cur); cur = ''; }
      out.push(...hardSplit(sentence, max));
      continue;
    }
    if (cur && (cur + sentence).length > max) { out.push(cur); cur = sentence; }
    else cur += sentence;
  }
  if (cur) out.push(cur);
  return out;
}

function chunkText(text, max) {
  if (text.length <= max) return [text];
  const ps = text.split(/\n\n+/);
  const cs = [];
  let c = '';
  for (const p of ps) {
    // 单段本身就超限：先冲掉累积内容，再对该段做句子级/硬切降级
    if (p.length > max) {
      if (c) { cs.push(c); c = ''; }
      cs.push(...splitBySentence(p, max));
      continue;
    }
    if (c && (c + '\n\n' + p).length > max) { cs.push(c); c = p; }
    else c = c ? c + '\n\n' + p : p;
  }
  if (c) cs.push(c);
  return cs;
}

async function translateText(text, s, lp) {
  if (!text || !text.trim()) return text;
  const { text: masked, store } = protectInline(text);
  let out;
  if (s.provider === 'llm') {
    out = await viaLlm(masked, lp, langLabel(s.targetLang));
  } else if (s.provider === 'deepl') {
    const parts = chunkText(masked, 4000);
    const tr = [];
    for (const p of parts) tr.push(await viaDeepl(p, s));
    out = tr.join('\n\n');
  } else {
    const parts = chunkText(masked, 1200);
    const tr = [];
    for (const p of parts) tr.push(await viaGoogle(p, googleLang(s.targetLang)));
    out = tr.join('\n\n');
  }
  return restoreInline(out, store);
}

async function translateBlock(block, s, lp) {
  if (block.type === 'frontmatter' || block.type === 'code' || block.type === 'blank')
    return { original: block.raw, translated: block.raw };
  if (block.type === 'heading') {
    const t = await translateText(block.text, s, lp);
    return { original: block.prefix + block.text, translated: block.prefix + t };
  }
  if (block.type === 'quote') {
    // 去掉每行 > 前缀，保留缩进与空行，翻译后加回前缀。
    // 前缀里必须用 [ \t] 而不是 \s：\s 会匹配换行，'>' 空行会连同行尾换行一起被吃掉，
    // 导致引用块内的段落分隔丢失（两段被并成一段）。
    const prefixMatch = block.raw.match(/^([ \t]*)>/);
    const blockIndent = prefixMatch ? prefixMatch[1] : '';
    const inner = block.raw.replace(/^[ \t]*>[ \t]?/gm, '');
    const t = await translateText(inner, s, lp);
    const lines = t.split('\n');
    // 空行只保留 '>' 而不加尾随空格，既维持引用块连续性又不产生 '> ' 脏行
    const reconstructed = lines.map((l) => l.trim() === '' ? blockIndent + '>' : blockIndent + '> ' + l).join('\n');
    return { original: block.raw, translated: reconstructed };
  }
  if (block.type === 'list') {
    const lines = block.raw.split('\n');
    // 各行相互独立，串行 await 会让长列表的耗时随行数线性增长；这里并发发起、按序回填。
    const translated = await Promise.all(lines.map(async (l) => {
      const m = l.match(/^(\s*(?:[-*+]|\d+\.)\s+)(.*)$/);
      if (m) return m[1] + (await translateText(m[2], s, lp));
      if (l.trim() === '') return l;
      // 续行：保留原缩进，只翻译文本
      const cont = l.match(/^(\s+)(.*)$/);
      if (cont) return cont[1] + (await translateText(cont[2], s, lp));
      return await translateText(l, s, lp);
    }));
    return { original: block.raw, translated: translated.join('\n') };
  }
  if (block.type === 'table') {
    const rows = block.raw.split('\n');
    const translated = await Promise.all(rows.map(async (row) => {
      // 分隔行（含 | :-: | 这类对齐语法）原样保留，不能翻译也不能重排
      if (TABLE_DELIM_RE.test(row)) return row;
      // split('|') 会在首尾产生空串（'| a | b |' -> ['', 'a', 'b', '']）。
      // 直接 join 会重建出 '|  | a | b |  |' 这样多两个空列的坏表格，故先剥掉首尾空元素。
      const parts = row.split('|');
      if (parts.length && parts[0].trim() === '') parts.shift();
      if (parts.length && parts[parts.length - 1].trim() === '') parts.pop();
      const cells = await Promise.all(parts.map(async (c) => {
        const trimmed = c.trim();
        return trimmed ? await translateText(trimmed, s, lp) : trimmed;
      }));
      return '| ' + cells.join(' | ') + ' |';
    }));
    return { original: block.raw, translated: translated.join('\n') };
  }
  const t = await translateText(block.raw, s, lp);
  return { original: block.raw, translated: t };
}

// 并发控制
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const cur = idx++;
      results[cur] = await fn(items[cur], cur);
    }
  }
  const workers = [];
  const n = Math.max(1, Math.min(limit, items.length));
  for (let i = 0; i < n; i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}
// 逐块并发翻译整篇文档。done 单调递增计数（而非块序号），保证进度提示不回跳。
// 容错策略：单块失败时保留原文而非中断整篇——一篇长文里某个块触发上游异常不该让前面
// 所有已完成的翻译白费。失败块数通过 failures 返回，由调用方决定如何提示用户。
async function translateDocument(src, s, lp, onProgress) {
  const blocks = parseBlocks(src);
  // blank / code / frontmatter 是原样复制的，不发请求
  const isPassthrough = (b) => b.type === 'blank' || b.type === 'code' || b.type === 'frontmatter';
  let done = 0;
  let failures = 0;
  let firstError = null;
  const total = blocks.length;
  // 进度分母只统计真正需要翻译的块：把原样复制的块算进分母，会让「19/19 块」
  // 这类提示明显高于实际工作量，用户会误判进度。
  const billable = blocks.filter((b) => !isPassthrough(b)).length;
  const limit = Math.min(CONCURRENCY_MAX, Math.max(1, s.concurrency || 4));
  const results = await mapWithConcurrency(blocks, limit, async (b) => {
    let r;
    try {
      r = await translateBlock(b, s, lp);
    } catch (e) {
      failures += 1;
      if (!firstError) firstError = e;
      console.error('[bilingual-reader] 块翻译失败，保留原文：', e);
      const raw = b.type === 'heading' ? b.prefix + b.text : b.raw;
      r = { original: raw, translated: raw };
    }
    if (!isPassthrough(b)) {
      done += 1;
      if (onProgress) onProgress(Math.min(done, billable), billable);
    }
    return r;
  });
  return { results, failures, total, billable, firstError };
}

// ---------------------------------------------------------------- 运行时厂商选择弹窗
class ProviderSuggestModal extends SuggestModal {
  constructor(app, providers, onChoose) {
    super(app);
    this.providers = providers;
    this.onChoose = onChoose;
    this.setPlaceholder('选择 LLM 厂商 / 模型进行翻译');
  }
  getSuggestions(query) {
    const q = query.toLowerCase();
    return this.providers.filter((p) =>
      (p.name || '').toLowerCase().includes(q) || (p.model || '').toLowerCase().includes(q));
  }
  renderSuggestion(p, el) {
    el.createEl('div', { text: p.name || '未命名' });
    el.createEl('small', { text: ' · ' + (p.model || '') });
  }
  onChooseSuggestion(p) { this.onChoose(p); }
}

// ---------------------------------------------------------------- 插件主体
module.exports = class BilingualReader extends Plugin {
  async onload() {
    const data = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULTS, data);
    // providers 是数组：浅拷贝会与 DEFAULTS 共享同一引用，后续 push 将污染 DEFAULTS，故必须另建数组。
    this.settings.providers = Array.isArray(data.providers) ? data.providers.slice() : [];
    this.editProviderId = null; // 设置面板中正在编辑的厂商（不持久化）

    // 首次启用时预置一个厂商模板，保证厂商列表与默认厂商 id 始终有效。
    if (this.settings.providers.length === 0) {
      this.settings.providers.push(Object.assign({}, PRESET_PROVIDER));
    }
    if (!this.settings.providers.some((p) => p.id === this.settings.defaultProviderId)) {
      this.settings.defaultProviderId = this.settings.providers[0].id;
    }
    await this.saveData(this.settings);

    this.addRibbonIcon(RIBBON_ICON, '译读（原文不动，左右分屏）', () => this.run({ mode: this.settings.mode }));

    // 不设默认热键：默认热键容易和用户已有配置或其他插件冲突，且很难挑到跨平台都空闲的组合。
    // 需要的用户可在 设置 → 快捷键 里自行绑定。
    this.addCommand({
      id: 'translate-bilingual',
      name: '译读（左右分屏）',
      callback: () => this.run({ mode: this.settings.mode }),
    });
    this.addCommand({
      id: 'translate-zh-only',
      name: '仅译文副本（左右分屏）',
      callback: () => this.run({ mode: 'zh' }),
    });
    this.addCommand({
      id: 'translate-bilingual-only',
      name: '仅上下对照副本',
      callback: () => this.run({ mode: 'bilingual' }),
    });
    this.addCommand({
      id: 'translate-with-provider',
      name: '用指定厂商翻译（左右分屏）',
      callback: () => {
        const list = this.settings.providers || [];
        if (!list.length) { new Notice('请先在 设置 → 译读 添加 LLM 厂商', 10000); return; }
        new ProviderSuggestModal(this.app, list, (p) => this.run({ mode: this.settings.mode, providerId: p.id })).open();
      },
    });

    this.addSettingTab(new BilingualSettingTab(this.app, this));
  }

  async writeFile(path, content) {
    // normalizePath 会把重复斜杠、反斜杠、首尾斜杠规整掉，跨平台建文件才不会出现非法路径。
    const p = normalizePath(path);
    const ex = this.app.vault.getAbstractFileByPath(p);
    if (ex instanceof TFile) {
      // 已存在时用 process 原子写入，避免和用户或其他插件同时改这个文件时互相覆盖。
      await this.app.vault.process(ex, () => content);
      return ex;
    }
    return await this.app.vault.create(p, content);
  }

  async run(opts) {
    const s = this.settings;
    const file = this.app.workspace.getActiveFile();
    if (!file) { new Notice('没有打开的笔记，请先打开要翻译的英文笔记'); return; }

    // 译文副本后缀：中文=zh，其余=语言键（ja/en/fr…），上下对照面恒为 .bilingual。
    const suf = fileSuffix(s.targetLang);
    // 拦住「对译文副本再翻一次」：否则会产出 xxx.zh.zh.md / xxx.bilingual.bilingual.md 这类垃圾文件。
    if (file.basename.endsWith('.bilingual') || file.basename.endsWith('.' + suf)) {
      new Notice('当前笔记（' + file.basename + '）已是译文副本，请对原文执行译读', 8000);
      return;
    }

    const lp = s.provider === 'llm' ? getProvider(s, opts && opts.providerId) : null;
    if (s.provider === 'llm' && (!lp || !lp.key)) {
      new Notice('未配置 LLM API Key：请到 设置 → 译读 填写（或先用「用指定 LLM 厂商翻译」选择已配置厂商）', 10000);
      return;
    }
    if ((s.provider === 'deepl') && !s.deeplKey) {
      new Notice('未配置 DeepL API Key：请到 设置 → 译读 填写', 10000);
      return;
    }

    const engineLabel = s.provider === 'llm' ? (lp ? lp.name : 'llm') : s.provider;
    const notice = new Notice('译读：开始（引擎=' + engineLabel + '）…', 0); // 0 = 常驻
    // 进度用百分比而非「n/m 块」：块数是内部切分粒度，用户无从判断 3/120 和 3/12 的差别，
    // 百分比才直接回答「还要等多久」。用 floor 而非 round，避免 199/200 四舍五入成 100% 却仍在跑。
    const onProgress = (done, total) => {
      if (!notice) return;
      const pct = total > 0 ? Math.floor((done / total) * 100) : 0;
      notice.setMessage('译读：翻译中 ' + pct + '%');
    };
    const finish = (msg) => {
      if (notice) {
        notice.setMessage(msg);
        setTimeout(() => { try { notice.hide(); } catch (e) { /* ignore */ } }, 8000);
      } else new Notice(msg);
    };

    try {
      const raw = await this.app.vault.read(file);
      const base = file.basename;
      const dir = (file.parent && file.parent.path && file.parent.path !== '/') ? file.parent.path + '/' : '';
      const mode = (opts && opts.mode) || s.mode;

      const { results, failures, billable, firstError } = await translateDocument(raw, s, lp, onProgress);
      // 需要翻译的块全部失败，说明是系统性问题（Key 失效、断网、配额耗尽），
      // 此时生成一份全是原文的「译文」毫无意义，直接抛错让用户去修配置。
      // 注意分母必须用 billable 而非 total：total 含 blank/code 等从不失败的块，用它比较永远不成立。
      if (billable > 0 && failures === billable) {
        throw firstError || new Error('所有内容块翻译均失败，请检查网络与 API 配置');
      }
      // blank 块本身就代表一个空行，若与其他块一样用 '\n\n' 相连会把每处段落间距翻倍。
      // 故先过滤掉 blank，由 join('\n\n') 统一提供段落分隔。
      const solid = results.filter((r) => r.original !== '' || r.translated !== '');
      const transNote = solid.map((r) => r.translated).join('\n\n');
      const biNote = solid.map((r) => r.original + '\n\n' + r.translated).join('\n\n');
      const srcLink = '[[' + base + '|原文]]'; // 首行相对链接，点击跳回原文笔记

      let transFile = null, biFile = null;
      if (mode === 'zh') {
        transFile = await this.writeFile(dir + base + '.' + suf + '.md', srcLink + '\n\n' + transNote);
      } else if (mode === 'bilingual') {
        biFile = await this.writeFile(dir + base + '.bilingual.md', srcLink + '\n\n' + biNote);
      } else {
        transFile = await this.writeFile(dir + base + '.' + suf + '.md', srcLink + '\n\n' + transNote);
        biFile = await this.writeFile(dir + base + '.bilingual.md', srcLink + '\n\n' + biNote);
      }

      // 主动左右分屏：左原文 / 右译文。
      // 用 getLeaf('split', 'vertical')：第二个参数 'vertical' 表示新窗格出现在右侧（左右并排）。
      // 不用已废弃的 splitActiveLeaf()/activeLeaf——getLeaf('vertical') 把 'vertical' 当 PaneType
      // 是站不住的写法（PaneType 只有 tab/split/window），会退化成普通标签页而分不出屏。
      const srcLeaf = this.app.workspace.getMostRecentLeaf(); // 原文所在叶，替代已废弃的 activeLeaf
      const openState = fileOpenState(s, srcLeaf);
      if (s.autoSplit && transFile) {
        const newLeaf = this.app.workspace.getLeaf('split', 'vertical'); // 右侧新列
        await newLeaf.openFile(transFile, { active: false, state: openState }); // 译文按 openMode 打开
        if (srcLeaf) this.app.workspace.setActiveLeaf(srcLeaf); // 焦点回到左原文
      } else if (transFile) {
        const l = this.app.workspace.getLeaf(true);
        await l.openFile(transFile, { state: openState });
      } else if (biFile) {
        const l = this.app.workspace.getLeaf(true);
        await l.openFile(biFile, { state: openState });
      }

      const names = [];
      if (transFile) names.push(base + '.' + suf);
      if (biFile) names.push(base + '.bilingual');
      let msg = '已生成对照笔记：' + names.join(' / ');
      if (failures > 0) msg += '（' + failures + '个块翻译失败，已保留原文）';
      finish(msg);
    } catch (e) {
      if (notice) { try { notice.hide(); } catch (err) { /* ignore */ } }
      new Notice('翻译失败：' + (e && e.message ? e.message : e), 15000);
      console.error('[bilingual-reader]', e);
    }
  }
};

class BilingualSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl: c } = this;
    c.empty();
    const s = this.plugin.settings;
    const save = () => this.plugin.saveData(s);

    new Setting(c).setName('翻译引擎').setDesc('Google 免费免配置；DeepL/LLM 质量更好，需要 Key。LLM 支持多厂商（见下方）')
      .addDropdown((d) => d.addOption('google', 'Google（免费）').addOption('deepl', 'DeepL').addOption('llm', 'LLM（OpenAI 兼容，多厂商）')
        .setValue(s.provider).onChange((v) => { s.provider = v; save(); this.display(); }));

    new Setting(c).setName('目标语言').setDesc('译文目标语言（简体中文 / 繁体中文 / English / 日本語 / 한국어 / Français / Deutsch / Español / Русский / Português / Italiano）')
      .addDropdown((d) => {
        Object.keys(LANGUAGES).forEach((k) => d.addOption(k, LANGUAGES[k].label + ' (' + k + ')'));
        d.setValue(s.targetLang in LANGUAGES ? s.targetLang : 'zh-CN').onChange((v) => { s.targetLang = v; save(); });
      });

    if (s.provider === 'deepl') {
      new Setting(c).setName('DeepL API Key').addText((t) => {
        t.setValue(s.deeplKey).onChange((v) => { s.deeplKey = v.trim(); save(); });
        t.inputEl.type = 'password'; // 不明文显示 Key，避免录屏/共享屏幕时泄露
        t.inputEl.autocomplete = 'off';
      });
      new Setting(c).setName('DeepL Pro 账户').setDesc('付费版打开（用 api.deepl.com）')
        .addToggle((t) => t.setValue(s.deeplPro).onChange((v) => { s.deeplPro = v; save(); }));
    }

    // ---- LLM 多厂商管理 ----
    if (s.provider === 'llm') {
      const list = s.providers;
      if (!this.plugin.editProviderId || !list.some((p) => p.id === this.plugin.editProviderId)) {
        this.plugin.editProviderId = s.defaultProviderId || (list[0] && list[0].id);
      }

      new Setting(c).setName('默认 LLM 厂商（用于翻译）').setDesc('翻译时默认使用的厂商/模型；可随时在此切换')
        .addDropdown((d) => {
          list.forEach((p) => d.addOption(p.id, p.name || p.model || p.id));
          d.setValue(s.defaultProviderId).onChange((v) => { s.defaultProviderId = v; save(); });
        });

      new Setting(c).setName('编辑厂商配置').setDesc('选择要查看/修改的厂商；可新增或删除')
        .addDropdown((d) => {
          list.forEach((p) => d.addOption(p.id, p.name || p.model || p.id));
          d.setValue(this.plugin.editProviderId).onChange((v) => { this.plugin.editProviderId = v; this.display(); });
        })
        .addButton((b) => b.setButtonText('+ 添加厂商').setCta().onClick(() => {
          const id = 'p' + Date.now();
          list.push({ id, name: '新厂商', endpoint: '', key: '', model: '', thinking: false });
          this.plugin.editProviderId = id; save(); this.display();
        }))
        .addButton((b) => b.setButtonText('- 删除当前').onClick(() => {
          if (list.length <= 1) { new Notice('至少保留一个厂商'); return; }
          const idx = list.findIndex((p) => p.id === this.plugin.editProviderId);
          list.splice(idx, 1);
          if (s.defaultProviderId === this.plugin.editProviderId) s.defaultProviderId = list[0].id;
          this.plugin.editProviderId = s.defaultProviderId; save(); this.display();
        }));

      const p = list.find((x) => x.id === this.plugin.editProviderId) || list[0];
      new Setting(c).setName('名称').setDesc('便于识别，如「DeepSeek」「OpenAI」「本地 Ollama」')
        .addText((t) => t.setValue(p.name).onChange((v) => { p.name = v.trim() || '未命名'; save(); }));
      new Setting(c).setName('Endpoint').setDesc('OpenAI 兼容 /chat/completions 基地址，如 https://api.deepseek.com（勿带末尾斜杠）')
        .addText((t) => t.setValue(p.endpoint).onChange((v) => { p.endpoint = v.trim(); save(); }));
      new Setting(c).setName('API Key').setDesc('仅存于本库 data.json，不随源码/笔记外泄')
        .addText((t) => {
          t.setValue(p.key).onChange((v) => { p.key = v.trim(); save(); });
          t.inputEl.type = 'password'; // 不明文显示 Key，避免录屏/共享屏幕时泄露
          t.inputEl.autocomplete = 'off';
        });
      new Setting(c).setName('模型').setDesc('如 deepseek-v4-flash / gpt-4o / qwen-plus / ...')
        .addText((t) => t.setValue(p.model).onChange((v) => { p.model = v.trim(); save(); }));
      new Setting(c).setName('开启推理 thinking').setDesc('仅部分厂商支持（DeepSeek V4 系、阿里云 qwen 系）；关闭（默认）可大幅提速降耗')
        .addToggle((t) => t.setValue(!!p.thinking).onChange((v) => { p.thinking = v; save(); }));
    }

    new Setting(c).setName('对照模式').setDesc('both=同时生成「左右对照译文」与「上下对照」两份副本；仅译文=只生成译文副本，文件名随目标语言（中文.zh / 日语.ja / 英.en …）；仅上下=只生成原文+译文上下对照副本')
      .addDropdown((d) => d.addOption('both', '双语对照（左右+上下）').addOption('zh', '仅译文副本（左右对照用）').addOption('bilingual', '仅上下对照（原文+译文）')
        .setValue(s.mode).onChange((v) => { s.mode = v; save(); }));

    new Setting(c).setName('生成后左右分屏').setDesc('自动左开原文、右开译文；关闭则只在当前页打开译文')
      .addToggle((t) => t.setValue(s.autoSplit).onChange((v) => { s.autoSplit = v; save(); }));

    new Setting(c).setName('译文打开模式').setDesc('preview=阅读（默认）；source=源码；current=沿用原文当前模式')
      .addDropdown((d) => d.addOption('preview', 'preview（阅读模式）').addOption('source', 'source（源码模式）').addOption('current', 'current（沿用原文）')
        .setValue(s.openMode).onChange((v) => { s.openMode = v; save(); }));

    new Setting(c).setName('并发数').setDesc('逐块翻译并发（1-8），默认 4')
      .addText((t) => t.setValue(String(s.concurrency)).onChange((v) => {
        const n = parseInt(v, 10);
        s.concurrency = isNaN(n) ? 4 : Math.max(1, Math.min(CONCURRENCY_MAX, n));
        save();
      }));
  }
}
