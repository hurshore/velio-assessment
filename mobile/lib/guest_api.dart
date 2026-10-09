import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:timezone/data/latest_all.dart' as tzdata;
import 'package:timezone/timezone.dart' as tz;

import 'guest_session.dart';
import 'bounded_http.dart';
import 'api_config.dart';

bool _timezonesInitialized = false;
void _initializeTimezones() {
  if (_timezonesInitialized) return;
  tzdata.initializeTimeZones();
  _timezonesInitialized = true;
}

Map<String, dynamic> object(Object? value) {
  if (value is! Map<String, dynamic>) {
    throw const FormatException('Unexpected API response');
  }
  return value;
}

String text(Map<String, dynamic> data, String key) {
  final value = data[key];
  if (value is! String || value.trim().isEmpty) {
    throw FormatException('Invalid $key');
  }
  return value;
}

String identifier(Map<String, dynamic> data, String key) {
  final value = text(data, key);
  if (!isId(value)) throw FormatException('Invalid $key');
  return value;
}

int integer(Map<String, dynamic> data, String key, {int minimum = 0}) {
  final value = data[key];
  if (value is! int || value < minimum) throw FormatException('Invalid $key');
  return value;
}

DateTime timestamp(Map<String, dynamic> data, String key) =>
    DateTime.parse(text(data, key));

class Availability {
  Availability(Map<String, dynamic> data)
    : capacity = integer(data, 'capacity', minimum: 1),
      confirmedCount = integer(data, 'confirmedCount'),
      remainingSeats = integer(data, 'remainingSeats'),
      version = integer(data, 'version', minimum: 1) {
    if (confirmedCount + remainingSeats != capacity) {
      throw const FormatException('Invalid seat counts');
    }
  }
  final int capacity, confirmedCount, remainingSeats, version;
}

class InvitePreview {
  InvitePreview(Map<String, dynamic> data)
    : code = text(data, 'code'),
      state = text(data, 'state'),
      activity = object(data['activity']),
      inviter = object(data['inviter']) {
    if (!isCode(code) ||
        !['public', 'vouch'].contains(data['rail']) ||
        data['trust'] != data['rail'] ||
        !['valid', 'full', 'expired', 'started', 'cancelled'].contains(state)) {
      throw const FormatException('Unsupported invitation');
    }
    timestamp(data, 'createdAt');
    timestamp(data, 'expiresAt');
    rail = text(data, 'rail');
    createdAt = text(data, 'createdAt');
    expiresAt = text(data, 'expiresAt');
    identifier(activity, 'id');
    identifier(activity, 'planId');
    for (final key in [
      'title',
      'description',
      'meetingLocation',
      'timezone',
      'status',
      'currency',
    ]) {
      text(activity, key);
    }
    timestamp(activity, 'startsAt');
    integer(activity, 'priceMinor');
    if (!RegExp(r'^[A-Z]{3}$').hasMatch(text(activity, 'currency'))) {
      throw const FormatException('Invalid currency');
    }
    Availability(activity);
    text(inviter, 'displayName');
    if (!['host', 'booker'].contains(inviter['role'])) {
      throw const FormatException('Invalid inviter');
    }
    _initializeTimezones();
    try {
      tz.getLocation(text(activity, 'timezone'));
    } on tz.LocationNotFoundException {
      throw const FormatException('Invalid activity timezone');
    }
  }
  final String code, state;
  late final String rail, createdAt, expiresAt;
  final Map<String, dynamic> activity, inviter;
  String get activityId => activity['id'] as String;
  String get planId => activity['planId'] as String;
  Availability get availability => Availability(activity);
  Map<String, dynamic> toJson() => {
    'code': code,
    'state': state,
    'rail': rail,
    'trust': rail,
    'createdAt': createdAt,
    'expiresAt': expiresAt,
    'inviter': {'displayName': inviter['displayName'], 'role': inviter['role']},
    'activity': {
      for (final key in [
        'id',
        'planId',
        'title',
        'description',
        'meetingLocation',
        'startsAt',
        'timezone',
        'status',
        'currency',
        'priceMinor',
        'capacity',
        'confirmedCount',
        'remainingSeats',
        'version',
      ])
        key: activity[key],
    },
  };
  InvitePreview withActivity(Map<String, dynamic> detail) {
    final now = DateTime.now();
    final state = detail['status'] == 'cancelled'
        ? 'cancelled'
        : detail['status'] == 'completed' ||
              !timestamp(detail, 'startsAt').isAfter(now)
        ? 'started'
        : !DateTime.parse(expiresAt).isAfter(now)
        ? 'expired'
        : Availability(detail).remainingSeats == 0
        ? 'full'
        : 'valid';
    return InvitePreview({...toJson(), 'state': state, 'activity': detail});
  }
}

class DemoIdentity {
  DemoIdentity(Map<String, dynamic> data)
    : id = identifier(data, 'id'),
      displayName = text(data, 'displayName') {
    integer(data, 'generation');
  }
  final String id, displayName;
}

class BookingState {
  BookingState(Map<String, dynamic> data, InvitePreview preview, String actor)
    : availability = Availability(object(data['availability'])),
      booking = data['booking'] == null ? null : object(data['booking']),
      replayed = data['replayed'] == true,
      telemetryDegraded = data['telemetry'] == 'degraded' {
    final counts = object(data['availability']);
    if (counts['activityId'] != preview.activityId ||
        counts['planId'] != preview.planId) {
      throw const FormatException('Invalid booking availability');
    }
    if (booking case final b?) {
      identifier(b, 'id');
      timestamp(b, 'confirmedAt');
      integer(b, 'priceMinor');
      if (b['activityId'] != preview.activityId ||
          b['planId'] != preview.planId ||
          b['userId'] != actor ||
          !RegExp(r'^[A-Z]{3}$').hasMatch(text(b, 'currency'))) {
        throw const FormatException('Invalid booking confirmation');
      }
    }
  }
  final Availability availability;
  final Map<String, dynamic>? booking;
  final bool replayed, telemetryDegraded;
}

class ApiFailure implements Exception {
  ApiFailure(this.code, this.retryable, this.requestId);
  final String code, requestId;
  final bool retryable;
  @override
  String toString() => 'API $code (retryable: $retryable, request: $requestId)';
}

class GuestApi {
  GuestApi({
    http.Client? client,
    this.baseUrl = apiBaseUrl,
    this.timeout = const Duration(seconds: 8),
  }) : _transport = BoundedHttp(client: client, timeout: timeout);
  final BoundedHttp _transport;
  final String baseUrl;
  final Duration timeout;

  Future<Object?> request(
    String path, {
    String method = 'GET',
    Map<String, dynamic>? body,
    String? actorId,
    String? key,
  }) async {
    final response = await _transport.send(
      method,
      Uri.parse('$baseUrl/api$path'),
      headers: {
        'Content-Type': 'application/json',
        'X-Demo-Actor-Id': ?actorId,
        'Idempotency-Key': ?key,
      },
      body: body == null ? null : jsonEncode(body),
    );
    final envelope = object(jsonDecode(response.body));
    final reference = text(envelope, 'requestId');
    if (response.statusCode >= 400) {
      final error = object(envelope['error']);
      if (error['retryable'] is! bool) {
        throw const FormatException('Invalid API error');
      }
      text(error, 'message');
      throw ApiFailure(
        text(error, 'code'),
        error['retryable'] as bool,
        reference,
      );
    }
    if (response.statusCode < 200 ||
        response.statusCode >= 300 ||
        !envelope.containsKey('data')) {
      throw const FormatException('Invalid API envelope');
    }
    return envelope['data'];
  }

  Future<InvitePreview> preview(String code) async => InvitePreview(
    object(await request('/invites/${Uri.encodeComponent(code)}')),
  );
  Future<void> deliver(GuestSession session) async {
    for (final event in session.pendingEvents) {
      final accepted = object(
        await request(
          '/events',
          method: 'POST',
          body: event,
          actorId: event['actorId'] as String?,
        ),
      );
      if (accepted['id'] != event['id'] || accepted['accepted'] is! bool) {
        throw const FormatException('Invalid event receipt');
      }
      await session.delivered(event['id'] as String);
    }
  }

  Future<List<DemoIdentity>> identities() async {
    final data = await request('/identities');
    if (data is! List) throw const FormatException('Invalid identity list');
    return data.map((value) => DemoIdentity(object(value))).toList();
  }

  Future<DemoIdentity> identity(String id) async =>
      DemoIdentity(object(await request('/identities/$id')));
  Future<DemoIdentity> createIdentity(
    String name,
    String code,
    String journey, {
    String? contact,
  }) async => DemoIdentity(
    object(
      await request(
        '/identities',
        method: 'POST',
        body: {
          'displayName': name,
          'inviteCode': code,
          'journeyId': journey,
          'platform': 'mobile',
          if (contact != null && contact.trim().isNotEmpty)
            'contact': contact.trim(),
        },
      ),
    ),
  );
  Future<bool> recipientMatches(InvitePreview preview, String actor) async {
    if (preview.rail == 'public') return true;
    final data = object(
      await request('/invites/${preview.code}/recipient-check', actorId: actor),
    );
    if (data['matches'] is! bool) {
      throw const FormatException('Invalid recipient check');
    }
    return data['matches'] as bool;
  }

  Future<BookingState> ownBooking(InvitePreview preview, String actor) async =>
      BookingState(
        object(
          await request(
            '/activities/${preview.activityId}/booking',
            actorId: actor,
          ),
        ),
        preview,
        actor,
      );
  Future<BookingState> claim(
    InvitePreview preview,
    String actor,
    String journey,
    String key,
  ) async {
    final data = object(
      await request(
        '/invites/${preview.code}/claims',
        method: 'POST',
        actorId: actor,
        key: key,
        body: {'platform': 'mobile', 'journeyId': journey},
      ),
    );
    if (data['replayed'] is! bool || data['booking'] == null) {
      throw const FormatException('Invalid committed claim');
    }
    return BookingState(data, preview, actor);
  }

  void dispose() => _transport.dispose();
}
