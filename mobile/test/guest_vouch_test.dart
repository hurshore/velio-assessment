import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:velio_mobile/guest_api.dart';
import 'package:velio_mobile/guest_screen.dart';
import 'package:velio_mobile/guest_session.dart';

import 'guest_journey_test.dart' as fixture;
import 'live_fixture.dart';

void main() {
  testWidgets(
    'a vouch selects only the matching saved identity and preserves drafts after recipient rejection',
    (tester) async {
      final directory = (await tester.runAsync(
        () => Directory.systemTemp.createTemp('vouch-screen-'),
      ))!;
      final session = (await tester.runAsync(
        () => GuestSession.open(File('${directory.path}/session.json')),
      ))!;
      addTearDown(() => directory.delete(recursive: true));
      const outsider = '44444444-4444-4444-8444-444444444444';
      final requests = <http.Request>[];
      final client = MockClient((request) async {
        requests.add(request);
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
        if (path.endsWith('/recipient-check')) {
          return fixture.envelope({
            'matches': request.headers['X-Demo-Actor-Id'] == fixture.actorId,
          });
        }
        if (path == '/api/identities/${fixture.actorId}') {
          return fixture.envelope({
            'id': fixture.actorId,
            'displayName': 'Matching recipient',
            'generation': 1,
          });
        }
        if (path == '/api/identities' && request.method == 'GET') {
          return fixture.envelope([
            {'id': outsider, 'displayName': 'Wrong recipient', 'generation': 0},
            {
              'id': fixture.actorId,
              'displayName': 'Matching recipient',
              'generation': 1,
            },
          ]);
        }
        if (path == '/api/identities' && request.method == 'POST') {
          return http.Response(
            jsonEncode({
              'error': {
                'code': 'RECIPIENT_MISMATCH',
                'message': 'Contact mismatch',
                'retryable': false,
              },
              'requestId': 'recipient-reference',
            }),
            403,
          );
        }
        return fixture.envelope({
          ...fixture.preview(),
          'rail': 'vouch',
          'trust': 'vouch',
        });
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
      expect(
        find.textContaining('personal vouch for one intended contact'),
        findsOneWidget,
      );
      await tester.ensureVisible(find.text('Choose demo identity'));
      await tester.runAsync(
        () => tester.tap(find.text('Choose demo identity')),
      );
      await fixture.settle(tester);
      await tester.ensureVisible(find.text('Wrong recipient'));
      await tester.runAsync(() => tester.tap(find.text('Wrong recipient')));
      await fixture.settle(tester);
      expect(session.actorId, isNull);
      expect(
        find.textContaining('This vouch is for one intended contact.'),
        findsOneWidget,
      );
      await tester.runAsync(
        () => tester.enterText(
          find.widgetWithText(TextField, 'Your display name'),
          'Entered name',
        ),
      );
      await tester.runAsync(
        () => tester.enterText(
          find.widgetWithText(TextField, 'Your demo contact (optional)'),
          'wrong@example.com',
        ),
      );
      await fixture.settle(tester);
      await tester.ensureVisible(find.text('Create demo identity'));
      await tester.runAsync(
        () => tester.tap(find.text('Create demo identity')),
      );
      await fixture.settle(tester);
      for (
        var attempt = 0;
        find.textContaining('recipient-reference').evaluate().isEmpty &&
            attempt < 10;
        attempt++
      ) {
        await fixture.settle(tester);
      }
      expect(session.displayName, 'Entered name');
      expect(session.contact, 'wrong@example.com');
      expect(find.textContaining('recipient-reference'), findsOneWidget);
      await tester.ensureVisible(find.text('Matching recipient'));
      await tester.runAsync(() => tester.tap(find.text('Matching recipient')));
      await fixture.settle(tester);
      for (
        var attempt = 0;
        find
                .text('Selected demo identity: Matching recipient')
                .evaluate()
                .isEmpty &&
            attempt < 10;
        attempt++
      ) {
        await fixture.settle(tester);
      }
      expect(session.actorId, fixture.actorId);
      expect(
        find.text('Selected demo identity: Matching recipient'),
        findsOneWidget,
      );
      expect(
        tester
            .widget<FilledButton>(
              find.widgetWithText(FilledButton, 'Claim my seat'),
            )
            .onPressed,
        isNotNull,
      );
      expect(requests.where((r) => r.url.path.endsWith('/claims')), isEmpty);
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );
}
