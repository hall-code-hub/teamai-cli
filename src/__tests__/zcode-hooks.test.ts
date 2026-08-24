import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────

let mockFiles: Record<string, unknown> = {};

vi.mock('../utils/fs.js', () => ({
  readJson: vi.fn(async (filePath: string) => mockFiles[filePath] ?? null),
  writeJson: vi.fn(async (filePath: string, data: unknown) => {
    mockFiles[filePath] = JSON.parse(JSON.stringify(data));
  }),
  expandHome: (p: string) => p,
  ensureDir: vi.fn(),
  pathExists: vi.fn(async () => true),
}));

vi.mock('../utils/logger.js', () => ({
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    dim: vi.fn(),
  },
  spinner: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
  })),
}));

import {
  injectHooks,
  removeHooks,
  reconcileHooks,
  getHookStatus,
  applyAgentHook,
  removeAgentHook,
  hookToolPathsForScope,
} from '../hooks.js';
import { KNOWN_AGENTS } from '../known-agents.js';
import { TeamaiConfigSchema } from '../types.js';

const ZC = '/home/u/.zcode/cli/config.json';

interface ZcodeEntry {
  matcher?: string;
  hooks: Array<{ type: string; command: string; timeout?: number }>;
  description?: string;
}

function zcodeEvents(file: unknown): Record<string, ZcodeEntry[]> {
  const doc = file as { hooks?: { events?: Record<string, ZcodeEntry[]> } };
  return doc?.hooks?.events ?? {};
}

// ── Tests ────────────────────────────────────────────────

describe('zcode hooks', () => {
  beforeEach(() => {
    mockFiles = {};
    vi.clearAllMocks();
  });

  it('injects built-in hooks under hooks.events with enabled: true', async () => {
    await injectHooks(ZC, 'zcode');

    const doc = mockFiles[ZC] as { hooks: { enabled?: boolean } };
    expect(doc.hooks.enabled).toBe(true);

    const events = zcodeEvents(mockFiles[ZC]);
    // Same event set as the other PascalCase backends.
    expect(Object.keys(events)).toEqual(['SessionStart', 'Stop', 'PostToolUse', 'UserPromptSubmit']);
    expect(events.PostToolUse).toHaveLength(3);
    // ZCode runs command hooks via cmd.exe on Windows, so teamai entries use
    // the shell-free process form: node + entry file + argument vector.
    const first = events.SessionStart[0].hooks[0];
    expect(first.type).toBe('process');
    expect(first.command).toBe(process.execPath);
    expect(first.args).toContain('--tool');
    expect(first.args).toContain('zcode');
    expect(first.args?.join(' ')).toContain('hook-dispatch');
    // ZCode documents no description field — entries carry none.
    expect(events.SessionStart[0].description).toBeUndefined();
  });

  it('omits the matcher for the "*" wildcard and keeps concrete matchers', async () => {
    await injectHooks(ZC, 'zcode');

    const events = zcodeEvents(mockFiles[ZC]);
    // A "*" matcher is an invalid regex in ZCode and would never match; the
    // wildcard entries must omit the field entirely (omitted = match all).
    expect(events.SessionStart[0].matcher).toBeUndefined();
    expect(events.Stop[0].matcher).toBeUndefined();
    // Concrete tool matchers pass through as regex-safe literals.
    const matchers = events.PostToolUse.map((e) => e.matcher);
    expect(matchers).toContain('Skill');
    expect(matchers).toContain('TodoWrite');
    expect(matchers).toContain(undefined);
  });

  it('preserves user entries and unrelated top-level keys in config.json', async () => {
    mockFiles[ZC] = {
      skills: { '/some/skills': { enabled: false } },
      hooks: {
        events: {
          SessionStart: [
            { matcher: 'startup', hooks: [{ type: 'command', command: 'echo user-hook' }] },
          ],
        },
      },
    };

    await injectHooks(ZC, 'zcode');

    const doc = mockFiles[ZC] as Record<string, unknown> & { hooks: { events: Record<string, ZcodeEntry[]> } };
    expect(doc.skills).toEqual({ '/some/skills': { enabled: false } });
    const session = doc.hooks.events.SessionStart;
    // User's own entry survives alongside the teamai one.
    expect(session.some((e) => e.hooks[0].command === 'echo user-hook')).toBe(true);
    expect(session.some((e) => (e.hooks[0].args ?? []).includes('hook-dispatch'))).toBe(true);
  });

  it('flips hooks.enabled on when writing into an existing config', async () => {
    mockFiles[ZC] = { hooks: { enabled: false, events: {} } };
    await injectHooks(ZC, 'zcode');
    const doc = mockFiles[ZC] as { hooks: { enabled?: boolean } };
    // Config-file hooks are disabled by default in ZCode — our write must
    // switch the runner on or the entries never fire.
    expect(doc.hooks.enabled).toBe(true);
  });

  it('is idempotent — a second run does not rewrite the file', async () => {
    await injectHooks(ZC, 'zcode');
    const afterFirst = JSON.stringify(mockFiles[ZC]);
    await injectHooks(ZC, 'zcode');
    expect(JSON.stringify(mockFiles[ZC])).toBe(afterFirst);
  });

  it('removeAll strips teamai entries but keeps user entries and enabled flag', async () => {
    await injectHooks(ZC, 'zcode');
    const doc = mockFiles[ZC] as { hooks: { events: Record<string, ZcodeEntry[]> } };
    doc.hooks.events.SessionStart.push({
      matcher: 'startup',
      hooks: [{ type: 'command', command: 'echo user-hook' }],
    });
    mockFiles[ZC] = JSON.parse(JSON.stringify(doc));

    await removeHooks(ZC, 'zcode');

    const after = mockFiles[ZC] as { hooks: { enabled?: boolean; events: Record<string, ZcodeEntry[]> } };
    expect(after.hooks.events.SessionStart).toHaveLength(1);
    expect(after.hooks.events.SessionStart[0].hooks[0].command).toBe('echo user-hook');
    // teamai-only events are emptied (kept as [] like the other backends).
    expect(after.hooks.events.Stop).toEqual([]);
    // The enabled flag is left alone — the user may run their own config hooks.
    expect(after.hooks.enabled).toBe(true);
  });

  it('getHookStatus reports installed after injection and missing otherwise', async () => {
    expect(await getHookStatus(ZC, 'zcode')).toBe('missing');
    await injectHooks(ZC, 'zcode');
    expect(await getHookStatus(ZC, 'zcode')).toBe('installed');
  });

  it('reconcileHooks routes zcode through the zcode backend (events nest)', async () => {
    await reconcileHooks(ZC, 'zcode', []);
    const doc = mockFiles[ZC] as { hooks: { events?: Record<string, ZcodeEntry[]> } };
    expect(doc.hooks.events).toBeDefined();
    expect(doc.hooks.SessionStart).toBeUndefined();
  });

  it('applyAgentHook installs by command and removeAgentHook tears it down', async () => {
    await applyAgentHook(ZC, 'zcode', {
      slug: 'my-agent',
      event: 'UserPromptSubmit',
      command: 'node ~/.teamai/agents/my-agent/hook.js',
    });

    let events = zcodeEvents(mockFiles[ZC]);
    let entry = events.UserPromptSubmit.find((e) => e.hooks[0].command.includes('my-agent'));
    expect(entry).toBeDefined();
    // agent-hook matcher defaults to '*' → omitted in zcode
    expect(entry?.matcher).toBeUndefined();

    await removeAgentHook(ZC, 'zcode', { slug: 'my-agent', command: 'node ~/.teamai/agents/my-agent/hook.js' });
    events = zcodeEvents(mockFiles[ZC]);
    expect(events.UserPromptSubmit).toBeUndefined();
  });
});

describe('hookToolPathsForScope', () => {
  const toolPaths = {
    claude: { settings: '.claude/settings.json' },
    zcode: { skills: '.zcode/skills', settings: '.zcode/cli/config.json' },
  };

  it('keeps everything intact in user scope', () => {
    expect(hookToolPathsForScope(toolPaths, 'user')).toBe(toolPaths);
  });

  it('strips only the zcode settings path in project scope', () => {
    const scoped = hookToolPathsForScope(toolPaths, 'project');
    expect(scoped.claude).toEqual(toolPaths.claude);
    expect(scoped.zcode?.settings).toBeUndefined();
    // Non-settings fields survive so skills/rules/mcp keep working.
    expect(scoped.zcode?.skills).toBe('.zcode/skills');
  });

  it('is a no-op when zcode has no settings configured', () => {
    const minimal = { zcode: { skills: '.zcode/skills' } };
    expect(hookToolPathsForScope(minimal, 'project')).toBe(minimal);
  });
});

describe('zcode registry', () => {
  it('KNOWN_AGENTS has a zcode entry pointing at .zcode/skills', () => {
    const zcode = KNOWN_AGENTS.find((a) => a.id === 'zcode');
    expect(zcode).toBeDefined();
    expect(zcode?.skillsPath).toBe('.zcode/skills');
    expect(zcode?.category).toBe('coding');
  });

  it('toolPaths defaults include zcode with the verified paths', () => {
    const config = TeamaiConfigSchema.parse({
      team: 't',
      repo: 'r',
    });
    const zc = config.toolPaths.zcode;
    expect(zc).toBeDefined();
    expect(zc?.skills).toBe('.zcode/skills');
    expect(zc?.rules).toBe('.zcode/rules');
    expect(zc?.agents).toBe('.zcode/agents');
    expect(zc?.settings).toBe('.zcode/cli/config.json');
    expect(zc?.mcp).toBe('.zcode/cli/config.json');
    expect(zc?.mcpProject).toBe('.zcode/config.json');
    // No claudemd: the two scopes read different files and userScope cannot
    // override it (open item in docs/designs/zcode-adapter.md).
    expect(zc?.claudemd).toBeUndefined();
  });
});
