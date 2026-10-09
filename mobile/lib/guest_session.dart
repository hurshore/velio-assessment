import 'dart:convert';
import 'dart:io';
import 'dart:math';

String utcTimestamp(DateTime instant) => DateTime.fromMillisecondsSinceEpoch(
  instant.millisecondsSinceEpoch,
  isUtc: true,
).toIso8601String();

String newId() {
  final bytes = List.generate(16, (_) => Random.secure().nextInt(256));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  final hex = bytes
      .map((byte) => byte.toRadixString(16).padLeft(2, '0'))
      .join();
  return '${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}';
}

bool isId(String? value) =>
    value != null &&
    RegExp(
      r'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
      caseSensitive: false,
    ).hasMatch(value);
String normalizeCode(String value) =>
    value.replaceAll(RegExp(r'[\s-]'), '').toUpperCase();
bool isCode(String value) =>
    value.length <= 64 &&
    RegExp(r'^[0-9A-HJKMNP-TV-Z]{12}$').hasMatch(normalizeCode(value));

bool _absoluteTimestamp(Object? value) {
  if (value is! String ||
      !RegExp(
        r'^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,3})?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$',
      ).hasMatch(value) ||
      DateTime.tryParse(value) == null) {
    return false;
  }
  final parts = value.substring(0, 10).split('-').map(int.parse).toList();
  final day = DateTime.utc(parts[0], parts[1], parts[2]);
  return day.year == parts[0] && day.month == parts[1] && day.day == parts[2];
}

class PendingClaim {
  PendingClaim._(String saved)
    : actorId = saved.split(':')[0],
      code = saved.split(':')[1];
  final String actorId, code;
  bool matches(String? actor, String? invitationCode) =>
      actorId == actor && code == invitationCode;
}

class GuestSession {
  GuestSession._(this.file, this._data);
  final File file;
  final Map<String, dynamic> _data;
  Future<void> _writes = Future.value();

  static Future<GuestSession> open(File file) async {
    final data = await file.exists()
        ? jsonDecode(utf8.decode(await file.readAsBytes()))
        : <String, dynamic>{};
    if (data is! Map<String, dynamic>) {
      throw const FormatException('Invalid guest session');
    }
    _validate(data);
    return GuestSession._(file, data);
  }

  String? get journeyId => _data['journeyId'] as String?;
  String get code => _data['code'] as String? ?? '';
  String get displayName => _data['displayName'] as String? ?? '';
  String get contact => _data['contact'] as String? ?? '';
  Map<String, dynamic>? cached(String code) {
    final value = (_data['cache'] as Map?)?[normalizeCode(code)];
    return value == null ? null : Map<String, dynamic>.from(value as Map);
  }

  List<PendingClaim> get pendingClaims =>
      List<String>.from(_data['pendingClaims'] as List? ?? [])
          .map(PendingClaim._)
          .toList();
  String? get actorId => _data['actorId'] as String?;
  List<Map<String, dynamic>> get pendingEvents =>
      (_data['events'] as List? ?? [])
          .map((e) => Map<String, dynamic>.from(e as Map))
          .toList();

  static void _validate(Map<String, dynamic> data) {
    Never invalid(String path) =>
        throw FormatException('Invalid saved session: $path');
    bool id(Object? value) => value is String && isId(value);
    bool intent(Object? value) {
      if (value is! String) return false;
      final parts = value.split(':');
      return parts.length == 2 &&
          id(parts[0]) &&
          isCode(parts[1]) &&
          parts[1] == normalizeCode(parts[1]);
    }

    for (final field in ['journeyId', 'actorId']) {
      if (data.containsKey(field) && !id(data[field])) invalid(field);
    }
    if (data.containsKey('code') &&
        (data['code'] is! String || !isCode(data['code'] as String))) {
      invalid('code');
    }
    if (data.containsKey('displayName') &&
        (data['displayName'] is! String ||
            (data['displayName'] as String).length > 100)) {
      invalid('displayName');
    }
    final keys = data['claimKeys'] ?? <String, dynamic>{};
    if (data.containsKey('contact') &&
        (data['contact'] is! String ||
            (data['contact'] as String).length > 254)) {
      invalid('contact');
    }
    if (data.containsKey('cache')) {
      if (data['cache'] is! Map<String, dynamic>) invalid('cache');
      for (final entry in (data['cache'] as Map<String, dynamic>).entries) {
        if (!isCode(entry.key) || entry.value is! Map<String, dynamic>) {
          invalid('cache entry');
        }
        final value = entry.value as Map<String, dynamic>;
        final participantVersion = value['participantVersion'];
        if (participantVersion != null &&
            (participantVersion is! int || participantVersion < 0)) {
          invalid('participant version');
        }
        if (value['preview'] is! Map<String, dynamic> ||
            !_absoluteTimestamp(value['savedAt']) ||
            value['participants'] is! List) {
          invalid('cached details');
        }
      }
    }
    if (keys is! Map<String, dynamic>) invalid('claimKeys');
    if (data.containsKey('claimKeys') && data['claimKeys'] == null) {
      invalid('claimKeys');
    }
    for (final entry in keys.entries) {
      if (!intent(entry.key) || !id(entry.value)) invalid('claimKeys entry');
    }
    for (final field in ['pendingClaims', 'celebrated', 'events']) {
      if (data.containsKey(field) && data[field] is! List) invalid(field);
    }
    for (final value in data['pendingClaims'] as List? ?? []) {
      if (!intent(value) || !keys.containsKey(value)) {
        invalid('pendingClaims entry/key');
      }
    }
    for (final value in data['celebrated'] as List? ?? []) {
      if (!id(value)) invalid('celebrated entry');
    }
    for (final entry in data['events'] as List? ?? []) {
      if (entry is! Map<String, dynamic>) invalid('events entry');
      if (!id(entry['id']) ||
          !id(entry['journeyId']) ||
          entry['schemaVersion'] != 1 ||
          entry['source'] != 'client' ||
          entry['platform'] != 'mobile' ||
          !_absoluteTimestamp(entry['occurredAt']) ||
          (entry.containsKey('actorId') && !id(entry['actorId']))) {
        invalid('events envelope');
      }
      final allowed = {
        'id',
        'name',
        'schemaVersion',
        'source',
        'platform',
        'journeyId',
        'actorId',
        'occurredAt',
        'synthetic',
        'test',
        if (entry['name'] == 'invite_opened') ...[
          'inviteCode',
          'displayedState',
        ] else ...[
          'activityId',
          'planId',
        ],
      };
      if (entry.keys.any((key) => !allowed.contains(key))) {
        invalid('events fields');
      }
      for (final flag in ['synthetic', 'test']) {
        if (entry.containsKey(flag) && entry[flag] is! bool) {
          invalid('events $flag');
        }
      }
      if (entry['name'] == 'invite_opened') {
        if (entry['inviteCode'] is! String ||
            !isCode(entry['inviteCode'] as String) ||
            ![
              'valid',
              'full',
              'expired',
              'started',
              'cancelled',
            ].contains(entry['displayedState'])) {
          invalid('events invite_opened');
        }
      } else if (entry['name'] == 'activity_viewed') {
        if (!id(entry['activityId']) || !id(entry['planId'])) {
          invalid('events activity_viewed');
        }
      } else {
        invalid('events name');
      }
    }
    if ((data.containsKey('code') ||
            keys.isNotEmpty ||
            (data['events'] as List? ?? []).isNotEmpty) &&
        !id(data['journeyId'])) {
      invalid('journeyId required for recovery');
    }
  }

  // Publish in-memory recovery state only after its atomic disk replacement succeeds.
  Future<T> _update<T>(T Function(Map<String, dynamic>) change) {
    final next = _writes.catchError((Object _) {}).then((_) async {
      final draft = Map<String, dynamic>.from(_data);
      final result = change(draft);
      _validate(draft);
      final encoded = jsonEncode(draft);
      if (encoded == jsonEncode(_data)) return result;
      await file.parent.create(recursive: true);
      final temporary = File('${file.path}.tmp');
      await temporary.writeAsString(encoded, flush: true);
      await temporary.rename(file.path);
      _data
        ..clear()
        ..addAll(draft);
      return result;
    });
    _writes = next.then<void>((_) {});
    // The caller receives the failure; keep the serialization tail handled too.
    _writes = _writes.catchError((Object _) {});
    return next;
  }

  Future<void> enter(String code, {String? linkedJourney}) async {
    if (!isCode(code)) throw const FormatException('Invalid invitation code');
    await _update<void>((draft) {
      draft['journeyId'] ??= isId(linkedJourney)
          ? linkedJourney!.toLowerCase()
          : newId();
      draft['code'] = normalizeCode(code);
    });
  }

  Future<void> saveName(String value) =>
      _update<void>((draft) => draft['displayName'] = value);
  Future<void> saveContact(String value) =>
      _update<void>((draft) => draft['contact'] = value);
  Future<void> saveDetails(
    String code,
    Map<String, dynamic> preview,
    List<Map<String, dynamic>> participants, {
    Map<String, dynamic>? booking,
    int participantVersion = 0,
  }) => _update<void>((draft) {
    final cache = Map<String, dynamic>.from(draft['cache'] as Map? ?? {});
    final previous = cache[normalizeCode(code)] as Map?;
    final details = {
      'preview': preview,
      'participants': participants,
      'participantVersion': participantVersion,
      if (booking != null || previous?['booking'] != null)
        'booking': booking ?? previous!['booking'],
    };
    final existing = previous == null
        ? null
        : (Map<String, dynamic>.from(previous)..remove('savedAt'));
    if (existing != null && jsonEncode(existing) == jsonEncode(details)) return;
    cache[normalizeCode(code)] = {
      ...details,
      'savedAt': utcTimestamp(DateTime.now()),
    };
    draft['cache'] = cache;
  });
  Future<void> selectActor(String id) =>
      _update<void>((draft) => draft['actorId'] = id);

  String _key(Map<String, dynamic> draft, String actor, String code) {
    final keys = Map<String, dynamic>.from(draft['claimKeys'] as Map? ?? {});
    final intent = '$actor:${normalizeCode(code)}';
    final key = keys[intent] as String? ?? newId();
    keys[intent] = key;
    draft['claimKeys'] = keys;
    return key;
  }

  Future<String> claimKey(String actor, String code) =>
      _update((draft) => _key(draft, actor, code));

  bool hasPendingClaim(String actor, String code) =>
      (_data['pendingClaims'] as List? ?? []).contains(
        '$actor:${normalizeCode(code)}',
      );

  Future<String> startClaim(String actor, String code) => _update((draft) {
    final key = _key(draft, actor, code);
    draft['pendingClaims'] = {
      ...(draft['pendingClaims'] as List? ?? []),
      '$actor:${normalizeCode(code)}',
    }.toList();
    return key;
  });

  Future<void> resolveClaim(String actor, String code) =>
      _update<void>((draft) {
        draft['pendingClaims'] = (draft['pendingClaims'] as List? ?? [])
            .where((value) => value != '$actor:${normalizeCode(code)}')
            .toList();
      });

  Future<bool> celebrate(String bookingId) => _update((draft) {
    final celebrated = List<String>.from(draft['celebrated'] as List? ?? []);
    if (celebrated.contains(bookingId)) return false;
    draft['celebrated'] = [...celebrated, bookingId];
    return true;
  });

  Future<void> enqueue(Map<String, dynamic> event) => _update<void>((draft) {
    draft['events'] = [...(draft['events'] as List? ?? []), event];
  });

  Future<void> delivered(String id) => _update<void>((draft) {
    draft['events'] = (draft['events'] as List? ?? [])
        .where((event) => event['id'] != id)
        .toList();
  });
}
