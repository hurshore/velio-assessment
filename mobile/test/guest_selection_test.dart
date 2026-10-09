import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/testing.dart';
import 'package:velio_mobile/guest_api.dart';
import 'package:velio_mobile/guest_screen.dart';
import 'package:velio_mobile/guest_session.dart';

import 'guest_journey_test.dart' as fixture;
import 'live_fixture.dart';

class FaultFile implements File {
  FaultFile(this.delegate);
  final File delegate;
  bool failWrites = false;
  @override
  String get path => delegate.path;
  @override
  Directory get parent =>
      failWrites ? Directory('/dev/null/session') : delegate.parent;
  @override
  Future<bool> exists() => delegate.exists();
  @override
  Future<Uint8List> readAsBytes() => delegate.readAsBytes();
  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

void main() {
  for (final scenario in ['save', 'reject', 'recovery', 'late']) {
    final rejected = scenario == 'reject';
    testWidgets(
      scenario == 'late'
          ? 'superseded candidate response never changes the active actor'
          : scenario == 'recovery'
          ? 'local recovery save failure retains original key and server confirmation'
          : rejected
          ? 'rejected vouch candidate preserves original actor recovery and live context'
          : 'failed identity save never publishes candidate confirmation or live context',
      (tester) async {
        final directory = (await tester.runAsync(
          () => Directory.systemTemp.createTemp('selection-'),
        ))!;
        addTearDown(() => directory.delete(recursive: true));
        final file = FaultFile(File('${directory.path}/session.json'));
        final session = (await tester.runAsync(() => GuestSession.open(file)))!;
        const candidate = '44444444-4444-4444-8444-444444444444';
        final subscriptions = <Map<String, dynamic>>[];
        final originalPreview = {
          ...fixture.preview(),
          if (rejected) 'rail': 'vouch',
          if (rejected) 'trust': 'vouch',
        };
        final booking = {
          'id': '66666666-6666-4666-8666-666666666666',
          'activityId': fixture.activityId,
          'planId': fixture.planId,
          'userId': candidate,
          'priceMinor': 2500,
          'currency': 'NGN',
          'confirmedAt': '2026-10-09T12:00:00Z',
        };
        final delayed = Completer<Map<String, dynamic>>();
        final client = MockClient((request) async {
          final path = request.url.path;
          if (path.endsWith('/events')) {
            return fixture.envelope({
              'id': jsonDecode(request.body)['id'],
              'accepted': true,
            }, 202);
          }
          if (scenario == 'late' &&
              path.endsWith('/booking') &&
              request.headers['X-Demo-Actor-Id'] == candidate) {
            return fixture.envelope(await delayed.future);
          }
          if (path.endsWith('/booking')) {
            return fixture.envelope({
              'booking':
                  !rejected && request.headers['X-Demo-Actor-Id'] == candidate
                  ? booking
                  : null,
              'availability': {
                'activityId': fixture.activityId,
                'planId': fixture.planId,
                ...fixture.preview()['activity'] as Map,
              },
            });
          }
          if (path.endsWith('/recipient-check')) {
            return fixture.envelope({
              'matches': request.headers['X-Demo-Actor-Id'] == fixture.actorId,
            });
          }
          if (path == '/api/identities') {
            return fixture.envelope([
              {
                'id': candidate,
                'displayName': 'Candidate guest',
                'generation': 0,
              },
            ]);
          }
          if (path.contains('/identities/')) {
            return fixture.envelope({
              'id': fixture.actorId,
              'displayName': 'Original guest',
              'generation': 0,
            });
          }
          return fixture.envelope(originalPreview);
        });
        final api = GuestApi(client: client);
        addTearDown(() {
          api.dispose();
          client.close();
        });
        final sockets = <FixtureSocket>[];
        await tester.runAsync(() async {
          await session.enter(fixture.code);
          await session.selectActor(fixture.actorId);
          await session.startClaim(fixture.actorId, fixture.code);
          await tester.pumpWidget(
            MaterialApp(
              home: GuestScreen(
                session: session,
                api: api,
                links: const Stream.empty(),
                liveConnect: (_) async {
                  final socket = FixtureSocket(
                    withParticipants(
                      Map<String, dynamic>.from(
                        fixture.preview()['activity'] as Map,
                      ),
                    ),
                  );
                  sockets.add(socket);
                  return socket;
                },
              ),
            ),
          );
          await Future<void>.delayed(const Duration(milliseconds: 100));
        });
        await fixture.settle(tester);
        final key = await tester.runAsync(
          () => session.claimKey(fixture.actorId, fixture.code),
        );
        await tester.ensureVisible(find.text('Choose demo identity'));
        await tester.runAsync(
          () => tester.tap(find.text('Choose demo identity')),
        );
        await fixture.settle(tester);
        if (scenario == 'save') file.failWrites = true;
        await tester.ensureVisible(find.text('Candidate guest'));
        await tester.runAsync(() => tester.tap(find.text('Candidate guest')));
        if (scenario == 'late') {
          await tester.pumpWidget(const SizedBox.shrink());
          await tester.runAsync(() async {
            delayed.complete({
              'booking': booking,
              'availability': {
                'activityId': fixture.activityId,
                'planId': fixture.planId,
                ...fixture.preview()['activity'] as Map,
              },
            });
            await Future<void>.delayed(const Duration(milliseconds: 50));
          });
          expect(session.actorId, fixture.actorId);
          expect(tester.takeException(), isNull);
          return;
        }
        for (var i = 0; i < 8; i++) {
          await fixture.settle(tester);
        }
        if (scenario == 'recovery') {
          expect(session.actorId, candidate);
          expect(find.text('Your seat is confirmed'), findsOneWidget);
          file.failWrites = true;
          await tester.ensureVisible(find.text('Recover earlier confirmation'));
          await tester.runAsync(
            () => tester.tap(find.text('Recover earlier confirmation')),
          );
          await fixture.settle(tester);
          expect(tester.takeException(), isNull);
          expect(session.actorId, candidate);
          expect(find.text('Your seat is confirmed'), findsOneWidget);
          expect(
            find.textContaining('Could not switch to the saved claim'),
            findsOneWidget,
          );
          expect(session.hasPendingClaim(fixture.actorId, fixture.code), true);
          file.failWrites = false;
          expect(
            await tester.runAsync(
              () => session.claimKey(fixture.actorId, fixture.code),
            ),
            key,
          );
          await tester.pumpWidget(const SizedBox.shrink());
          return;
        }
        expect(session.actorId, fixture.actorId);
        expect(find.text('Your seat is confirmed'), findsNothing);
        expect(
          find.text('Selected demo identity: Original guest'),
          findsOneWidget,
        );
        expect(find.text('Check / retry confirmation'), findsOneWidget);
        expect(session.hasPendingClaim(fixture.actorId, fixture.code), true);
        file.failWrites = false;
        expect(
          await tester.runAsync(
            () => session.claimKey(fixture.actorId, fixture.code),
          ),
          key,
        );
        for (final socket in sockets) {
          subscriptions.addAll(
            socket.sent.where((m) => m['type'] == 'subscribe'),
          );
        }
        expect(
          subscriptions.every((m) => m['actorId'] == fixture.actorId),
          true,
        );
        expect(
          find.textContaining(
            rejected
                ? 'This vouch is for one intended contact.'
                : 'Could not save',
          ),
          findsOneWidget,
        );
        await tester.pumpWidget(const SizedBox.shrink());
      },
    );
  }
}
