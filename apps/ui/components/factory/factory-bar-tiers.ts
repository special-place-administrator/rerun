export const BAR_NATURAL_WIDTH = { t0: 1861, t1: 1557, t2: 1133, t3: 631 } as const

export const BAR_FIT_SLACK = 16

export const BAR_TIERS = {
    t1: { below: 1877, hide: '@max-[1877px]:hidden', show: '@max-[1877px]:flex', square: '@max-[1877px]:size-8 @max-[1877px]:px-0' },
    t2: { below: 1573, hide: '@max-[1573px]:hidden', show: '@max-[1573px]:flex' },
    t3: {
        below: 1149,
        hide: '@max-[1149px]:hidden',
        show: '@max-[1149px]:flex',
        srOnly: '@max-[1149px]:sr-only',
        undivided: '@max-[1149px]:border-l-0 @max-[1149px]:pl-0',
        repo: '@max-[1149px]:max-w-26',
        square: '@max-[1149px]:size-8 @max-[1149px]:px-0',
        workspaceIcon: '@max-[1149px]:size-8 @max-[1149px]:justify-center @max-[1149px]:p-0 @max-[1149px]:[&>span.truncate]:hidden @max-[1149px]:[&>svg]:hidden',
    },
} as const
