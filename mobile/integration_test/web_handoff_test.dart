import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path_provider/path_provider.dart';
import 'package:velio_mobile/guest_api.dart';
import 'package:velio_mobile/guest_screen.dart';
import 'package:velio_mobile/guest_session.dart';
import 'package:velio_mobile/velio_theme.dart';

import 'live_guest_test.dart' show InterruptedTransport, enabled;
import 'public_guest_test.dart' show waitFor;

// Create/book/share two fresh two-seat activities on web before running this test.
// Their hosts must be marked synthetic/test so these signups inherit that cohort.
void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets('web-created invitations fill their last seat in native Flutter', (
    tester,
  ) async {
    final setup = GuestApi();
    addTearDown(setup.dispose);
    final directory = await getApplicationSupportDirectory();
    for (final fixture in [
      ('vouch', const String.fromEnvironment('HANDOFF_VOUCH_CODE')),
      ('public', const String.fromEnvironment('HANDOFF_PUBLIC_CODE')),
    ]) {
      final (rail, code) = fixture;
      expect(
        isCode(code),
        true,
        reason: 'Supply fresh HANDOFF_${rail.toUpperCase()}_CODE',
      );
      final preview = await setup.preview(code);
      expect(preview.rail, rail);
      expect(preview.availability.remainingSeats, 1);
      final file = File('${directory.path}/web-handoff-${newId()}.json');
      final session = await GuestSession.open(file);
      final transport = InterruptedTransport();
      final api = GuestApi(client: transport);
      addTearDown(() async {
        api.dispose();
        transport.close();
        if (await file.exists()) await file.delete();
      });
      Future<void> launch() async => tester.pumpWidget(
        MaterialApp(
          theme: VelioTheme.theme,
          debugShowCheckedModeBanner: false,
          home: GuestScreen(
            session: session,
            api: api,
            links: const Stream.empty(),
          ),
        ),
      );
      await launch();
      await tester.enterText(
        find.widgetWithText(TextField, 'Invitation code'),
        code,
      );
      await tester.ensureVisible(find.text('View invitation'));
      await tester.tap(find.text('View invitation'));
      await waitFor(tester, find.text(preview.activity['title'] as String));
      await tester.pump(const Duration(milliseconds: 300));
      await binding.takeScreenshot('$rail-preview');
      await tester.ensureVisible(find.text('Choose demo identity'));
      await tester.tap(find.text('Choose demo identity'));
      await waitFor(tester, find.text('Create demo identity'));
      await tester.enterText(
        find.widgetWithText(TextField, 'Your display name'),
        'Web handoff $rail guest',
      );
      if (rail == 'vouch') {
        await tester.enterText(
          find.widgetWithText(TextField, 'Your demo contact (optional)'),
          const String.fromEnvironment('HANDOFF_VOUCH_CONTACT'),
        );
      }
      await enabled(tester, 'Create demo identity');
      await tester.tap(find.text('Create demo identity'));
      await enabled(tester, 'Claim my seat');
      await tester.tap(find.text('Claim my seat'));
      await waitFor(tester, find.text('Your seat is confirmed'));
      await tester.ensureVisible(find.text('Your seat is confirmed'));
      await tester.pump(const Duration(milliseconds: 300));
      await binding.takeScreenshot('$rail-confirmed');
      final confirmed = await setup.ownBooking(preview, session.actorId!);
      expect(confirmed.availability.remainingSeats, 0);
      expect(confirmed.availability.confirmedCount, 2);
      expect(transport.keys, hasLength(1));
      await tester.pumpWidget(const SizedBox.shrink());
      await launch();
      await waitFor(tester, find.text('Your seat is confirmed'));
      await tester.ensureVisible(find.text('Your seat is confirmed'));
      await tester.pump(const Duration(milliseconds: 300));
      await binding.takeScreenshot('$rail-recovered');
      expect(
        (await setup.ownBooking(preview, session.actorId!)).booking!['id'],
        confirmed.booking!['id'],
      );
      expect(transport.keys, hasLength(1));
      debugPrint(
        'VELIO_WEB_HANDOFF_VERIFIED rail=$rail code=$code activity=${preview.activityId} journey=${session.journeyId} actor=${session.actorId} booking=${confirmed.booking!['id']}',
      );
      await tester.pumpWidget(const SizedBox.shrink());
    }
  });
}
