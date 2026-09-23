/**
 * Markdown report rendering.
 *
 * Kept as a pure function of (plan, cases, results, config) so the report format
 * is covered by unit tests without running a browser.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Escape a value for a Markdown table cell. */
function cell(value) {
  return String(value ?? '')
    .replace(/\r?\n/g, '<br>')
    .replace(/\|/g, '\\|')
    .trim();
}

/** Status badge used in the detail table. */
const STATUS_BADGE = {
  passed: '✅ 通过',
  failed: '❌ 失败',
  flaky: '⚠️ 不稳定',
  skipped: '⏭️ 跳过',
  'not-automated': '🚫 未自动化',
  'not-executed': '⏸️ 本次未执行',
  unknown: '❔ 未知',
};

/** Chinese numerals for section headings. */
const NUMERALS = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

/**
 * Read a test's step timeline attachment, when one was written.
 *
 * The timeline is what distinguishes "the task never got submitted" from "the
 * task was still queued when the test gave up" — two failures that look identical
 * in a screenshot.
 *
 * @param {object} test normalized test record
 * @returns {{title: string, status: string, durationMs: number, error?: string, observations?: {at: number, state: string}[]}[]|null}
 */
function readTimeline(test) {
  const attachment = (test.attachments ?? []).find((entry) => entry.name === 'timeline');
  if (attachment === undefined) return null;
  const file = attachment.path;
  if (typeof file !== 'string' || file === '' || !fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const steps = Array.isArray(parsed) ? parsed : parsed?.steps;
    return Array.isArray(steps) && steps.length > 0 ? steps : null;
  } catch {
    return null;
  }
}

/** Human-readable duration. */
function duration(ms) {
  const value = Number(ms) || 0;
  if (value < 1000) return `${value}ms`;
  if (value < 60000) return `${(value / 1000).toFixed(1)}s`;
  const minutes = Math.floor(value / 60000);
  const seconds = Math.round((value % 60000) / 1000);
  return `${minutes}m${seconds}s`;
}

/** Render an ISO timestamp as a local, readable string. */
function when(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/**
 * Render the final Markdown report.
 * @param {{
 *   plan?: {raw?: string} | null,
 *   cases?: object[],
 *   summary: object,
 *   config?: object,
 *   runDir: string,
 *   baseURL: string,
 *   generatedAt?: string,
 * }} input
 * @returns {string}
 */
export function renderReport(input) {
  const {
    cases = [],
    summary,
    config = {},
    runDir,
    baseURL,
    plan = null,
    generatedAt = new Date().toISOString(),
  } = input;

  const counts = summary.counts ?? {};
  const verdict = summary.verdict ?? { label: '—', reasons: [] };
  const notExecuted = summary.notExecuted ?? [];
  const lines = [];

  // Sections are numbered as they are emitted: several are conditional, and a
  // gap in the numbering reads like a rendering bug.
  let sectionCounter = 0;
  const section = (title) => {
    const numeral = NUMERALS[sectionCounter] ?? String(sectionCounter + 1);
    sectionCounter += 1;
    lines.push(`## ${numeral}、${title}`);
    lines.push('');
  };

  // --- Header ---------------------------------------------------------------
  lines.push('# 自动化测试报告');
  lines.push('');
  lines.push('| 项目 | 内容 |');
  lines.push('| --- | --- |');
  lines.push(`| 被测地址 | ${cell(baseURL)} |`);
  lines.push(`| 执行开始 | ${when(summary.startedAt)} |`);
  lines.push(`| 报告生成 | ${when(generatedAt)} |`);
  lines.push(`| 执行耗时 | ${duration(summary.durationMs)} |`);
  lines.push(`| 浏览器 | ${cell((summary.browsers ?? config.browsers ?? []).join(', '))} |`);
  lines.push(`| 用例总数 | ${cases.length} 条（本次执行 ${counts.total ?? 0} 条） |`);
  if (summary.attempt?.id) {
    lines.push(`| 执行批次 | \`${cell(summary.attempt.id)}\`（每次执行独立目录，附件不跨批次混用） |`);
  }
  if (summary.filter?.grep || summary.filter?.project) {
    const parts = [
      summary.filter.grep ? `--grep "${summary.filter.grep}"` : '',
      summary.filter.project ? `--project ${summary.filter.project}` : '',
    ].filter(Boolean);
    lines.push(`| 本次筛选 | ${cell(parts.join(' '))} —— 未跑到的用例见「本次未执行用例」 |`);
  }
  lines.push(`| 运行目录 | \`${cell(runDir)}\` |`);
  lines.push('');

  // --- Verdict --------------------------------------------------------------
  section('测试结论');
  lines.push(`### ${verdict.label}`);
  lines.push('');
  for (const reason of verdict.reasons ?? []) lines.push(`- ${reason}`);
  lines.push('');
  lines.push('| 通过 | 失败 | 不稳定 | 跳过 | 本次未执行 | 未自动化 | 通过率 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  lines.push(
    `| ${counts.passed ?? 0} | ${counts.failed ?? 0} | ${counts.flaky ?? 0} | ${counts.skipped ?? 0} | ` +
      `${notExecuted.length} | ${summary.notAutomated?.length ?? 0} | ${summary.passRate ?? 0}% |`,
  );
  lines.push('');
  lines.push(
    '> 「未自动化」= 从未编写自动化代码（覆盖缺口）；「本次未执行」= 已有自动化代码，' +
      '但被 `--grep` / `--project` 排除（执行范围）。两者不可混为一谈。',
  );
  lines.push('');

  // --- Detail table ---------------------------------------------------------
  section('用例执行明细');

  const statusById = new Map((summary.caseStatus ?? []).map((entry) => [entry.id, entry]));
  const modules = new Map();
  for (const testCase of cases) {
    if (!modules.has(testCase.module)) modules.set(testCase.module, []);
    modules.get(testCase.module).push(testCase);
  }

  if (modules.size === 0) {
    lines.push('_没有解析到用例清单，以下仅列出实际执行的测试。_');
    lines.push('');
  }

  for (const [module, list] of modules) {
    lines.push(`### ${module}`);
    lines.push('');
    lines.push('| 用例ID | 标题 | 优先级 | 状态 | 耗时 | 备注 |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const testCase of list) {
      const entry = statusById.get(testCase.id);
      const status = entry?.status ?? 'not-automated';
      const matches = (summary.tests ?? []).filter((test) => test.caseId === testCase.id);
      const spent = matches.reduce((total, test) => total + test.durationMs, 0);
      const note = matches.some((test) => test.status === 'failed')
        ? '见下方失败详情'
        : matches.length === 0
          ? status === 'not-executed'
            ? '本次未执行（被 --grep/--project 排除）'
            : '未生成对应自动化用例'
          : matches.some((test) => test.retries > 0)
            ? `重试 ${matches.find((test) => test.retries > 0).retries} 次`
            : '';
      lines.push(
        `| ${cell(testCase.id)} | ${cell(testCase.title)} | ${cell(testCase.priority)} | ` +
          `${STATUS_BADGE[status] ?? status} | ${duration(spent)} | ${cell(note)} |`,
      );
    }
    lines.push('');
  }

  // --- Failures -------------------------------------------------------------
  const failures = (summary.tests ?? []).filter((test) => test.status === 'failed');
  section('失败详情');
  if (failures.length === 0) {
    lines.push('没有失败用例。');
    lines.push('');
  } else {
    failures.forEach((test, index) => {
      lines.push(`### ${index + 1}. ${test.caseId ?? '（无用例ID）'} ${test.title}`);
      lines.push('');
      lines.push(`- 模块：${test.module}`);
      lines.push(`- 优先级：${test.priority}`);
      lines.push(`- 位置：\`${test.file}:${test.line}\``);
      lines.push(`- 重试次数：${test.retries}`);
      lines.push('');
      lines.push('```text');
      lines.push(test.error || '（没有错误信息）');
      lines.push('```');
      lines.push('');

      // Step timeline: shows how far the test actually got before it failed.
      const timeline = readTimeline(test);
      if (timeline !== null) {
        lines.push('步骤时间线：');
        lines.push('');
        lines.push('| 步骤 | 结果 | 耗时 |');
        lines.push('| --- | --- | --- |');
        for (const entry of timeline) {
          const mark = entry.status === 'failed' ? '❌' : entry.status === 'skipped' ? '⏭️' : '✅';
          const observations = Array.isArray(entry.observations) && entry.observations.length > 0
            ? `<br>状态变化：${entry.observations.map((item) => `${cell(item.state)}（${duration(item.at)}）`).join(' → ')}`
            : '';
          lines.push(`| ${cell(entry.title)} | ${mark} | ${duration(entry.durationMs)}${observations} |`);
        }
        lines.push('');
        const lastFailed = [...timeline].reverse().find((entry) => entry.status === 'failed');
        if (lastFailed !== undefined) {
          lines.push(`> 失败发生在「${cell(lastFailed.title)}」这一步；此前的步骤均已成功。`);
          lines.push('');
        }
      }

      const shots = (test.attachments ?? []).filter(
        (attachment) => attachment.contentType?.startsWith('image/') || attachment.name?.includes('screenshot'),
      );
      const traces = (test.attachments ?? []).filter((attachment) => attachment.name?.includes('trace'));
      if (shots.length > 0) {
        lines.push('截图：');
        for (const shot of shots) lines.push(`- \`${shot.path || shot.name}\``);
        lines.push('');
      }
      if (traces.length > 0) {
        lines.push('Trace（用 `npx playwright show-trace <文件>` 打开）：');
        for (const trace of traces) lines.push(`- \`${trace.path || trace.name}\``);
        lines.push('');
      }
    });
  }

  // --- Not automated --------------------------------------------------------
  section('未自动化用例（覆盖缺口）');
  if ((summary.notAutomated ?? []).length === 0) {
    lines.push('所有用例都已自动化。');
    lines.push('');
  } else {
    lines.push(`以下 ${summary.notAutomated.length} 条用例没有生成自动化用例，**不计入通过率**：`);
    lines.push('');
    lines.push('| 用例ID | 模块 | 标题 | 优先级 |');
    lines.push('| --- | --- | --- | --- |');
    for (const entry of summary.notAutomated) {
      lines.push(`| ${cell(entry.id)} | ${cell(entry.module)} | ${cell(entry.title)} | ${cell(entry.priority)} |`);
    }
    lines.push('');
  }

  // --- Not executed this run ------------------------------------------------
  if (notExecuted.length > 0) {
    section('本次未执行用例（筛选执行，非覆盖缺口）');
    const parts = [
      summary.filter?.grep ? `--grep "${summary.filter.grep}"` : '',
      summary.filter?.project ? `--project ${summary.filter.project}` : '',
    ].filter(Boolean);
    lines.push(
      `以下 ${notExecuted.length} 条用例**已经有自动化代码**，只是被本次执行的筛选条件` +
        `${parts.length > 0 ? `（${cell(parts.join(' '))}）` : ''}排除在外，` +
        '因此没有本次结果。**它们不是覆盖缺口**：去掉筛选参数重跑即可得到结果。',
    );
    lines.push('');
    lines.push('| 用例ID | 模块 | 标题 | 优先级 | 状态 |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const entry of notExecuted) {
      lines.push(
        `| ${cell(entry.id)} | ${cell(entry.module)} | ${cell(entry.title)} | ${cell(entry.priority)} | ⏸️ 本次未执行 |`,
      );
    }
    lines.push('');
  }

  // --- Anomalies ------------------------------------------------------------
  if ((summary.unmatchedTests ?? []).length > 0) {
    section('未关联到用例的测试');
    lines.push('这些测试没有匹配到用例清单中的 ID，可能是新增的临时验证：');
    lines.push('');
    lines.push('| 标题 | 用例ID | 位置 |');
    lines.push('| --- | --- | --- |');
    for (const entry of summary.unmatchedTests) {
      lines.push(`| ${cell(entry.title)} | ${cell(entry.caseId ?? '—')} | \`${cell(entry.file)}:${entry.line}\` |`);
    }
    lines.push('');
  }

  if ((summary.infrastructureErrors ?? []).length > 0) {
    section('基础设施错误');
    lines.push('这些错误发生在用例执行之外，可能导致部分用例根本没有运行：');
    lines.push('');
    for (const error of summary.infrastructureErrors) {
      lines.push(`- ${error.location ? `\`${error.location}\` ` : ''}${error.message}`);
    }
    lines.push('');
  }

  // --- Artifacts ------------------------------------------------------------
  const artifacts = summary.artifacts ?? {};
  lines.push('## 附件索引');
  lines.push('');
  lines.push('| 产物 | 路径 |');
  lines.push('| --- | --- |');
  if (artifacts.htmlReport) {
    lines.push(`| Playwright HTML 报告 | \`${path.join(artifacts.htmlReport, 'index.html')}\` |`);
  }
  if (artifacts.jsonResults) lines.push(`| Playwright JSON 结果 | \`${artifacts.jsonResults}\` |`);
  if (artifacts.summary) lines.push(`| 归一化结果 | \`${artifacts.summary}\` |`);
  if (artifacts.testResults) lines.push(`| 截图 / trace 目录 | \`${artifacts.testResults}\` |`);
  lines.push('');

  // --- Environment ----------------------------------------------------------
  lines.push('## 环境与配置');
  lines.push('');
  lines.push('| 配置项 | 值 |');
  lines.push('| --- | --- |');
  lines.push(`| baseURL | ${cell(baseURL)} |`);
  // State the consequence, not just the flag: could a human have watched?
  lines.push(
    `| 浏览器可见性 | ${
      config.headless
        ? '⚠️ 无头 —— 测试人员看不到执行过程，只能凭截图与 trace 回放'
        : '✅ 有头 —— 执行时弹出浏览器窗口，过程可见'
    } |`,
  );
  lines.push(`| 视口 | ${config.viewport?.width ?? '—'}×${config.viewport?.height ?? '—'} |`);
  lines.push(`| 语言 / 时区 | ${cell(config.locale ?? '—')} / ${cell(config.timezoneId ?? '—')} |`);
  lines.push(`| 单用例超时 | ${duration(config.timeout)}（等待异步任务的用例会自动放宽） |`);
  lines.push(
    `| 异步任务预算 | 提交 ${duration(config.asyncTasks?.submitTimeout ?? 0)} / ` +
      `完成 ${duration(config.asyncTasks?.completionTimeout ?? 0)} |`,
  );
  lines.push(`| 重试次数 | ${config.retries ?? 0} |`);
  lines.push(`| 并发数 | ${config.workers ?? 1} |`);
  lines.push(`| 登录方式 | ${cell(summary.authLabel ?? (config.auth?.enabled ? '自动登录' : '未启用'))} |`);
  if (summary.attempt?.id) {
    lines.push(`| 执行批次目录 | \`${cell(summary.attempt.dir ?? '')}\` |`);
  }
  lines.push('');

  if (plan?.raw) {
    lines.push('## 附：已确认的测试计划');
    lines.push('');
    lines.push('<details>');
    lines.push('<summary>展开查看</summary>');
    lines.push('');
    lines.push(plan.raw.replace(/^\s*(?:状态|status)\s*[:：].*$/gim, '').trim());
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push(`_本报告由 playwright-e2e skill 自动生成于 ${when(generatedAt)}。_`);

  return `${lines.join('\n')}\n`;
}

/**
 * Render the test-plan skeleton the agent fills in before execution.
 * @param {{baseURL: string, cases: object[], config?: object, runDir: string}} input
 * @returns {string}
 */
export function renderPlanSkeleton(input) {
  const { baseURL, cases, config = {}, runDir } = input;
  const modules = new Map();
  for (const testCase of cases) {
    if (!modules.has(testCase.module)) modules.set(testCase.module, []);
    modules.get(testCase.module).push(testCase);
  }

  const lines = [];
  lines.push('# 测试计划');
  lines.push('');
  lines.push('## 1. 测试目标与范围');
  lines.push('');
  lines.push(`- 被测地址：${baseURL}`);
  lines.push(`- 用例总数：${cases.length} 条，覆盖 ${modules.size} 个模块`);
  lines.push(`- 浏览器：${(config.browsers ?? ['chromium']).join(', ')}`);
  lines.push(`- 运行目录：\`${runDir}\``);
  lines.push('');
  lines.push('<!-- 请在此补充：本次测试要验证的业务目标、明确不测的范围 -->');
  lines.push('');
  lines.push('## 2. 用例清单');
  lines.push('');
  for (const [module, list] of modules) {
    lines.push(`### ${module}（${list.length} 条）`);
    lines.push('');
    lines.push('| 用例ID | 标题 | 优先级 | 自动化可行性 |');
    lines.push('| --- | --- | --- | --- |');
    for (const testCase of list) {
      lines.push(`| ${testCase.id} | ${testCase.title} | ${testCase.priority} | <!-- 可自动化 / 需登录 / 需人工 --> |`);
    }
    lines.push('');
  }
  lines.push('## 3. 执行策略');
  lines.push('');
  lines.push('<!-- 请在此说明：登录方式、测试数据准备、执行顺序、需要人工介入的环节 -->');
  lines.push('');
  lines.push(
    '- **浏览器可见性**：<!-- 必填，取自阶段 0 的 launch 结果。' +
      '能弹窗口就写「有头，测试人员可看到执行全过程」；' +
      '弹不出就写清原因、是否已提权重试、以及用户选择了哪种处理方式 -->',
  );
  lines.push('');
  lines.push('## 4. 风险与不确定项');
  lines.push('');
  lines.push('<!-- 请在此列出：验证码、短信、第三方依赖、动态数据、环境不稳定等 -->');
  lines.push('');
  lines.push('## 5. 需要用户确认的问题');
  lines.push('');
  lines.push('<!-- 请在此列出必须由用户回答才能继续的问题；没有则写「无」 -->');
  lines.push('');
  lines.push('状态: 待确认');

  return `${lines.join('\n')}\n`;
}
