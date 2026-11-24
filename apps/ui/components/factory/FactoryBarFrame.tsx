import type { ReactNode, Ref } from 'react'

export function FactoryBarFrame({ edge, rightInset, frameRef, className, children }: {
    edge: 'top' | 'bottom'
    rightInset: number
    frameRef?: Ref<HTMLDivElement>
    className?: string
    children: ReactNode
}) {
    return (
        <div
            data-bar-frame={edge}
            className={`@container pointer-events-none absolute ${edge === 'top' ? 'top-0 justify-start' : 'bottom-0 justify-center'} left-0 flex`}
            style={{ right: rightInset }}
        >
            <div ref={frameRef} className={`pointer-events-auto m-3 flex max-w-[calc(100%-1.5rem)] flex-nowrap rounded-2xl border border-border/60 bg-background/75 shadow-[0_8px_40px_rgba(0,0,0,0.12)] backdrop-blur-xl${className ? ` ${className}` : ''}`}>
                {children}
            </div>
        </div>
    )
}
