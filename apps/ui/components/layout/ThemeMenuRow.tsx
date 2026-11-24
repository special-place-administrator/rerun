'use client'

import { ThemeToggle } from '@moldwright/ui/theme'

import { SunMoonIcon } from '@/lib/icons'
import { useTranslations } from 'next-intl'

export function ThemeMenuRow() {
    const t = useTranslations('layout')
    return (
        <div className="flex items-center gap-2 px-1.5 py-0.5 text-sm text-muted-foreground">
            <SunMoonIcon className="size-4" />
            {t('theme')}
            <ThemeToggle className="ml-auto p-px shadow-none [&_[data-slot=segmented-control-item]]:size-6 [&_svg]:size-3.5" />
        </div>
    )
}
