const REDACTED = '[redacted]'

export function redactSecrets(text: string, secrets: readonly string[]): string {
    return secrets.reduce((out, secret) => out.split(secret).join(REDACTED), text)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (value === null || typeof value !== 'object') return false
    const proto = Object.getPrototypeOf(value)
    return proto === Object.prototype || proto === null
}

export function redactSecretsDeep<T>(value: T, secrets: readonly string[]): T {
    if (secrets.length === 0) return value
    if (typeof value === 'string') return redactSecrets(value, secrets) as T
    if (Array.isArray(value)) return value.map(item => redactSecretsDeep(item, secrets)) as T
    if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactSecretsDeep(item, secrets)])) as T
    return value
}
