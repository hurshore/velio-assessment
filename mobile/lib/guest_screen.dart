import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:intl/intl.dart';
import 'package:timezone/timezone.dart' as tz;

import 'guest_api.dart';
import 'guest_session.dart';
import 'guest_live.dart';
import 'readiness.dart';
import 'velio_theme.dart';

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
    'RECIPIENT_MISMATCH' => 'This vouch is for one intended contact. Choose the identity registered with that same demo contact, or create it with the matching contact. The contact is never shown in this preview.',
    'ALREADY_REDEEMED' => 'This vouch has already been used. Its matching recipient can reopen their existing confirmation.',
    'CONTACT_IN_USE' => 'That demo contact is already registered. Select its existing identity instead of creating another.',
    'INVALID_REQUEST' => 'Check your entered details. Use a valid email or a phone number in the same format as the inviter.',
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
    this.liveConnect = connectLive,
  });
  final GuestSession session;
  final GuestApi api;
  final Stream<Uri> links;
  final Future<LiveSocket> Function(Uri) liveConnect;
  @override
  State<GuestScreen> createState() => _GuestScreenState();
}

class _GuestScreenState extends State<GuestScreen> with WidgetsBindingObserver {
  late final TextEditingController _code, _name, _contact;
  final _scroll = ScrollController();
  StreamSubscription<Uri>? _links;
  Timer? _refresh;
  InvitePreview? _preview;
  DemoIdentity? _identity;
  List<DemoIdentity>? _identities;
  BookingState? _confirmation;
  GuestLive? _live;
  String? _liveActivity;
  final _clientId = newId();
  List<Map<String, dynamic>> _participants = [];
  String? _savedAt;
  int _participantVersion = 0;
  bool _foreground = true, _liveReady = false, _recipientMatched = true;
  String? _message;
  bool _busy = false,
      _eventFailure = false,
      _delivering = false,
      _checkedBooking = false,
      _uncertain = false;
  bool _claimBlocked = false, _stale = false;
  int _version = 0, _selectionVersion = 0;
  Uri? _queuedLink;
  GuestSession get session => widget.session;
  GuestApi get api => widget.api;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    final lifecycle = WidgetsBinding.instance.lifecycleState;
    _foreground = lifecycle == null || lifecycle == AppLifecycleState.resumed;
    _code = TextEditingController(text: session.code);
    _name = TextEditingController(text: session.displayName);
    _contact = TextEditingController(text: session.contact);
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
    _refresh = Timer.periodic(const Duration(seconds: 3), (_) {
      if (mounted &&
          _foreground &&
          !_busy &&
          _live == null &&
          _stale &&
          session.code.isNotEmpty &&
          normalizeCode(_code.text) == session.code) {
        unawaited(_load());
      }
    });
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _foreground = state == AppLifecycleState.resumed;
    _stopLive();
    if (mounted) {
      setState(() {
        _stale = true;
        _liveReady = false;
      });
    }
    if (_foreground) {
      if (!_busy && session.code.isNotEmpty) unawaited(_load());
      unawaited(_deliver());
    }
  }

  void _stopLive() {
    _live?.dispose();
    _live = null;
    _liveActivity = null;
    _liveReady = false;
  }

  void _startLive(InvitePreview preview) {
    if (!_foreground || !mounted || _liveActivity == preview.activityId) return;
    _stopLive();
    final currentVersion = _version;
    final uri = Uri.parse('${api.baseUrl}/api/live');
    late final GuestLive live;
    live = GuestLive(
      uri: uri.replace(scheme: uri.scheme == 'https' ? 'wss' : 'ws'),
      subscription: {
        'activityId': preview.activityId,
        'clientId': _clientId,
        'foreground': true,
        'platform': 'mobile',
        'journeyId': session.journeyId,
        'inviteCode': preview.code,
        'actorId': ?session.actorId,
      },
      preview: preview,
      connect: widget.liveConnect,
      onStale: () {
        if (mounted && currentVersion == _version) {
          setState(() {
            _liveReady = false;
            _stale = true;
          });
        }
      },
      onSnapshot: (snapshot) {
        if (!mounted || !_foreground || currentVersion != _version) return;
        final previous = _preview!;
        final reconnecting = !_liveReady;
        final receivedVersion = snapshot.activity.availability.version;
        final visibleVersion = previous.availability.version;
        if (receivedVersion < visibleVersion ||
            receivedVersion < (_confirmation?.availability.version ?? 0)) {
          _acknowledgeAfterFrame(live, snapshot, currentVersion);
          return;
        }
        setState(() {
          if (receivedVersion > visibleVersion ||
              previous.state != snapshot.activity.state) {
            _preview = snapshot.activity;
          }
          if (receivedVersion >= _participantVersion) {
            _participants = snapshot.participants;
            _participantVersion = receivedVersion;
          }
          _liveReady = true;
          _stale = false;
        });
        unawaited(_saveDetails());
        _acknowledgeAfterFrame(live, snapshot, currentVersion);
        if (reconnecting && !_busy && session.actorId != null) {
          unawaited(_refreshOwn());
        }
      },
    );
    _live = live;
    _liveActivity = preview.activityId;
    live.start();
  }

  void _acknowledgeAfterFrame(
    GuestLive live,
    LiveSnapshot snapshot,
    int renderVersion,
  ) {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted &&
          _foreground &&
          renderVersion == _version &&
          !_stale &&
          identical(_live, live)) {
        live.acknowledge(snapshot);
      }
    });
  }

  Future<void> _refreshOwn() async {
    if (_busy || _preview == null || session.actorId == null) return;
    setState(() => _busy = true);
    try {
      final actor = session.actorId!;
      final identity = await api.identity(actor);
      if (!mounted) return;
      setState(() => _identity = identity);
      await _lookup(_preview!, actor);
      final matches =
          _confirmation != null || await api.recipientMatches(_preview!, actor);
      if (mounted) setState(() => _recipientMatched = matches);
    } catch (error) {
      if (mounted) {
        setState(() {
          _checkedBooking = false;
          _message = failureMessage(error);
        });
      }
    } finally {
      _finish();
    }
  }

  Future<void> _saveDetails() async {
    final preview = _preview;
    if (preview == null) return;
    try {
      await session.saveDetails(
        preview.code,
        preview.toJson(),
        _participants,
        booking: _confirmation?.booking,
        participantVersion: _participantVersion,
      );
      if (mounted && _preview?.code == preview.code) {
        setState(
          () => _savedAt = session.cached(preview.code)?['savedAt'] as String?,
        );
      }
    } catch (_) {
      if (mounted) {
        setState(
          () => _message = 'Could not save these details for offline use. Your booking remains valid.',
        );
      }
    }
  }

  void _restoreDetails(String code) {
    final cached = session.cached(code);
    if (cached == null) return;
    try {
      final preview = InvitePreview(object(cached['preview']));
      if (preview.code != normalizeCode(code)) {
        throw const FormatException('Cached code mismatch');
      }
      _preview = preview;
      _savedAt = cached['savedAt'] as String;
      _participants = (cached['participants'] as List).map((value) {
        final person = object(value);
        return <String, dynamic>{
          'id': identifier(person, 'id'),
          'displayName': text(person, 'displayName'),
        };
      }).toList();
      _participantVersion =
          cached['participantVersion'] as int? ??
          (_participants.length == preview.availability.confirmedCount
              ? preview.availability.version
              : 0);
      final booking = cached['booking'];
      if (booking is Map && booking['userId'] == session.actorId) {
        _confirmation = BookingState(
          {
            'booking': booking,
            'availability': {
              'activityId': preview.activityId,
              'planId': preview.planId,
              ...preview.activity,
            },
          },
          preview,
          session.actorId!,
        );
      }
    } catch (_) {
      _preview = null;
      _confirmation = null;
      _participants = [];
      _message =
          'Saved details are unreadable. Reconnect and retry to refresh them.';
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
    if (link != null) {
      unawaited(_openLink(link));
    } else if (_foreground && _preview != null && _live == null && !_stale) {
      _startLive(_preview!);
    }
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
    _stopLive();
    final sameInvitation = _preview?.code == normalizeCode(_code.text);
    setState(() {
      _busy = true;
      _message = null;
      if (_confirmation != null &&
          _confirmation?.booking?['userId'] != session.actorId) {
        _confirmation = null;
      }
      if (_identity != null && _identity!.id != session.actorId) {
        _identity = null;
      }
      if (!sameInvitation) {
        _preview = null;
        _confirmation = null;
        _participants = [];
        _participantVersion = 0;
        _savedAt = null;
        _identity = null;
        _restoreDetails(normalizeCode(_code.text));
      }
      _stale = true;
      _checkedBooking = false;
      if (!sameInvitation) _uncertain = false;
      _identities = null;
      _claimBlocked = false;
      _recipientMatched = true;
    });
    final savedPreview = sameInvitation ? null : _preview;
    final savedActor = session.actorId;
    if (savedPreview != null) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted &&
            _foreground &&
            version == _version &&
            identical(_preview, savedPreview)) {
          unawaited(_rendered(savedPreview, savedActor));
        }
      });
    }
    try {
      await session.enter(_code.text, linkedJourney: linkedJourney);
      final preview = await api.preview(normalizeCode(_code.text));
      if (!mounted || version != _version) return;
      setState(() {
        if (_preview == null ||
            preview.availability.version >= _preview!.availability.version) {
          _preview = preview;
        }
        _stale = false;
      });
      if (!sameInvitation) _showSummary();
      await _saveDetails();
      final actor = session.actorId;
      // Capture the anonymous/selected context of this rendered preview before later identity setup.
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted && _foreground && version == _version) {
          unawaited(_rendered(preview, actor));
        }
      });
      if (actor != null) {
        _identity = await api.identity(actor);
        await _lookup(preview, actor);
        if (_confirmation == null) {
          _recipientMatched = await api.recipientMatches(preview, actor);
        }
      }
      if (mounted && version == _version) _startLive(_preview!);
    } catch (error) {
      if (!mounted || version != _version) return;
      setState(() {
        _stale = true;
        _message =
            _preview == null &&
                error is! ApiFailure &&
                error is! FormatException &&
                error is! FileSystemException
            ? 'No saved details for this invitation yet. Connect to the internet and retry. Your code is kept.'
            : failureMessage(error);
      });
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
    if (_busy || _preview == null) return;
    final preview = _preview!;
    final version = _version;
    final selection = ++_selectionVersion;
    bool current() =>
        mounted && version == _version && selection == _selectionVersion;
    setState(() {
      _busy = true;
      _message = null;
    });
    try {
      // Candidate checks must not publish state belonging to an unaccepted actor.
      final result = await api.ownBooking(preview, identity.id);
      if (!current()) return;
      final matches =
          result.booking != null ||
          await api.recipientMatches(preview, identity.id);
      if (!current()) return;
      if (!matches) {
        setState(
          () => _message = failureMessage(
            ApiFailure('RECIPIENT_MISMATCH', false, ''),
          ),
        );
        return;
      }
      await session.selectActor(identity.id);
      if (!current()) return;
      _stopLive();
      setState(() {
        _identity = identity;
        _identities = null;
        _recipientMatched = true;
        _claimBlocked = false;
        _checkedBooking = true;
        _uncertain = session.hasPendingClaim(identity.id, preview.code);
        _confirmation = null;
      });
      if (result.booking != null) {
        await _confirm(result, preview, identity.id, celebrate: _uncertain);
      }
      if (current()) _startLive(_preview!);
    } catch (error) {
      if (current()) setState(() => _message = failureMessage(error));
    } finally {
      if (current()) _finish();
    }
  }

  Future<void> _recoverPending(PendingClaim intent) async {
    if (_busy) return;
    final version = _version;
    final selection = ++_selectionVersion;
    bool current() =>
        mounted && version == _version && selection == _selectionVersion;
    setState(() {
      _busy = true;
      _message = null;
    });
    try {
      await session.selectActor(intent.actorId);
      if (!current()) return;
      _code.text = intent.code;
      setState(() => _busy = false);
      await _load();
    } catch (error) {
      if (current()) {
        setState(
          () => _message = error is FileSystemException
              ? 'Could not switch to the saved claim because local storage could not be updated. Free device storage and retry. Your earlier pending request and its original key are retained.'
                    '${_confirmation != null ? ' Your current server-confirmed booking remains valid.' : ' No booking request was sent.'}'
              : failureMessage(error),
        );
      }
    } finally {
      if (current()) _finish();
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
      await session.saveContact(_contact.text);
      final identity = await api.createIdentity(
        _name.text.trim(),
        _preview!.code,
        session.journeyId!,
        contact: _contact.text,
      );
      await session.selectActor(identity.id);
      _stopLive();
      if (!mounted) return;
      setState(() {
        _identity = identity;
        _identities = null;
        _recipientMatched = true;
      });
      await _lookup(_preview!, identity.id);
      _startLive(_preview!);
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
      setState(() {
        _confirmation = null;
        _uncertain = session.hasPendingClaim(actor, preview.code);
      });
    }
  }

  void _showSummary() {
    FocusScope.of(context).unfocus();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && _scroll.hasClients) _scroll.jumpTo(0);
    });
  }

  Future<void> _confirm(
    BookingState result,
    InvitePreview preview,
    String actor, {
    required bool celebrate,
  }) async {
    if (!mounted) return;
    final newlyConfirmed = _confirmation == null;
    setState(() {
      _confirmation = result;
      _uncertain = false;
      _message = null;
    });
    if (newlyConfirmed) _showSummary();
    await _saveDetails();
    // Confirmation stays valid even if local persistence or haptic delivery fails.
    try {
      await session.resolveClaim(actor, preview.code);
      if (celebrate &&
          await session.celebrate(result.booking!['id'] as String) &&
          mounted) {
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (mounted && _foreground) {
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
    if (!_foreground ||
        (!_uncertain && (_stale || !_liveReady || !_recipientMatched))) {
      return;
    }
    if (session.pendingClaims.any(
      (intent) => !intent.matches(_identity!.id, _preview!.code),
    )) {
      return;
    }
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
      if (!_foreground || (!_uncertain && (_stale || !_liveReady))) return;
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
                'RECIPIENT_MISMATCH',
                'ALREADY_REDEEMED',
                'SELF_INVITE',
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
    _refresh?.cancel();
    _stopLive();
    _scroll.dispose();
    _code.dispose();
    _name.dispose();
    _contact.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      title: const Text.rich(
        TextSpan(
          text: 'velio',
          children: [
            TextSpan(
              text: '.',
              style: TextStyle(color: VelioTheme.brandDot),
            ),
          ],
        ),
        style: TextStyle(
          fontWeight: FontWeight.w800,
          fontSize: 28,
          letterSpacing: -1,
        ),
      ),
    ),
    body: SafeArea(
      child: SingleChildScrollView(
        controller: _scroll,
        padding: const EdgeInsets.all(24),
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 520),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (_preview case final preview?) ..._details(preview),
                if (_preview == null) ...[
                  const SizedBox(height: 32),
                  const Icon(
                    Icons.people_outline_rounded,
                    size: 64,
                    color: VelioTheme.purple,
                  ),
                  const SizedBox(height: 32),
                  Text(
                    'Good company is one invitation away.',
                    style: Theme.of(context).textTheme.headlineLarge,
                  ),
                  const SizedBox(height: 16),
                  const Text(
                    'Enter your code to see the plan. You can explore the details before choosing an identity.',
                  ),
                  const SizedBox(height: 32),
                ] else ...[
                  const SizedBox(height: 32),
                  Text(
                    'Have another invitation?',
                    style: Theme.of(context).textTheme.titleLarge,
                  ),
                  const SizedBox(height: 16),
                ],
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
                  Semantics(
                    liveRegion: true,
                    child: Text(
                      _message!
                          .split('\n')
                          .where((line) => !line.startsWith('Request: '))
                          .join('\n'),
                    ),
                  ),
                if (_message?.contains('Request: ') ?? false)
                  ExpansionTile(
                    title: const Text('Technical error details'),
                    children: [
                      SelectableText(
                        _message!
                            .split('\n')
                            .where((line) => line.startsWith('Request: '))
                            .join('\n'),
                      ),
                    ],
                  ),
                for (final intent in session.pendingClaims.where(
                  (intent) => !intent.matches(session.actorId, _preview?.code),
                )) ...[
                  const Text(
                    'An earlier claim is still uncertain. Recover it before claiming another seat.',
                  ),
                  TextButton(
                    onPressed: _busy ? null : () => _recoverPending(intent),
                    child: const Text('Recover earlier confirmation'),
                  ),
                ],
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
    final price = _price(activity);
    final availability =
        (_confirmation?.availability.version ?? 0) >
            preview.availability.version
        ? _confirmation!.availability
        : preview.availability;
    return [
      const SizedBox(height: 16),
      Chip(
        avatar: Icon(
          preview.rail == 'vouch' ? Icons.favorite_outline : Icons.north_east,
          size: 18,
        ),
        label: Text('${preview.inviter['displayName']} invited you'),
      ),
      const SizedBox(height: 16),
      Text(
        activity['title'] as String,
        style: Theme.of(context).textTheme.headlineMedium,
      ),
      const SizedBox(height: 16),
      if (_confirmation case final confirmation?) ...[
        const SizedBox(height: 16),
        Semantics(
          liveRegion: true,
          child: Text(
            'Your seat is confirmed',
            style: Theme.of(context).textTheme.headlineSmall,
          ),
        ),
        const Text('You’re on the list. Make time for good company.'),
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 12),
          child: ExpansionTile(
            title: const Text('Booking reference'),
            children: [
              SelectableText(
                'Plan: ${preview.planId}\nBooking: ${confirmation.booking!['id']}',
              ),
              Text('Confirmed price: ${_price(confirmation.booking!)}'),
            ],
          ),
        ),
        if (confirmation.telemetryDegraded)
          const Text('Your seat is confirmed; server tracking is delayed.'),
      ],
      if (_stale)
        const Text(
          'Saved/offline details. Availability may have changed; reconnect and refresh before a new claim. Offline claims are not queued.',
        ),
      if (_savedAt != null && _stale) Text('Saved at $_savedAt'),
      Text(
        _liveReady ? 'Live availability connected.' : 'Live availability disconnected or refreshing. New claims wait for a fresh snapshot.',
      ),
      Text(
        '${availability.remainingSeats} of ${availability.capacity} seats open at last check · refresh for current availability',
      ),
      const SizedBox(height: 16),
      _surface([
        Text(activity['description'] as String),
        const SizedBox(height: 20),
        _fact(
          Icons.calendar_today_outlined,
          '${DateFormat('EEEE, d MMMM yyyy · HH:mm').format(starts)} (${activity['timezone']})',
        ),
        _fact(Icons.place_outlined, activity['meetingLocation'] as String),
        _fact(Icons.payments_outlined, price),
        _fact(
          Icons.people_outline,
          '${availability.remainingSeats} of ${availability.capacity} spots available',
        ),
      ]),
      const SizedBox(height: 16),
      if (_confirmation == null) ...[
        if (preview.state != 'valid')
          _surface([
            Text(unavailableMessages[preview.state]!),
            const Text(
              'Already booked? Choose your original identity to recover confirmation.',
            ),
          ], guidance: true),
        if (_identity != null)
          Text('Selected demo identity: ${_identity!.displayName}'),
        if (!_recipientMatched)
          Text(failureMessage(ApiFailure('RECIPIENT_MISMATCH', false, ''))),
        TextButton(
          onPressed: _busy ? null : _choose,
          child: const Text('Choose demo identity'),
        ),
        if (_identities != null) ...[
          const Text(
            'Demo identity selection is for this assessment; it is not authentication.',
          ),
          if (preview.state == 'valid') ...[
            TextField(
              controller: _name,
              enabled: !_busy,
              decoration: const InputDecoration(labelText: 'Your display name'),
              maxLength: 100,
              onChanged: (value) => unawaited(
                session.saveName(value).catchError((Object _) {
                  if (mounted) {
                    setState(
                      () => _message = 'Could not save your entered name.',
                    );
                  }
                }),
              ),
            ),
            TextField(
              controller: _contact,
              enabled: !_busy,
              maxLength: 254,
              decoration: const InputDecoration(
                labelText: 'Your demo contact (optional)',
              ),
              onChanged: (value) => unawaited(
                session.saveContact(value).catchError((Object _) {
                  if (mounted) {
                    setState(
                      () => _message = 'Could not save your entered contact.',
                    );
                  }
                }),
              ),
            ),
            const Text(
              'For a vouch, enter the intended contact. Email case and outer spaces are ignored; phone spaces, dashes, dots and parentheses are ignored. No country format is inferred: use the same saved phone format. Public links need no contact.',
            ),
            FilledButton(
              onPressed: _busy ? null : _create,
              child: const Text('Create demo identity'),
            ),
          ],
          const SizedBox(height: 24),
          Text(
            'Or choose an existing demo identity',
            style: Theme.of(context).textTheme.titleLarge,
          ),
          for (final identity in _identities!)
            OutlinedButton(
              onPressed: _busy ? null : () => _select(identity),
              child: Text(identity.displayName),
            ),
        ],
        if (_identity != null)
          FilledButton(
            onPressed:
                _busy ||
                    _claimBlocked ||
                    !_foreground ||
                    session.pendingClaims.any(
                      (intent) => !intent.matches(_identity!.id, preview.code),
                    ) ||
                    (!_uncertain && (!_liveReady || !_recipientMatched)) ||
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
      const SizedBox(height: 16),
      _surface([
        Text(
          preview.rail == 'vouch'
              ? 'A personal introduction'
              : 'An open invitation',
          style: Theme.of(context).textTheme.titleLarge,
        ),
        const SizedBox(height: 8),
        Text(
          preview.rail == 'vouch'
              ? 'This is a personal vouch for one intended contact. Choose the identity with that matching demo contact. No seat is reserved.'
              : 'Anyone with this public link can claim an available spot. No seat is reserved.',
        ),
      ], guidance: true),
      const SizedBox(height: 20),
      const SizedBox(height: 16),
      Text(
        'Confirmed participants',
        style: Theme.of(context).textTheme.titleLarge,
      ),
      const SizedBox(height: 8),
      if (_participants.isEmpty)
        Text(
          _stale
              ? 'No saved participant list.'
              : _liveReady
              ? 'No confirmed participants yet.'
              : 'Waiting for the live participant list…',
        ),
      for (final participant in _participants)
        ListTile(
          contentPadding: EdgeInsets.zero,
          leading: CircleAvatar(
            backgroundColor: VelioTheme.lavender,
            child: Text((participant['displayName'] as String).substring(0, 1)),
          ),
          title: Text(participant['displayName'] as String),
        ),
      const SizedBox(height: 24),
      const ExpansionTile(
        title: Text('About this demo'),
        children: [
          Padding(
            padding: EdgeInsets.all(16),
            child: Text(
              'Demo identities and contacts are unverified. Matching simulates a personal introduction, not authentication. No payment is collected. Confirmed participants do not prove attendance.',
            ),
          ),
        ],
      ),
    ];
  }

  Widget _surface(List<Widget> children, {bool guidance = false}) => Container(
    padding: const EdgeInsets.all(24),
    decoration: BoxDecoration(
      color: guidance ? VelioTheme.lavender : Colors.white,
      borderRadius: BorderRadius.circular(28),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: children,
    ),
  );

  Widget _fact(IconData icon, String text) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 8),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(icon, size: 20, color: VelioTheme.purple),
        const SizedBox(width: 12),
        Expanded(child: Text(text)),
      ],
    ),
  );

  String _price(Map<String, dynamic> source) {
    if (source['priceMinor'] == 0) return 'Free';
    final formatter = NumberFormat.currency(name: source['currency'] as String);
    return formatter.format(
      (source['priceMinor'] as int) / _minorScale(formatter.decimalDigits!),
    );
  }

  int _minorScale(int digits) {
    var scale = 1;
    for (var i = 0; i < digits; i++) {
      scale *= 10;
    }
    return scale;
  }
}
