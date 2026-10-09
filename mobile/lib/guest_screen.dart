import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:intl/intl.dart';
import 'package:timezone/timezone.dart' as tz;

import 'guest_api.dart';
import 'guest_session.dart';
import 'readiness.dart';

const unavailableMessages = {
  'full': 'The last spot has been taken. This activity is full.',
  'expired': 'This invitation has expired. Ask for a new link.',
  'started': 'This activity has already started.',
  'cancelled': 'This activity was cancelled.',
};
String failureMessage(Object error) {
  if (error is FormatException) return unexpectedResponseMessage;
  if (error is FileSystemException) {
    return 'Could not save your guest session. Check device storage and retry; your entered code is kept here.';
  }
  if (error is! ApiFailure) {
    return connectionErrorMessage;
  }
  final message = switch (error.code) {
    'INVALID_INVITE' =>
      'Invitation not found. Check the 12-character code and try again.',
    'SOLD_OUT' => 'The last spot was just taken. Your details are saved.',
    'INVITE_EXPIRED' => unavailableMessages['expired']!,
    'ACTIVITY_STARTED' => unavailableMessages['started']!,
    'ACTIVITY_UNAVAILABLE' => unavailableMessages['cancelled']!,
    'SELF_INVITE' => 'You cannot claim through your own invitation. Choose another demo identity.',
    'IDENTITY_REQUIRED' => 'Choose an existing demo identity to continue.',
    'IDEMPOTENCY_MISMATCH' => 'This saved request could not be reused. Check your confirmation before trying again.',
    _ => 'The request could not be completed. Please retry.',
  };
  return error.requestId.isEmpty
      ? message
      : '$message\nRequest: ${error.requestId}';
}

class GuestScreen extends StatefulWidget {
  const GuestScreen({
    super.key,
    required this.session,
    required this.api,
    required this.links,
  });
  final GuestSession session;
  final GuestApi api;
  final Stream<Uri> links;
  @override
  State<GuestScreen> createState() => _GuestScreenState();
}

class _GuestScreenState extends State<GuestScreen> with WidgetsBindingObserver {
  late final TextEditingController _code, _name;
  StreamSubscription<Uri>? _links;
  InvitePreview? _preview;
  DemoIdentity? _identity;
  List<DemoIdentity>? _identities;
  BookingState? _confirmation;
  String? _message;
  bool _busy = false,
      _eventFailure = false,
      _delivering = false,
      _checkedBooking = false,
      _uncertain = false;
  bool _claimBlocked = false, _stale = false;
  int _version = 0;
  Uri? _queuedLink;
  GuestSession get session => widget.session;
  GuestApi get api => widget.api;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _code = TextEditingController(text: session.code);
    _name = TextEditingController(text: session.displayName);
    _links = widget.links.listen(
      _openLink,
      onError: (Object _) {
        if (mounted) {
          setState(
            () => _message = 'Could not read the app link. Enter the invitation code instead.',
          );
        }
      },
    );
    if (session.code.isNotEmpty) unawaited(_load());
    unawaited(_deliver());
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      if (!_busy && _preview != null) unawaited(_load());
      unawaited(_deliver());
    }
  }

  Future<void> _openLink(Uri uri) async {
    bool supported;
    try {
      final journeys = uri.queryParametersAll['journey'];
      supported =
          uri.scheme == 'velio' &&
          uri.host == 'invite' &&
          uri.userInfo.isEmpty &&
          !uri.hasPort &&
          !uri.hasFragment &&
          uri.pathSegments.length == 1 &&
          isCode(uri.pathSegments.single) &&
          uri.queryParameters.keys.every((key) => key == 'journey') &&
          (journeys == null || (journeys.length == 1 && isId(journeys.single)));
    } on FormatException {
      supported = false;
    }
    if (!supported) {
      if (mounted) {
        setState(
          () => _message = 'Cannot open this invitation link. Use velio://invite/<12-character code> or enter the code below.',
        );
      }
      return;
    }
    if (_busy) {
      _queuedLink = uri;
      return;
    }
    _code.text = uri.pathSegments.single;
    await _load(linkedJourney: uri.queryParameters['journey']);
  }

  void _finish() {
    if (!mounted) return;
    setState(() => _busy = false);
    final link = _queuedLink;
    _queuedLink = null;
    if (link != null) unawaited(_openLink(link));
  }

  Future<void> _load({String? linkedJourney}) async {
    if (_busy) return;
    if (!isCode(_code.text)) {
      setState(
        () => _message = 'Enter a valid 12-character invitation code. Spaces and hyphens are allowed.',
      );
      return;
    }
    final version = ++_version;
    final sameInvitation = _preview?.code == normalizeCode(_code.text);
    setState(() {
      _busy = true;
      _message = null;
      if (!sameInvitation) {
        _preview = null;
        _confirmation = null;
      }
      _stale = sameInvitation;
      _checkedBooking = false;
      if (!sameInvitation) _uncertain = false;
      _identities = null;
      _claimBlocked = false;
    });
    try {
      await session.enter(_code.text, linkedJourney: linkedJourney);
      final preview = await api.preview(normalizeCode(_code.text));
      if (!mounted || version != _version) return;
      setState(() {
        _preview = preview;
        _stale = false;
      });
      final actor = session.actorId;
      // Capture the anonymous/selected context of this rendered preview before later identity setup.
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted && version == _version) {
          unawaited(_rendered(preview, actor));
        }
      });
      if (actor != null) {
        _identity = await api.identity(actor);
        await _lookup(preview, actor);
      }
    } catch (error) {
      if (!mounted || version != _version) return;
      setState(() => _message = failureMessage(error));
    } finally {
      _finish();
    }
  }

  Future<void> _rendered(InvitePreview preview, String? actor) async {
    try {
      final common = <String, dynamic>{
        'schemaVersion': 1,
        'source': 'client',
        'platform': 'mobile',
        'occurredAt': utcTimestamp(DateTime.now()),
        'journeyId': session.journeyId,
        'actorId': ?actor,
      };
      await session.enqueue({
        ...common,
        'id': newId(),
        'name': 'invite_opened',
        'inviteCode': preview.code,
        'displayedState': preview.state,
      });
      await session.enqueue({
        ...common,
        'id': newId(),
        'name': 'activity_viewed',
        'activityId': preview.activityId,
        'planId': preview.planId,
      });
      await _deliver();
    } catch (_) {
      if (mounted) setState(() => _eventFailure = true);
    }
  }

  Future<void> _deliver() async {
    if (_delivering) return;
    _delivering = true;
    try {
      await api.deliver(session);
      if (mounted) {
        setState(() => _eventFailure = session.pendingEvents.isNotEmpty);
      }
    } catch (_) {
      if (mounted) setState(() => _eventFailure = true);
    } finally {
      _delivering = false;
    }
  }

  Future<void> _choose() async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _message = null;
    });
    try {
      final identities = await api.identities();
      if (mounted) setState(() => _identities = identities);
    } catch (error) {
      if (mounted) setState(() => _message = failureMessage(error));
    } finally {
      _finish();
    }
  }

  Future<void> _select(DemoIdentity identity) async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _message = null;
      _confirmation = null;
      _checkedBooking = false;
    });
    try {
      await session.selectActor(identity.id);
      _claimBlocked = false;
      if (!mounted) return;
      setState(() {
        _identity = identity;
        _identities = null;
      });
      await _lookup(_preview!, identity.id);
    } catch (error) {
      if (mounted) setState(() => _message = failureMessage(error));
    } finally {
      _finish();
    }
  }

  Future<void> _create() async {
    if (_busy) return;
    if (_name.text.trim().isEmpty || _name.text.trim().length > 100) {
      setState(() => _message = 'Enter a display name of 1–100 characters.');
      return;
    }
    setState(() {
      _busy = true;
      _message = null;
    });
    try {
      await session.saveName(_name.text);
      final identity = await api.createIdentity(
        _name.text.trim(),
        _preview!.code,
        session.journeyId!,
      );
      await session.selectActor(identity.id);
      if (!mounted) return;
      setState(() {
        _identity = identity;
        _identities = null;
      });
      await _lookup(_preview!, identity.id);
    } catch (error) {
      if (mounted) {
        setState(
          () => _message =
              '${failureMessage(error)}\nIf identity creation had an uncertain response, select your name from the demo directory before creating again.',
        );
      }
    } finally {
      _finish();
    }
  }

  Future<void> _lookup(InvitePreview preview, String actor) async {
    if (mounted) {
      setState(() {
        _checkedBooking = false;
        _uncertain = session.hasPendingClaim(actor, preview.code);
      });
    }
    final result = await api.ownBooking(preview, actor);
    if (!mounted) return;
    _checkedBooking = true;
    if (result.booking != null) {
      final pending = session.hasPendingClaim(actor, preview.code);
      await _confirm(result, preview, actor, celebrate: pending);
    } else {
      setState(() => _uncertain = session.hasPendingClaim(actor, preview.code));
    }
  }

  Future<void> _confirm(
    BookingState result,
    InvitePreview preview,
    String actor, {
    required bool celebrate,
  }) async {
    if (!mounted) return;
    setState(() {
      _confirmation = result;
      _uncertain = false;
      _message = null;
    });
    // Confirmation stays valid even if local persistence or haptic delivery fails.
    try {
      await session.resolveClaim(actor, preview.code);
      if (celebrate &&
          await session.celebrate(result.booking!['id'] as String) &&
          mounted) {
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (mounted) {
            unawaited(HapticFeedback.lightImpact().catchError((Object _) {}));
          }
        });
      }
    } catch (_) {
      if (mounted) {
        setState(
          () => _message = 'Your seat is confirmed. Could not save local recovery state; select this identity again to recover it.',
        );
      }
    }
  }

  Future<void> _claim() async {
    if (_busy || _preview == null || _identity == null) return;
    final preview = _preview!;
    final actor = _identity!.id;
    var submitted = false;
    setState(() {
      _busy = true;
      _message = 'Checking your confirmation…';
    });
    try {
      // Always recover membership before creating or resending a booking intent.
      await _lookup(preview, actor);
      if (!mounted || _confirmation != null) return;
      if (preview.state != 'valid' &&
          !session.hasPendingClaim(actor, preview.code)) {
        return;
      }
      final key = await session.startClaim(actor, preview.code);
      if (!mounted) return;
      setState(() => _message = 'Claiming your seat…');
      submitted = true;
      final result = await api.claim(preview, actor, session.journeyId!, key);
      await _confirm(result, preview, actor, celebrate: !result.replayed);
    } catch (error) {
      if (!mounted) return;
      if (!submitted) {
        setState(() {
          _uncertain = session.hasPendingClaim(actor, preview.code);
          _message =
              '${failureMessage(error)}\nNo claim was submitted on this attempt.'
              '${_uncertain ? ' Your earlier pending request is still saved; check/retry confirmation.' : ''}';
        });
      } else if (error is ApiFailure &&
          !error.retryable &&
          error.code != 'IDEMPOTENCY_MISMATCH') {
        var resolved = false;
        try {
          await session.resolveClaim(actor, preview.code);
          resolved = true;
        } catch (_) {
          // Keep the durable intent until a later confirmation check can resolve it.
        }
        if (!mounted) return;
        setState(() {
          _message = failureMessage(error);
          if (!resolved) {
            _message =
                '$_message\nCould not save recovery state; your pending request is retained.';
          }
          _uncertain = !resolved;
          _claimBlocked =
              resolved &&
              [
                'SOLD_OUT',
                'INVITE_EXPIRED',
                'ACTIVITY_STARTED',
                'ACTIVITY_UNAVAILABLE',
              ].contains(error.code);
        });
      } else {
        setState(() {
          _uncertain = true;
          _message =
              '${failureMessage(error)}\nChecking your confirmation. The claim response was uncertain; your request key is saved.';
        });
        try {
          await _lookup(preview, actor);
        } catch (_) {
          if (mounted) {
            setState(
              () => _message =
                  '${failureMessage(error)}\nConfirmation is still uncertain. Check/retry with your saved request.',
            );
          }
        }
      }
    } finally {
      _finish();
    }
  }

  @override
  void dispose() {
    _version++;
    WidgetsBinding.instance.removeObserver(this);
    _links?.cancel();
    _code.dispose();
    _name.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('Velio · Join a plan')),
    body: SafeArea(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(24),
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 520),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                TextField(
                  controller: _code,
                  maxLength: 64,
                  enabled: !_busy,
                  decoration: const InputDecoration(
                    labelText: 'Invitation code',
                    hintText: 'ABCD-2345-EFGH',
                  ),
                  textCapitalization: TextCapitalization.characters,
                  autocorrect: false,
                  onSubmitted: _busy ? null : (_) => _load(),
                ),
                const SizedBox(height: 16),
                FilledButton(
                  onPressed: _busy ? null : _load,
                  child: const Text('View invitation'),
                ),
                if (_busy)
                  const Padding(
                    padding: EdgeInsets.all(16),
                    child: Text('Working… Please wait.'),
                  ),
                if (_message != null)
                  Semantics(liveRegion: true, child: Text(_message!)),
                if (_preview case final preview?) ..._details(preview),
                if (_eventFailure) ...[
                  const Text(
                    'Preview tracking is saved for retry. Your booking is unaffected.',
                  ),
                  TextButton(
                    onPressed: _deliver,
                    child: const Text('Retry saved events'),
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    ),
  );
  List<Widget> _details(InvitePreview preview) {
    final activity = preview.activity;
    final starts = tz.TZDateTime.from(
      timestamp(activity, 'startsAt'),
      tz.getLocation(activity['timezone'] as String),
    );
    final formatter = NumberFormat.currency(
      name: activity['currency'] as String,
    );
    final price = activity['priceMinor'] == 0
        ? 'Free'
        : formatter.format(
            (activity['priceMinor'] as int) /
                _minorScale(formatter.decimalDigits!),
          );
    final availability = _confirmation?.availability ?? preview.availability;
    return [
      const SizedBox(height: 24),
      Text(
        '${preview.inviter['displayName']} invited you · ${preview.inviter['role']}',
      ),
      Text(
        activity['title'] as String,
        style: Theme.of(context).textTheme.headlineMedium,
      ),
      const SizedBox(height: 12),
      const Text(
        'This public link is open to anyone. It is not a personal vouch and does not reserve a seat.',
      ),
      const SizedBox(height: 16),
      Text(activity['description'] as String),
      Text(activity['meetingLocation'] as String),
      Text(
        '${DateFormat('EEEE, d MMMM yyyy · HH:mm').format(starts)} (${activity['timezone']})',
      ),
      Text('$price · no payment is collected in this demo'),
      if (_stale)
        const Text(
          'Last fetched details. Availability may have changed; refresh before a new claim.',
        ),
      Text(
        '${availability.remainingSeats} of ${availability.capacity} seats open at last check · refresh for current availability',
      ),
      if (_confirmation case final confirmation?) ...[
        const SizedBox(height: 16),
        Semantics(
          liveRegion: true,
          child: Text(
            'Your seat is confirmed',
            style: Theme.of(context).textTheme.headlineSmall,
          ),
        ),
        Text(
          'You are a participant in this plan.\nPlan: ${preview.planId}\nBooking: ${confirmation.booking!['id']}',
        ),
        Text(
          'Confirmed price: ${confirmation.booking!['priceMinor']} minor units ${confirmation.booking!['currency']}',
        ),
        if (confirmation.telemetryDegraded)
          const Text('Your seat is confirmed; server tracking is delayed.'),
      ] else ...[
        if (preview.state != 'valid') Text(unavailableMessages[preview.state]!),
        if (_identity != null)
          Text('Selected demo identity: ${_identity!.displayName}'),
        TextButton(
          onPressed: _busy ? null : _choose,
          child: const Text('Choose demo identity'),
        ),
        if (_identities != null) ...[
          const Text(
            'Demo identity selection is for this assessment; it is not authentication.',
          ),
          for (final identity in _identities!)
            OutlinedButton(
              onPressed: _busy ? null : () => _select(identity),
              child: Text(identity.displayName),
            ),
          if (preview.state == 'valid') ...[
            TextField(
              controller: _name,
              enabled: !_busy,
              decoration: const InputDecoration(labelText: 'Your display name'),
              maxLength: 100,
            ),
            FilledButton(
              onPressed: _busy ? null : _create,
              child: const Text('Create demo identity'),
            ),
          ],
        ],
        if (_identity != null)
          FilledButton(
            onPressed:
                _busy ||
                    _claimBlocked ||
                    (_stale && !_uncertain) ||
                    (!_uncertain &&
                        (preview.state != 'valid' || !_checkedBooking))
                ? null
                : _claim,
            child: Text(
              _uncertain ? 'Check / retry confirmation' : 'Claim my seat',
            ),
          ),
        if (_identity != null && !_checkedBooking)
          TextButton(
            onPressed: _busy ? null : _load,
            child: const Text('Check existing booking'),
          ),
      ],
    ];
  }

  int _minorScale(int digits) {
    var scale = 1;
    for (var i = 0; i < digits; i++) {
      scale *= 10;
    }
    return scale;
  }
}
