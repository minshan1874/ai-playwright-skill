/**
 * Integration checks on the skill bundle itself.
 *
 * These catch the failure modes that make a skill silently disappear from the DSH
 * catalog — invalid frontmatter, a name that does not match its directory, a
 * broken script reference — none of which the runtime reports to the model.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const ROOT = process.cwd();
const SKILL_DIR = path.join(ROOT, 'skill');
const SKILL_FILE = path.join(SKILL_DIR, 'SKILL.md');

/** DSH's skill-name grammar. */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The catalog caps rendered descriptions at this length. */
const DESCRIPTION_LIMIT = 500;

/**
 * Extract YAML frontmatter the same way DSH does: a leading `---` line, then a
 * closing `---` line.
 * @param {string} raw
 * @returns {{data: Record<string, string>, body: string}|null}
 */
function parseFrontmatter(raw) {
  const firstLineEnd = raw.indexOf('\n');
  if (firstLineEnd < 0) return null;
  if (raw.slice(0, firstLineEnd).replace(/\r$/, '') !== '---') return null;

  const rest = raw.slice(firstLineEnd + 1);
  const closing = rest.search(/^---[ \t]*\r?$/m);
  if (closing < 0) return null;

  const block = rest.slice(0, closing);
  const data = {};
  for (const line of block.split(/\r?\n/)) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (match !== null) data[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
  }
  const bodyStart = rest.indexOf('\n', closing);
  return { data, body: bodyStart < 0 ? '' : rest.slice(bodyStart + 1) };
}

describe('SKILL.md manifest', () => {
  const raw = fs.readFileSync(SKILL_FILE, 'utf8');
  const parsed = parseFrontmatter(raw);

  it('has parseable frontmatter', () => {
    assert.notEqual(parsed, null, 'SKILL.md 必须以 --- 开头并有闭合的 ---');
  });

  it('declares a kebab-case name', () => {
    assert.ok(parsed.data.name, 'frontmatter 缺少 name');
    assert.ok(SKILL_NAME.test(parsed.data.name), `name "${parsed.data.name}" 不是 kebab-case`);
  });

  it('installs into a directory named after the skill', () => {
    // DSH discovers `<root>/<name>/SKILL.md`, so the installed directory must
    // match the frontmatter name even though the source directory is `skill/`.
    const install = fs.readFileSync(path.join(ROOT, 'install.sh'), 'utf8');
    const declared = /^SKILL_NAME="([^"]+)"/m.exec(install);
    assert.ok(declared, 'install.sh 中找不到 SKILL_NAME');
    assert.equal(declared[1], parsed.data.name);
    assert.ok(
      install.includes('skills/$SKILL_NAME'),
      'install.sh 应把 skill 装到 <root>/skills/$SKILL_NAME',
    );
  });

  it('declares a description within the catalog limit', () => {
    assert.ok(parsed.data.description, 'frontmatter 缺少 description');
    assert.ok(
      parsed.data.description.length <= DESCRIPTION_LIMIT,
      `description 有 ${parsed.data.description.length} 字符，超过 ${DESCRIPTION_LIMIT} 上限`,
    );
  });

  it('declares a whenToUse hint', () => {
    assert.ok(parsed.data.whenToUse, 'frontmatter 缺少 whenToUse');
  });

  it('keeps metadata.version in sync with package.json', () => {
    // A stale version string is how a copy looks updated while still running old
    // code — the frontmatter says 1.1.0 but the scripts are 1.0.x.
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const declared = /^metadata:[\s\S]*?^\s+version:\s*(\S+)/m.exec(raw);
    assert.ok(declared, 'SKILL.md 的 metadata 缺少 version');
    assert.equal(
      declared[1],
      manifest.version,
      `SKILL.md 声明 ${declared[1]}，package.json 是 ${manifest.version}`,
    );
  });

  it('does not disable model or user invocation', () => {
    assert.notEqual(parsed.data['disable-model-invocation'], 'true');
    assert.notEqual(parsed.data['user-invocable'], 'false');
  });
});

describe('skill bundle contents', () => {
  it('ships every reference the SKILL.md links to', () => {
    const raw = fs.readFileSync(SKILL_FILE, 'utf8');
    const referenced = new Set(
      [...raw.matchAll(/`(references\/[a-z-]+\.md)`/g)].map((match) => match[1]),
    );
    assert.ok(referenced.size >= 5, `SKILL.md 只引用了 ${referenced.size} 个参考文件`);
    for (const relative of referenced) {
      assert.ok(fs.existsSync(path.join(SKILL_DIR, relative)), `缺少 ${relative}`);
    }
  });

  it('ships every script the SKILL.md tells the agent to run', () => {
    const raw = fs.readFileSync(SKILL_FILE, 'utf8');
    const referenced = new Set(
      [...raw.matchAll(/\$SKILL\/scripts\/([a-z-]+\.mjs)/g)].map((match) => match[1]),
    );
    assert.ok(referenced.size >= 8, `SKILL.md 只引用了 ${referenced.size} 个脚本`);
    for (const name of referenced) {
      assert.ok(fs.existsSync(path.join(SKILL_DIR, 'scripts', name)), `缺少 scripts/${name}`);
    }
  });

  it('ships every asset the SKILL.md mentions', () => {
    const raw = fs.readFileSync(SKILL_FILE, 'utf8');
    for (const name of ['case-template.xlsx', 'case-template.csv', 'e2e.config.example.json', 'spec.template.ts']) {
      assert.ok(raw.includes(name), `SKILL.md 未提及 ${name}`);
      assert.ok(fs.existsSync(path.join(SKILL_DIR, 'assets', name)), `缺少 assets/${name}`);
    }
  });

  it('has a scripts/lib directory with every shared module', () => {
    for (const name of [
      'cases.mjs',
      'config.mjs',
      'csv.mjs',
      'deps.mjs',
      'locators.mjs',
      'log.mjs',
      'paths.mjs',
      'plan.mjs',
      'report.mjs',
      'results.mjs',
      'spreadsheet.mjs',
      'toolchain.mjs',
    ]) {
      assert.ok(fs.existsSync(path.join(SKILL_DIR, 'scripts', 'lib', name)), `缺少 lib/${name}`);
    }
  });

  it('ships no node_modules or run artifacts', () => {
    assert.ok(!fs.existsSync(path.join(SKILL_DIR, 'node_modules')), 'skill/ 不应包含 node_modules');
    assert.ok(!fs.existsSync(path.join(SKILL_DIR, 'runs')), 'skill/ 不应包含 runs');
  });
});

describe('repository hygiene', () => {
  const gitignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');

  it('ignores every credential-bearing path', () => {
    // These are the files that must never reach a public repository.
    for (const pattern of ['auth/', '.env', 'e2e.config.json', '*.storage-state.json']) {
      assert.ok(
        gitignore.includes(pattern),
        `.gitignore 缺少 "${pattern}" —— 提交凭据会导致真实会话泄漏`,
      );
    }
  });

  it('still allows the committed example config', () => {
    // `e2e.config.json` is ignored, but the shipped example must stay tracked.
    assert.ok(fs.existsSync(path.join(SKILL_DIR, 'assets', 'e2e.config.example.json')));
    assert.ok(!/e2e\.config\.example\.json/.test(gitignore), '示例配置不应被忽略');
  });

  it('ignores runtime artifacts and the toolchain', () => {
    for (const pattern of [
      'node_modules/',
      'runs/',
      'playwright-report/',
      'test-results/',
      '.npm-cache/',
      '.pw-browsers/',
    ]) {
      assert.ok(gitignore.includes(pattern), `.gitignore 缺少 "${pattern}"`);
    }
  });

  it('lets the demo install browsers, so it works on a fresh machine', () => {
    // The demo is invoked explicitly by a human, which is the consent bootstrap
    // otherwise waits for. Without this flag the demo can never run on a machine
    // that has not used Playwright before — every clean CI runner included.
    const demo = fs.readFileSync(path.join(SKILL_DIR, 'scripts', 'demo.mjs'), 'utf8');
    assert.match(
      demo,
      /runScript\('bootstrap\.mjs', \[\s*'--install-browsers'\s*\]\)/,
      'demo.mjs 必须以 --install-browsers 调用 bootstrap，否则在干净机器上必然失败',
    );
  });

  it('makes the demo match the skill default, except on CI', () => {
    // A new user's first command is `npm run demo`. If that is headless while
    // real runs are headed, the first impression contradicts the real behaviour.
    // CI has no display, so it must still go headless there.
    const demo = fs.readFileSync(path.join(SKILL_DIR, 'scripts', 'demo.mjs'), 'utf8');
    assert.match(demo, /modeFlags\.push\('--headless'\)/, 'demo 需要无头分支');
    assert.match(demo, /modeFlags\.push\('--headed'\)/, 'demo 需要默认有头分支');
    assert.match(demo, /process\.env\.CI/, 'demo 必须检测 CI 环境');
    assert.match(demo, /flags\.headed !== true && isCI\(\)/, 'CI 时无头，其余情况有头');
  });

  it('documents headed mode in the skill instructions', () => {
    // If SKILL.md never mentions it, the agent cannot tell the user how to watch.
    const skill = fs.readFileSync(SKILL_FILE, 'utf8');
    assert.ok(skill.includes('--headed'), 'SKILL.md 必须说明怎么开窗口观看');
    assert.ok(skill.includes('--headless'), 'SKILL.md 必须说明服务器/CI 上要用 --headless');
    assert.ok(skill.includes('--slow-mo'), 'SKILL.md 必须说明怎么放慢以便肉眼跟');
  });

  it('gives the CI demo job a deterministic browser cache path', () => {
    // actions/cache errors on a path that does not exist, and a platform-specific
    // default would make the cache key ambiguous. Pinning the path avoids both.
    const ci = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
    assert.match(ci, /PLAYWRIGHT_BROWSERS_PATH:/, 'CI 应固定 PLAYWRIGHT_BROWSERS_PATH');
    assert.match(ci, /mkdir -p \.pw-browsers/, '缓存前应先创建浏览器目录');
  });

  it('ships a LICENSE matching the declared license', () => {
    const licensePath = path.join(ROOT, 'LICENSE');
    assert.ok(fs.existsSync(licensePath), '缺少 LICENSE');
    const license = fs.readFileSync(licensePath, 'utf8');
    assert.match(license, /^MIT License/);

    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.equal(manifest.license, 'MIT');
    assert.ok(license.includes(manifest.author), 'LICENSE 的版权人应与 package.json 的 author 一致');
  });

  it('declares repository metadata', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.match(manifest.repository.url, /github\.com\/minshan1874\/ai-playwright-skill/);
    assert.match(manifest.bugs.url, /\/issues$/);
    assert.match(manifest.homepage, /^https:\/\/github\.com\//);
    assert.ok(manifest.engines.node, 'package.json 应声明 Node 版本要求');
    assert.equal(manifest.private, true, '这是一个 skill 仓库，不应被意外发布到 npm');
  });

  it('keeps the README, CHANGELOG and CONTRIBUTING in sync with the repo', () => {
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    assert.match(readme, /github\.com\/minshan1874\/ai-playwright-skill/, 'README 的克隆地址应为真实仓库');
    assert.ok(readme.includes('CONTRIBUTING.md'));
    assert.ok(readme.includes('SECURITY.md'));
    assert.ok(readme.includes('LICENSE'));

    const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
    const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
    assert.ok(changelog.includes(`[${version}]`), `CHANGELOG 缺少 ${version} 条目`);

    for (const file of ['CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md']) {
      assert.ok(fs.existsSync(path.join(ROOT, file)), `缺少 ${file}`);
    }
  });

  it('marks the Excel template as binary for git', () => {
    const attributes = fs.readFileSync(path.join(ROOT, '.gitattributes'), 'utf8');
    assert.ok(attributes.includes('*.xlsx binary'));
    assert.ok(attributes.includes('eol=lf'), '应统一换行符，避免跨平台 diff 噪音');
  });

  it('links the CI workflow from the README', () => {
    // A live CI badge beats a hardcoded test count, which goes stale silently.
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    assert.ok(
      readme.includes('actions/workflows/ci.yml/badge.svg'),
      'README 缺少 CI 徽章',
    );
    assert.ok(fs.existsSync(path.join(ROOT, '.github', 'workflows', 'ci.yml')));
  });

  it('has no broken relative links in any Markdown file', () => {
    /** Walk the repo, skipping .git and anything installed at runtime. */
    const walk = (dir) =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        if (['.git', 'node_modules', 'runs', 'test-results', 'playwright-report'].includes(entry.name)) return [];
        const full = path.join(dir, entry.name);
        return entry.isDirectory() ? walk(full) : [full];
      });

    const markdown = walk(ROOT).filter((file) => file.endsWith('.md'));
    assert.ok(markdown.length >= 8, `只找到 ${markdown.length} 个 Markdown 文件`);

    const broken = [];
    for (const file of markdown) {
      const text = fs.readFileSync(file, 'utf8');
      for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
        const target = match[1].trim();
        // External links and in-page anchors are not our problem.
        if (/^(https?:|mailto:|#)/.test(target)) continue;
        const relative = target.split('#')[0];
        if (relative === '') continue;
        if (!fs.existsSync(path.resolve(path.dirname(file), relative))) {
          broken.push(`${path.relative(ROOT, file)} → ${target}`);
        }
      }
    }
    assert.deepEqual(broken, [], `发现失效的相对链接：\n${broken.join('\n')}`);
  });
});

describe('script syntax', () => {
  const scriptsDir = path.join(SKILL_DIR, 'scripts');
  const entries = [
    ...fs.readdirSync(scriptsDir).filter((name) => name.endsWith('.mjs')).map((name) => path.join(scriptsDir, name)),
    ...fs
      .readdirSync(path.join(scriptsDir, 'lib'))
      .filter((name) => name.endsWith('.mjs'))
      .map((name) => path.join(scriptsDir, 'lib', name)),
  ];

  it('found the expected number of modules', () => {
    assert.ok(entries.length >= 20, `只找到 ${entries.length} 个模块`);
  });

  for (const file of entries) {
    it(`${path.relative(ROOT, file)} parses`, () => {
      // `--check` parses without executing, so a syntax error fails loudly here.
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    });
  }
});

describe('CLI contracts', () => {
  /**
   * Scratch home for the CLI subprocesses. Kept in the OS temp directory so the
   * test run never leaves artifacts inside the repository.
   * @type {string}
   */
  let sandbox;

  before(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-e2e-cli-'));
  });
  after(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  /**
   * Run a script and return its parsed JSON payload.
   * @param {string} script
   * @param {string[]} args
   * @returns {{code: number, payload: any}}
   */
  function run(script, args) {
    let stdout = '';
    let code = 0;
    try {
      stdout = execFileSync(process.execPath, [path.join(SKILL_DIR, 'scripts', script), ...args, '--json'], {
        encoding: 'utf8',
        env: { ...process.env, PLAYWRIGHT_E2E_HOME: sandbox },
        stdio: 'pipe',
      });
    } catch (error) {
      stdout = String(error.stdout ?? '');
      code = Number(error.status ?? 1);
    }
    const marker = '###PLAYWRIGHT_E2E_JSON###';
    const index = stdout.indexOf(marker);
    const line = index === -1 ? '' : stdout.slice(index + marker.length).split('\n').find((entry) => entry.trim() !== '');
    return { code, payload: line ? JSON.parse(line) : null };
  }

  it('every script reports a structured failure when required flags are missing', () => {
    const cases = [
      ['parse-cases.mjs', [], /--input/],
      ['make-plan.mjs', [], /--run-dir/],
      ['confirm-plan.mjs', [], /--plan|--run-dir/],
      ['explore.mjs', [], /--out/],
      ['run.mjs', [], /--run-dir/],
      ['report.mjs', [], /--run-dir/],
      ['new-run.mjs', [], /--url|--name/],
    ];

    for (const [script, args, pattern] of cases) {
      const { code, payload } = run(script, args);
      assert.equal(code, 1, `${script} 在缺少参数时应以退出码 1 结束`);
      assert.ok(payload !== null, `${script} 未输出 JSON`);
      assert.equal(payload.ok, false, `${script} 应报告 ok:false`);
      assert.match(String(payload.error), pattern, `${script} 的错误信息未指出缺失的参数`);
      assert.ok(payload.hint, `${script} 应给出 hint`);
    }
  });

  it('the plan gate refuses to run an unconfirmed plan', () => {
    const runDir = path.join(sandbox, 'gate-check');
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'plan.md'), '# 计划\n\n状态: 待确认\n');

    const { payload } = run('run.mjs', ['--run-dir', runDir]);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /尚未确认/);
    assert.match(payload.hint, /confirm-plan/);

    fs.rmSync(runDir, { recursive: true, force: true });
  });

  it('confirm-plan flips the status and run.mjs then proceeds past the gate', () => {
    const runDir = path.join(sandbox, 'gate-confirm');
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'plan.md'), '# 计划\n\n状态: 待确认\n');

    const confirmed = run('confirm-plan.mjs', ['--plan', path.join(runDir, 'plan.md')]);
    assert.equal(confirmed.payload.ok, true);
    assert.equal(confirmed.payload.status, '已确认');

    // Past the gate, the next failure is a downstream one — not the plan gate.
    const { payload } = run('run.mjs', ['--run-dir', runDir, '--url', 'https://example.test']);
    assert.equal(payload.ok, false);
    assert.ok(!/尚未确认/.test(String(payload.error)), '确认后不应再被计划门禁拦下');
    // Depending on whether the toolchain happens to be installed, run.mjs stops at
    // the missing dependency or at the missing specs. Both mean the gate opened.
    assert.match(String(payload.error), /没有找到任何用例文件|未找到 Playwright/);

    fs.rmSync(runDir, { recursive: true, force: true });
  });
});
