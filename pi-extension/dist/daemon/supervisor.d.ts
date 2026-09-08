import { type CronResult } from "./cron_log.js";
/** Thrown by `start()` when another live supervisor already holds the UDS.
 *  Prevents a second supervisor from orphaning the first's children. */
export declare class SupervisorAlreadyRunningError extends Error {
    readonly sockPath: string;
    constructor(sockPath: string);
}
export interface SupervisorOptions {
    /** Absolute path to remote-pi's dist/index.js — passed as -e to each
     *  spawned `pi`. Defaults to the location relative to where this file
     *  is bundled (so the supervisor finds itself). */
    extensionPath: string;
    /** Override the `pi` binary path. Defaults to "pi" on PATH. */
    piBin?: string;
}
/** Pure decision for `fireJob` (plan/39) — picks the action from the daemon's
 *  liveness/busy state + the job's flags. Tested in isolation for all 4 ramos. */
export type FireAction = "send" | "wake_and_send" | "skip_down" | "skip_busy";
export declare function decideFireAction(o: {
    running: boolean;
    busy: boolean;
    wake: boolean;
    skipIfBusy: boolean;
}): FireAction;
export declare class Supervisor {
    private readonly opts;
    private server;
    private readonly children;
    /** Live croner schedules, keyed by cron job id (plan/39). */
    private readonly cronJobs;
    private shuttingDown;
    constructor(opts: SupervisorOptions);
    /** Bind the control UDS + spawn all registered daemons. */
    start(): Promise<void>;
    /** Graceful shutdown: stop all children, close UDS. */
    stop(): Promise<void>;
    private _mkdirParent;
    private _bindUds;
    private _onConnection;
    private _handleRequest;
    private _listInfo;
    private _opStartAll;
    /** Spawn a single registered daemon by id. Idempotent: a daemon already
     *  running returns `started: false`. Unknown id → ok:false. This is what
     *  `/remote-pi create` calls so a freshly-registered folder boots its Pi
     *  immediately instead of waiting for the next supervisor restart. */
    private _opStart;
    private _opStopAll;
    /** Stop a single registered daemon by id. Idempotent: a daemon that isn't
     *  running returns `stopped: false`. Unknown id → ok:false. Mirrors the
     *  per-id semantics of `_opStart`. Cancels any pending restart backoff so a
     *  deliberate stop stays stopped. */
    private _opStop;
    /** Restart a single registered daemon by id (stop-if-running, then spawn).
     *  Unknown id → ok:false. Resets the crash backoff. */
    private _opRestart;
    private _opRestartAll;
    private _opSend;
    private _opRegister;
    private _opUnregister;
    private _opCronAdd;
    private _opCronList;
    private _opCronRemove;
    private _opCronEnable;
    private _opCronRun;
    private _opCronLog;
    private _jobView;
    /** Rebuild all live `Cron` schedules from the registry (enabled jobs only).
     *  Called on start; mutations reconcile incrementally via _scheduleCron/_stopCron. */
    private _reconcileCron;
    private _scheduleCron;
    private _stopCron;
    /** Detail 2: on start, run a catchup job once if its previous scheduled run
     *  was missed while the supervisor was down. Opt-in (`catchup`), at most 1×. */
    private _runCatchup;
    /**
     * Fires a cron job: resolves the daemon, decides the action (decideFireAction),
     * acts, and records the outcome — ALWAYS one `last_status` update + one JSONL
     * line, for both fires and skips. Returns the result. `manual` bypasses the
     * disabled-skip (used by `cron run` + catchup).
     */
    fireJob(jobId: string, opts?: {
        manual?: boolean;
    }): Promise<CronResult | "missing">;
    private _spawnAllFromRegistry;
    private _spawnEntry;
    private _onChildExit;
}
/** Test helper: derive id from cwd without going through the registry. */
export declare function _idForCwdForTest(cwd: string): string;
/** Exported for the bin/supervisord entry + tests to know where the
 *  supervisor will bind. */
export declare function getSupervisorSockPath(): string;
