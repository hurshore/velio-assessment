import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:velio_mobile/guest_api.dart';
import 'package:velio_mobile/guest_screen.dart';
import 'package:velio_mobile/guest_session.dart';
import 'package:velio_mobile/velio_theme.dart';

void main() {
  testWidgets(
    'code entry stays usable with a narrow screen and keyboard, retaining invalid input',
    (tester) async {
      tester.view.physicalSize = const Size(320, 568);
      tester.view.devicePixelRatio = 1;
      tester.view.viewInsets = const FakeViewPadding(bottom: 250);
      addTearDown(tester.view.reset);
      final directory = (await tester.runAsync(
        () => Directory.systemTemp.createTemp('guest-layout-'),
      ))!;
      final session = (await tester.runAsync(
        () => GuestSession.open(File('${directory.path}/session.json')),
      ))!;
      final api = GuestApi();
      addTearDown(() {
        api.dispose();
        directory.deleteSync(recursive: true);
      });
      await tester.pumpWidget(
        MaterialApp(
          theme: VelioTheme.theme,
          home: GuestScreen(
            session: session,
            api: api,
            links: const Stream.empty(),
          ),
        ),
      );
      expect(find.text('Good company is one invitation away.'), findsOneWidget);
      await tester.enterText(
        find.widgetWithText(TextField, 'Invitation code'),
        'KEPT-CODE',
      );
      await tester.ensureVisible(find.text('View invitation'));
      await tester.tap(find.text('View invitation'));
      await tester.pump();
      expect(find.textContaining('Enter a valid 12-character'), findsOneWidget);
      expect(
        tester
            .widget<TextField>(
              find.widgetWithText(TextField, 'Invitation code'),
            )
            .controller!
            .text,
        'KEPT-CODE',
      );
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );
}
