const connectionErrorMessage =
    'Could not connect to the API. Check your connection and retry.';
const unexpectedResponseMessage =
    'The API returned an unexpected response. Please retry.';
const _dependencyErrorMessage =
    'The API is running, but its dependencies are unavailable. Please retry.';

class Readiness {
  const Readiness(this.requestId, this.error);
  final String requestId;
  final String? error;
}

bool _text(Object? value) => value is String && value.trim().isNotEmpty;

Readiness parseReadiness(int status, Object? body) {
  if (body is! Map<String, dynamic> || !_text(body['requestId'])) {
    throw const FormatException('Invalid response envelope');
  }
  if (status == 200) {
    final data = body['data'];
    if (data is! Map<String, dynamic> || data['status'] != 'ok') {
      throw const FormatException('Invalid readiness payload');
    }
    final dependencies = data['dependencies'];
    if (dependencies is! Map<String, dynamic> ||
        dependencies['postgres'] != 'ok' ||
        dependencies['redis'] != 'ok') {
      throw const FormatException('Invalid readiness dependencies');
    }
    return Readiness(body['requestId'] as String, null);
  }
  final error = body['error'];
  if (status < 400 ||
      error is! Map<String, dynamic> ||
      !_text(error['code']) ||
      !_text(error['message']) ||
      error['retryable'] is! bool) {
    throw const FormatException('Invalid error envelope');
  }
  return Readiness(
    body['requestId'] as String,
    error['code'] == 'DEPENDENCIES_UNAVAILABLE'
        ? _dependencyErrorMessage
        : connectionErrorMessage,
  );
}
