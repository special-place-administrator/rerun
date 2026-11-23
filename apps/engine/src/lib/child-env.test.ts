import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { childProcessEnv, envOverlay, inheritedEnv, spawnSafeEnv, withEngineOwnedEnv } from './child-env.js'

const engineEnv = {
    PATH: '/usr/bin',
    HOME: '/home/rerun',
    LANG: 'fr_FR.UTF-8',
    LC_TIME: 'en_GB.UTF-8',
    XDG_RUNTIME_DIR: '/run/user/1000',
    DISPLAY: ':1',
    https_proxy: 'http://proxy:3128',
    RERUN_API_KEY: 'engine-key',
    RERUN_PAIR_TOKEN: 'pair',
    RERUN_HUB_BASE_URL: 'https://hub.example',
    RERUN_DATA_DIR: '/data',
    RERUN_PORT: '3900',
    NODE_ENV: 'production',
    EMPTY: undefined,
}

afterEach(() => vi.unstubAllEnvs())

describe('inheritedEnv', () => {
    it('keeps the user, paths, locale, display and network settings and nothing of the engine configuration', () => {
        expect(inheritedEnv(engineEnv)).toEqual({
            PATH: '/usr/bin',
            HOME: '/home/rerun',
            LANG: 'fr_FR.UTF-8',
            LC_TIME: 'en_GB.UTF-8',
            XDG_RUNTIME_DIR: '/run/user/1000',
            DISPLAY: ':1',
            https_proxy: 'http://proxy:3128',
        })
    })

    it('reads the engine process by default', () => {
        vi.stubEnv('RERUN_API_KEY', 'live-key')
        vi.stubEnv('TZ', 'Europe/Paris')
        const env = inheritedEnv()
        expect(env.TZ).toBe('Europe/Paris')
        expect(env).not.toHaveProperty('RERUN_API_KEY')
    })
})

describe('childProcessEnv', () => {
    it('lays the agent variables and the extras over the inherited base, with the engine PATH last', () => {
        vi.stubEnv('PATH', '/usr/bin')
        vi.stubEnv('RERUN_API_KEY', 'live-key')
        expect(childProcessEnv({ PATH: '/agent/bin', LINEAR_API_KEY: 'lin', RERUN_WORKSPACE: '/w' }, { RERUN_WORKSPACE: '/ws' })).toMatchObject({ PATH: '/usr/bin', LINEAR_API_KEY: 'lin', RERUN_WORKSPACE: '/ws' })
        expect(childProcessEnv({})).not.toHaveProperty('RERUN_API_KEY')
    })

    it('passes a declared key only as a ${VAR} reference or a named engine key, and an agent key unless it steers a loader, installer or proxy', () => {
        const declared = { PREFIX: '${RERUN_WORKSPACE}/p', FOO_UNKNOWN: '1', RUBYOPT: '-rx', PERL5OPT: '-Mx', PIP_INDEX_URL: 'https://a.invalid', UV_INDEX_URL: 'https://a.invalid', HTTPS_PROXY: 'http://a.invalid', npm_config_registry: 'http://a.invalid', API_KEY: '${SECRET_X}', UV_CACHE_DIR: '/data/tools/uv-cache', MCP_MODE: 'stdio', NODE_OPTIONS: '${SECRET_X}', FALCON_BASE_URL: 'https://api.eu-1.crowdstrike.com', ANTHROPIC_BASE_URL: '${SECRET_X}' }
        expect(Object.keys(spawnSafeEnv(declared)).sort()).toEqual(['API_KEY', 'FALCON_BASE_URL', 'MCP_MODE', 'UV_CACHE_DIR'])
        expect(Object.keys(spawnSafeEnv({ A: 'Bearer ${X}', B: 'token ${A}:${B}', C: '${X}/bin', D: '--require ${X}', E: '${HOME}/../x', F: 'a=${X}', G: 'C:${X}', H: '~${X}', I: 'Bearer', NODE_OPTIONS: 'Bearer ${X}' }))).toEqual(['A', 'B'])
        expect(['https://falcon.example', 'https://api.eu-1.crowdstrike.com/', 'https://API.eu-1.crowdstrike.com', '${SECRET_X}'].map(value => spawnSafeEnv({ FALCON_BASE_URL: value }))).toEqual([{}, {}, {}, {}])
        const shell = childProcessEnv({ FOO_UNKNOWN: '1', DATABASE_URL: 'postgres://db', UV_CACHE_DIR: '/data/uv', UV_PYTHON_INSTALL_DIR: '/data/py', PREFIX: '/tmp/p', PIP_INDEX_URL: 'x', PIP_CONFIG_FILE: 'x', UV_EXTRA_INDEX_URL: 'x', UV_INDEX: 'x', HTTPS_PROXY: 'x', all_proxy: 'x', npm_config_registry: 'x', RUBYOPT: '-rx', RUBYLIB: 'x', PERL5OPT: '-Mx', FALCON_BASE_URL: 'x', LINEAR_API_KEY: 'lin', NOTION_TOKEN: '/data/agents/a/workspace/t', RERUN_WORKSPACE: '/data/agents/a/workspace' })
        expect(Object.keys(shell).filter(key => ['FOO_UNKNOWN', 'DATABASE_URL', 'UV_CACHE_DIR', 'UV_PYTHON_INSTALL_DIR', 'LINEAR_API_KEY', 'RERUN_WORKSPACE', 'PREFIX', 'PIP_INDEX_URL', 'PIP_CONFIG_FILE', 'UV_EXTRA_INDEX_URL', 'UV_INDEX', 'all_proxy', 'npm_config_registry', 'RUBYOPT', 'RUBYLIB', 'PERL5OPT', 'FALCON_BASE_URL', 'NOTION_TOKEN'].includes(key)).sort()).toEqual(['DATABASE_URL', 'FOO_UNKNOWN', 'LINEAR_API_KEY', 'RERUN_WORKSPACE', 'UV_CACHE_DIR', 'UV_PYTHON_INSTALL_DIR'])
        expect(shell.HTTPS_PROXY).not.toBe('x')
    })

    it('passes no git config, shell hook or loader key from the agent, and sets the engine git helper last', () => {
        const dir = mkdtempSync(resolve(tmpdir(), 'child-env-git-'))
        const hook = resolve(dir, 'hook.sh')
        writeFileSync(hook, `#!/bin/sh\ntouch ${resolve(dir, 'fsmonitor-ran')}\n`, { mode: 0o755 })
        spawnSync('git', ['init', '-q', dir])
        const env = childProcessEnv({ GH_TOKEN: 'gh-1', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: hook, GIT_PAGER: 'sh -c id', SHELLOPTS: 'xtrace', PS4: `$(touch ${resolve(dir, 'ps4-ran')})`, BASH_FUNC_ls: '() { :; }', ANTHROPIC_BASE_URL: 'https://attacker.invalid', 'bad-key': 'x', LINEAR_API_KEY: 'lin' })
        spawnSync('git', ['status'], { cwd: dir, env })
        spawnSync('bash', ['-c', 'true'], { env })
        expect([existsSync(resolve(dir, 'fsmonitor-ran')), existsSync(resolve(dir, 'ps4-ran'))]).toEqual([false, false])
        for (const key of ['GIT_PAGER', 'SHELLOPTS', 'PS4', 'BASH_FUNC_ls', 'ANTHROPIC_BASE_URL', 'bad-key']) expect(env).not.toHaveProperty(key)
        expect([env.LINEAR_API_KEY, env.GIT_CONFIG_COUNT, env.GIT_CONFIG_KEY_1]).toEqual(['lin', '2', 'credential.https://github.com.helper'])

        const refused = ['PYTHONPATH', 'PYTHONHOME', 'PYTHONSTARTUP', 'PYTHONUSERBASE', 'PROMPT_COMMAND', 'ZDOTDIR', 'GLIBC_TUNABLES', 'CLAUDE_CODE_SHELL_PREFIX', 'CLAUDE_ENV_FILE', 'OPENSSL_MODULES', 'OPENSSL_ENGINES', 'LOCPATH', 'GIT_DIR', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'NODE_OPTIONS', 'JAVA_TOOL_OPTIONS', 'JDK_JAVA_OPTIONS', '_JAVA_OPTIONS', 'OPENSSL_CONF', 'GCONV_PATH', 'PERLLIB', 'PERL5LIB', 'LESSOPEN', 'BASH_ENV', 'SHELLOPTS', 'PS4', 'ENV', 'IFS', 'ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL', 'ANTHROPIC_BEDROCK_BASE_URL', 'PATH', 'HOME', 'NODE_PATH']
        const spawned = withEngineOwnedEnv({ PATH: '/usr/bin', HOME: '/home/rerun', RERUN_WORKSPACE: '/data/agents/a/workspace' }, { ...Object.fromEntries(refused.map(key => [key, 'x'])), UV_CACHE_DIR: '/data/uv', PYTHONUNBUFFERED: '1', API_KEY: '/data/agents/a/workspace/k', FALCON_BASE_URL: 'https://falcon.example', npm_config_registry: 'http://a.invalid', PYTHONPATH: '/data/agents/a/workspace/lib', SSL_CERT_FILE: '/data/agents/a/workspace/ca.pem', NODE_EXTRA_CA_CERTS: '/data/agents/a/workspace/../workspace/ca.pem' })
        expect(Object.keys(spawned).filter(key => !key.startsWith('NPM_CONFIG_')).sort()).toEqual(['HOME', 'PATH', 'PYTHONUNBUFFERED', 'RERUN_WORKSPACE', 'UV_CACHE_DIR'])
        expect([spawned.PATH, spawned.HOME]).toEqual(['/usr/bin', '/home/rerun'])
    })
})

describe('envOverlay', () => {
    it('empties every engine variable the child must not see and keeps the rest', () => {
        vi.stubEnv('RERUN_API_KEY', 'live-key')
        vi.stubEnv('PATH', '/usr/bin')
        const overlay = envOverlay({ PATH: '/usr/bin', CODEX_HOME: '/codex' })
        expect(overlay.RERUN_API_KEY).toBe('')
        expect(overlay.PATH).toBe('/usr/bin')
        expect(overlay.CODEX_HOME).toBe('/codex')
        expect({ ...process.env, ...overlay }.RERUN_API_KEY).toBe('')
        expect(Object.values(overlay).every(value => typeof value === 'string')).toBe(true)
    })
})
