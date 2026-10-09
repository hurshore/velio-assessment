import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:velio_mobile/guest_host.dart';

import 'guest_journey_test.dart' show settle;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
          const MethodChannel('com.llfbandit.app_links/events'),
          (_) async => null,
        );
  });

  testWidgets(
    'invalid saved data uses restore UI without deleting recovery data',
    (tester) async {
      final directory = (await tester.runAsync(
        () => Directory.systemTemp.createTemp('velio-restore-'),
      ))!;
      addTearDown(() => directory.delete(recursive: true));
      final file = File('${directory.path}/guest.json');
      final original = jsonEncode({
        'code': 1,
        'claimKeys': {'original': 'keep'},
      });
      await tester.runAsync(() => file.writeAsString(original));
      await tester.runAsync(() async {
        await tester.pumpWidget(
          MaterialApp(home: GuestHost(sessionFile: file)),
        );
        await Future<void>.delayed(const Duration(milliseconds: 100));
      });
      await settle(tester);
      expect(tester.takeException(), isNull);
      expect(find.textContaining('contains invalid data'), findsOneWidget);
      expect(find.text('View invitation'), findsNothing);
      expect(await tester.runAsync(() => file.readAsString()), original);
      await tester.runAsync(() async {
        await tester.tap(find.text('Retry saved session'));
      });
      await settle(tester);
      expect(find.textContaining('contains invalid data'), findsOneWidget);
      expect(await tester.runAsync(() => file.readAsString()), original);
      // Repairing the file, rather than resetting it in the app, permits restoration.
      await tester.runAsync(() async {
        await file.writeAsString('{}');
        await tester.tap(find.text('Retry saved session'));
      });
      await settle(tester);
      expect(find.text('View invitation'), findsOneWidget);
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );

  testWidgets(
    'storage read failure is distinguished from invalid session data',
    (tester) async {
      final directory = (await tester.runAsync(
        () => Directory.systemTemp.createTemp('velio-read-'),
      ))!;
      addTearDown(() => directory.delete(recursive: true));
      await tester.runAsync(() async {
        await tester.pumpWidget(
          MaterialApp(home: GuestHost(sessionFile: UnreadableFile())),
        );
        await Future<void>.delayed(const Duration(milliseconds: 100));
      });
      await settle(tester);
      expect(
        find.textContaining('Could not read your saved guest session'),
        findsOneWidget,
      );
      expect(find.textContaining('contains invalid data'), findsNothing);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );
}

class UnreadableFile extends Fake implements File {
  @override
  Future<bool> exists() async => true;
  @override
  Future<Uint8List> readAsBytes() async =>
      throw const FileSystemException('Storage temporarily unavailable');
}
