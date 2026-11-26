'use client'

import type { RoomSummary } from '@moldwright/contracts'

const EMPTY = 'No rooms for this job yet'
const CLOSED = 'Closed'

export function RoomList({ rooms, onOpen }: { rooms: RoomSummary[]; onOpen: (id: string) => void }) {
    if (rooms.length === 0) return <div className="p-4 text-sm text-muted-foreground">{EMPTY}</div>

    return (
        <div className="flex flex-col gap-1 p-2">
            {rooms.map((r) => (
                <button
                    key={r.id}
                    type="button"
                    data-room={r.id}
                    onClick={() => onOpen(r.id)}
                    className="flex items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-muted"
                >
                    <span className="shrink-0 rounded-full border px-2 py-1 text-xs font-medium tracking-wide">
                        {r.members.map((m) => m.name.charAt(0).toUpperCase()).join('')}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-sm font-medium">{r.title}</span>
                        {r.lastPost !== null && (
                            <span className="truncate text-xs text-muted-foreground">{r.lastPost.authorName.toUpperCase()}: {r.lastPost.text}</span>
                        )}
                    </span>
                    {r.status !== 'open' && <span className="shrink-0 text-xs text-muted-foreground">{CLOSED}</span>}
                </button>
            ))}
        </div>
    )
}
