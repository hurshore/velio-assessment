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
    RegExp(r'^[0-9A-HJKMNP-TV-Z]{12}$').hasMatch(normalizeCode(value));

class GuestSession {
  GuestSession._(this.file, this._data);
  final File file;
  final Map<String, dynamic> _data;
  Future<void> _writes = Future.value();

  static Future<GuestSession> open(File file) async {
    final data = await file.exists()
        ? jsonDecode(await file.readAsString())
        : <String, dynamic>{};
    if (data is! Map<String, dynamic>) {
      throw const FormatException('Invalid guest session');
    }
    if (data['journeyId'] != null && !isId(data['journeyId'] as String?) ||
        data['actorId'] != null && !isId(data['actorId'] as String?)) {
      throw const FormatException('Invalid saved identity or journey');
    }
    return GuestSession._(file, data);
  }

  String? get journeyId => _data['journeyId'] as String?;
  String get code => _data['code'] as String? ?? '';
  String get displayName => _data['displayName'] as String? ?? '';
  String? get actorId => _data['actorId'] as String?;
  List<Map<String, dynamic>> get pendingEvents =>
      (_data['events'] as List? ?? [])
          .map((e) => Map<String, dynamic>.from(e as Map))
          .toList();

  Future<void> _save() {
    final snapshot = jsonEncode(_data);
    final next = _writes.catchError((Object _) {}).then((_) async {
      await file.parent.create(recursive: true);
      final temporary = File('${file.path}.tmp');
      await temporary.writeAsString(snapshot, flush: true);
      await temporary.rename(file.path);
    });
    _writes = next;
    return next;
  }

  Future<void> enter(String code, {String? linkedJourney}) async {
    _data['journeyId'] ??= isId(linkedJourney)
        ? linkedJourney!.toLowerCase()
        : newId();
    _data['code'] = code;
    await _save();
  }

  Future<void> saveName(String value) async {
    _data['displayName'] = value;
    await _save();
  }

  Future<void> selectActor(String id) async {
    _data['actorId'] = id;
    await _save();
  }

  Future<String> claimKey(String actor, String code) async {
    final keys = Map<String, dynamic>.from(_data['claimKeys'] as Map? ?? {});
    final intent = '$actor:${normalizeCode(code)}';
    final key = keys[intent] as String? ?? newId();
    keys[intent] = key;
    _data['claimKeys'] = keys;
    await _save();
    return key;
  }

  bool hasPendingClaim(String actor, String code) =>
      (_data['pendingClaims'] as List? ?? []).contains(
        '$actor:${normalizeCode(code)}',
      );
  Future<String> startClaim(String actor, String code) async {
    final key = await claimKey(actor, code);
    _data['pendingClaims'] = {
      ...(_data['pendingClaims'] as List? ?? []),
      '$actor:${normalizeCode(code)}',
    }.toList();
    await _save();
    return key;
  }

  Future<void> resolveClaim(String actor, String code) async {
    _data['pendingClaims'] = (_data['pendingClaims'] as List? ?? [])
        .where((v) => v != '$actor:${normalizeCode(code)}')
        .toList();
    await _save();
  }

  Future<bool> celebrate(String bookingId) async {
    final celebrated = List<String>.from(_data['celebrated'] as List? ?? []);
    if (celebrated.contains(bookingId)) return false;
    _data['celebrated'] = [...celebrated, bookingId];
    await _save();
    return true;
  }

  Future<void> enqueue(Map<String, dynamic> event) async {
    _data['events'] = [...pendingEvents, event];
    await _save();
  }

  Future<void> delivered(String id) async {
    _data['events'] = pendingEvents.where((e) => e['id'] != id).toList();
    await _save();
  }
}
