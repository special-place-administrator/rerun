export const EVEROS_WRAPPER_COMMAND = '/data/tools/bin/everos-mcp'

export const EVEROS_MCP_SERVER = {
    name: 'everos',
    transport: 'stdio',
    command: '/data/tools/bin/uv',
    args: ['run', '--quiet', '--python', '3.12', '/data/tools/everos-mcp/server.py'],
    env: {
        EVEROS_URL: '${EVEROS_URL}',
        EVEROS_USER_ID: '${EVEROS_USER_ID}',
        EVEROS_APP: '${EVEROS_APP}',
        EVEROS_TOKEN: '${EVEROS_TOKEN}',
        UV_CACHE_DIR: '/data/tools/uv-cache',
        UV_PYTHON_INSTALL_DIR: '/data/tools/uv-python',
    },
    headers: {},
} as const
