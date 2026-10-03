import 'dart:async';
import 'dart:io';

import 'package:cockpit/app/cockpit/domain/contracts/process_tree_provider.dart';
import 'package:cockpit/app/cockpit/domain/entities/process_snapshot.dart';
import 'package:cockpit/app/core/domain/entities/harness.dart';
import 'package:cockpit/app/cockpit/domain/services/process_tree_resolver.dart';
import 'package:cockpit/app/core/data/diagnostics/performance_diagnostics.dart';

class SessionAnchor {
  final String sessionId;
  final int? Function() rootPid;
  final String? wslDistro;
  final void Function(HarnessKind? newHarness) onHarnessChanged;
  bool visible;
  DateTime lastActivity;

  SessionAnchor({
    required this.sessionId,
    required this.rootPid,
    this.wslDistro,
    required this.onHarnessChanged,
    this.visible = false,
    DateTime? lastActivity,
  }) : lastActivity = lastActivity ?? DateTime.fromMillisecondsSinceEpoch(0);
}

class TerminalHarnessMonitor {
  final ProcessTreeProvider provider;
  final Map<String, ProcessTreeProvider>? wslProvidersByDistro;
  final ProcessTreeProvider Function(String distro)? wslProviderForDistro;
  final Duration pollInterval;
  final Duration idlePollInterval;
  final Duration inactivePollInterval;
  final Duration activityPollCooldown;
  final bool Function()? windowIsActive;

  Timer? _timer;
  bool _inFlight = false;
  bool _pendingPoll = false;
  bool _pendingActivityPoll = false;
  Timer? _activityTimer;
  DateTime? _lastPollCompletedAt;
  final Map<String, SessionAnchor> _anchors = {};
  final Map<String, HarnessKind?> _lastKnownHarness = {};
  final Map<String, ProcessTreeProvider> _wslProviderCache = {};

  TerminalHarnessMonitor({
    required this.provider,
    this.wslProvidersByDistro,
    this.wslProviderForDistro,
    // Baseline safety net for silent exits / nested tools. Interactive
    // launches are kicked immediately from TerminalSession (Enter/output).
    Duration? pollInterval,
    Duration? idlePollInterval,
    Duration? inactivePollInterval,
    Duration? activityPollCooldown,
    this.windowIsActive,
  }) : pollInterval =
           pollInterval ??
           (Platform.isWindows
               ? const Duration(seconds: 8)
               : const Duration(seconds: 2)),
       idlePollInterval =
           idlePollInterval ??
           (Platform.isWindows
               ? const Duration(seconds: 20)
               : const Duration(seconds: 5)),
       inactivePollInterval =
           inactivePollInterval ??
           (Platform.isWindows
               ? const Duration(seconds: 30)
               : const Duration(seconds: 10)),
       activityPollCooldown =
           activityPollCooldown ??
           (Platform.isWindows
               ? const Duration(seconds: 1)
               : const Duration(milliseconds: 250));

  bool get isRunning =>
      _anchors.isNotEmpty &&
      (_timer != null || _activityTimer != null || _inFlight);
  int get registeredCount => _anchors.length;

  void registerSession({
    required String sessionId,
    required int? Function() rootPid,
    String? wslDistro,
    required void Function(HarnessKind? newHarness) onHarnessChanged,
  }) {
    _anchors[sessionId] = SessionAnchor(
      sessionId: sessionId,
      rootPid: rootPid,
      wslDistro: wslDistro,
      onHarnessChanged: onHarnessChanged,
    );

    if (_timer == null && _anchors.isNotEmpty) {
      _scheduleNextPoll();
    }
    // Immediate poll on registration (and whenever a session is (re)bound).
    requestPoll();
  }

  void unregisterSession(String sessionId) {
    _anchors.remove(sessionId);
    _lastKnownHarness.remove(sessionId);

    if (_anchors.isEmpty) {
      _stopTimer();
      _activityTimer?.cancel();
      _activityTimer = null;
      _pendingPoll = false;
      _pendingActivityPoll = false;
    }
  }

  /// Ask for a poll as soon as possible. Coalesces with an in-flight poll.
  void requestPoll({String? sessionId}) {
    if (_anchors.isEmpty) return;
    if (sessionId != null) {
      _anchors[sessionId]?.lastActivity = DateTime.now();
      _requestActivityPoll();
      return;
    }
    _activityTimer?.cancel();
    _activityTimer = null;
    _timer?.cancel();
    _timer = null;
    if (_inFlight) {
      _pendingPoll = true;
      return;
    }
    unawaited(poll());
  }

  /// Output de várias PTYs pode chegar sem parar. Cada sessão limita seus
  /// próprios kicks, mas sem limite global o fim de um scan iniciava outro
  /// imediatamente enquanto qualquer PTY continuasse emitindo. Limitar só
  /// estes pedidos preserva o scan inicial e o safety poll periódico.
  void _requestActivityPoll() {
    if (_inFlight) {
      _pendingActivityPoll = true;
      return;
    }
    if (_activityTimer != null) return;
    final last = _lastPollCompletedAt;
    final remaining = last == null
        ? Duration.zero
        : activityPollCooldown - DateTime.now().difference(last);
    if (remaining <= Duration.zero) {
      requestPoll();
      return;
    }
    _activityTimer = Timer(remaining, () {
      _activityTimer = null;
      if (_anchors.isNotEmpty) requestPoll();
    });
  }

  /// Informa se uma sessão tem superfície visível. A sessão e seu PTY
  /// continuam vivos; isto governa somente a frequência do safety poll.
  void setSessionVisible(String sessionId, bool visible) {
    final anchor = _anchors[sessionId];
    if (anchor == null || anchor.visible == visible) return;
    anchor.visible = visible;
    // Switching tabs or workspaces changes visibility, not the process tree.
    // On Windows an eager poll starts a full CIM scan for every switch.
    // Terminal input/output still calls requestPoll for real activity.
    if (visible) anchor.lastActivity = DateTime.now();
    if (!_inFlight) _scheduleNextPoll();
  }

  void _scheduleNextPoll() {
    _timer?.cancel();
    if (_anchors.isEmpty) {
      _timer = null;
      return;
    }
    final windowActive = windowIsActive?.call() ?? true;
    final hasVisible = _anchors.values.any((anchor) => anchor.visible);
    final hasRecentActivity = _anchors.values.any(
      (anchor) =>
          DateTime.now().difference(anchor.lastActivity) < idlePollInterval,
    );
    final delay = !windowActive
        ? inactivePollInterval
        : (hasVisible || hasRecentActivity ? pollInterval : idlePollInterval);
    _timer = Timer(delay, requestPoll);
  }

  void _stopTimer() {
    _timer?.cancel();
    _timer = null;
  }

  Future<void> poll() async {
    if (_inFlight || _anchors.isEmpty) {
      if (_inFlight) _pendingPoll = true;
      return;
    }
    _inFlight = true;
    _pendingPoll = false;
    final stopwatch = Stopwatch()..start();

    try {
      // Group sessions into native host vs WSL by distro
      final nativeAnchors = <SessionAnchor>[];
      final wslAnchorsByDistro = <String, List<SessionAnchor>>{};

      for (final anchor in _anchors.values) {
        if (anchor.wslDistro != null && anchor.wslDistro!.isNotEmpty) {
          wslAnchorsByDistro
              .putIfAbsent(anchor.wslDistro!, () => [])
              .add(anchor);
        } else {
          nativeAnchors.add(anchor);
        }
      }

      // Collect native process snapshots
      if (nativeAnchors.isNotEmpty) {
        final nativeRootPids = nativeAnchors
            .map((a) => a.rootPid())
            .whereType<int>()
            .toList();
        final snapshots = await provider.getProcessSnapshots(
          rootPids: nativeRootPids,
        );

        for (final anchor in nativeAnchors) {
          _evaluateAnchor(anchor, snapshots);
        }
      }

      // Collect WSL process snapshots per distro
      for (final entry in wslAnchorsByDistro.entries) {
        final distro = entry.key;
        final anchors = entry.value;
        final distroProvider = _resolveWslProvider(distro);
        final rootPids = anchors
            .map((a) => a.rootPid())
            .whereType<int>()
            .toList();
        final snapshots = await distroProvider.getProcessSnapshots(
          rootPids: rootPids,
        );

        for (final anchor in anchors) {
          _evaluateAnchor(anchor, snapshots);
        }
      }
    } catch (_) {
      // Fallback silently on error
    } finally {
      _lastPollCompletedAt = DateTime.now();
      PerformanceDiagnostics.instance.record(PerfMetric.processScan, {
        PerfField.durationUs: stopwatch.elapsedMicroseconds,
        PerfField.sessions: _anchors.length,
      });
      _inFlight = false;
      if (_pendingPoll && _anchors.isNotEmpty) {
        _pendingPoll = false;
        scheduleMicrotask(requestPoll);
      } else if (_pendingActivityPoll && _anchors.isNotEmpty) {
        _pendingActivityPoll = false;
        _requestActivityPoll();
      } else {
        _scheduleNextPoll();
      }
    }
  }

  ProcessTreeProvider _resolveWslProvider(String distro) {
    final cached = _wslProviderCache[distro];
    if (cached != null) return cached;

    final resolved =
        wslProvidersByDistro?[distro] ??
        wslProviderForDistro?.call(distro) ??
        provider;
    _wslProviderCache[distro] = resolved;
    return resolved;
  }

  void _evaluateAnchor(SessionAnchor anchor, List<ProcessSnapshot> snapshots) {
    final rootPid = anchor.rootPid();
    if (rootPid == null) {
      _updateHarness(anchor, null);
      return;
    }

    final harness = ProcessTreeResolver.resolve(
      rootPid: rootPid,
      snapshots: snapshots,
    );

    _updateHarness(anchor, harness);
  }

  void _updateHarness(SessionAnchor anchor, HarnessKind? newHarness) {
    final previous = _lastKnownHarness[anchor.sessionId];
    if (previous != newHarness) {
      _lastKnownHarness[anchor.sessionId] = newHarness;
      anchor.onHarnessChanged(newHarness);
    }
  }

  void dispose() {
    _stopTimer();
    _activityTimer?.cancel();
    _activityTimer = null;
    _anchors.clear();
    _lastKnownHarness.clear();
    _wslProviderCache.clear();
    _pendingPoll = false;
    _pendingActivityPoll = false;
  }
}
