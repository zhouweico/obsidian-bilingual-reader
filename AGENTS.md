# AGENTS.md

给 AI agent 的项目约定。人要读的是 [README.md](README.md)；本文件只回答一件事：**在这个仓库里怎么做才不会被 CI 或社区目录打回。**

## 项目形态

Obsidian 社区插件，**没有构建步骤**：`main.js` 就是源码，没有 `package.json`、`node_modules`、打包器和依赖。运行时只 `require('obsidian')`。

| 文件 | 职责 |
|---|---|
| `manifest.json` | 插件元数据，**版本号与名称的唯一事实源** |
| `versions.json` | 插件版本 → 最低 Obsidian 版本映射 |
| `main.js` | 全部逻辑，单文件 CommonJS |
| `styles.css` | 目前为空壳（原生组件渲染，不注入样式） |
| `README.md` | 用户文档，保持精简，不写开发者内容 |
| `.github/workflows/release.yml` | 校验 + 签发 attestation + 建 release |
| `.github/release-notes/<tag>.md` | 发布说明，存在即作为 release body |

## 改完必须跑的检查

```bash
node --check main.js
```

## 硬约束

以下任一条不满足，社区目录自动审核或 CI 会直接拒绝。

| 约束 | 原因 |
|---|---|
| `manifest.name` 只能用 Basic Latin 字符 | 目录不接受非拉丁名称（全库 9200+ 插件中 CJK 名称为 0） |
| `manifest.id` 只能小写字母与连字符，不得含 `obsidian` | 目录校验，且改动会导致用户插件目录失效 |
| `description` 以英文句点 `.` 结尾、≤250 字符、无 emoji | 目录校验；中文句号「。」不通过 |
| 版本三处一致：`manifest.version`、`versions.json` 的键、Git tag | CI 校验，不一致拒绝发布 |
| 改工作流必须打进 tag 所在提交 | 发布执行的是 tag 上的 workflow，不是 main 的最新版 |
| `data.json` 绝不入库 | 内含用户 API Key，已在 `.gitignore` |
| 不设默认热键 | Obsidian 审查项；默认热键易与用户配置冲突 |
| 不用正则 lookbehind | iOS 16.4 以下 Safari 不支持，而 `isDesktopOnly: false` |
| 不硬编码颜色与样式 | 需跟随主题；样式走 CSS 变量 |

## 代码约定

- 不用已废弃 API：`workspace.activeLeaf` → `getMostRecentLeaf()`；`splitActiveLeaf()` → `getLeaf('split', 'vertical')`；改写已有文件用 `Vault.process()`，不用 `Vault.modify()`
- 所有路径过 `normalizePath()`
- 默认值集中在 `DEFAULTS`；新增设置项要同步 README 的「配置」与「已知限制」
- 提示用 `new Notice()`；错误日志统一前缀 `[bilingual-reader]`
- 界面文案用中文；注释只写「为什么」，不复述代码
- 保持单文件，不引入第三方依赖或打包器——可逐行审阅是刻意的取舍

## 不要做

- 不提交 `.obsidian/`、`data.json`、`.workbuddy/`、编辑器配置
- 不为了临时需求改 `manifest.id` / `name`（牵动目录条目与用户安装路径）
- 不往 README 里加开发者内容（安装路径、命令清单、贡献流程都曾因此被删）
- 不自动 push 到 main、不打 tag、不发 release：分支提交供评审可以，合并与发版必须维护者确认

## 发布流程

1. 升 `manifest.json` 的 `version`，并在 `versions.json` 加同名的 `"<版本>": "<minAppVersion>"`
2. 写 `.github/release-notes/<版本>.md`（文件缺失时 release 会退回 `--generate-notes`）
3. 提交上述改动，打 annotated tag，**tag 名与 `manifest.version` 完全一致**；tag 必须落在包含第 1、2 步的提交上
4. 推送 `main` 与 tag，等待 Actions 完成校验 → 签发资产 attestation → 创建 release

```bash
git push origin main <版本>
gh release view <版本> --json assets -q '.assets[].name'   # 应为 main.js / manifest.json / styles.css
```

发布后到 community.obsidian.md 点 **Check for new releases** 重跑审核。

## 本文件不写什么

具体版本号、默认模型名、语言列表这类会漂移的值——它们以 `manifest.json` 和 `main.js` 为准，写在这里只会过期。

规则变了就改这里；**能被 CI 拦住的规则，优先加进 workflow，不要只写文档。**
