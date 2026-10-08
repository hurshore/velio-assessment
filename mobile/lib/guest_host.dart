import 'dart:async';
import 'dart:io';

import 'package:app_links/app_links.dart';
import 'package:flutter/material.dart';
import 'package:path_provider/path_provider.dart';

import 'guest_api.dart';
import 'guest_screen.dart';
import 'guest_session.dart';

class GuestHost extends StatefulWidget {
  const GuestHost({super.key});
  @override
  State<GuestHost> createState() => _GuestHostState();
}

class _GuestHostState extends State<GuestHost> {
  final _links = StreamController<Uri>.broadcast();
  StreamSubscription<Uri>? _nativeLinks;
  GuestSession? _session;
  GuestApi? _api;
  bool _linkReady = false;
  Uri? _pendingLink;
  String? _error;
  @override
  void initState() {
    super.initState();
    // Subscribe before asynchronous storage setup so a cold-start link cannot be lost.
    _nativeLinks = AppLinks().uriLinkStream.listen(
      (uri) {
        if (!_linkReady) {
          _pendingLink = uri;
        } else {
          _links.add(uri);
        }
      },
      onError: (Object _) {
        if (mounted) {
          setState(
            () => _error =
                'Could not open the app link. Enter its code after setup.',
          );
        }
      },
    );
    unawaited(_restore());
  }

  Future<void> _restore() async {
    try {
      final directory = await getApplicationSupportDirectory();
      final session = await GuestSession.open(
        File('${directory.path}/guest-v1.json'),
      );
      if (!mounted) return;
      setState(() {
        _session = session;
        _api ??= GuestApi();
        _error = null;
      });
      WidgetsBinding.instance.addPostFrameCallback((_) {
        _linkReady = true;
        if (mounted && _pendingLink != null) {
          _links.add(_pendingLink!);
          _pendingLink = null;
        }
      });
    } catch (_) {
      if (mounted) {
        setState(
          () => _error = 'Could not restore your saved guest session. Retry to preserve identity and pending requests.',
        );
      }
    }
  }

  @override
  void dispose() {
    _nativeLinks?.cancel();
    _links.close();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (_session case final session?) {
      return GuestScreen(session: session, api: _api!, links: _links.stream);
    }
    return Scaffold(
      appBar: AppBar(title: const Text('Velio')),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            children: [
              Text(_error ?? 'Restoring your guest session…'),
              if (_error != null)
                FilledButton(
                  onPressed: _restore,
                  child: const Text('Retry saved session'),
                ),
            ],
          ),
        ),
      ),
    );
  }
}
