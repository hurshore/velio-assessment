import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:integration_test/integration_test.dart';
import 'package:path_provider/path_provider.dart';
import 'package:velio_mobile/guest_api.dart';
import 'package:velio_mobile/guest_live.dart';
import 'package:velio_mobile/guest_screen.dart';
import 'package:velio_mobile/guest_session.dart';

import 'public_guest_test.dart' as helpers;

class InterruptedTransport extends http.BaseClient {
  final delegate = http.Client();
  bool offline = false, loseClaim = true;
  final events = <Map<String, dynamic>>[];
  final keys = <String>[];
  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    if (offline) throw http.ClientException('Integration: offline');
    if (request.url.path.endsWith('/events') && request is http.Request) {
      events.add(jsonDecode(request.body) as Map<String, dynamic>);
    }
    final response = await delegate.send(request);
    if (request.url.path.endsWith('/claims')) {
      keys.add(request.headers['Idempotency-Key']!);
      if (loseClaim) {
        loseClaim = false;
        await response.stream.drain<void>();
        throw http.ClientException('Integration: lost committed response');
      }
    }
    return response;
  }

  @override
  void close() => delegate.close();
}

Future<void> enabled(WidgetTester tester, String title) async {
  await helpers.waitFor(tester, find.text(title));
  final deadline = DateTime.now().add(const Duration(seconds: 12));
  while (tester
              .widget<FilledButton>(find.widgetWithText(FilledButton, title))
              .onPressed ==
          null &&
      DateTime.now().isBefore(deadline)) {
    await tester.pump(const Duration(milliseconds: 100));
  }
  expect(
    tester
        .widget<FilledButton>(find.widgetWithText(FilledButton, title))
        .onPressed,
    isNotNull,
  );
  await tester.ensureVisible(find.text(title));
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'both rails converge live, recover a lost claim, persist offline confirmation and resume',
    (tester) async {
      final setup = GuestApi();
      addTearDown(setup.dispose);
      final directory = await getApplicationSupportDirectory();
      for (final rail in ['public', 'vouch']) {
        final journey = newId();
        final contact = 'mobile-$journey@example.com';
        final host = object(
          await setup.request(
            '/identities',
            method: 'POST',
            body: {
              'displayName': 'Live host $journey',
              'journeyId': newId(),
              'platform': 'web',
              'test': true,
            },
          ),
        );
        final activity = await helpers.treatmentActivity(
          setup,
          host['id'] as String,
          '$rail live supper $journey',
        );
        final invite = object(
          await setup.request(
            '/activities/${activity['id']}/invites',
            method: 'POST',
            actorId: host['id'] as String,
            body: {
              'rail': rail,
              if (rail == 'vouch') 'recipientContact': contact,
              'platform': 'web',
              'journeyId': newId(),
            },
          ),
        );
        final code = invite['code'] as String;
        final file = File('${directory.path}/live-$journey.json');
        var session = await GuestSession.open(file);
        await session.enter(code, linkedJourney: journey);
        final transport = InterruptedTransport();
        final api = GuestApi(client: transport);
        addTearDown(() {
          api.dispose();
          transport.close();
        });
        Future<LiveSocket> connection(Uri uri) async {
          if (transport.offline) {
            throw const SocketException('Integration: offline');
          }
          return connectLive(uri);
        }

        Future<void> launch() async {
          await tester.pumpWidget(
            MaterialApp(
              home: GuestScreen(
                session: session,
                api: api,
                links: const Stream.empty(),
                liveConnect: connection,
              ),
            ),
          );
          await helpers.waitFor(tester, find.text(activity['title'] as String));
        }

        await launch();
        await helpers.waitFor(
          tester,
          find.text('Live availability connected.'),
        );
        await tester.ensureVisible(find.text('Choose demo identity'));
        await tester.tap(find.text('Choose demo identity'));
        await helpers.waitFor(tester, find.text('Create demo identity'));
        final displayName = 'Live guest $journey';
        await tester.enterText(
          find.widgetWithText(TextField, 'Your display name'),
          displayName,
        );
        if (rail == 'vouch') {
          // A missing contact cannot create a vouch-acquired identity, and the entered name remains.
          await enabled(tester, 'Create demo identity');
          await tester.tap(find.text('Create demo identity'));
          await helpers.waitFor(
            tester,
            find.textContaining('This vouch is for one intended contact.'),
          );
          expect(session.actorId, isNull);
          expect(
            tester
                .widget<TextField>(
                  find.widgetWithText(TextField, 'Your display name'),
                )
                .controller!
                .text,
            displayName,
          );
          await tester.enterText(
            find.widgetWithText(TextField, 'Your demo contact (optional)'),
            contact.toUpperCase(),
          );
        }
        await enabled(tester, 'Create demo identity');
        await tester.tap(find.text('Create demo identity'));
        await enabled(tester, 'Claim my seat');
        await tester.tap(find.text('Claim my seat'));
        await helpers.waitFor(tester, find.text('Your seat is confirmed'));
        await helpers.waitFor(tester, find.text(displayName));
        expect(transport.keys, hasLength(1));
        final actor = session.actorId!;
        final confirmed = await setup.ownBooking(
          await setup.preview(code),
          actor,
        );
        expect(confirmed.availability.remainingSeats, 0);
        expect(session.hasPendingClaim(actor, code), false);
        final open = transport.events.firstWhere(
          (event) => event['name'] == 'invite_opened',
        );
        expect(open['journeyId'], journey);
        expect(
          object(
            await setup.request('/events', method: 'POST', body: open),
          )['accepted'],
          false,
        );
        // Background teardown makes the client ineligible for foreground delivery expectations.
        tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.inactive,
        );
        await tester.pump();
        expect(find.textContaining('Saved/offline details'), findsOneWidget);
        tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
        tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
        await Future<void>.delayed(const Duration(milliseconds: 100));
        tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
        tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.inactive,
        );
        tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.resumed,
        );
        await helpers.waitFor(
          tester,
          find.text('Live availability connected.'),
        );
        await tester.pumpWidget(const SizedBox.shrink());
        transport.offline = true;
        session = await GuestSession.open(file);
        await launch();
        await helpers.waitFor(tester, find.text('Your seat is confirmed'));
        expect(find.textContaining('Saved/offline details'), findsOneWidget);
        expect(find.text(displayName), findsOneWidget);
        transport.offline = false;
        await helpers.waitFor(
          tester,
          find.text('Live availability connected.'),
        );
        expect(
          (await setup.ownBooking(
            await setup.preview(code),
            actor,
          )).booking!['id'],
          confirmed.booking!['id'],
        );
        expect(transport.keys, hasLength(1));
        debugPrint(
          'VELIO_LIVE_GUEST_VERIFIED rail=$rail journey=$journey activity=${activity['id']} actor=$actor booking=${confirmed.booking!['id']} code=$code',
        );
        await tester.pumpWidget(const SizedBox.shrink());
        await file.delete();
      }
    },
  );
}
