export const BAR_NATURAL_WIDTH = { t0: 1869, t1: 1565, t2: 1145, t3: 558 } as const

export const BAR_FIT_SLACK = 16

export const BAR_PANE_FLOOR = BAR_NATURAL_WIDTH.t3 + BAR_FIT_SLACK

export const BAR_TIERS = {
    t1: { below: 1885, hide: '@max-[1885px]:hidden', show: '@max-[1885px]:flex', square: '@max-[1885px]:size-8 @max-[1885px]:px-0' },
    t2: { below: 1581, hide: '@max-[1581px]:hidden', show: '@max-[1581px]:flex' },
    t3: {
        below: 1161,
        hide: '@max-[1161px]:hidden',
        show: '@max-[1161px]:flex',
        srOnly: '@max-[1161px]:sr-only',
        undivided: '@max-[1161px]:border-l-0 @max-[1161px]:pl-0',
        repo: '@max-[1161px]:max-w-26 @min-[640px]:@max-[1161px]:max-w-40',
        square: '@max-[1161px]:size-8 @max-[1161px]:px-0',
        workspaceIcon: '@max-[1161px]:size-8 @max-[1161px]:justify-center @max-[1161px]:p-0 @max-[1161px]:[&>span.truncate]:hidden @max-[1161px]:[&>svg]:hidden',
    },
} as const
