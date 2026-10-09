import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/testing.dart';
import 'package:velio_mobile/guest_api.dart';
import 'package:velio_mobile/guest_screen.dart';
import 'package:velio_mobile/guest_session.dart';

import 'guest_journey_test.dart' as fixture;
import 'live_fixture.dart';

void main() {
  for (final ahead in [true, false]) {
    testWidgets(
      'online eligibility follows the server when the device clock is ${ahead ? 'ahead' : 'behind'}',
      (tester) async {
        final directory = (await tester.runAsync(
          () => Directory.systemTemp.createTemp('eligibility-'),
        ))!;
        addTearDown(() => directory.delete(recursive: true));
        final session = (await tester.runAsync(
          () => GuestSession.open(File('${directory.path}/session.json')),
        ))!;
        // The server is ten minutes behind/ahead of this device. Only server state is authoritative.
        final activity = {
          ...fixture.preview()['activity'] as Map,
          'startsAt': utcTimestamp(
            DateTime.now().add(Duration(minutes: ahead ? -5 : 20)),
          ),
        };
        final state = ahead ? 'valid' : 'expired';
        final preview = {
          ...fixture.preview(),
          'activity': activity,
          'state': state,
          'expiresAt': utcTimestamp(
            DateTime.now().add(const Duration(minutes: 5)),
          ),
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
              'booking': null,
              'availability': {
                'activityId': fixture.activityId,
                'planId': fixture.planId,
                ...activity,
              },
            });
          }
          if (path.contains('/identities/')) {
            return fixture.envelope({
              'id': fixture.actorId,
              'displayName': 'Guest',
              'generation': 0,
            });
          }
          return fixture.envelope(preview);
        });
        final api = GuestApi(client: client);
        addTearDown(() {
          api.dispose();
          client.close();
        });
        await tester.runAsync(() async {
          await session.enter(fixture.code);
          await session.selectActor(fixture.actorId);
          await tester.pumpWidget(
            MaterialApp(
              home: GuestScreen(
                session: session,
                api: api,
                links: const Stream.empty(),
                liveConnect: (_) async => FixtureSocket(
                  withParticipants({...activity, 'inviteState': state}),
                ),
              ),
            ),
          );
          await Future<void>.delayed(const Duration(milliseconds: 100));
        });
        await fixture.settle(tester);
        expect(find.text('Live availability connected.'), findsOneWidget);
        final button = tester.widget<FilledButton>(
          find.widgetWithText(FilledButton, 'Claim my seat'),
        );
        expect(button.onPressed != null, ahead);
        if (!ahead) {
          expect(find.text(unavailableMessages['expired']!), findsOneWidget);
        }
        await tester.pumpWidget(const SizedBox.shrink());
      },
    );
  }
}
