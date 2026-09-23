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

注意：`.xlsx` 现在有内置的备用读取器，所以缺 exceljs **不再**导致解析失败 ——
`parse-cases.mjs` 会照常解析并在 `warnings` 里说明用了内置读取器。
仍然建议装好依赖，exceljs 对日期、数字格式的处理更完整。

### `用例文件格式兼容问题` / `Cannot read properties of undefined (reading 'sheets')`

**这是文件格式兼容问题，不是你的用例内容写错了。**

`Cannot read properties of undefined (reading 'sheets')` 来自 exceljs 内部：它解析
`xl/workbook.xml` 时假定元素结构固定，遇到不认识的命名空间或结构（第三方导出工具生成的
`.xlsx`、Strict OOXML、带前缀的元素）就会拿到 `undefined` 再取 `.sheets`。
这个报错完全不提真正的原因，很容易被误读成「表格有问题」。

现在的处理顺序是：

1. exceljs 读取 → 失败则
2. 内置的命名空间无关读取器（自己解 ZIP + 解析 XML）→ 失败则
3. 按内容而非扩展名再试一次：HTML 表格 / 分隔符文本 → 都不行才报错

报错时会列出每种方式各自的失败原因（`attempts`），并明确写成「格式兼容问题」。
如果内置读取器成功，还会把解析到的内容另存为
`<runDir>/<原文件名>.recovered.csv`（返回值的 `recovered` 字段），**请打开核对**：
备用读取器不解释单元格的数字格式，日期可能显示为序列号。

修复办法（任选其一）：

- 用 Excel / WPS / Numbers 打开后「另存为 .csv（UTF-8）」，重新解析；
- 或另存为标准 `.xlsx`；
- 或把表格直接贴成 Markdown 表格（`| 列 | 列 |`）交给 skill。

### 列名识别失败（`未能识别用例表头`）

这才是内容问题：表格里没有「用例标题」和「操作步骤」这两列。
按 `references/case-format.md` 对齐列名，或让用户参照 `assets/case-template.xlsx` 填。

### 版本冲突

`bootstrap.mjs` 默认钉死 `@playwright/test@1.63.0`，与已下载的浏览器版本对齐。
要换版本：

```bash
node "$SKILL/scripts/bootstrap.mjs" --playwright-version 1.64.0 --install-browsers
```

换版本几乎一定会触发浏览器重新下载，先和用户确认。

---

## 3. 浏览器问题

### 窗口弹不出来

**默认是有头模式**，会真的弹出浏览器窗口。启动失败有两种原因，
**处理方式相反，别搞混**。

#### A. 沙箱禁止 Chromium 注册 Mach 端口（macOS）

真实报错长这样：

```
ERROR:third_party/crashpad/crashpad/util/mach/bootstrap.cc:65]
  bootstrap_check_in org.chromium.crashpad.child_port_handshake.…: Permission denied (1100)
ERROR:…file_io_posix.cc:208]
  open …/Chrome for Testing/Crashpad/settings.dat: Operation not permitted (1)
Received signal 6

FATAL:base/apple/mach_port_rendezvous_mac.cc:159]
  Check failed: kr == KERN_SUCCESS.
  bootstrap_check_in org.chromium.Chromium.MachPortRendezvousServer.…: Permission denied (1100)
```

**这是 macOS 沙箱（seatbelt）拦截了 Chromium 的 Mach 端口注册。**
关键点：`MachPortRendezvousServer` 是**有头和无头都要用**的多进程 IPC ——
所以**改成 `--headless` 一样会失败**，只会白跑一轮。

处理（按优先级）：

1. **给浏览器放行**。在受限沙箱（Codex、某些 agent 环境）里，向用户说明并申请
   更宽的执行权限；批准后重跑，保持有头模式。
2. **让用户在有桌面会话的普通终端里跑**。这是最可靠的 —— 沙箱外一切正常。
3. 确实拿不到权限时，才降级 `--headless`，并**明确告诉用户测试人员将看不到执行过程**。

> 这一条是血泪教训：早期版本的 SKILL.md 无差别地写「加 `--headless` 重试」，
> 在 macOS 沙箱里导致 agent 先有头失败、再无头失败、最后才申请提权 —— 白跑一轮。

#### B. 没有显示服务

以下环境确实没有显示，有头必然失败，**但无头可以正常跑**：

- CI runner（GitHub Actions 的 `ubuntu-latest` 等）
- 无头服务器、容器
- 通过 SSH 连的远程机器

报错关键词：`cannot open display`、`Missing X server`、`no DISPLAY`。

处理：加 `--headless`。

```bash
node "$SKILL/scripts/run.mjs" --run-dir "<runDir>" --headless --json
```

或在 `e2e.config.json` 里设 `"headless": true`。

在 Linux CI 上也可以用 `xvfb-run`，但既然测试本来就不需要人看，
直接 `--headless` 更简单也更快。

#### 怎么快速分辨

`explore.mjs` 和 `run.mjs` 会给出诊断，直接看 `failureKind`：

| `failureKind` | 含义 | `canRetryHeadless` |
| --- | --- | --- |
| `sandbox-mach` | A 类，沙箱限制 | `false` —— 换无头也没用 |
| `no-display` | B 类，无显示服务 | `true` —— 换无头可以 |
| `missing-browser` | 浏览器没下载 | `false` |
| `unknown` | 未识别 | `false` |

`canRetryHeadless` 为 `false` 时**不要**自己改成无头 —— 照 `hint` 做。

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

页面被重定向到登录页。三种登录方式任选（见 `references/workflow.md` 第 2 节）：

- 只复用已有登录态：`{"auth": {"enabled": false, "storageState": "auth/site.json"}}`
  （`storageState` 相对路径按配置文件所在目录解析），或 `explore.mjs --storage-state <文件>`；
- 自动登录：`auth.enabled: true` + `loginUrl` + `username`/`password`；
- 多步骤登录：再加 `auth.continueSelector`，或用 `auth.steps` 自定义。

**Google / 第三方 OAuth 不要走自动登录**：Google 会拦截自动化浏览器。
让用户用 `codegen` 手工登录一次导出登录态。

登录态文件不存在时，`run.mjs` 会直接报错并说明怎么办，不会静默跳过登录。

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

### `browserContext.close: ENOENT` / 报告里混进了上一次的截图

旧版本在同一个 `test-results/` 里反复重跑，上一次留下的 trace、截图会让 Playwright
清理目录时报 ENOENT，报告也可能混入上一轮的附件。

现在每次执行都写入独立的 `<runDir>/attempts/attempt-<时间戳>/`，
`results-summary.json` 与 `report.md` 只反映最近一次执行。如果还看到这种报错：

- 确认用的是同一批 `attempts/` 目录，不要把旧附件手工拷回去；
- 磁盘上的历史批次由 `attempts.keep`（默认 10）控制，可以调小。

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
| 在等异步任务（文生图/导出） | 用 `waitForAsyncTask()`，调 `asyncTasks.completionTimeout`；**不要**调全局 `timeout` |

---

## 6. 结果与报告

### 通过率看起来偏低，因为有未自动化用例

未自动化用例**不计入通过率**，它们单独列在报告里。这是有意的：
避免「跑了 3 条全过」被读成「18 条全过」。

### 报告说「本次未执行」而不是「未自动化」

这是两回事，报告也分成两节：

- **未自动化**（`notAutomated`）= 从未写过自动化代码 → 覆盖缺口；
- **本次未执行**（`notExecuted`）= 已有代码，但被 `--grep` / `--project` 排除 → 执行范围。

用 `--grep` 重跑过就会出现后者。去掉筛选参数重跑即可补齐，**不要**把它当成缺口汇报。
判定依据是 `specs/` 下是否真的有对应用例代码（静态扫描 `caseId` 注解与 `[用例ID]` 标题）。

### `未关联到用例的测试`

spec 的标题没有 `[用例ID]` 前缀，也没有 `caseId` annotation。补上即可。

### 报告里的失败原因看不懂

Playwright 的错误信息通常很长。看 trace 最直接：

```bash
node ~/.dsh/playwright-e2e/node_modules/playwright/cli.js show-trace "<trace 文件路径>"
```

trace 文件路径在报告的失败详情里，或最近一批
`<runDir>/attempts/attempt-<时间戳>/test-results/` 下。

### 报告里只有失败步骤，没有步骤时间线

步骤时间线由 `_fixtures.ts` 的 `step()` / `waitForAsyncTask()` 记录，
随用例结束写成 `timeline.json` 附件。以下情况不会有时间线：

- 用例没有用 `step()` 包步骤（直接写裸断言）；
- 用例被 Playwright 直接杀掉（超时杀死 worker），时间线来不及落盘。

### 异步任务一直停在 Queued，用例被判失败

先看步骤时间线的状态变化，再决定改什么：

| 时间线表现 | 含义 | 处理 |
| --- | --- | --- |
| 停在「提交…」步骤 | 提交就没成功 | 查接口 4xx/5xx、按钮是否可点，属产品/用例问题 |
| 状态一直 `Queued` | 排队久，不是失败 | 调大 `asyncTasks.completionTimeout`（如 300000） |
| 状态推进后卡住 | 生成环节有问题 | 结合 `network.json` 判断，属产品问题 |
| 状态始终「未知」 | 没读到状态元素 | 定位器或状态文案不对，重新探索页面 |

**不要**用调大全局 `timeout` 的方式解决 —— 那只会让所有用例的失败都变慢。
`waitForAsyncTask()` 已经只给当前用例放宽超时。

---

## 7. 诊断命令速查

```bash
SKILL="<本 skill 的基础目录>"     # DSH 通常是 ~/.dsh/skills/playwright-e2e

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

## 8. 怀疑装的是旧版

表现：行为和新文档对不上，比如明明说默认弹窗口却不弹。

```bash
cd <仓库目录>
./install.sh --status     # 列出所有副本的版本与脚本是否匹配
./install.sh --update     # 就地覆盖所有副本
```

`--status` 按 `SKILL.md` 的 `name` 扫描所有技能根目录，连装错目录名
（如 `~/.codex/skills/skill/`）的副本也能找出来。

更新后**必须新开一个会话** —— 当前会话已经把旧版 `SKILL.md` 读进上下文了，
即使文件更新，这一轮仍会按旧指令行动。

## 9. 还是解决不了

把以下信息一起反馈，能大幅缩短定位时间：

1. 完整的 `--json` 输出（含 `error` 与 `hint`）
2. `node -v`、`npm -v`、操作系统版本
3. `bootstrap.mjs --check --json` 的完整输出
4. 失败的 `<runDir>` 路径（保留现场，不要删）
5. 如果是用例失败：trace 文件路径
