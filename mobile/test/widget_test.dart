import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:velio_mobile/main.dart';

void main() {
  testWidgets('shows readiness and request reference after an API roundtrip', (
    tester,
  ) async {
    final client = MockClient(
      (request) async => http.Response(
        '{"data":{"status":"ok","dependencies":{"postgres":"ok","redis":"ok"}},"requestId":"mobile-roundtrip"}',
        200,
      ),
    );
    await tester.pumpWidget(VelioApp(client: client));
    expect(find.text('Checking API connection…'), findsOneWidget);
    await tester.pumpAndSettle();
    expect(find.text('API connected'), findsOneWidget);
    expect(find.text('PostgreSQL and Redis are ready.'), findsOneWidget);
    expect(find.text('Request: mobile-roundtrip'), findsOneWidget);
    await tester.pumpWidget(const SizedBox.shrink());
    client.close();
  });

  testWidgets('shows a connection error and recovers after retry', (
    tester,
  ) async {
    var fail = true;
    final client = MockClient((request) async {
      if (fail) throw http.ClientException('Connection refused');
      return http.Response(
        '{"data":{"status":"ok","dependencies":{"postgres":"ok","redis":"ok"}},"requestId":"retry-success"}',
        200,
      );
    });
    await tester.pumpWidget(VelioApp(client: client));
    await tester.pumpAndSettle();
    expect(
      find.text(
        'Could not connect to the API. Check your connection and retry.',
      ),
      findsOneWidget,
    );
    fail = false;
    await tester.tap(find.text('Retry connection'));
    await tester.pumpAndSettle();
    expect(find.text('API connected'), findsOneWidget);
    await tester.pumpWidget(const SizedBox.shrink());
    client.close();
  });

  testWidgets('shows dependency unavailability without claiming readiness', (
    tester,
  ) async {
    final client = MockClient(
      (request) async => http.Response(
        '{"error":{"code":"DEPENDENCIES_UNAVAILABLE","message":"Unavailable","retryable":true},"requestId":"outage-reference"}',
        503,
      ),
    );
    await tester.pumpWidget(VelioApp(client: client));
    await tester.pumpAndSettle();
    expect(
      find.text(
        'The API is running, but its dependencies are unavailable. Please retry.',
      ),
      findsOneWidget,
    );
    expect(find.text('API connected'), findsNothing);
    expect(find.text('Request: outage-reference'), findsOneWidget);
    await tester.pumpWidget(const SizedBox.shrink());
    client.close();
  });
}
