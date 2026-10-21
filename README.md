# Bilingual Reader（译读）

Translate a note into another language without touching the original.
一键生成对照译文，原文永不改动。

## English overview

**Bilingual Reader** translates the active note into one of 11 languages, writes the result to a separate file, and opens it next to the original in a split pane.

- The original note is never modified.
- Two layouts: a translation-only copy (`note.zh.md`) opened side by side, or an interleaved copy (`note.bilingual.md`) where every paragraph is followed by its translation.
- Markdown structure survives: headings, lists, tables, quotes, links, embeds and inline code are protected; code blocks and frontmatter are copied verbatim instead of being translated.
- Three engines: Google (free, no key), DeepL, and any OpenAI-compatible LLM with multiple providers and models.
- The translated file starts with an `[[note|原文]]` backlink to the source.

**Requirements:** Obsidian 1.4.0 or later, desktop and mobile.

**Install:** Settings → Community plugins → Browse → search "Bilingual Reader". Manual install: copy `manifest.json`, `main.js` and `styles.css` into `<vault>/.obsidian/plugins/bilingual-reader/`.

**Network and privacy:** note text is sent only to the translation service you configure — `translate.googleapis.com` (Google), `api.deepl.com` / `api-free.deepl.com` (DeepL), or the OpenAI-compatible endpoint you enter yourself. No middle server, no telemetry. API keys live in `<vault>/.obsidian/plugins/bilingual-reader/data.json` and are only sent to that provider — be aware that this file travels with your vault if you sync it.

The plugin UI is currently in Chinese. License: [MIT](LICENSE).

---

## 它解决什么问题

Obsidian 里存的英文资料——论文、文档、newsletter——读起来慢，又不该让机翻污染原件。

译读的做法：原文一个字都不碰，另外生成一份译文笔记，左右分屏摆在一起。卡住时扫一眼右边即可。

- 原文只读，永不修改
- 译文首行自带回链，点一下跳回原文
- Markdown 结构、代码块、链接、图片路径原样保留
- 支持 11 种目标语言，不只中文

## 两种对照模式

### 并排对照（`xxx.zh.md`）

纯译文，不夹带原文，翻译完成后自动在**右侧分屏**打开。

![左原文，右译文，并排对照](images/split-view.png)

适合沉浸式读译文、卡住时才回头看原文。这是默认推荐。

### 上下对照（`xxx.bilingual.md`）

原文段落紧跟译文段落，交替排列，一个文件读完。

![原文与译文段落交替排列](images/bilingual-view.png)

适合精读、学英语、逐句核对译文。

### 怎么选

设置里的**对照模式**有三个选项：

| 选项 | 生成什么 |
|---|---|
| **双语对照**（默认） | 两个文件都生成，并排那份自动分屏打开 |
| **仅译文副本** | 只生成 `xxx.zh.md` |
| **仅上下对照** | 只生成 `xxx.bilingual.md` |

文件名跟着目标语言变：中文 `xxx.zh.md`、日语 `xxx.ja.md`、法语 `xxx.fr.md`；上下对照那份始终是 `xxx.bilingual.md`。

## 安装

**社区目录**：审核通过后可在 **设置 → 第三方插件 → 浏览** 搜索 `Bilingual Reader` 安装。

**手动安装**：把 `manifest.json`、`main.js`、`styles.css` 放进

```
你的库/.obsidian/plugins/bilingual-reader/
```

然后在 **设置 → 第三方插件** 里启用 **Bilingual Reader**（界面中文名为「译读」）。

需要 Obsidian 1.4.0 或更高版本。

## 第一次使用前

打开 **设置 → 译读**，配一个翻译服务：

- **LLM**（默认，推荐）——预置了 DeepSeek 配置（`https://api.deepseek.com` / `deepseek-v4-flash`），填 API Key 即可用。也可自行添加 OpenAI、OpenRouter、本地 Ollama 等任何 OpenAI 兼容接口
- **Google**——免费免配置，质量一般
- **DeepL**——需要填 DeepL 的 Key

## 使用

1. 打开要读的笔记
2. 点左侧栏的翻译图标，或在命令面板搜「译读」
3. 顶部显示「翻译中 45%」，翻完自动分屏

本插件不预设快捷键：需要的话在 **设置 → 快捷键** 搜「译读」自行绑定。长文档会分块并发翻译，稍等片刻。

## 设置项

| 设置 | 说明 | 默认 |
|------|------|------|
| 目标语言 | 简体中文 / 繁體中文 / English / 日本語 / 한국어 / Français / Deutsch / Español / Русский / Português / Italiano | 简体中文 |
| 翻译引擎 | LLM / Google / DeepL | LLM |
| 默认 LLM 厂商 | 配了多个厂商时用哪个 | 第一个 |
| LLM 厂商管理 | 添加 / 编辑 / 删除厂商（名称、接口地址、Key、模型） | — |
| 对照模式 | 见上文「两种对照模式」 | 双语对照 |
| 生成后左右分屏 | 关闭则译文只在当前页打开 | 开 |
| 译文打开模式 | 阅读模式 / 源码模式 / 跟原文一致 | 阅读模式 |
| 并发数 | 同时翻几块（1–8），越大越快但更容易触发限流 | 4 |

## 命令

| 命令 | 作用 |
|------|------|
| 译读（左右分屏） | 按当前设置翻译 |
| 仅译文副本（左右分屏） | 只出并排那份 |
| 仅上下对照副本 | 只出上下交替那份 |
| 用指定厂商翻译（左右分屏） | 临时换个 LLM 厂商，不改设置 |

## 已知限制

- 代码块、frontmatter、表格分隔行原样保留，不翻译
- 加粗、斜体等行内标记不做单独保护，个别引擎可能改动其位置
- Google 走的是 `translate.googleapis.com` 的免费公开端点（非官方 API），随时可能限流或失效，长期使用建议 LLM / DeepL
- 已是译文副本的笔记（`xxx.zh.md` / `xxx.bilingual.md`）会被拦下，避免产出 `xxx.zh.zh.md`
- 同名译文文件已存在时会被覆盖
- 界面语言目前只有中文

## 关于隐私

API Key 只存在你自己库里的 `.obsidian/plugins/bilingual-reader/data.json`，不写进代码、不随插件分发。翻译请求由 Obsidian 直接发给你配置的服务商，不经过任何中间服务器，也没有任何遥测。

实际会访问的地址：

| 引擎 | 地址 |
|------|------|
| Google | `translate.googleapis.com` |
| DeepL | `api.deepl.com` / `api-free.deepl.com` |
| LLM | 你自己填的接口地址 |

需要注意：如果库通过 iCloud 或 Obsidian Sync 同步，`data.json` 会一起上云。介意的话用自托管接口，或给这个插件单独签一把 Key。

## 反馈

Bug 与建议：<https://github.com/zhouweico/obsidian-bilingual-reader/issues>

## License

MIT
