import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:app_links/app_links.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:integration_test/integration_test.dart';
import 'package:path_provider/path_provider.dart';
import 'package:velio_mobile/guest_api.dart';
import 'package:velio_mobile/guest_screen.dart';
import 'package:velio_mobile/guest_session.dart';

// Lose one committed HTTP response while retaining the real API transaction.
class LostClaimResponse extends http.BaseClient {
  final delegate = http.Client();
  bool loseNextClaim = true;
  final keys = <String>[];
  final events = <Map<String, dynamic>>[];
  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    if (request.url.path.endsWith('/events') && request is http.Request) {
      events.add(jsonDecode(request.body) as Map<String, dynamic>);
    }
    final response = await delegate.send(request);
    if (request.url.path.endsWith('/claims')) {
      keys.add(request.headers['Idempotency-Key']!);
      if (loseNextClaim) {
        loseNextClaim = false;
        await response.stream.drain<void>();
        throw http.ClientException(
          'Integration fixture: committed response lost',
        );
      }
    }
    return response;
  }

  @override
  void close() => delegate.close();
}

class CompetingBooking extends http.BaseClient {
  CompetingBooking(this.beforeClaim);
  final Future<void> Function() beforeClaim;
  final delegate = http.Client();
  bool raced = false;
  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    if (request.url.path.endsWith('/claims') && !raced) {
      raced = true;
      await beforeClaim();
    }
    return delegate.send(request);
  }

  @override
  void close() => delegate.close();
}

Future<Map<String, dynamic>> treatmentActivity(
  GuestApi setup,
  String host,
  String title,
) async {
  for (var attempt = 0; attempt < 30; attempt++) {
    final activity = object(
      await setup.request(
        '/activities',
        method: 'POST',
        actorId: host,
        body: {
          'title': title,
          'description': 'A real simulator invitation test.',
          'meetingLocation': 'Marina gate',
          'startsAt': utcTimestamp(DateTime.now().add(const Duration(days: 2))),
          'timezone': 'Africa/Lagos',
          'capacity': 1,
          'priceMinor': 2500,
          'currency': 'NGN',
        },
      ),
    );
    if (object(activity['assignment'])['variant'] == 'treatment') {
      return activity;
    }
  }
  throw StateError(
    'No treatment fixture after 30 attempts. Check the configured treatment allocation.',
  );
}

Future<void> waitFor(
  WidgetTester tester,
  Finder finder, {
  Duration timeout = const Duration(seconds: 12),
}) async {
  final deadline = DateTime.now().add(timeout);
  while (finder.evaluate().isEmpty && DateTime.now().isBefore(deadline)) {
    await tester.pump(const Duration(milliseconds: 200));
  }
  expect(finder, findsOneWidget);
  await tester.pumpAndSettle();
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'native link, lost committed response, last-seat race, code entry and recovery',
    (tester) async {
      final nativeLinks = AppLinks();
      final setup = GuestApi();
      final journey = newId();
      final host = object(
        await setup.request(
          '/identities',
          method: 'POST',
          body: {
            'displayName': 'Mobile host · integration $journey',
            'journeyId': newId(),
            'platform': 'mobile',
            'test': true,
          },
        ),
      );
      final activity = await treatmentActivity(
        setup,
        host['id'] as String,
        'Flutter supper · integration $journey',
      );
      final invite = object(
        await setup.request(
          '/activities/${activity['id']}/invites',
          method: 'POST',
          actorId: host['id'] as String,
          body: {'rail': 'public', 'platform': 'mobile', 'journeyId': newId()},
        ),
      );
      final code = invite['code'] as String;
      final directory = await getApplicationSupportDirectory();
      final file = File('${directory.path}/integration-$journey.json');
      final session = await GuestSession.open(file);
      final transport = LostClaimResponse();
      await tester.pumpWidget(
        MaterialApp(
          home: GuestScreen(
            session: session,
            api: GuestApi(client: transport),
            links: nativeLinks.uriLinkStream,
          ),
        ),
      );
      // scripts/check-mobile-guest.mjs opens this URL through simctl when the real listener is attached.
      debugPrint('VELIO_LINK_READY=velio://invite/$code?journey=$journey');
      await waitFor(
        tester,
        find.text(activity['title'] as String),
        timeout: const Duration(seconds: 45),
      );
      expect(session.journeyId, journey);
      expect(find.text('Marina gate'), findsOneWidget);
      expect(find.text('Claim my seat'), findsNothing);
      await tester.ensureVisible(find.text('Choose demo identity'));
      await tester.tap(find.text('Choose demo identity'));
      await waitFor(tester, find.text('Create demo identity'));
      final guestName = 'Mobile guest · $journey';
      await tester.enterText(
        find.widgetWithText(TextField, 'Your display name'),
        guestName,
      );
      await tester.ensureVisible(find.text('Create demo identity'));
      await tester.tap(find.text('Create demo identity'));
      await waitFor(tester, find.text('Claim my seat'));
      await tester.ensureVisible(find.text('Claim my seat'));
      await tester.tap(find.text('Claim my seat'));
      await waitFor(tester, find.text('Your seat is confirmed'));
      expect(transport.keys, hasLength(1));
      expect(transport.events, hasLength(2));
      final replayEvent = object(
        await setup.request(
          '/events',
          method: 'POST',
          body: transport.events.first,
        ),
      );
      expect(replayEvent['accepted'], false);
      final actor = session.actorId!;
      final confirmed = await setup.ownBooking(
        await setup.preview(code),
        actor,
      );
      expect(confirmed.availability.remainingSeats, 0);
      expect(confirmed.booking, isNotNull);
      await tester.pumpWidget(const SizedBox.shrink());
      final restored = await GuestSession.open(file);
      await tester.pumpWidget(
        MaterialApp(
          home: GuestScreen(
            session: restored,
            api: GuestApi(),
            links: nativeLinks.uriLinkStream,
          ),
        ),
      );
      await waitFor(tester, find.text('Your seat is confirmed'));
      expect(
        (await setup.ownBooking(
          await setup.preview(code),
          actor,
        )).booking!['id'],
        confirmed.booking!['id'],
      );
      await tester.pumpWidget(const SizedBox.shrink());

      // A separate guest sees the stale last seat, loses the race, and keeps their entered code.
      final loser = object(
        await setup.request(
          '/identities',
          method: 'POST',
          body: {
            'displayName': 'Competing mobile guest · $journey',
            'journeyId': newId(),
            'platform': 'mobile',
            'test': true,
          },
        ),
      );
      final raceActivity = await treatmentActivity(
        setup,
        host['id'] as String,
        'Competing supper · integration $journey',
      );
      final raceInvite = object(
        await setup.request(
          '/activities/${raceActivity['id']}/invites',
          method: 'POST',
          actorId: host['id'] as String,
          body: {'rail': 'public', 'platform': 'mobile', 'journeyId': newId()},
        ),
      );
      final raceCode = raceInvite['code'] as String;
      final fallback = await GuestSession.open(
        File('${directory.path}/fallback-$journey.json'),
      );
      await fallback.selectActor(loser['id'] as String);
      final competitor = CompetingBooking(() async {
        await setup.request(
          '/activities/${raceActivity['id']}/bookings',
          method: 'POST',
          actorId: host['id'] as String,
          key: newId(),
          body: {'platform': 'mobile', 'journeyId': newId()},
        );
      });
      await tester.pumpWidget(
        MaterialApp(
          home: GuestScreen(
            session: fallback,
            api: GuestApi(client: competitor),
            links: const Stream<Uri>.empty(),
          ),
        ),
      );
      await tester.enterText(
        find.widgetWithText(TextField, 'Invitation code'),
        raceCode,
      );
      await tester.tap(find.text('View invitation'));
      await waitFor(tester, find.text(raceActivity['title'] as String));
      await waitFor(tester, find.text('Claim my seat'));
      while (tester
              .widget<FilledButton>(
                find.widgetWithText(FilledButton, 'Claim my seat'),
              )
              .onPressed ==
          null) {
        await tester.pump(const Duration(milliseconds: 200));
      }
      await tester.ensureVisible(find.text('Claim my seat'));
      await tester.tap(find.text('Claim my seat'));
      await waitFor(
        tester,
        find.textContaining('The last spot was just taken.'),
      );
      expect(find.text('Marina gate'), findsOneWidget);
      expect(find.text('Your seat is confirmed'), findsNothing);
      expect(fallback.code, raceCode);
      expect(
        (await setup.ownBooking(
          await setup.preview(raceCode),
          loser['id'] as String,
        )).booking,
        isNull,
      );
      await tester.ensureVisible(find.text('View invitation'));
      await tester.tap(find.text('View invitation'));
      await waitFor(
        tester,
        find.text('The last spot has been taken. This activity is full.'),
      );
      debugPrint(
        'VELIO_LOSING_GUEST_VERIFIED activity=${raceActivity['id']} actor=${loser['id']} journey=${fallback.journeyId}',
      );
      debugPrint(
        'VELIO_GUEST_VERIFIED journey=$journey activity=${activity['id']} actor=$actor booking=${confirmed.booking!['id']} code=$code',
      );
      await tester.pumpWidget(const SizedBox.shrink());
      transport.close();
      competitor.close();
      setup.dispose();
      await file.delete();
      await fallback.file.delete();
    },
  );
}
