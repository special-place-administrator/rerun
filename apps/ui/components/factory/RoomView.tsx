'use client'

import { useState } from 'react'
import type { RoomDetail } from '@moldwright/contracts'

const STATUS_LABEL: Record<RoomDetail['status'], string> = {
    open: 'Open',
    decided: 'Decided',
    presented: 'Presented to you',
    expired: 'Closed: time limit',
}
const SEND = 'Send'
const CLOSED = 'This room is closed. You can read it.'
const PLACEHOLDER = 'Write to the room'

export function RoomView({ room, onSend }: { room: RoomDetail; onSend: (text: string) => void }) {
    const [draft, setDraft] = useState('')
    const posts = [...room.posts].sort((a, b) => a.seq - b.seq)
    const sumIn = room.members.reduce((n, m) => n + m.tokensIn, 0)
    const sumOut = room.members.reduce((n, m) => n + m.tokensOut, 0)

    const send = () => {
        const text = draft.trim()
        if (text === '') return
        onSend(text)
        setDraft('')
    }

    return (
        <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
            <header className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{room.title}</span>
                <span data-room-status={room.status} className="shrink-0 rounded-full border px-2 py-0.5 text-xs text-muted-foreground">{STATUS_LABEL[room.status]}</span>
            </header>

            <div className="flex flex-wrap items-center gap-2">
                {room.members.map((m) => (
                    <span key={m.agentId} data-member={m.agentId} className="flex items-baseline gap-1.5 rounded-md border px-2 py-1 text-xs">
                        <span className="font-medium">{m.name}</span>
                        <span className="tabular-nums text-muted-foreground">{m.tokensIn} in / {m.tokensOut} out</span>
                    </span>
                ))}
                <span data-room-cost className="ml-auto text-xs tabular-nums text-muted-foreground">Cost: {sumIn} in / {sumOut} out</span>
            </div>

            <ol className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
                {posts.map((p) => (
                    <li
                        key={p.seq}
                        data-post={p.seq}
                        {...(p.kind === 'decision' ? { 'data-decision': '' } : {})}
                        className={p.kind === 'decision' ? 'rounded-md border border-foreground/40 bg-muted p-3 text-sm' : 'rounded-md border p-3 text-sm'}
                    >
                        <div className="flex items-baseline gap-2 text-xs text-muted-foreground">
                            <span className="font-medium text-foreground">{p.authorName}</span>
                            {p.round > 0 && <span className="tabular-nums">Round {p.round}</span>}
                        </div>
                        <p className="mt-1 whitespace-pre-wrap">{p.text}</p>
                    </li>
                ))}
            </ol>

            {room.status === 'open' ? (
                <div className="flex items-end gap-2">
                    <textarea
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        placeholder={PLACEHOLDER}
                        rows={2}
                        className="min-w-0 flex-1 resize-none rounded-md border bg-background p-2 text-sm"
                    />
                    <button type="button" data-room-send onClick={send} className="shrink-0 rounded-md border px-3 py-1.5 text-sm hover:bg-muted">{SEND}</button>
                </div>
            ) : (
                <p data-room-closed className="text-sm text-muted-foreground">{CLOSED}</p>
            )}
        </div>
    )
}
