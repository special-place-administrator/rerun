export const BAR_NATURAL_WIDTH = { t0: 1854, t1: 1550, t2: 1129, t3: 574 } as const

export const BAR_FIT_SLACK = 16

export const BAR_PANE_FLOOR = BAR_NATURAL_WIDTH.t3 + BAR_FIT_SLACK

export const BAR_TIERS = {
    t1: { below: 1870, hide: '@max-[1870px]:hidden', show: '@max-[1870px]:flex', square: '@max-[1870px]:size-8 @max-[1870px]:px-0' },
    t2: { below: 1566, hide: '@max-[1566px]:hidden', show: '@max-[1566px]:flex' },
    t3: {
        below: 1145,
        hide: '@max-[1145px]:hidden',
        show: '@max-[1145px]:flex',
        srOnly: '@max-[1145px]:sr-only',
        undivided: '@max-[1145px]:border-l-0 @max-[1145px]:pl-0',
        repo: '@max-[1145px]:max-w-26',
        square: '@max-[1145px]:size-8 @max-[1145px]:px-0',
        workspaceIcon: '@max-[1145px]:size-8 @max-[1145px]:justify-center @max-[1145px]:p-0 @max-[1145px]:[&>span.truncate]:hidden @max-[1145px]:[&>svg]:hidden',
    },
} as const
