import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:velio_mobile/main.dart';

void main() {
  final diagnostics = <String>[];
  void statusTest(String name, Future<void> Function(WidgetTester) body) {
    testWidgets(name, (tester) async {
      final previous = debugPrint;
      diagnostics.clear();
      debugPrint = (message, {wrapWidth}) {
        if (message != null) diagnostics.add(message);
      };
      try {
        await body(tester);
      } finally {
        debugPrint = previous;
      }
    });
  }

  statusTest('shows readiness and request reference after an API roundtrip', (
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

  statusTest('shows a connection error and recovers after retry', (
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

  statusTest('shows dependency unavailability without claiming readiness', (
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

  final fixtures = jsonDecode(
    File('../docs/contracts/readiness-fixtures.json').readAsStringSync(),
  ) as List<dynamic>;
  for (final fixture in fixtures) {
    statusTest('shared contract: ${fixture['name']}', (tester) async {
      final client = MockClient(
        (request) async => http.Response(
          jsonEncode(fixture['body']),
          fixture['status'] as int,
        ),
      );
      await tester.pumpWidget(VelioApp(client: client));
      await tester.pumpAndSettle();
      expect(find.text(fixture['message'] as String), findsOneWidget);
      expect(find.text('API connected'), findsNothing);
      if ((fixture['message'] as String).contains('unexpected')) {
        expect(find.textContaining('Request: '), findsNothing);
      }
      await tester.pumpWidget(const SizedBox.shrink());
      client.close();
    });
  }

  statusTest('same-frame retry taps cannot overlap checks', (tester) async {
    var calls = 0;
    final pending = Completer<http.Response>();
    final client = MockClient((request) async {
      calls++;
      if (calls == 1) throw http.ClientException('First request failed');
      return pending.future;
    });
    await tester.pumpWidget(VelioApp(client: client));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Retry connection'));
    await tester.tap(find.text('Retry connection'));
    pending.complete(
      http.Response(
        '{"data":{"status":"ok","dependencies":{"postgres":"ok","redis":"ok"}},"requestId":"current"}',
        200,
      ),
    );
    await tester.pumpAndSettle();
    expect(calls, 2);
    expect(find.text('API connected'), findsOneWidget);
    await tester.pumpWidget(const SizedBox.shrink());
    client.close();
  });

  statusTest('a timed-out response cannot overwrite a successful retry', (
    tester,
  ) async {
    var calls = 0;
    final oldRequest = Completer<http.Response>();
    final client = MockClient((request) async {
      calls++;
      if (calls == 1) return oldRequest.future;
      return http.Response(
        '{"data":{"status":"ok","dependencies":{"postgres":"ok","redis":"ok"}},"requestId":"current"}',
        200,
      );
    });
    await tester.pumpWidget(VelioApp(client: client));
    await tester.pump();
    await tester.pump(const Duration(seconds: 6));
    await tester.pumpAndSettle();
    expect(find.text('Retry connection'), findsOneWidget);
    expect(
      diagnostics.any((message) => message.contains('TimeoutException')),
      isTrue,
    );
    await tester.tap(find.text('Retry connection'));
    await tester.pumpAndSettle();
    oldRequest.complete(
      http.Response(
        '{"error":{"code":"DEPENDENCIES_UNAVAILABLE","message":"Unavailable","retryable":true},"requestId":"old"}',
        503,
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('API connected'), findsOneWidget);
    expect(find.text('Request: current'), findsOneWidget);
    expect(find.text('Connection unavailable'), findsNothing);
    await tester.pumpWidget(const SizedBox.shrink());
    client.close();
  });

  statusTest(
    'non-JSON errors preserve debug context and show a contract error',
    (tester) async {
      final client = MockClient(
        (request) async => http.Response('<html>Proxy failed</html>', 502),
      );
      await tester.pumpWidget(VelioApp(client: client));
      await tester.pumpAndSettle();
      expect(
        find.text('The API returned an unexpected response. Please retry.'),
        findsOneWidget,
      );
      expect(
        diagnostics.any(
          (message) =>
              message.contains('FormatException') &&
              message.contains('API readiness failed'),
        ),
        isTrue,
      );
      await tester.pumpWidget(const SizedBox.shrink());
      client.close();
    },
  );
}
