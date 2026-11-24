import { raw } from '../db/client.js'

export const BUS_DDL = `
CREATE TABLE IF NOT EXISTS bus_messages (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    v INTEGER NOT NULL,
    ts TEXT NOT NULL,
    ts_ms INTEGER NOT NULL,
    sender TEXT NOT NULL,
    sender_run TEXT,
    recipients TEXT NOT NULL,
    type TEXT NOT NULL,
    verdict TEXT,
    thread TEXT NOT NULL,
    topic TEXT,
    re TEXT,
    corr TEXT NOT NULL,
    depth INTEGER NOT NULL DEFAULT 0,
    prio INTEGER NOT NULL DEFAULT 2,
    deadline_ms INTEGER,
    expires_ms INTEGER NOT NULL,
    idem_key TEXT NOT NULL,
    body TEXT NOT NULL,
    refs TEXT NOT NULL DEFAULT '[]',
    untrusted INTEGER NOT NULL DEFAULT 0,
    sha256 TEXT NOT NULL,
    UNIQUE (sender, idem_key)
);
CREATE INDEX IF NOT EXISTS bus_messages_thread_idx ON bus_messages(thread, seq);

CREATE TABLE IF NOT EXISTS bus_deliveries (
    seq INTEGER NOT NULL,
    recipient TEXT NOT NULL,
    sender TEXT NOT NULL,
    state TEXT NOT NULL,
    actionable INTEGER NOT NULL,
    prods INTEGER NOT NULL DEFAULT 0,
    next_ms INTEGER,
    wake_id TEXT,
    read_ms INTEGER,
    acked_ms INTEGER,
    done_ms INTEGER,
    PRIMARY KEY (seq, recipient)
);
CREATE INDEX IF NOT EXISTS bus_deliveries_inbox_idx ON bus_deliveries(recipient, state, next_ms);
CREATE INDEX IF NOT EXISTS bus_deliveries_due_idx ON bus_deliveries(state, next_ms);
CREATE INDEX IF NOT EXISTS bus_deliveries_pair_idx ON bus_deliveries(sender, recipient, state);

CREATE TABLE IF NOT EXISTS bus_wakes (
    id TEXT PRIMARY KEY,
    recipient TEXT NOT NULL,
    session_id TEXT,
    run_id TEXT,
    kind TEXT NOT NULL,
    state TEXT NOT NULL,
    started_ms INTEGER NOT NULL,
    last_step_ms INTEGER,
    ended_ms INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS bus_wakes_open_idx ON bus_wakes(recipient) WHERE state = 'open';

CREATE TABLE IF NOT EXISTS bus_flags (
    id TEXT PRIMARY KEY,
    subject TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    recipient TEXT NOT NULL,
    prods INTEGER NOT NULL DEFAULT 0,
    next_ms INTEGER,
    escalated_ms INTEGER,
    cleared_ms INTEGER,
    untrusted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS bus_flags_due_idx ON bus_flags(cleared_ms, next_ms);

CREATE TABLE IF NOT EXISTS bus_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    ts_ms INTEGER NOT NULL,
    kind TEXT NOT NULL,
    msg_id TEXT,
    actor TEXT NOT NULL,
    recipient TEXT,
    detail TEXT
);
CREATE INDEX IF NOT EXISTS bus_events_ts_idx ON bus_events(ts_ms);

CREATE TABLE IF NOT EXISTS bus_heartbeat (
    k TEXT PRIMARY KEY,
    last_sweep_ms INTEGER NOT NULL,
    last_seq INTEGER NOT NULL,
    counts_json TEXT NOT NULL,
    violations INTEGER NOT NULL DEFAULT 0
);
`

export async function ensureBusTables(): Promise<void> {
    await raw().executeMultiple(BUS_DDL)
}
