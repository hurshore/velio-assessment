import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:velio_mobile/main.dart' as app;

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets('status screen completes a real API readiness roundtrip', (
    tester,
  ) async {
    await tester.pumpWidget(const app.VelioApp(showConnection: true));
    await tester.pumpAndSettle(const Duration(milliseconds: 100));
    final deadline = DateTime.now().add(const Duration(seconds: 10));
    while (find.text('API connected').evaluate().isEmpty &&
        DateTime.now().isBefore(deadline)) {
      await tester.pump(const Duration(milliseconds: 200));
    }
    expect(find.text('API connected'), findsOneWidget);
    expect(find.text('PostgreSQL and Redis are ready.'), findsOneWidget);
    final reference = tester
        .widget<Text>(find.textContaining('Request: '))
        .data!;
    expect(reference, matches(RegExp(r'^Request: [0-9a-f-]{36}$')));
    debugPrint(
      'Verified simulator API roundtrip at ${app.apiBaseUrl}; $reference',
    );
  });
}
