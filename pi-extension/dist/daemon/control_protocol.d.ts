/**
 * CLI ↔ supervisor IPC contract for `~/.pi/remote/supervisor.sock`.
 *
 * Framing: one JSON object per line, newline-terminated. The CLI sends a
 * single `ControlRequest`, the supervisor sends a single `ControlReply`,
 * both close the connection. No multiplexing, no streaming — each command
 * is a short round-trip.
 *
 * Plan/26 W2. The Pi RPC protocol (`pi --mode rpc`) used by the daemon
 * children themselves is a separate contract — see
 * `node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-types.d.ts`.
 * This file is strictly the supervisor's own control plane.
 */
import type { CronJob } from "./cron_registry.js";
import type { CronLogEntry } from "./cron_log.js";
/** Per-daemon runtime state observable through the supervisor. */
export type DaemonState = "running" | "stopped" | "starting" | "crashed";
export interface DaemonInfo {
    id: string;
    cwd: string;
    name: string;
    state: DaemonState;
    pid?: number;
    uptime_s?: number;
    restart_count?: number;
}
/** Requests sent CLI → supervisor. */
export type ControlRequest = {
    op: "list";
} | {
    op: "status";
} | {
    op: "start_all";
} | {
    op: "start";
    id: string;
} | {
    op: "stop_all";
} | {
    op: "stop";
    id: string;
} | {
    op: "restart_all";
} | {
    op: "restart";
    id: string;
} | {
    op: "send";
    id: string;
    text: string;
} | {
    op: "register";
    cwd: string;
} | {
    op: "unregister";
    id: string;
} | {
    op: "cron_add";
    daemon_id: string;
    schedule: string;
    prompt: string;
    tz?: string;
    skip_if_busy?: boolean;
    wake?: boolean;
    catchup?: boolean;
} | {
    op: "cron_list";
} | {
    op: "cron_remove";
    job_id: string;
} | {
    op: "cron_enable";
    job_id: string;
    enabled: boolean;
} | {
    op: "cron_run";
    job_id: string;
} | {
    op: "cron_log";
    job_id?: string;
    tail?: number;
};
/** Replies sent supervisor → CLI. Tagged by `ok` boolean. */
export type ControlReply<T = unknown> = {
    ok: true;
    data?: T;
} | {
    ok: false;
    error: string;
};
/**
 * Response shapes per op. Keep in sync with the supervisor handlers in
 * `daemon/supervisor.ts`. Used for typed client calls.
 */
export interface ControlReplyShapes {
    list: {
        daemons: DaemonInfo[];
    };
    status: {
        daemons: DaemonInfo[];
    };
    start_all: {
        started: string[];
        already_running: string[];
    };
    start: {
        id: string;
        state: DaemonState;
        started: boolean;
    };
    stop_all: {
        stopped: string[];
        already_stopped: string[];
    };
    stop: {
        id: string;
        state: DaemonState;
        stopped: boolean;
    };
    restart_all: {
        restarted: string[];
    };
    restart: {
        id: string;
        state: DaemonState;
        restarted: boolean;
    };
    send: {
        id: string;
        delivered: boolean;
    };
    register: {
        id: string;
        cwd: string;
    };
    unregister: {
        removed: boolean;
        cwd?: string;
    };
    cron_add: {
        job: CronJobView;
    };
    cron_list: {
        jobs: CronJobView[];
    };
    cron_remove: {
        removed: boolean;
    };
    cron_enable: {
        job_id: string;
        enabled: boolean;
        updated: boolean;
    };
    cron_run: {
        job_id: string;
        result: string;
    };
    cron_log: {
        entries: CronLogEntry[];
    };
}
/** A cron job plus its computed `next_run` (ISO), for `cron list`. */
export type CronJobView = CronJob & {
    next_run?: string | null;
};
/** Convenience for typed `Client.request<...>("op")` calls. */
export type ControlReplyFor<Op extends ControlRequest["op"]> = Op extends keyof ControlReplyShapes ? ControlReplyShapes[Op] : never;
export declare function encodeRequest(req: ControlRequest): string;
export declare function encodeReply<T>(reply: ControlReply<T>): string;
/**
 * Parses a single JSON line into a request. Throws on malformed input —
 * the supervisor catches and replies `{ok:false, error}` so the client
 * gets a clean error rather than an unframed disconnect.
 */
export declare function parseRequest(line: string): ControlRequest;
export declare function parseReply(line: string): ControlReply<unknown>;
