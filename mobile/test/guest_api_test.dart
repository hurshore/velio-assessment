import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:velio_mobile/guest_api.dart';
import 'package:velio_mobile/guest_screen.dart';
import 'package:velio_mobile/readiness.dart';

import 'guest_journey_test.dart' show preview, code;

void main() {
  test(
    'malformed API envelopes and unknown timezones report unexpected responses',
    () async {
      for (final body in [
        'not json',
        jsonEncode({'data': preview()}),
        jsonEncode({
          'requestId': 'test',
          'data': {
            ...preview(),
            'activity': {
              ...preview()['activity'] as Map,
              'timezone': 'Mars/Olympus',
            },
          },
        }),
      ]) {
        final client = MockClient((_) async => http.Response(body, 200));
        final api = GuestApi(client: client);
        try {
          await api.preview(code);
          fail('Malformed preview must be rejected');
        } catch (error) {
          expect(error, isA<FormatException>());
          expect(failureMessage(error), unexpectedResponseMessage);
        } finally {
          api.dispose();
          client.close();
        }
      }
    },
  );
  test('transport failure reports connectivity separately from malformed responses', () async {
    final client = MockClient(
      (_) async => throw http.ClientException('Offline'),
    );
    final api = GuestApi(client: client);
    try {
      await api.preview(code);
      fail('Disconnected request must fail');
    } catch (error) {
      expect(failureMessage(error), connectionErrorMessage);
    } finally {
      api.dispose();
      client.close();
    }
  });
}
