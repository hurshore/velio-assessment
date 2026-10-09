import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:velio_mobile/guest_api.dart';
import 'package:velio_mobile/guest_live.dart';
import 'package:velio_mobile/guest_screen.dart';
import 'package:velio_mobile/guest_session.dart';

import 'guest_journey_test.dart' as fixture;
import 'live_fixture.dart';

void main() {
  late Directory directory;
  late GuestSession session;
  setUp(() async {
    directory = await Directory.systemTemp.createTemp('guest-live-');
    session = await GuestSession.open(File('${directory.path}/session.json'));
  });
  tearDown(() async => directory.delete(recursive: true));

  testWidgets(
    'saved offline details survive restart and reconnect without re-entering a code',
    (tester) async {
      var offline = false;
      final events = <Map<String, dynamic>>[];
      final client = MockClient((request) async {
        if (offline) throw http.ClientException('Disconnected');
        if (request.url.path.endsWith('/events')) {
          final event = jsonDecode(request.body) as Map<String, dynamic>;
          events.add(event);
          return fixture.envelope({'id': event['id'], 'accepted': true}, 202);
        }
        return fixture.envelope(fixture.preview());
      });
      final api = GuestApi(client: client);
      addTearDown(() {
        api.dispose();
        client.close();
      });
      Future<LiveSocket> connect(Uri uri) async {
        if (offline) throw const SocketException('Offline');
        return FixtureSocket(
          withParticipants(
            Map<String, dynamic>.from(fixture.preview()['activity'] as Map),
          ),
        );
      }

      await tester.runAsync(() => session.enter(fixture.code));
      Future<void> launch(GuestSession state) async {
        await tester.runAsync(() async {
          await tester.pumpWidget(
            MaterialApp(
              home: GuestScreen(
                session: state,
                api: api,
                links: const Stream.empty(),
                liveConnect: connect,
              ),
            ),
          );
          await Future<void>.delayed(const Duration(milliseconds: 100));
        });
        await fixture.settle(tester);
      }

      await launch(session);
      expect(find.text('Participant 1'), findsOneWidget);
      await tester.pumpWidget(const SizedBox.shrink());
      offline = true;
      final restored = await tester.runAsync(
        () => GuestSession.open(session.file),
      );
      await launch(restored!);
      expect(find.text('Supper club'), findsOneWidget);
      expect(find.textContaining('Saved/offline details'), findsOneWidget);
      expect(find.text('Participant 1'), findsOneWidget);
      expect(find.text('Claim my seat'), findsNothing);
      expect(
        restored.pendingEvents.map((event) => event['name']),
        contains('invite_opened'),
      );
      offline = false;
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(seconds: 4)),
      );
      await fixture.settle(tester);
      expect(find.text('Live availability connected.'), findsOneWidget);
      expect(find.textContaining('Saved/offline details'), findsNothing);
      expect(events.first['journeyId'], restored.journeyId);
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );
  testWidgets(
    'newer membership stays visible and issued older deliveries are ACKed only after a frame',
    (tester) async {
      final socket = FixtureSocket(
        withParticipants(
          Map<String, dynamic>.from(fixture.preview()['activity'] as Map),
        ),
      );
      final client = MockClient((request) async {
        if (request.url.path.endsWith('/events')) {
          return fixture.envelope({
            'id': jsonDecode(request.body)['id'],
            'accepted': true,
          }, 202);
        }
        return fixture.envelope(fixture.preview());
      });
      final api = GuestApi(client: client);
      addTearDown(() {
        api.dispose();
        client.close();
      });
      await tester.runAsync(() async {
        await session.enter(fixture.code);
        await tester.pumpWidget(
          MaterialApp(
            home: GuestScreen(
              session: session,
              api: api,
              links: const Stream.empty(),
              liveConnect: (_) async => socket,
            ),
          ),
        );
        await Future<void>.delayed(const Duration(milliseconds: 100));
      });
      await fixture.settle(tester);
      const event = '99999999-9999-4999-8999-999999999999';
      final full = withParticipants({
        ...Map<String, dynamic>.from(fixture.preview()['activity'] as Map),
        'version': 3,
        'confirmedCount': 2,
        'remainingSeats': 0,
      });
      await tester.runAsync(() async {
        socket.snapshot(activity: full, eventId: event);
        await Future<void>.delayed(const Duration(milliseconds: 20));
      });
      expect(socket.sent.where((m) => m['type'] == 'ack'), isEmpty);
      await fixture.settle(tester);
      expect(find.text('Participant 2'), findsOneWidget);
      expect(find.text(unavailableMessages['full']!), findsOneWidget);
      expect(socket.sent.where((m) => m['type'] == 'ack').single['version'], 3);
      const older = '77777777-7777-4777-8777-777777777777';
      await tester.runAsync(() async {
        socket.snapshot(eventId: older);
        socket.snapshot(activity: full, eventId: event);
        await Future<void>.delayed(const Duration(milliseconds: 20));
      });
      await fixture.settle(tester);
      expect(find.text('Participant 2'), findsOneWidget);
      expect(socket.sent.where((m) => m['eventId'] == event), hasLength(1));
      expect(socket.sent.where((m) => m['eventId'] == older), hasLength(1));
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );
  testWidgets(
    'background suppresses pending ACKs and resume requires fresh context before a claim',
    (tester) async {
      final sockets = <FixtureSocket>[];
      Completer<http.Response>? refresh;
      final client = MockClient((request) async {
        final path = request.url.path;
        if (path.endsWith('/events')) {
          return fixture.envelope({
            'id': jsonDecode(request.body)['id'],
            'accepted': true,
          }, 202);
        }
        if (path.endsWith('/booking')) {
          return fixture.envelope({
            'booking': null,
            'availability': {
              'activityId': fixture.activityId,
              'planId': fixture.planId,
              ...Map<String, dynamic>.from(
                fixture.preview()['activity'] as Map,
              ),
            },
          });
        }
        if (path.contains('/identities')) {
          return fixture.envelope({
            'id': fixture.actorId,
            'displayName': 'Tunde',
            'generation': 1,
          });
        }
        if (refresh != null) return refresh.future;
        return fixture.envelope(fixture.preview());
      });
      final api = GuestApi(client: client);
      addTearDown(() {
        api.dispose();
        client.close();
      });
      Future<LiveSocket> connect(Uri uri) async {
        final socket = FixtureSocket(
          withParticipants(
            Map<String, dynamic>.from(fixture.preview()['activity'] as Map),
          ),
        );
        sockets.add(socket);
        return socket;
      }

      await tester.runAsync(() async {
        await session.enter(fixture.code);
        await session.selectActor(fixture.actorId);
        await tester.pumpWidget(
          MaterialApp(
            home: GuestScreen(
              session: session,
              api: api,
              links: const Stream.empty(),
              liveConnect: connect,
            ),
          ),
        );
        await Future<void>.delayed(const Duration(milliseconds: 100));
      });
      await fixture.settle(tester);
      expect(
        tester
            .widget<FilledButton>(
              find.widgetWithText(FilledButton, 'Claim my seat'),
            )
            .onPressed,
        isNotNull,
      );
      await tester.runAsync(() async {
        sockets.last.snapshot(eventId: '99999999-9999-4999-8999-999999999999');
        await Future<void>.delayed(const Duration(milliseconds: 10));
        tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.inactive,
        );
      });
      await tester.pump();
      expect(sockets.first.sent.where((m) => m['type'] == 'ack'), isEmpty);
      expect(
        tester
            .widget<FilledButton>(
              find.widgetWithText(FilledButton, 'Claim my seat'),
            )
            .onPressed,
        isNull,
      );
      refresh = Completer<http.Response>();
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      await tester.runAsync(() async {
        tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
        tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.inactive,
        );
        tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.resumed,
        );
        await Future<void>.delayed(const Duration(milliseconds: 20));
      });
      await tester.pump();
      expect(
        tester
            .widget<FilledButton>(
              find.widgetWithText(FilledButton, 'Claim my seat'),
            )
            .onPressed,
        isNull,
      );
      await tester.runAsync(() async {
        refresh!.complete(fixture.envelope(fixture.preview()));
        await Future<void>.delayed(const Duration(milliseconds: 100));
      });
      await fixture.settle(tester);
      expect(sockets, hasLength(2));
      expect(
        tester
            .widget<FilledButton>(
              find.widgetWithText(FilledButton, 'Claim my seat'),
            )
            .onPressed,
        isNotNull,
      );
      expect(session.code, fixture.code);
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );
  testWidgets(
    'recovering an earlier same-code claim never shows another identity confirmation',
    (tester) async {
      const bookedActor = '44444444-4444-4444-8444-444444444444';
      final booking = {
        'id': '66666666-6666-4666-8666-666666666666',
        'activityId': fixture.activityId,
        'planId': fixture.planId,
        'userId': bookedActor,
        'priceMinor': 2500,
        'currency': 'NGN',
        'confirmedAt': '2026-10-09T12:00:00Z',
      };
      final client = MockClient((request) async {
        final path = request.url.path;
        if (path.endsWith('/events')) {
          return fixture.envelope({
            'id': jsonDecode(request.body)['id'],
            'accepted': true,
          }, 202);
        }
        if (path.endsWith('/booking')) {
          return fixture.envelope({
            'booking': request.headers['X-Demo-Actor-Id'] == bookedActor
                ? booking
                : null,
            'availability': {
              'activityId': fixture.activityId,
              'planId': fixture.planId,
              ...Map<String, dynamic>.from(
                fixture.preview()['activity'] as Map,
              ),
            },
          });
        }
        if (path == '/api/identities') {
          return fixture.envelope([
            {'id': bookedActor, 'displayName': 'Booked guest', 'generation': 0},
          ]);
        }
        if (path.startsWith('/api/identities/')) {
          return fixture.envelope({
            'id': path.endsWith(bookedActor) ? bookedActor : fixture.actorId,
            'displayName': path.endsWith(bookedActor)
                ? 'Booked guest'
                : 'Pending guest',
            'generation': 0,
          });
        }
        return fixture.envelope(fixture.preview());
      });
      final api = GuestApi(client: client);
      addTearDown(() {
        api.dispose();
        client.close();
      });
      String? originalKey;
      await tester.runAsync(() async {
        await session.enter(fixture.code);
        await session.selectActor(fixture.actorId);
        originalKey = await session.startClaim(fixture.actorId, fixture.code);
        await tester.pumpWidget(
          MaterialApp(
            home: GuestScreen(
              session: session,
              api: api,
              links: const Stream.empty(),
              liveConnect: (_) async => FixtureSocket(
                withParticipants(
                  Map<String, dynamic>.from(
                    fixture.preview()['activity'] as Map,
                  ),
                ),
              ),
            ),
          ),
        );
        await Future<void>.delayed(const Duration(milliseconds: 100));
      });
      await fixture.settle(tester);
      await tester.ensureVisible(find.text('Choose demo identity'));
      await tester.runAsync(
        () => tester.tap(find.text('Choose demo identity')),
      );
      await fixture.settle(tester);
      await tester.ensureVisible(find.text('Booked guest'));
      await tester.runAsync(() => tester.tap(find.text('Booked guest')));
      for (
        var attempt = 0;
        find.text('Your seat is confirmed').evaluate().isEmpty && attempt < 10;
        attempt++
      ) {
        await fixture.settle(tester);
      }
      expect(find.text('Your seat is confirmed'), findsOneWidget);
      await tester.ensureVisible(find.text('Recover earlier confirmation'));
      await tester.runAsync(
        () => tester.tap(find.text('Recover earlier confirmation')),
      );
      for (var attempt = 0; attempt < 10; attempt++) {
        await fixture.settle(tester);
      }
      expect(session.actorId, fixture.actorId);
      expect(find.text('Your seat is confirmed'), findsNothing);
      expect(find.text('Check / retry confirmation'), findsOneWidget);
      expect(session.hasPendingClaim(fixture.actorId, fixture.code), true);
      expect(
        await tester.runAsync(
          () => session.claimKey(fixture.actorId, fixture.code),
        ),
        originalKey,
      );
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );
}
