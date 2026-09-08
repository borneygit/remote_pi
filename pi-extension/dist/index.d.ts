#!/usr/bin/env node
/**
 * pi-extension — remote-pi slash commands + AgentBridge wiring
 *
 * Exported as ExtensionFactory (default export) to be loaded by Pi SDK:
 *   pi -e $(pwd)/dist/index.js
 *
 * State machine:  idle → started → paired
 *   /remote-pi start   connects to relay (idle → started)
 *   /remote-pi pair    shows QR for new peers (started, async → paired via auto-listener)
 *   /remote-pi stop    closes everything (any → idle)
 *
 * Pairing (post plano 06 — sem Noise XX):
 *   App envia inner `pair_request` (id, token, device_name) sobre canal opaco.
 *   Pi valida o token via qrSession.consumeToken, salva peer em peers.json
 *   {name, remote_epk, paired_at} e responde com `pair_ok` (ou `pair_error`).
 *   `ct` é base64(JSON.stringify(inner)) — sem cifra, sem MAC.
 *
 * Reconexão de peer conhecido:
 *   Se uma mensagem chega em estado `started` vinda de um epk presente em
 *   peers.json, o auto-listener promove direto pra `paired` sem novo
 *   pair_request, criando o PlainPeerChannel e roteando a mensagem.
 *
 * Architecture note — why we don't use AgentBridge directly here:
 *   AgentBridge.beforeToolCallHook is designed to be passed to createAgentSession().
 *   Inside an extension Pi already owns the AgentSession, so we can't re-bind
 *   beforeToolCall after the fact. The equivalent is pi.on("tool_call", …) which
 *   fires BEFORE execution and supports { block: true }.
 *   AgentBridge (src/session/agent_bridge.ts) remains the tested, mockable unit
 *   for integration tests.
 */
import type { ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { ClientMessage, SessionHistoryEvent } from "./protocol/types.js";
import { PlainPeerChannel } from "./transport/peer_channel.js";
export type RemoteState = "idle" | "started";
/** Relay connectivity as seen by an RPC client (Cockpit). Derived from
 *  `_state` + `_relay`: "disconnected" = relay off (idle); "connected" = live
 *  WS; "reconnecting" = was on, WS dropped, retrying. Surfaced via the
 *  `remote-pi:relay-state` custom message (see `_emitRelayState`). */
export type RelayConnectivity = "connected" | "reconnecting" | "disconnected";
/** Sentinel prefix for a transparent control message an RPC client sends on the
 *  `prompt` channel (stdin). The `input` hook intercepts it, runs the action,
 *  and swallows it (`action:"handled"`) so it never becomes an LLM turn or a
 *  transcript entry. Starts with NUL so it can't collide with real user input
 *  and doesn't begin with "/" (which would route to the command parser). */
export declare const CTRL_PREFIX = "\0remote-pi-ctrl:";
type BufferMsg = {
    role: "user" | "assistant" | "toolResult" | string;
    content?: unknown;
    timestamp?: number;
    toolCallId?: string;
    toolName?: string;
    isError?: boolean;
    usage?: {
        input?: number;
        output?: number;
    };
    /** Plan/32: pre-compaction token count, set on the synthetic
     *  `role:"compaction"` marker pushed in `session_compact`. */
    tokensBefore?: number;
};
type MeshEnvelope = {
    id: string;
    from: string;
    re: string | null;
    body: unknown;
};
/** Test-only override of the message buffer. */
/**
 * Test-only: emulate what `/remote-pi` does on the returning-user path
 * (join the local mesh, then start the relay) without touching the FS for
 * a `localConfigExists()` lookup. Lets tests bring the relay up without
 * mocking the wizard or the local config storage.
 *
 * Typed loosely to accept any ctx shape with `ui.notify` + `cwd` — the
 * unit tests use minimal mocks that don't satisfy the full
 * `ExtensionContext` interface.
 */
export declare function _connectForTest(ctx: unknown): Promise<void>;
/** Test-only: tear everything down (mirrors `/remote-pi stop`). */
export declare function _stopForTest(ctx: unknown): Promise<void>;
/** Test-only: read/reset the `_disposed` flag. Production clears it only when
 *  a host reuses this module for a replacement session; tests share one module
 *  across cases, so they also reset it to avoid cross-test pollution. */
export declare function _getDisposedForTest(): boolean;
export declare function _setDisposedForTest(v: boolean): void;
/** Test-only: reset the once-per-session auto-init gate so session_start re-runs it. */
export declare function _resetAutoInitedForTest(): void;
/** Test-only: set the auto-init gate for lifecycle replacement tests. */
export declare function _setAutoInitedForTest(value: boolean): void;
/** Test-only: true when this instance holds a live local-mesh node. */
export declare function _hasMeshNodeForTest(): boolean;
/** Test-only: drive the current real SelfRevoke producer through one sweep. */
export declare function _checkSelfRevokeForTest(): Promise<void>;
/** Test-only: the effective (possibly `#N`-suffixed) name the cwd-lock reserved. */
export declare function _getLockedNameForTest(): string | null;
/** Test-only: release + clear the cwd lock (the lock normally survives stop). */
export declare function _resetCwdLockForTest(): void;
/**
 * Test-only: relay-only startup, no UDS mesh join. Replaces the old
 * `remote-pi relay start` handler that some tests captured to bring up
 * the relay in isolation (e.g. ping/pong tests that don't care about the
 * agent-network broker).
 */
export declare function _startRelayForTest(ctx: unknown): Promise<void>;
/** Test-only: public marker for canceled-keypair cache regression checks. */
export declare function _getCachedPublicKeyForTest(): string | null;
export declare function _setMessageBufferForTest(msgs: unknown[]): void;
/** Test-only accessor: returns a defensive copy of the buffer. */
export declare function _getMessageBufferForTest(): unknown[];
/** Test-only override of session started timestamp. */
export declare function _setSessionStartedAtForTest(ts: number | null): void;
/** Test-only: reset the cached model name (between tests). */
export declare function _setCurrentModelForTest(name: string | undefined): void;
/** Test-only: read the active turn id used for plain `cancel` routing. */
export declare function _getCurrentTurnIdForTest(): string | null;
export declare function _getPendingSteerIdsForTest(text: string): string[];
/** Test-only: override the bound AgentSession so a spy can capture the
 *  content handed to `sendUserMessage` (plan/30 multimodal ingest). */
export declare function _setPiForTest(pi: unknown): void;
/** Test-only: exposes pending reconnect timer state. */
export declare function _hasPendingReconnect(): boolean;
/**
 * Public state-snapshot helper. Returns the derived UX state, not the raw
 * `_state` enum: the W2D refactor collapsed the internal machine to
 * `idle | started` and made `paired` a derived metric
 * (`_activePeers.size > 0`). Tests and the footer keep the three-state
 * mental model via this getter.
 */
export declare function _getState(): "idle" | "started" | "paired";
/** Test-only: number of owners currently attached via PlainPeerChannel. */
export declare function _getActivePeerCountForTest(): number;
/** Test-only: true if a specific peer (base64 std) has an attached channel. */
export declare function _hasActivePeerForTest(appPeerIdStd: string): boolean;
/**
 * Handle a transparent control command from an RPC client (Cockpit), received
 * as a `CTRL_PREFIX`-tagged input the `input` hook swallowed. Toggles the relay
 * WITHOUT leaving the local mesh (relay-only: `_cmdStart` up / `_goIdle` down),
 * then emits the fresh state. `relay:status` just re-emits (no change) so the
 * client can sync its button after (re)attaching to the RPC stream.
 */
export declare function _handleControl(cmd: string): Promise<void>;
/**
 * Per-owner disconnect callback. Fires when one specific owner's channel
 * detaches (e.g. relay told us the peer is gone). Other owners' channels
 * keep running — relay stays "started".
 *
 * Exported so tests can trigger the disconnect path for a specific peer.
 *
 * Backward-compat: a no-arg call (legacy tests / pre-W2D callers) falls
 * back to detaching the most recently attached peer, mirroring the old
 * singleton semantics.
 */
export declare function _onPeerDisconnect(appPeerId?: string): void;
declare const extension: ExtensionFactory;
export default extension;
/** Test-only entry point for verifying mesh-to-agent delivery semantics. */
export declare function _deliverMeshMessageToAgentForTest(env: MeshEnvelope): void;
export declare function _routeClientMessageFrom(sender: PlainPeerChannel, msg: ClientMessage, ctx: Pick<ExtensionContext, "abort">): void;
/**
 * Backward-compatible shim for legacy callers + tests that didn't track
 * a specific sender channel. Routes to the most recently attached owner,
 * mirroring the pre-W2D singleton behavior.
 */
export declare function routeClientMessage(msg: ClientMessage, ctx: Pick<ExtensionContext, "abort">): void;
/**
 * Maps SDK AgentMessage[] (UserMessage / AssistantMessage / ToolResultMessage)
 * into the flat SessionHistoryEvent[] shape consumed by the app.
 *
 * Caveats (see report): in_reply_to of agent_message is the *last* user_input
 * id seen in a linear scan — fine for typical conversational flow but not
 * a perfect reconstruction of multi-turn ordering when tools interleave.
 * Stable id for user_input is `sync_<timestamp>`.
 */
export declare function _mapAgentMessagesToEvents(messages: BufferMsg[]): SessionHistoryEvent[];
/**
 * `remote-pi restart-supervisor` — restarts the `pi-supervisord` PROCESS
 * (not the daemons). The supervisor is a long-running Node process with no
 * hot-reload, so after a `dist` rebuild the old code keeps running until the
 * process is restarted. The Cockpit "Restart supervisor" button shells out to
 * this; the OS-specific restart lives here so the app stays cross-platform.
 *
 * Restarting the supervisor re-spawns every daemon as a side effect. Exits 0
 * on success, non-zero on failure (the Cockpit detects failure by exit code).
 */
/** One step of a restart sequence. `ignoreFailure` steps (e.g. `schtasks /End`
 *  when the task isn't running) don't abort the sequence. */
export interface RestartStep {
    cmd: string;
    args: string[];
    ignoreFailure?: boolean;
}
/** Pure: the OS command sequence that restarts the supervisor service, or null
 *  when the platform isn't supported. Most platforms are 1 step; Windows is 2
 *  (`schtasks /End` then `/Run`). Exported for tests. */
export declare function _restartSupervisorCommand(platform: NodeJS.Platform, uid: number): RestartStep[] | null;
/**
 * Read-only probe of the local UDS broker for the mesh roster, backing
 * `remote-pi peers`. Opens a raw connection to `sockPath`, sends a single
 * unregistered `list_peers` request, and resolves with the peer names from the
 * broker's reply (local UDS peers + cross-PC `<pc>:<peer>` entries).
 *
 * The probe deliberately does NOT register as a peer: the broker answers
 * observer probes without assigning a name or broadcasting peer_joined/left
 * (see Broker._tryObserverProbe), so a shell query never perturbs the mesh —
 * no phantom peer flashes in anyone's roster, local or cross-PC.
 *
 * Resolves null when no broker is reachable (connection refused / no socket
 * file — i.e. no Pi or daemon is leading the mesh on this machine), or on
 * timeout, so the caller can print an "offline" message instead of an empty
 * roster.
 */
export declare function probeListPeers(sockPath: string, timeoutMs?: number): Promise<string[] | null>;
