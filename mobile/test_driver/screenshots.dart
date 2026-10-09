import 'dart:io';

import 'package:integration_test/integration_test_driver_extended.dart';

Future<void> main() async {
  final output = Directory(
    Platform.environment['VELIO_SCREENSHOT_DIR'] ?? 'build/review-screenshots',
  );
  await output.create(recursive: true);
  await integrationDriver(
    onScreenshot: (name, bytes, [arguments]) async {
      await File('${output.path}/$name.png').writeAsBytes(bytes);
      return true;
    },
    responseDataCallback: null,
  );
}
