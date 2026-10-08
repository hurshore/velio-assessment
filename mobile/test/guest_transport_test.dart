import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/io_client.dart';
import 'package:velio_mobile/guest_api.dart';

void main() {
  test('timeouts and disposal terminate sockets and leave a caller-owned client usable', () async {
    final server = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
    final disconnected = <Completer<void>>[];
    final sockets = <Socket>[];
    server.listen((socket) {
      sockets.add(socket);
      final done = Completer<void>();
      var sent = false;
      socket.listen(
        (bytes) {
          if (sent) return;
          sent = true;
          if (String.fromCharCodes(bytes).contains('/api/health')) {
            const body =
                '{"data":{"status":"ok"},"requestId":"transport-reference"}';
            socket.write(
              'HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n$body',
            );
            unawaited(socket.flush().then((_) => socket.close()));
          } else {
            disconnected.add(done);
            // Leave the HTTP body incomplete; observe the peer socket rather than server-side response completion.
            socket.write(
              'HTTP/1.1 200 OK\r\nContent-Length: 10000\r\n\r\n{"data":',
            );
          }
        },
        onDone: () {
          if (!done.isCompleted) done.complete();
        },
        onError: (Object _) {
          if (!done.isCompleted) done.complete();
        },
      );
    });
    final client = IOClient();
    final baseUrl = 'http://127.0.0.1:${server.port}';
    final api = GuestApi(
      client: client,
      baseUrl: baseUrl,
      timeout: const Duration(milliseconds: 120),
    );
    addTearDown(() async {
      api.dispose();
      client.close();
      for (final socket in sockets) {
        socket.destroy();
      }
      await server.close();
    });
    for (var i = 0; i < 3; i++) {
      await expectLater(api.request('/ready'), throwsA(isA<Exception>()));
      await disconnected.last.future.timeout(const Duration(seconds: 2));
    }
    final disposed = GuestApi(client: client, baseUrl: baseUrl);
    final pending = disposed.request('/ready');
    final failed = expectLater(pending, throwsA(isA<Exception>()));
    while (disconnected.length < 4) {
      await Future<void>.delayed(const Duration(milliseconds: 10));
    }
    disposed.dispose();
    await failed;
    await disconnected.last.future.timeout(const Duration(seconds: 2));
    final response = await client.get(Uri.parse('$baseUrl/api/health'));
    expect(response.statusCode, 200);
  });
}
