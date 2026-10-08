# Velio guest foundation

Use Flutter 3.47.6 / Dart 3.13.5; dependencies are pinned in `pubspec.yaml` and `pubspec.lock`. This app shows a real API readiness request with loading, success, dependency failure, and network error/retry states.

See the [root setup guide](../README.md) for API startup and simulator/device URLs. Run `flutter pub get --enforce-lockfile`, `flutter analyze`, and `flutter test` here. For the actual simulator roundtrip, start the API and dependencies, then:

```sh
flutter test integration_test/api_roundtrip_test.dart -d <ios-simulator-id> --dart-define=API_BASE_URL=http://127.0.0.1:3000
```

`flutter run -d <device-id> --dart-define=API_BASE_URL=<url>` launches the status screen. Android emulator uses `http://10.0.2.2:3000`; physical phones use the development machine's LAN address. Local HTTP exceptions are in Debug configurations only. Release devices require HTTPS and your own signing configuration.
