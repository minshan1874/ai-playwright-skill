# 安全说明

这个工具会驱动真实浏览器访问你的系统，并且需要处理登录凭据。
下面说明它怎么处理敏感信息，以及发现问题时该怎么办。

---

## 凭据是怎么处理的

### 设计原则：凭据不落盘

账号密码**只通过环境变量传递**，不写入任何生成的文件：

```bash
E2E_USERNAME=admin E2E_PASSWORD='***' node "$SKILL/scripts/run.mjs" --run-dir "<runDir>" --json
```

配置文件里只写占位符：

```json
{
  "auth": {
    "username": "${E2E_USERNAME}",
    "password": "${E2E_PASSWORD}"
  }
}
```

`run.mjs` 在把配置快照写入运行目录前会**主动脱敏**这两个字段。
如果你新增了配置字段并把它写进快照，请确认它也需要脱敏。

### 生成的文件里有什么

| 文件 | 是否含敏感信息 |
| --- | --- |
| `<runDir>/e2e.config.json` | 否，账号密码已替换为 `<已提供>` |
| `<runDir>/specs/_auth.setup.ts` | 否，代码里只引用 `process.env.E2E_USERNAME` |
| `<runDir>/report.md` | 否 |
| `<runDir>/playwright-report/` | 否 |
| `~/.dsh/playwright-e2e/auth/<项目>.json` | **是** —— Playwright 的 storageState，含真实会话 Cookie |

### storageState 是真正的敏感文件

`auth/<项目>.json` 保存的是登录后的会话状态，拿到它就等于拿到了登录态。

- 它默认在 `~/.dsh/playwright-e2e/auth/`，**不在被测项目里**
- `.gitignore` 已忽略 `auth/` 和 `*.storage-state.json`
- 卸载时用 `./uninstall.sh --purge` 会一并删除
- **不要**把 `auth.storageState` 指到版本库里的路径

---

## 提交 issue 或 PR 前

请删掉以下内容：

- 账号、密码、API key、token
- Cookie、`storageState` 文件内容
- 内网域名、IP、服务器路径
- 真实业务数据、客户信息、订单号
- 本地绝对路径中的用户名（`/Users/<你的名字>/...`）

脚本的 JSON 输出里通常不含凭据，但 `explore/console.json`、
`explore/network.json` 和 Playwright 的 trace 文件**可能包含页面上的真实数据**。
分享 trace 前请先确认内容。

---

## 使用建议

- **不要**把生产环境的真实账号配进 `e2e.config.json`
- 优先使用专门的测试账号，并限制其权限
- 对生产环境跑测试前，确认用例**不会产生真实副作用**（下单、支付、发消息、删数据）
- 在计划阶段就把「会不会产生真实副作用」列为风险项，让用户确认
- 内网系统注意：本工具会把页面截图和 DOM 结构写到本地运行目录

---

## 报告安全漏洞

如果发现的是**安全漏洞本身**（例如凭据泄漏到生成的文件、命令注入、
`explore.mjs` 的步骤文件可执行任意代码等），请**不要**开公开 issue。

请通过 GitHub 的
[私密漏洞报告](https://github.com/minshan1874/ai-playwright-skill/security/advisories/new)
提交，或直接联系仓库维护者。

请在报告里包含：

- 受影响的版本或 commit
- 复现步骤
- 影响范围（泄漏了什么、谁能利用）
- 如果有的话，建议的修复方式

我会尽快确认并回复。

---

## 已知的设计取舍

这些不是漏洞，但你应该知道：

**`explore.mjs --steps` 会执行步骤文件里的定位器表达式。**
字符串形式的 `locator` 会被求值为 `page.<表达式>`。
步骤文件是**本地、由 agent 编写**的可信内容 —— 不要对来源不明的步骤文件使用这个参数。
文档里已明确标注。结构化对象形式（`{"by": "role", ...}`）没有这个问题，优先用它。

**测试代码是任意代码。**
`specs/*.spec.ts` 由 AI 根据测试计划生成，能执行任意 Node.js 代码。
这跟你自己写 Playwright 测试没有区别 —— 但在运行 AI 生成的用例前，
尤其是对生产环境，请先看一眼生成的代码。
