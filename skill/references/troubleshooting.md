# 故障排查

脚本报错时先在这里找。所有脚本都支持 `--json`，错误信息在 `error` 字段，处理建议在 `hint` 字段。

---

## 1. 沙箱 / 权限

### 现象

```
无法写入 /Users/you/.dsh/playwright-e2e（EACCES）
```

或 npm 报：

```
Log files were not written due to an error writing to the directory: /Users/you/.npm/_logs
```

### 原因

agent 会话的文件沙箱只允许写入当前工作区，**这不是磁盘权限问题**。
默认运行目录在 `~/.dsh/playwright-e2e/`，位于工作区之外。

### 处理

按优先级选一种：

1. **批准提权**。在 DSH 会话里允许该命令以更宽的文件权限运行。这是最省事的方式。
2. **把运行目录放到可写位置**：
   ```bash
   export PLAYWRIGHT_E2E_HOME="$PWD/.playwright-e2e"
   node "$SKILL/scripts/bootstrap.mjs"
   ```
   代价是运行数据落在当前工作区里，不再是全局共享。
3. **让用户自己在普通终端里装**（无沙箱限制）：
   ```bash
   ~/.dsh/skills/playwright-e2e/../../../..  # 直接跑 install.sh
   ```

npm 缓存已经被强制指向 `<home>/.npm-cache`，所以 `~/.npm` 不可写不会影响依赖安装 ——
如果还看到 `~/.npm` 相关报错，说明是别的命令（例如用户手工跑的 `npm`）。

---

## 2. 依赖安装失败

### `依赖安装失败：npm 退出码 1`

按顺序排查：

| 检查 | 命令 |
| --- | --- |
| npm 是否可用 | `npm -v` |
| 网络是否可达 | `npm view @playwright/test version` |
| 是否需要代理 | 见下 |
| 磁盘空间 | `df -h ~` |

公司内网需要代理时：

```bash
export npm_config_proxy=http://proxy.corp:8080
export npm_config_https_proxy=http://proxy.corp:8080
node "$SKILL/scripts/bootstrap.mjs"
```

私有 registry：

```bash
export npm_config_registry=https://npm.corp.example.com/
node "$SKILL/scripts/bootstrap.mjs"
```

### `依赖 "exceljs" 未安装`

skill 的脚本从运行目录解析依赖，而不是从 skill 目录。装到别处没用：

```bash
node "$SKILL/scripts/bootstrap.mjs"          # 正确
```

### 版本冲突

`bootstrap.mjs` 默认钉死 `@playwright/test@1.63.0`，与已下载的浏览器版本对齐。
要换版本：

```bash
node "$SKILL/scripts/bootstrap.mjs" --playwright-version 1.64.0 --install-browsers
```

换版本几乎一定会触发浏览器重新下载，先和用户确认。

---

## 3. 浏览器问题

### 窗口弹不出来 / `cannot open display`

**默认是有头模式**，会真的弹出一个浏览器窗口。以下环境没有显示服务，
有头模式必然启动失败：

- CI runner（GitHub Actions 的 `ubuntu-latest` 等）
- 无头服务器、容器
- 通过 SSH 连的远程机器

处理：加 `--headless`。

```bash
node "$SKILL/scripts/run.mjs" --run-dir "<runDir>" --headless --json
```

或在 `e2e.config.json` 里设 `"headless": true`。

常见报错关键词：`cannot open display`、`Missing X server`、
`Target page, context or browser has been closed`、`Browser closed unexpectedly`。

在 Linux CI 上有另一种选择是 `xvfb-run`，但既然测试本来就不需要人看，
直接用 `--headless` 更简单也更快。

> 内置演示 `demo.mjs` 会自动适配：检测到 `CI` 环境变量就无头，否则和真实运行
> 一样弹窗口。想显式指定就用 `--headed` 或 `--headless`。

### 窗口弹得太快，看不清

加 `--slow-mo`，单位毫秒：

```bash
node "$SKILL/scripts/run.mjs" --run-dir "<runDir>" --slow-mo 500 --json
```

500 通常够用；设成 1000 以上会明显拖慢整体用时。只想排查某几条用例时，
配合 `--grep` 一起用。

### 不想弹窗，但想事后看过程

无头模式下截图和 trace 都照常产出。用 trace viewer 可以逐步回放每个操作：

```bash
node ~/.dsh/playwright-e2e/node_modules/playwright/cli.js show-trace "<trace 文件>"
```

trace 文件路径在报告「失败详情」一节里。这比盯着屏幕信息量更大 ——
可以看每一步的 DOM 快照、网络请求和控制台输出。

### `browserType.launch: Executable doesn't exist`

浏览器没装，或版本与 Playwright 不匹配。

```bash
node "$SKILL/scripts/bootstrap.mjs" --check --json
```

看 `browsers.details`：`status` 为 `absent` 是没装，`revision-mismatch` 是版本不符。

```bash
node "$SKILL/scripts/bootstrap.mjs" --install-browsers
```

### 下载被拒绝

浏览器缓存目录（macOS：`~/Library/Caches/ms-playwright`）在工作区之外，
沙箱可能拒绝写入。处理：

```bash
# 让用户批准提权，或把缓存指到可写位置
export PLAYWRIGHT_BROWSERS_PATH="$PWD/.playwright-browsers"
node "$SKILL/scripts/bootstrap.mjs" --install-browsers
```

注意：换了 `PLAYWRIGHT_BROWSERS_PATH` 之后，后续所有命令都要带上同一个环境变量。

### 只想省流量

默认只装 Chromium。已有的 Chromium 缓存会被复用，不会重复下载。
不要为了「保险」装全部浏览器 —— Firefox + WebKit 多出约 170 MB。

---

## 4. 页面访问失败

`explore.mjs` 返回 `无法访问 <URL>`。按错误类型判断：

| 错误关键词 | 原因 | 处理 |
| --- | --- | --- |
| `ERR_NAME_NOT_RESOLVED` | 域名解析不了 | 确认网址拼写；内网域名需要 VPN |
| `ERR_CONNECTION_REFUSED` | 服务没起或端口错 | 确认服务在运行；本机服务用 `127.0.0.1` 而不是 `localhost`（IPv6 问题） |
| `ERR_CERT_*` / `net::ERR_CERT_AUTHORITY_INVALID` | 自签名证书 | 配置里设 `ignoreHTTPSErrors: true`，但要先和用户确认这是预期的 |
| `Timeout ... exceeded` | 页面太慢或卡住 | 加大 `timeout`；确认页面不是一直在加载 |
| `ERR_TUNNEL_CONNECTION_FAILED` | 代理问题 | 设置 `HTTPS_PROXY` / `HTTP_PROXY` 环境变量 |
| `net::ERR_ABORTED` | 被跳转或拦截 | 可能需要登录；检查登录态 |

**这类失败必须回到计划阶段和用户确认，不要硬写用例。** 页面都打不开时写出来的
用例 100% 会失败，只会浪费一轮执行。

### 需要登录才能访问

页面被重定向到登录页 → 配置 `auth`（见 `references/workflow.md` 第 2 节），
或提供 `--storage-state`。

### 页面是空白 / 只有骨架

SPA 没渲染完。`explore.mjs` 已经尽力等 `networkidle`，但慢接口仍可能没回来。
处理：用步骤文件加一个 `waitFor` 等真实内容出现。

---

## 5. 执行阶段失败

### `测试计划尚未确认，拒绝执行`

这是**有意设计**，不是 bug。把计划展示给用户，得到明确确认后：

```bash
node "$SKILL/scripts/confirm-plan.mjs" --plan "<runDir>/plan.md" --note "用户确认原话"
```

### `没有找到任何用例文件`

`<runDir>/specs/` 下没有 `*.spec.ts`。先根据计划和探索结果写用例，
参考 `assets/spec.template.ts`。

### `测试未产生 JSON 结果文件`

执行在用例开始前就失败了。看 `hint` 里附的原始输出末尾。常见原因：

- 浏览器未安装 → 跑 `bootstrap.mjs --install-browsers`
- TypeScript 编译错误 → 检查 spec 文件的语法与 import 路径
- `playwright.config.ts` 被手工改坏 → 删掉它，`run.mjs` 会重新生成

### 所有用例同时失败，截图停在登录页

登录态失效。重新登录一次（删除 `~/.dsh/playwright-e2e/auth/<项目>.json` 后重跑），
**不要改用例**。

### 用例全部超时

| 原因 | 处理 |
| --- | --- |
| 环境慢 | 加大配置里的 `timeout` |
| 用了 `waitForTimeout` 掩盖问题 | 换成状态等待 |
| 定位器指向了不存在的元素 | 看 trace，重新对照 `outline.md` |
| 并发太高压垮环境 | 把 `workers` 降到 1 |

---

## 6. 结果与报告

### 通过率看起来偏低，因为有未自动化用例

未自动化用例**不计入通过率**，它们单独列在报告第四节。这是有意的：
避免「跑了 3 条全过」被读成「18 条全过」。

### `未关联到用例的测试`

spec 的标题没有 `[用例ID]` 前缀，也没有 `caseId` annotation。补上即可。

### 报告里的失败原因看不懂

Playwright 的错误信息通常很长。看 trace 最直接：

```bash
node ~/.dsh/playwright-e2e/node_modules/playwright/cli.js show-trace "<trace 文件路径>"
```

trace 文件路径在报告的失败详情里，或 `<runDir>/test-results/` 下。

---

## 7. 诊断命令速查

```bash
SKILL=~/.dsh/skills/playwright-e2e

# 环境状态（只读，不写任何文件）
node "$SKILL/scripts/bootstrap.mjs" --check --json

# 依赖装在哪
ls ~/.dsh/playwright-e2e/node_modules | head

# 浏览器缓存
ls ~/Library/Caches/ms-playwright

# Playwright 需要的浏览器版本
cat ~/.dsh/playwright-e2e/node_modules/playwright-core/browsers.json

# 计划状态
grep -i "^状态" "<runDir>/plan.md"

# 结果概览
node -e "const s=require('<runDir>/results-summary.json'); console.log(s.counts, s.verdict)"

# 回放 trace
node ~/.dsh/playwright-e2e/node_modules/playwright/cli.js show-trace "<trace 文件>"
```

---

## 8. 还是解决不了

把以下信息一起反馈，能大幅缩短定位时间：

1. 完整的 `--json` 输出（含 `error` 与 `hint`）
2. `node -v`、`npm -v`、操作系统版本
3. `bootstrap.mjs --check --json` 的完整输出
4. 失败的 `<runDir>` 路径（保留现场，不要删）
5. 如果是用例失败：trace 文件路径
