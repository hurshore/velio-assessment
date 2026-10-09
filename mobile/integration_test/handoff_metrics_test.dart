import 'dart:convert';
import 'dart:io';

import 'package:app_links/app_links.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path_provider/path_provider.dart';
import 'package:velio_mobile/guest_api.dart';
import 'package:velio_mobile/guest_screen.dart';
import 'package:velio_mobile/guest_session.dart';

import 'live_guest_test.dart' show InterruptedTransport, enabled;
import 'public_guest_test.dart' show waitFor;

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets('both native entry methods and rails feed the real metric queries', (
    tester,
  ) async {
    final setup = GuestApi();
    addTearDown(setup.dispose);
    final cohort = newId();
    final host = object(
      await setup.request(
        '/identities',
        method: 'POST',
        body: {
          'displayName': 'Handoff test host $cohort',
          'journeyId': newId(),
          'platform': 'web',
          'test': true,
        },
      ),
    );
    Future<Map<String, dynamic>> activity(
      String title,
      DateTime starts,
    ) async => object(
      await setup.request(
        '/activities',
        method: 'POST',
        actorId: host['id'] as String,
        body: {
          'title': title,
          'description': 'Labelled #12 native analytics verification',
          'meetingLocation': 'Marina gate',
          'startsAt': utcTimestamp(starts),
          'timezone': 'Africa/Lagos',
          'capacity': 2,
          'priceMinor': 2500,
          'currency': 'NGN',
        },
      ),
    );
    // Establish the inviter's eligibility before the fixed K cohort starts.
    await activity(
      'K cohort qualifier $cohort',
      DateTime.now().add(const Duration(days: 2)),
    );
    final from = utcTimestamp(DateTime.now());
    final directory = await getApplicationSupportDirectory();
    final files = <File>[];
    addTearDown(() async {
      for (final file in files) {
        if (await file.exists()) await file.delete();
      }
    });
    Future<GuestSession> session() async {
      final file = File('${directory.path}/handoff-${newId()}.json');
      files.add(file);
      return GuestSession.open(file);
    }

    Future<Map<String, dynamic>> report(
      String kind, {
      bool includeTest = true,
    }) async => object(
      await setup.request(
        '/metrics/$kind?${Uri(queryParameters: {'from': from, 'to': utcTimestamp(DateTime.now()), 'includeTest': '$includeTest'}).query}',
      ),
    );
    Future<void> checkpoint(String stage) async {
      final product = await report('product');
      final summary = await report('summary');
      debugPrint(
        'VELIO_HANDOFF_METRICS ${jsonEncode({'cohort': cohort, 'stage': stage, 'product': product, 'bookings': summary['bookings'], 'integrity': summary['integrity']})}',
      );
    }

    var completed = 0;
    DateTime? lastStart;
    final nativeLinks = AppLinks();
    for (final rail in ['public', 'vouch']) {
      for (final entry in ['link', 'code']) {
        final journey = newId();
        final contact = 'handoff-$journey@example.com';
        final starts = DateTime.now().add(const Duration(minutes: 3));
        lastStart = starts;
        late Map<String, dynamic> detail;
        for (var attempt = 0; attempt < 30; attempt++) {
          detail = await activity('Handoff $rail $entry $journey', starts);
          if (object(detail['assignment'])['variant'] == 'treatment') break;
        }
        expect(object(detail['assignment'])['variant'], 'treatment');
        await setup.request(
          '/activities/${detail['id']}/bookings',
          method: 'POST',
          actorId: host['id'] as String,
          key: newId(),
          body: {'platform': 'web', 'journeyId': newId()},
        );
        Future<Map<String, dynamic>> invite() async => object(
          await setup.request(
            '/activities/${detail['id']}/invites',
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
        final original = await invite();
        final alternate = await invite();
        final code = original['code'] as String;
        final transport = InterruptedTransport();
        final api = GuestApi(client: transport);
        addTearDown(() {
          api.dispose();
          transport.close();
        });
        var current = await session();
        Future<void> launch() async {
          await tester.pumpWidget(
            MaterialApp(
              home: GuestScreen(
                session: current,
                api: api,
                links: nativeLinks.uriLinkStream,
              ),
            ),
          );
        }

        await launch();
        if (entry == 'link') {
          debugPrint('VELIO_LINK_READY=velio://invite/$code?journey=$journey');
        } else {
          await tester.enterText(
            find.widgetWithText(TextField, 'Invitation code'),
            code,
          );
          await tester.tap(find.text('View invitation'));
        }
        await waitFor(
          tester,
          find.text(detail['title'] as String),
          timeout: const Duration(seconds: 45),
        );
        if (entry == 'link') expect(current.journeyId, journey);
        await tester.ensureVisible(find.text('Choose demo identity'));
        await tester.tap(find.text('Choose demo identity'));
        await waitFor(tester, find.text('Create demo identity'));
        await tester.enterText(
          find.widgetWithText(TextField, 'Your display name'),
          'Handoff guest $journey',
        );
        if (rail == 'vouch') {
          await tester.enterText(
            find.widgetWithText(TextField, 'Your demo contact (optional)'),
            contact,
          );
        }
        await enabled(tester, 'Create demo identity');
        await tester.tap(find.text('Create demo identity'));
        await enabled(tester, 'Claim my seat');
        await tester.tap(find.text('Claim my seat'));
        await waitFor(tester, find.text('Your seat is confirmed'));
        final actor = current.actorId!;
        final preview = await setup.preview(code);
        final booking = (await setup.ownBooking(preview, actor)).booking!;
        completed++;
        await checkpoint('$rail/$entry committed-response-recovery');
        final before = await report('product');
        expect(object(before['openToClaim'])['notYetMature'], {
          'openedJourneys': completed,
          'convertedJourneys': completed,
        });
        final open = transport.events.firstWhere(
          (event) => event['name'] == 'invite_opened',
        );
        expect(
          object(
            await setup.request('/events', method: 'POST', body: open),
          )['accepted'],
          false,
        );
        final retry = await setup.claim(
          preview,
          actor,
          current.journeyId!,
          transport.keys.single,
        );
        expect(retry.booking!['id'], booking['id']);
        expect(retry.replayed, true);
        // A repeated render keeps the original anonymous journey's acquisition unit.
        await tester.pumpWidget(const SizedBox.shrink());
        await launch();
        await waitFor(tester, find.text('Your seat is confirmed'));
        // Fresh confirmation journeys, including another code, must remain recovery traffic.
        for (final recoveryCode in [code, alternate['code'] as String]) {
          await tester.pumpWidget(const SizedBox.shrink());
          current = await session();
          await current.enter(recoveryCode);
          await current.selectActor(actor);
          await launch();
          await waitFor(tester, find.text('Your seat is confirmed'));
        }
        await tester.pumpWidget(const SizedBox.shrink());
        final after = await report('product');
        expect(
          object(after['openToClaim'])['notYetMature'],
          object(before['openToClaim'])['notYetMature'],
        );
        for (final field in [
          'cohort',
          'byRail',
          'newUsersByGeneration',
          'status',
        ]) {
          expect(
            object(after['kFactor'])[field],
            object(before['kFactor'])[field],
          );
        }
        expect(after['bookersInvite'], before['bookersInvite']);
        expect(after['holdout'], before['holdout']);
        final summary = await report('summary');
        expect(
          object(object(summary['bookings'])['rawOutcomes'])['committed'],
          completed * 2,
        );
        expect(object(summary['integrity'])['violatingActivities'], 0);
        final state = object(
          await setup.request('/activities/${detail['id']}'),
        );
        expect(state['confirmedCount'], 2);
        expect((state['participants'] as List).length, 2);
        await checkpoint('$rail/$entry replay-and-reopens');
        debugPrint(
          'VELIO_HANDOFF_TRACE ${jsonEncode({'cohort': cohort, 'rail': rail, 'entry': entry, 'journey': open['journeyId'], 'activity': detail['id'], 'actor': actor, 'booking': booking['id'], 'invite': original['id'], 'code': code})}',
        );
      }
    }
    // Wait for the real activity-start deadlines; no clock rewriting or future report cutoff.
    while (DateTime.now().isBefore(
      lastStart!.add(const Duration(seconds: 1)),
    )) {
      await tester.pump(const Duration(seconds: 1));
    }
    final product = await report('product');
    final opens = object(product['openToClaim']);
    expect(object(opens['headline'])['openedJourneys'], 4);
    expect(object(opens['headline'])['convertedJourneys'], 4);
    expect(opens['byRail'], {
      'public': {'opened': 2, 'converted': 2},
      'vouch': {'opened': 2, 'converted': 2},
    });
    expect(object(opens['reasons'])['recoveryOpens'], 8);
    expect(opens['byPlatform'], {
      'mobile': {'opened': 4, 'converted': 4},
    });
    expect(opens['status'], 'insufficient_sample');
    final k = object(product['kFactor']);
    for (final rail in ['public', 'vouch']) {
      expect(object(object(k['byRail'])[rail])['acquired'], 2);
      expect(object(object(k['byRail'])[rail])['activated'], 2);
    }
    expect(k['status'], 'partial_window');
    expect(object(product['bookersInvite'])['notYetMature'], {
      'qualifyingBookers': 5,
      'invitedWithin24h': 1,
    });
    expect(
      object(
        (await report('product', includeTest: false))['openToClaim'],
      )['status'],
      'no_data',
    );
    expect(
      object(
        object(
          (await report('summary', includeTest: false))['bookings'],
        )['rawOutcomes'],
      )['committed'],
      0,
    );
    await checkpoint('mature-real-clock');
  }, timeout: const Timeout(Duration(minutes: 12)));
}
