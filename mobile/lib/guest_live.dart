import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'guest_api.dart';
import 'guest_session.dart';

abstract interface class LiveSocket {
  Stream<Object?> get messages;
  void send(String message);
  Future<void> close();
}

class NativeLiveSocket implements LiveSocket {
  NativeLiveSocket(this.socket);
  final WebSocket socket;
  @override
  Stream<Object?> get messages => socket;
  @override
  void send(String message) => socket.add(message);
  @override
  Future<void> close() async => socket.close();
}

Future<LiveSocket> connectLive(Uri uri) async {
  final client = HttpClient();
  try {
    return NativeLiveSocket(
      await WebSocket.connect(
        uri.toString(),
        customClient: client,
      ).timeout(const Duration(seconds: 8)),
    );
  } finally {
    client.close(force: true);
  }
}

class LiveSnapshot {
  LiveSnapshot(Object? value, InvitePreview preview) {
    final data = object(value);
    final detail = object(data['activity']);
    final parsed = preview.withActivity(detail);
    if (data['type'] != 'snapshot' ||
        data['activityId'] != preview.activityId ||
        parsed.activityId != preview.activityId ||
        parsed.planId != preview.planId ||
        data['version'] != parsed.availability.version ||
        data['capacity'] != parsed.availability.capacity ||
        data['confirmedCount'] != parsed.availability.confirmedCount ||
        data['remainingSeats'] != parsed.availability.remainingSeats ||
        (data['eventId'] != null &&
            (data['eventId'] is! String || !isId(data['eventId'] as String)))) {
      throw const FormatException('Invalid live snapshot');
    }
    final members = detail['participants'];
    if (members is! List ||
        members.length != parsed.availability.confirmedCount) {
      throw const FormatException('Invalid participants');
    }
    participants = members.map((member) {
      final person = object(member);
      return <String, dynamic>{
        'id': identifier(person, 'id'),
        'displayName': text(person, 'displayName'),
      };
    }).toList();
    if (participants.map((p) => p['id']).toSet().length !=
        participants.length) {
      throw const FormatException('Duplicate participants');
    }
    activity = parsed;
    eventId = data['eventId'] as String?;
  }
  late final InvitePreview activity;
  late final String? eventId;
  late final List<Map<String, dynamic>> participants;
}

// One foreground view owns a stable client ID; reconnects receive a fresh server snapshot.
class GuestLive {
  GuestLive({
    required this.uri,
    required this.subscription,
    required this.preview,
    required this.onSnapshot,
    required this.onStale,
    this.connect = connectLive,
  });
  final Uri uri;
  final Map<String, dynamic> subscription;
  final InvitePreview preview;
  final void Function(LiveSnapshot) onSnapshot;
  final void Function() onStale;
  final Future<LiveSocket> Function(Uri) connect;
  LiveSocket? _socket;
  StreamSubscription<Object?>? _messages;
  Timer? _retry, _watchdog;
  bool _stopped = false;
  DateTime _lastSnapshot = DateTime.now();
  final _acked = <String>{};

  void start() => unawaited(_open());
  Future<void> _open() async {
    if (_stopped) return;
    onStale();
    try {
      // A late connection is closed even if the view stopped during the handshake.
      final attempt = connect(uri);
      var abandoned = false;
      attempt.then((socket) {
        if (abandoned || _stopped) unawaited(socket.close());
      }, onError: (Object _) {});
      final socket = await attempt.timeout(
        const Duration(seconds: 8),
        onTimeout: () {
          abandoned = true;
          throw TimeoutException('Live connection timed out');
        },
      );
      if (_stopped) {
        await socket.close();
        return;
      }
      _socket = socket;
      _lastSnapshot = DateTime.now();
      _messages = socket.messages.listen(
        (value) {
          if (_stopped || _socket != socket) return;
          try {
            final snapshot = LiveSnapshot(jsonDecode(value as String), preview);
            _lastSnapshot = DateTime.now();
            onSnapshot(snapshot);
          } catch (_) {
            _lost(socket);
          }
        },
        onError: (Object _) => _lost(socket),
        onDone: () => _lost(socket),
      );
      socket.send(jsonEncode({'type': 'subscribe', ...subscription}));
      _watchdog = Timer.periodic(const Duration(seconds: 1), (_) {
        if (DateTime.now().difference(_lastSnapshot) >
            const Duration(seconds: 5)) {
          _lost(socket);
        }
      });
    } catch (_) {
      if (!_stopped) {
        onStale();
        _retry = Timer(const Duration(seconds: 1), _open);
      }
    }
  }

  void _lost(LiveSocket socket) {
    if (_stopped || _socket != socket) return;
    _socket = null;
    _acked.clear();
    _watchdog?.cancel();
    unawaited(_messages?.cancel());
    unawaited(socket.close());
    onStale();
    _retry = Timer(const Duration(seconds: 1), _open);
  }

  void acknowledge(LiveSnapshot snapshot) {
    final socket = _socket;
    final event = snapshot.eventId;
    if (_stopped || socket == null || event == null || !_acked.add(event)) {
      return;
    }
    if (_acked.length > 1024) _acked.remove(_acked.first);
    try {
      socket.send(
        jsonEncode({
          'type': 'ack',
          'eventId': event,
          'activityId': preview.activityId,
          'version': snapshot.activity.availability.version,
        }),
      );
    } catch (_) {
      _lost(socket);
    }
  }

  void dispose() {
    _stopped = true;
    _retry?.cancel();
    _watchdog?.cancel();
    unawaited(_messages?.cancel());
    final socket = _socket;
    _socket = null;
    if (socket != null) unawaited(socket.close());
  }
}
