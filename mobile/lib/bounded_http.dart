import 'dart:async';

import 'package:http/http.dart' as http;

/// Owns cancellation of each request; an injected client remains caller-owned.
class BoundedHttp {
  BoundedHttp({http.Client? client, this.timeout = const Duration(seconds: 8)})
    : _client = client ?? http.Client(),
      _ownsClient = client == null;
  final http.Client _client;
  final bool _ownsClient;
  final Duration timeout;
  final Set<Completer<void>> _requests = {};
  bool _disposed = false;

  Future<http.Response> send(
    String method,
    Uri uri, {
    Map<String, String>? headers,
    String? body,
  }) async {
    if (_disposed) throw StateError('HTTP transport is closed');
    final abort = Completer<void>();
    _requests.add(abort);
    final timer = Timer(timeout, () {
      if (!abort.isCompleted) abort.complete();
    });
    try {
      final request = http.AbortableRequest(
        method,
        uri,
        abortTrigger: abort.future,
      );
      if (headers != null) request.headers.addAll(headers);
      if (body != null) request.body = body;
      return await (() async => http.Response.fromStream(
        await _client.send(request),
      ))().timeout(timeout);
    } finally {
      timer.cancel();
      if (!abort.isCompleted) abort.complete();
      _requests.remove(abort);
    }
  }

  void dispose() {
    _disposed = true;
    for (final abort in _requests) {
      if (!abort.isCompleted) abort.complete();
    }
    if (_ownsClient) _client.close();
  }
}
