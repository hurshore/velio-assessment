import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:velio_mobile/guest_screen.dart';
import 'package:velio_mobile/guest_session.dart';
import 'package:velio_mobile/guest_api.dart';

import 'live_fixture.dart';

Future<FixtureSocket> fixtureConnect(Uri uri) async => FixtureSocket(
  withParticipants(Map<String, dynamic>.from(preview()['activity'] as Map)),
);

const code = 'ABCD2345EFGH';
const activityId = '11111111-1111-4111-8111-111111111111';
const planId = '22222222-2222-4222-8222-222222222222';
const actorId = '33333333-3333-4333-8333-333333333333';
Map<String, Object?> preview({String state = 'valid'}) => {
  'code': code,
  'rail': 'public',
  'trust': 'public',
  'state': state,
  'createdAt': '2026-10-09T10:00:00Z',
  'expiresAt': '2026-10-10T10:00:00Z',
  'inviter': {'displayName': 'Amara', 'role': 'host'},
  'activity': {
    'id': activityId,
    'planId': planId,
    'title': 'Supper club',
    'description': 'Bring your favourite story.',
    'meetingLocation': 'Marina gate',
    'startsAt': '2026-10-10T18:00:00Z',
    'timezone': 'Africa/Lagos',
    'status': 'scheduled',
    'capacity': 2,
    'confirmedCount': state == 'full' ? 2 : 1,
    'remainingSeats': state == 'full' ? 0 : 1,
    'version': 2,
    'priceMinor': 2500,
    'currency': 'NGN',
  },
};
Future<void> settle(WidgetTester tester) async {
  for (var i = 0; i < 4; i++) {
    await tester.runAsync(() async {
      await tester.pump();
      await Future<void>.delayed(const Duration(milliseconds: 60));
    });
  }
}

http.Response envelope(Object? data, [int status = 200]) => http.Response(
  jsonEncode({'data': data, 'requestId': 'test-reference'}),
  status,
);

void main() {
  late Directory directory;
  late GuestSession session;
  setUp(() async {
    directory = await Directory.systemTemp.createTemp('velio-guest-test-');
    session = await GuestSession.open(File('${directory.path}/session.json'));
  });
  tearDown(() async => directory.delete(recursive: true));

  testWidgets(
    'lookup timeout before submission never reports an uncertain write',
    (tester) async {
      var timeoutLookup = false;
      final claims = <http.Request>[];
      final client = MockClient((request) async {
        if (request.url.path.endsWith('/claims')) claims.add(request);
        if (request.url.path.endsWith('/booking')) {
          if (timeoutLookup) throw TimeoutException('Lookup timed out');
          return envelope({
            'booking': null,
            'availability': {
              'activityId': activityId,
              'planId': planId,
              'capacity': 2,
              'confirmedCount': 1,
              'remainingSeats': 1,
              'version': 2,
            },
          });
        }
        if (request.url.path.contains('/identities')) {
          return envelope({
            'id': actorId,
            'displayName': 'Tunde',
            'generation': 1,
          });
        }
        if (request.url.path.endsWith('/events')) {
          return envelope({
            'id': jsonDecode(request.body)['id'],
            'accepted': true,
          }, 202);
        }
        return envelope(preview());
      });
      final api = GuestApi(client: client);
      addTearDown(() {
        api.dispose();
        client.close();
      });
      await tester.runAsync(() async {
        await session.enter(code);
        await session.selectActor(actorId);
        await tester.pumpWidget(
          MaterialApp(
            home: GuestScreen(
              liveConnect: fixtureConnect,
              session: session,
              api: api,
              links: const Stream<Uri>.empty(),
            ),
          ),
        );
        await Future<void>.delayed(const Duration(milliseconds: 100));
      });
      await settle(tester);
      timeoutLookup = true;
      await tester.ensureVisible(find.text('Claim my seat'));
      await tester.runAsync(() async {
        await tester.tap(find.text('Claim my seat'));
      });
      await settle(tester);
      expect(claims, isEmpty);
      expect(session.hasPendingClaim(actorId, code), isFalse);
      expect(find.textContaining('No claim was submitted'), findsOneWidget);
      expect(find.textContaining('key is saved'), findsNothing);
      expect(find.text('Check / retry confirmation'), findsNothing);
      await tester.pumpWidget(const SizedBox.shrink());
      // The parent can reuse its API after removing the screen.
      timeoutLookup = false;
      expect((await api.preview(code)).code, code);
    },
  );

  testWidgets('failed key persistence never submits or reports a saved key', (
    tester,
  ) async {
    final claims = <http.Request>[];
    final client = MockClient((request) async {
      if (request.url.path.endsWith('/claims')) claims.add(request);
      if (request.url.path.endsWith('/booking')) {
        return envelope({
          'booking': null,
          'availability': {
            'activityId': activityId,
            'planId': planId,
            'capacity': 2,
            'confirmedCount': 1,
            'remainingSeats': 1,
            'version': 2,
          },
        });
      }
      if (request.url.path.contains('/identities')) {
        return envelope({
          'id': actorId,
          'displayName': 'Tunde',
          'generation': 1,
        });
      }
      if (request.url.path.endsWith('/events')) {
        return envelope({
          'id': jsonDecode(request.body)['id'],
          'accepted': true,
        }, 202);
      }
      return envelope(preview());
    });
    final api = GuestApi(client: client);
    addTearDown(() {
      api.dispose();
      client.close();
    });
    await tester.runAsync(() async {
      await session.enter(code);
      await session.selectActor(actorId);
      await tester.pumpWidget(
        MaterialApp(
          home: GuestScreen(
            liveConnect: fixtureConnect,
            session: session,
            api: api,
            links: const Stream<Uri>.empty(),
          ),
        ),
      );
      await Future<void>.delayed(const Duration(milliseconds: 100));
    });
    await settle(tester);
    await tester.runAsync(() => Directory('${session.file.path}.tmp').create());
    await tester.ensureVisible(find.text('Claim my seat'));
    await tester.runAsync(() async {
      await tester.tap(find.text('Claim my seat'));
    });
    await settle(tester);
    expect(claims, isEmpty);
    expect(session.hasPendingClaim(actorId, code), isFalse);
    expect(
      find.textContaining('Could not save your guest session'),
      findsOneWidget,
    );
    expect(find.textContaining('No claim was submitted'), findsOneWidget);
    final restored = await tester.runAsync(
      () => GuestSession.open(session.file),
    );
    expect(restored!.hasPendingClaim(actorId, code), isFalse);
    expect(find.textContaining('key is saved'), findsNothing);
    expect(find.text('Check / retry confirmation'), findsNothing);
    await tester.pumpWidget(const SizedBox.shrink());
    // The parent can reuse its API after removing the screen.

    expect((await api.preview(code)).code, code);
  });

  testWidgets(
    'unsupported and malformed links preserve the valid draft and details',
    (tester) async {
      final links = StreamController<Uri>();
      final client = MockClient((request) async {
        if (request.url.path.endsWith('/events')) {
          return envelope({
            'id': jsonDecode(request.body)['id'],
            'accepted': true,
          }, 202);
        }
        return envelope(preview());
      });
      final api = GuestApi(client: client);
      addTearDown(() {
        api.dispose();
        client.close();
      });
      await tester.runAsync(() async {
        await session.enter(code);
        await tester.pumpWidget(
          MaterialApp(
            home: GuestScreen(
              liveConnect: fixtureConnect,
              session: session,
              api: api,
              links: links.stream,
            ),
          ),
        );
        await Future<void>.delayed(const Duration(milliseconds: 100));
      });
      await settle(tester);
      for (final link in [
        'velio://invite/$code/extra',
        'https://example.com/$code',
        'velio://invite/bad',
        'velio://invite/%FF',
        'velio://invite/$code?journey=%FF',
        'velio://invite/$code?journey=bad',
        'velio://invite/$code?journey=${newId()}&journey=${newId()}',
      ]) {
        await tester.runAsync(() async {
          links.add(Uri.parse(link));
        });
        await settle(tester);
        expect(
          find.textContaining('Cannot open this invitation link'),
          findsOneWidget,
        );
        expect(session.code, code);
        expect(find.text('Supper club'), findsOneWidget);
      }
      await tester.enterText(
        find.widgetWithText(TextField, 'Invitation code'),
        'bad',
      );
      await tester.runAsync(() async {
        await tester.ensureVisible(find.text('View invitation'));
        await tester.tap(find.text('View invitation'));
      });
      await settle(tester);
      expect(session.code, code);
      expect(find.text('Supper club'), findsOneWidget);
      expect(find.textContaining('12-character'), findsOneWidget);
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.runAsync(() => links.close());
    },
  );
  testWidgets(
    'code entry renders activity and anonymous human previews before identity setup',
    (tester) async {
      final events = <Map<String, dynamic>>[];
      final client = MockClient((request) async {
        if (request.url.path == '/api/events') {
          events.add(jsonDecode(request.body) as Map<String, dynamic>);
          return envelope({'id': events.last['id'], 'accepted': true}, 202);
        }
        if (request.url.path == '/api/invites/$code') {
          return envelope(preview());
        }
        fail('Unexpected request before identity setup: ${request.url}');
      });
      await tester.pumpWidget(
        MaterialApp(
          home: GuestScreen(
            liveConnect: fixtureConnect,
            session: session,
            api: GuestApi(client: client),
            links: const Stream<Uri>.empty(),
          ),
        ),
      );
      await settle(tester);
      await tester.enterText(
        find.widgetWithText(TextField, 'Invitation code'),
        'abcd-2345-efgh',
      );
      await tester.runAsync(() async {
        await tester.ensureVisible(find.text('View invitation'));
        await tester.tap(find.text('View invitation'));
        await Future<void>.delayed(const Duration(milliseconds: 100));
      });
      await settle(tester);
      expect(find.text('Supper club'), findsOneWidget);
      expect(find.text('Marina gate'), findsOneWidget);
      expect(find.textContaining('Africa/Lagos'), findsOneWidget);
      expect(find.textContaining('19:00'), findsOneWidget);
      expect(find.textContaining('NGN'), findsOneWidget);
      expect(find.textContaining('Amara'), findsOneWidget);
      expect(find.text('Choose demo identity'), findsOneWidget);
      expect(
        events.map((e) => e['name']),
        containsAll(['invite_opened', 'activity_viewed']),
      );
      expect(
        events.every(
          (e) =>
              e['platform'] == 'mobile' &&
              e['journeyId'] == session.journeyId &&
              !e.containsKey('actorId'),
        ),
        isTrue,
      );
      await tester.pumpWidget(const SizedBox.shrink());
      client.close();
    },
  );
  testWidgets(
    'invited identity claims a committed seat and replay restores it without another haptic',
    (tester) async {
      final requests = <http.Request>[];
      var claimed = false;
      var offline = false;
      var haptics = 0;
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        (call) async {
          if (call.method == 'HapticFeedback.vibrate') haptics++;
          return null;
        },
      );
      final booking = {
        'id': '66666666-6666-4666-8666-666666666666',
        'activityId': activityId,
        'planId': planId,
        'userId': actorId,
        'priceMinor': 2500,
        'currency': 'NGN',
        'confirmedAt': '2026-10-09T12:00:00Z',
      };
      final availability = {
        'activityId': activityId,
        'planId': planId,
        'capacity': 2,
        'confirmedCount': 2,
        'remainingSeats': 0,
        'version': 3,
      };
      final client = MockClient((request) async {
        if (offline) {
          throw http.ClientException('Offline on confirmation refresh');
        }
        requests.add(request);
        final path = request.url.path;
        if (path == '/api/events') {
          return envelope({
            'id': jsonDecode(request.body)['id'],
            'accepted': true,
          }, 202);
        }
        if (path == '/api/invites/$code') {
          return envelope(preview(state: claimed ? 'full' : 'valid'));
        }
        if (path == '/api/identities' && request.method == 'GET') {
          return envelope([]);
        }
        if (path.startsWith('/api/identities')) {
          return envelope({
            'id': actorId,
            'displayName': 'Tunde',
            'generation': 1,
          }, request.method == 'POST' ? 201 : 200);
        }
        if (path == '/api/activities/$activityId/booking') {
          return envelope({
            'booking': claimed ? booking : null,
            'availability': availability,
          });
        }
        if (path == '/api/invites/$code/claims') {
          claimed = true;
          return envelope({
            'booking': booking,
            'availability': availability,
            'replayed': false,
            'telemetry': 'ok',
          }, 201);
        }
        fail('Unexpected request: $path');
      });
      await tester.runAsync(() => session.enter(code));
      await tester.runAsync(() async {
        await tester.pumpWidget(
          MaterialApp(
            home: GuestScreen(
              liveConnect: fixtureConnect,
              session: session,
              api: GuestApi(client: client),
              links: const Stream<Uri>.empty(),
            ),
          ),
        );
        await Future<void>.delayed(const Duration(milliseconds: 100));
      });
      await settle(tester);
      await tester.runAsync(() async {
        await tester.ensureVisible(find.text('Choose demo identity'));
        await tester.tap(find.text('Choose demo identity'));
      });
      await settle(tester);
      await tester.runAsync(
        () => tester.enterText(
          find.widgetWithText(TextField, 'Your display name'),
          'Tunde',
        ),
      );
      await tester.ensureVisible(find.text('Create demo identity'));
      await tester.runAsync(() async {
        await tester.tap(find.text('Create demo identity'));
      });
      await settle(tester);
      await tester.ensureVisible(find.text('Claim my seat'));
      await tester.runAsync(() async {
        await tester.tap(find.text('Claim my seat'));
      });
      await settle(tester);
      expect(find.text('Your seat is confirmed'), findsOneWidget);
      expect(haptics, 1);
      final signup = requests.singleWhere(
        (r) => r.url.path == '/api/identities' && r.method == 'POST',
      );
      expect(jsonDecode(signup.body), {
        'displayName': 'Tunde',
        'inviteCode': code,
        'journeyId': session.journeyId,
        'platform': 'mobile',
      });
      final claim = requests.singleWhere((r) => r.url.path.endsWith('/claims'));
      expect(
        claim.headers['Idempotency-Key'],
        await tester.runAsync(() => session.claimKey(actorId, code)),
      );
      expect(jsonDecode(claim.body), {
        'platform': 'mobile',
        'journeyId': session.journeyId,
      });
      await tester.pumpWidget(const SizedBox.shrink());
      final restored = await tester.runAsync(
        () => GuestSession.open(session.file),
      );
      await tester.runAsync(() async {
        await tester.pumpWidget(
          MaterialApp(
            home: GuestScreen(
              liveConnect: fixtureConnect,
              session: restored!,
              api: GuestApi(client: client),
              links: const Stream<Uri>.empty(),
            ),
          ),
        );
        await Future<void>.delayed(const Duration(milliseconds: 100));
      });
      await settle(tester);
      expect(find.text('Your seat is confirmed'), findsOneWidget);
      expect(haptics, 1);
      offline = true;
      await tester.ensureVisible(find.text('View invitation'));
      await tester.runAsync(() async {
        await tester.ensureVisible(find.text('View invitation'));
        await tester.tap(find.text('View invitation'));
        await Future<void>.delayed(const Duration(milliseconds: 100));
      });
      await settle(tester);
      expect(find.text('Your seat is confirmed'), findsOneWidget);
      expect(
        find.textContaining('Availability may have changed'),
        findsOneWidget,
      );
      expect(haptics, 1);

      expect(requests.where((r) => r.url.path.endsWith('/claims')).length, 1);
      await tester.pumpWidget(const SizedBox.shrink());
      client.close();
    },
  );

  for (final state in ['full', 'expired', 'started', 'cancelled']) {
    testWidgets('$state previews retain context without offering a new claim', (
      tester,
    ) async {
      final events = <String>[];
      final client = MockClient((request) async {
        if (request.url.path == '/api/events') {
          final event = jsonDecode(request.body);
          if (event['name'] == 'invite_opened') {
            events.add(event['displayedState'] as String);
          }
          return envelope({'id': event['id'], 'accepted': true}, 202);
        }
        return envelope(preview(state: state));
      });
      await tester.runAsync(() async {
        await session.enter(code);
        await tester.pumpWidget(
          MaterialApp(
            home: GuestScreen(
              liveConnect: (_) async => throw const SocketException(
                'No live transport in unavailable-state fixture',
              ),
              session: session,
              api: GuestApi(client: client),
              links: const Stream<Uri>.empty(),
            ),
          ),
        );
        await Future<void>.delayed(const Duration(milliseconds: 100));
      });
      await settle(tester);
      expect(find.text('Marina gate'), findsOneWidget);
      expect(find.text(unavailableMessages[state]!), findsOneWidget);
      expect(find.text('Claim my seat'), findsNothing);
      expect(events, [state]);
      await tester.pumpWidget(const SizedBox.shrink());
      client.close();
    });
  }
  testWidgets(
    'an uncertain claim retains its key across restart and retries without duplicate haptics',
    (tester) async {
      var failClaim = true;
      var failLookup = false;
      var claimed = false;
      var haptics = 0;
      final keys = <String>[];
      final booking = {
        'id': '66666666-6666-4666-8666-666666666666',
        'activityId': activityId,
        'planId': planId,
        'userId': actorId,
        'priceMinor': 2500,
        'currency': 'NGN',
        'confirmedAt': '2026-10-09T12:00:00Z',
      };
      final availability = {
        'activityId': activityId,
        'planId': planId,
        'capacity': 2,
        'confirmedCount': 1,
        'remainingSeats': 1,
        'version': 3,
      };
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        (call) async {
          if (call.method == 'HapticFeedback.vibrate') haptics++;
          return null;
        },
      );
      final client = MockClient((request) async {
        final path = request.url.path;
        if (path == '/api/events') {
          return envelope({
            'id': jsonDecode(request.body)['id'],
            'accepted': true,
          }, 202);
        }
        if (path == '/api/invites/$code') return envelope(preview());
        if (path.startsWith('/api/identities')) {
          return envelope({
            'id': actorId,
            'displayName': 'Tunde',
            'generation': 1,
          });
        }
        if (path.endsWith('/booking')) {
          if (failLookup) throw TimeoutException('Recovery lookup timed out');
          return envelope({
            'booking': claimed ? booking : null,
            'availability': availability,
          });
        }
        if (path.endsWith('/claims')) {
          keys.add(request.headers['Idempotency-Key']!);
          if (failClaim) {
            throw http.ClientException('Disconnected before response');
          }
          claimed = true;
          return envelope({
            'booking': booking,
            'availability': availability,
            'replayed': false,
          }, 201);
        }
        fail('Unexpected request: $path');
      });
      Future<void> launch(GuestSession current) async {
        await tester.runAsync(() async {
          await tester.pumpWidget(
            MaterialApp(
              home: GuestScreen(
                liveConnect: fixtureConnect,
                session: current,
                api: GuestApi(client: client),
                links: const Stream<Uri>.empty(),
              ),
            ),
          );
          await Future<void>.delayed(const Duration(milliseconds: 100));
        });
        await settle(tester);
      }

      await tester.runAsync(() async {
        await session.enter(code);
        await session.selectActor(actorId);
      });
      await launch(session);
      await tester.ensureVisible(find.text('Claim my seat'));
      await tester.runAsync(() async {
        await tester.tap(find.text('Claim my seat'));
      });
      await settle(tester);
      expect(find.text('Your seat is confirmed'), findsNothing);
      expect(find.text('Check / retry confirmation'), findsOneWidget);
      expect(haptics, 0);
      await tester.pumpWidget(const SizedBox.shrink());
      final restored = await tester.runAsync(
        () => GuestSession.open(session.file),
      );
      failClaim = false;
      failLookup = true;
      await launch(restored!);
      expect(find.text('Check / retry confirmation'), findsOneWidget);
      expect(restored.hasPendingClaim(actorId, code), isTrue);
      failLookup = false;
      await tester.ensureVisible(find.text('Check / retry confirmation'));
      await tester.runAsync(() async {
        await tester.tap(find.text('Check / retry confirmation'));
      });
      await settle(tester);
      expect(find.text('Your seat is confirmed'), findsOneWidget);
      expect(keys, hasLength(2));
      expect(keys.last, keys.first);
      expect(haptics, 1);
      await tester.pumpWidget(const SizedBox.shrink());
      client.close();
    },
  );
  testWidgets(
    'installed-app link adopts a fresh web journey and malformed preview does not emit opens',
    (tester) async {
      const webJourney = '77777777-7777-4777-8777-777777777777';
      final links = StreamController<Uri>();
      var malformed = true;
      final events = <Map<String, dynamic>>[];
      final client = MockClient((request) async {
        if (request.url.path == '/api/events') {
          final event = jsonDecode(request.body) as Map<String, dynamic>;
          events.add(event);
          return envelope({'id': event['id'], 'accepted': true}, 202);
        }
        return envelope(
          malformed
              ? {
                  ...preview(),
                  'activity': {
                    ...preview()['activity'] as Map,
                    'confirmedCount': 9,
                  },
                }
              : preview(),
        );
      });
      await tester.runAsync(() async {
        await tester.pumpWidget(
          MaterialApp(
            home: GuestScreen(
              liveConnect: fixtureConnect,
              session: session,
              api: GuestApi(client: client),
              links: links.stream,
            ),
          ),
        );
        links.add(Uri.parse('velio://invite/$code?journey=$webJourney'));
        await Future<void>.delayed(const Duration(milliseconds: 100));
      });
      await settle(tester);
      expect(find.text('Supper club'), findsNothing);
      expect(events, isEmpty);
      expect(session.code, code);
      expect(session.journeyId, webJourney);
      malformed = false;
      await tester.runAsync(() async {
        await tester.ensureVisible(find.text('View invitation'));
        await tester.tap(find.text('View invitation'));
      });
      await settle(tester);
      expect(find.text('Supper club'), findsOneWidget);
      expect(events.first['journeyId'], webJourney);
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.runAsync(() => links.close());
      client.close();
    },
  );

  testWidgets(
    'a last-seat rejection keeps details and produces no success haptic',
    (tester) async {
      var haptics = 0;
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        (call) async {
          if (call.method == 'HapticFeedback.vibrate') haptics++;
          return null;
        },
      );
      final client = MockClient((request) async {
        final path = request.url.path;
        if (path == '/api/events') {
          return envelope({
            'id': jsonDecode(request.body)['id'],
            'accepted': true,
          }, 202);
        }
        if (path == '/api/invites/$code') return envelope(preview());
        if (path.startsWith('/api/identities')) {
          return envelope({
            'id': actorId,
            'displayName': 'Tunde',
            'generation': 1,
          });
        }
        if (path.endsWith('/booking')) {
          return envelope({
            'booking': null,
            'availability': {
              'activityId': activityId,
              'planId': planId,
              'capacity': 2,
              'confirmedCount': 1,
              'remainingSeats': 1,
              'version': 2,
            },
          });
        }
        return http.Response(
          jsonEncode({
            'error': {
              'code': 'SOLD_OUT',
              'message': 'The last spot was just taken.',
              'retryable': false,
            },
            'requestId': 'last-seat-reference',
          }),
          409,
        );
      });
      await tester.runAsync(() async {
        await session.enter(code);
        await session.selectActor(actorId);
        await tester.pumpWidget(
          MaterialApp(
            home: GuestScreen(
              liveConnect: fixtureConnect,
              session: session,
              api: GuestApi(client: client),
              links: const Stream<Uri>.empty(),
            ),
          ),
        );
        await Future<void>.delayed(const Duration(milliseconds: 100));
      });
      await settle(tester);
      await tester.ensureVisible(find.text('Claim my seat'));
      await tester.runAsync(() async {
        await tester.tap(find.text('Claim my seat'));
      });
      await settle(tester);
      expect(
        find.textContaining('The last spot was just taken.'),
        findsOneWidget,
      );
      expect(find.text('Marina gate'), findsOneWidget);
      expect(session.code, code);
      expect(find.text('Your seat is confirmed'), findsNothing);
      expect(haptics, 0);
      expect(
        tester
            .widget<FilledButton>(
              find.widgetWithText(FilledButton, 'Claim my seat'),
            )
            .onPressed,
        isNull,
      );
      await tester.pumpWidget(const SizedBox.shrink());
      client.close();
    },
  );
  testWidgets('refresh failure keeps the last rendered invitation context', (
    tester,
  ) async {
    var offline = false;
    final client = MockClient((request) async {
      if (offline) throw http.ClientException('Offline during refresh');
      if (request.url.path == '/api/events') {
        return envelope({
          'id': jsonDecode(request.body)['id'],
          'accepted': true,
        }, 202);
      }
      return envelope(preview());
    });
    await tester.runAsync(() async {
      await session.enter(code);
      await tester.pumpWidget(
        MaterialApp(
          home: GuestScreen(
            liveConnect: fixtureConnect,
            session: session,
            api: GuestApi(client: client),
            links: const Stream<Uri>.empty(),
          ),
        ),
      );
      await Future<void>.delayed(const Duration(milliseconds: 100));
    });
    await settle(tester);
    offline = true;
    await tester.runAsync(() async {
      await tester.ensureVisible(find.text('View invitation'));
      await tester.tap(find.text('View invitation'));
      await Future<void>.delayed(const Duration(milliseconds: 100));
    });
    await settle(tester);
    expect(find.text('Supper club'), findsOneWidget);
    expect(find.text('Marina gate'), findsOneWidget);
    expect(
      find.textContaining('Availability may have changed'),
      findsOneWidget,
    );
    expect(session.code, code);
    await tester.pumpWidget(const SizedBox.shrink());
    client.close();
  });
}
