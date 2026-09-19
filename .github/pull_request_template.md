## 这个 PR 做了什么

<!-- 一句话说清改动目的。如果是修 bug，请关联 issue：Fixes #123 -->

## 改动类型

- [ ] Bug 修复
- [ ] 新功能
- [ ] 文档改进
- [ ] 重构（不改变外部行为）
- [ ] 其它：

## 影响范围

<!-- 勾选受影响的阶段 / 模块 -->

- [ ] 用例解析（`parse-cases.mjs` / `lib/cases.mjs` / `lib/csv.mjs` / `lib/spreadsheet.mjs`）
- [ ] 配置（`lib/config.mjs`）
- [ ] 测试计划与确认门禁（`make-plan.mjs` / `confirm-plan.mjs` / `lib/plan.mjs`）
- [ ] 页面探索（`explore.mjs` / `lib/locators.mjs`）
- [ ] 执行（`run.mjs` / `lib/playwright-config.mjs` / `lib/toolchain.mjs`）
- [ ] 报告（`report.mjs` / `lib/results.mjs` / `lib/report.mjs`）
- [ ] 安装与文档（`install.sh` / `README.md` / `SKILL.md` / `references/`）
- [ ] 测试

## 检查清单

- [ ] `npm test` 全部通过
- [ ] 新增或修改的行为有对应测试覆盖
- [ ] 没有提交任何真实凭据、Cookie、token 或内网地址
- [ ] 没有提交 `node_modules/`、`runs/`、`playwright-report/` 等运行产物

## 是否触碰了这几条设计约束

如果改动涉及下面任何一条，请在描述里说明为什么：

- [ ] **计划门禁**：`run.mjs` 在 `plan.md` 状态不是「已确认」时必须拒绝执行
- [ ] **不伪造结果**：未自动化的用例不得计入通过率，也不得伪造为通过
- [ ] **不污染被测项目**：所有产物必须写在运行目录内，不得写入被测项目
- [ ] **凭据不入盘**：账号密码只通过环境变量传递，不写入任何生成的文件或报告
- [ ] **报告渲染是纯函数**：`renderReport()` 不应产生副作用

以上均未涉及。

## 验证方式

<!-- 你是怎么验证这个改动有效的？贴出关键命令和输出 -->

```bash
npm test
```

## 备注

<!-- 需要 reviewer 特别注意的地方、已知的取舍、后续计划 -->
