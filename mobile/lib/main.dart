import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

import 'readiness.dart';
import 'api_config.dart';
export 'api_config.dart' show apiBaseUrl;
import 'guest_host.dart';
import 'velio_theme.dart';
import 'bounded_http.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const VelioApp());
}

class VelioApp extends StatelessWidget {
  const VelioApp({super.key, this.client, this.showConnection = false});
  final bool showConnection;
  final http.Client? client;

  @override
  Widget build(BuildContext context) => MaterialApp(
    title: 'Velio',
    theme: VelioTheme.theme,
    debugShowCheckedModeBanner: false,
    home: showConnection ? ConnectionScreen(client: client) : const GuestHost(),
  );
}

class ConnectionScreen extends StatefulWidget {
  const ConnectionScreen({super.key, this.client});
  final http.Client? client;

  @override
  State<ConnectionScreen> createState() => _ConnectionScreenState();
}

class _ConnectionScreenState extends State<ConnectionScreen> {
  late final BoundedHttp _transport;
  String? _requestId;
  bool _loading = true;
  bool _checking = false;
  int _attempt = 0;
  String? _error;

  @override
  void initState() {
    super.initState();
    _transport = BoundedHttp(
      client: widget.client,
      timeout: const Duration(seconds: 5),
    );
    _checkConnection();
  }

  Future<void> _checkConnection() async {
    if (_checking) return;
    _checking = true;
    final attempt = ++_attempt;
    setState(() {
      _loading = true;
      _error = null;
      _requestId = null;
    });
    try {
      final response = await _transport.send(
        'GET',
        Uri.parse('$apiBaseUrl/api/ready'),
      );
      final readiness = parseReadiness(
        response.statusCode,
        jsonDecode(response.body),
      );
      if (!mounted || attempt != _attempt) return;
      setState(() {
        _error = readiness.error;
        _requestId = readiness.requestId;
        _loading = false;
      });
    } catch (error, stack) {
      assert(() {
        debugPrint(
          'API readiness failed (${error.runtimeType}): $error\n$stack',
        );
        return true;
      }());
      if (!mounted || attempt != _attempt) return;
      setState(() {
        _loading = false;
        _error = error is FormatException
            ? unexpectedResponseMessage
            : connectionErrorMessage;
      });
    } finally {
      if (attempt == _attempt) _checking = false;
    }
  }

  @override
  void dispose() {
    _attempt++;
    _transport.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('Velio')),
    body: SafeArea(
      child: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 520),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'Your next plan starts here.',
                  style: Theme.of(context).textTheme.headlineMedium,
                ),
                const SizedBox(height: 16),
                const Text(
                  'Check the shared API connection before joining an activity.',
                ),
                const SizedBox(height: 24),
                Semantics(
                  liveRegion: true,
                  child: Card(
                    child: Padding(
                      padding: const EdgeInsets.all(24),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: _loading
                            ? [
                                const Text('Checking API connection…'),
                                const SizedBox(height: 16),
                                const CircularProgressIndicator(),
                              ]
                            : _error != null
                            ? [
                                Text(
                                  'Connection unavailable',
                                  style: Theme.of(context).textTheme.titleLarge,
                                ),
                                const SizedBox(height: 8),
                                Text(_error!),
                                if (_requestId != null)
                                  Text('Request: $_requestId'),
                                const SizedBox(height: 16),
                                FilledButton(
                                  onPressed: _checkConnection,
                                  child: const Text('Retry connection'),
                                ),
                              ]
                            : [
                                Text(
                                  'API connected',
                                  style: Theme.of(context).textTheme.titleLarge,
                                ),
                                const SizedBox(height: 8),
                                const Text('PostgreSQL and Redis are ready.'),
                                const SizedBox(height: 16),
                                Text('Request: $_requestId'),
                              ],
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    ),
  );
}
