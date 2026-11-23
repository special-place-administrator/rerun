import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { dataDir } from '../config/paths.js'

export const INHERITED_ENV_VARS = ['HOME', 'LOGNAME', 'USER', 'SHELL', 'TERM', 'PATH', 'TMPDIR', 'TZ', 'LANG', 'LANGUAGE', 'LC_ALL', 'DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'COREPACK_ENABLE_DOWNLOAD_PROMPT'] as const

export const INHERITED_ENV_PREFIXES = ['LC_', 'XDG_'] as const

const inherited = (key: string): boolean => (INHERITED_ENV_VARS as readonly string[]).includes(key) || INHERITED_ENV_PREFIXES.some(prefix => key.startsWith(prefix))

export function inheritedEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(source)) if (value !== undefined && inherited(key)) env[key] = value
    return env
}

const ENGINE_OWNED_ENV_VARS = ['PATH', 'HOME', 'NODE_PATH'] as const

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

const HARD_REFUSED_ENV_RE = /^(?:GIT_|LD_|DYLD_|BASH_|OPENSSL_|LOCPATH$|GCONV_PATH$|PERL\w*LIB$|LESSOPEN$|SHELLOPTS$|BASHOPTS$|PS4$|ENV$|IFS$|PYTHONPATH$|PYTHONHOME$|PYTHONSTARTUP$|PYTHONUSERBASE$|PROMPT_COMMAND$|ZDOTDIR$|GLIBC_TUNABLES$|CLAUDE_CODE_SHELL_PREFIX$|CLAUDE_ENV_FILE$|PREFIX$|RUBYOPT$|RUBYLIB$|PERL5OPT$|PIP_|UV_INDEX|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$|NO_PROXY$|NPM_CONFIG_)|_OPTIONS$|_BASE_URL$|_INDEX_URL$/

export function isSpawnRefusedEnvKey(key: string): boolean {
    const upper = key.toUpperCase()
    return !ENV_KEY_RE.test(key) || (ENGINE_OWNED_ENV_VARS as readonly string[]).includes(upper) || HARD_REFUSED_ENV_RE.test(upper)
}

export const NAMED_ENGINE_ENV_KEYS = ['UV_CACHE_DIR', 'UV_PYTHON_INSTALL_DIR', 'ALLOW_USER_GENERATED_CONTENT', 'EMAIL_USER', 'IMAP_HOST', 'IMAP_PORT', 'IMAP_SECURE', 'KIE_AI_ALLOW_DIRECT_GENERATION', 'MCP_MODE', 'MCP_MODEL_ID', 'MCP_SERVER_URL', 'META_ADS_ENABLE_WRITE_TOOLS', 'MYSHOPIFY_DOMAIN', 'N8N_API_URL', 'READ_ONLY', 'SLACK_TEAM_ID', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE'] as const

const named = (key: string): boolean => (NAMED_ENGINE_ENV_KEYS as readonly string[]).includes(key)

export const MCP_ONLY_ENV_VALUES: Readonly<Record<string, readonly string[]>> = {
    FALCON_BASE_URL: ['https://api.crowdstrike.com', 'https://api.us-2.crowdstrike.com', 'https://api.eu-1.crowdstrike.com', 'https://api.laggar.gcw.crowdstrike.com'],
}

const mcpOnly = (key: string): boolean => Object.hasOwn(MCP_ONLY_ENV_VALUES, key)

const mcpRefused = (key: string, value: string): boolean => (mcpOnly(key) ? !MCP_ONLY_ENV_VALUES[key]!.includes(value) : isSpawnRefusedEnvKey(key))

const ENV_REF_RE = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/g

const TEMPLATE_REMAINDER_REFUSED_RE = /[/=\\~$]|\.\.|(?:^|\s)-|(?:^|[^A-Za-z])[A-Za-z]:/

const hasEnvRef = (value: string): boolean => value.replace(ENV_REF_RE, '\u0000') !== value

const templatedEnvValue = (value: string): boolean => hasEnvRef(value) && !TEMPLATE_REMAINDER_REFUSED_RE.test(value.replace(ENV_REF_RE, '\u0000'))

export function templateRefusedEnvKeys(env: Record<string, string>): string[] {
    return Object.entries(env)
        .filter(([key, value]) => !mcpRefused(key, value) && !named(key) && !mcpOnly(key) && hasEnvRef(value) && !templatedEnvValue(value))
        .map(([key]) => key)
}

const NPM_CONFIG_RE = /^npm_config_/i

const ENGINE_LABEL_RE = /^RERUN_[A-Z0-9_]+$/

export function spawnSafeEnv(env: Record<string, string>): Record<string, string> {
    return Object.fromEntries(Object.entries(env).filter(([key, value]) => !mcpRefused(key, value) && (templatedEnvValue(value) || named(key) || mcpOnly(key))))
}

function agentSafeEnv(env: Record<string, string>): Record<string, string> {
    const root = env.RERUN_WORKSPACE ? dirname(env.RERUN_WORKSPACE) : undefined
    return Object.fromEntries(Object.entries(env).filter(([key, value]) => !isSpawnRefusedEnvKey(key) && (ENGINE_LABEL_RE.test(key) || !(root && pointsInto(value, root)))))
}

export function engineNpmEnv(): Record<string, string> {
    const dir = resolve(dataDir(), 'npm-empty')
    mkdirSync(dir, { recursive: true })
    const files = { NPM_CONFIG_GLOBALCONFIG: resolve(dir, 'globalconfig'), NPM_CONFIG_USERCONFIG: resolve(dir, 'userconfig') }
    for (const file of Object.values(files)) writeFileSync(file, '')
    return files
}

export function outsideAgentDir(env: Record<string, string>, root: string): Record<string, string> {
    return Object.fromEntries(Object.entries(env).filter(([, value]) => !pointsInto(value, root)))
}

const GIT_HELPER_KEY = 'credential.https://github.com.helper'
const GIT_HELPER = '!f() { if [ "$1" = get ]; then echo username=x-access-token; echo "password=$GH_TOKEN"; fi; }; f'

export function engineGitEnv(env: Record<string, string>): Record<string, string> {
    if (!env.GH_TOKEN) return {}
    return { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: GIT_HELPER_KEY, GIT_CONFIG_VALUE_0: '', GIT_CONFIG_KEY_1: GIT_HELPER_KEY, GIT_CONFIG_VALUE_1: GIT_HELPER }
}

function engineOwned(base: Record<string, string>): Record<string, string> {
    const owned: Record<string, string> = {}
    for (const key of ENGINE_OWNED_ENV_VARS) if (base[key] !== undefined) owned[key] = base[key]
    return owned
}

export function childProcessEnv(agentEnv: Record<string, string>, extra: Record<string, string> = {}): Record<string, string> {
    const base = inheritedEnv()
    return { ...base, ...agentSafeEnv(agentEnv), ...extra, ...engineOwned(base), ...engineGitEnv(agentEnv) }
}

function pointsInto(value: string, root: string): boolean {
    return value.includes(`${root}/`) || value.split(/[:;\s=,]+/).some(part => {
        const rel = relative(root, resolve(root, part))
        return isAbsolute(part) && (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)))
    })
}

export function withEngineOwnedEnv(spawnEnv: Record<string, string>, serverEnv: Record<string, string>): Record<string, string> {
    const agentRoot = spawnEnv.RERUN_WORKSPACE ? dirname(spawnEnv.RERUN_WORKSPACE) : undefined
    const declared = Object.entries(serverEnv).filter(([key, value]) => !mcpRefused(key, value) && (!agentRoot || !pointsInto(value, agentRoot)))
    const spawned = Object.entries(spawnEnv).filter(([key]) => !NPM_CONFIG_RE.test(key))
    return { ...Object.fromEntries(spawned), ...Object.fromEntries(declared), ...engineOwned(spawnEnv), ...engineNpmEnv() }
}

export function envOverlay(env: Record<string, string>): Record<string, string> {
    const overlay: Record<string, string> = {}
    for (const key of Object.keys(process.env)) if (!(key in env)) overlay[key] = ''
    return { ...overlay, ...env }
}
