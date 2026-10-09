import 'dart:io';
import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:velio_mobile/guest_api.dart';

import 'package:flutter_test/flutter_test.dart';
import 'package:velio_mobile/guest_session.dart';

void main() {
  test(
    'invalid and oversized codes preserve the valid draft on disk',
    () async {
      final directory = await Directory.systemTemp.createTemp('velio-code-');
      addTearDown(() => directory.delete(recursive: true));
      final file = File('${directory.path}/guest.json');
      final session = await GuestSession.open(file);
      await session.enter('abcd-2345-efgh');
      final original = await file.readAsString();
      for (final invalid in ['bad', '${' ' * 1000}ABCD2345EFGH']) {
        await expectLater(session.enter(invalid), throwsFormatException);
        expect(await file.readAsString(), original);
        expect(session.code, 'ABCD2345EFGH');
      }
    },
  );
  test(
    'invalid nested sessions fail before use and preserve recovery bytes',
    () async {
      final directory = await Directory.systemTemp.createTemp('velio-invalid-');
      addTearDown(() => directory.delete(recursive: true));
      final file = File('${directory.path}/guest.json');
      const intent = '33333333-3333-4333-8333-333333333333:ABCD2345EFGH';
      for (final data in [
        {'journeyId': 1},
        {'actorId': []},
        {'code': 12},
        {'code': 'bad'},
        {'displayName': {}},
        {'events': {}},
        {
          'events': [1],
        },
        {
          'events': [
            {'id': 'bad'},
          ],
        },
        {'claimKeys': []},
        {
          'claimKeys': {intent: 1},
        },
        {
          'claimKeys': {'bad': newId()},
        },
        {
          'pendingClaims': [intent],
        },
        {
          'pendingClaims': [1],
        },
        {
          'celebrated': [1],
        },
        {
          'celebrated': ['bad'],
        },
      ]) {
        final bytes = jsonEncode(data);
        await file.writeAsString(bytes);
        await expectLater(GuestSession.open(file), throwsFormatException);
        expect(await file.readAsString(), bytes);
      }
    },
  );
  test(
    'corrupt queued event envelopes are rejected without rewriting the file',
    () async {
      final directory = await Directory.systemTemp.createTemp(
        'velio-event-invalid-',
      );
      addTearDown(() => directory.delete(recursive: true));
      final file = File('${directory.path}/guest.json');
      final journey = newId();
      final event = <String, dynamic>{
        'id': newId(),
        'name': 'invite_opened',
        'schemaVersion': 1,
        'source': 'client',
        'platform': 'mobile',
        'journeyId': journey,
        'occurredAt': '2026-10-09T12:00:00Z',
        'inviteCode': 'ABCD2345EFGH',
        'displayedState': 'valid',
      };
      for (final corrupt in [
        {...event, 'occurredAt': '2026-10-09'},
        {...event, 'occurredAt': '2026-02-30T12:00:00Z'},
        {...event, 'occurredAt': '2026-10-09T12:00:00+99:99'},
        {...event, 'occurredAt': '2026-10-09T12:00:00+24:00'},
        {...event, 'unexpected': true},
        {...event, 'test': 'true'},
        {...event, 'actorId': 1},
        {...event, 'schemaVersion': '1'},
      ]) {
        final bytes = jsonEncode({
          'journeyId': journey,
          'events': [corrupt],
        });
        await file.writeAsString(bytes);
        await expectLater(GuestSession.open(file), throwsFormatException);
        expect(await file.readAsString(), bytes);
      }
    },
  );
  test(
    'failed pending resolution retains the durable intent and original key',
    () async {
      final directory = await Directory.systemTemp.createTemp('velio-resolve-');
      addTearDown(() => directory.delete(recursive: true));
      final file = File('${directory.path}/guest.json');
      final session = await GuestSession.open(file);
      const actor = '33333333-3333-4333-8333-333333333333';
      await session.enter('ABCD2345EFGH');
      final key = await session.startClaim(actor, 'ABCD2345EFGH');
      final original = await file.readAsString();
      final obstruction = await Directory('${file.path}.tmp').create();
      await expectLater(
        session.resolveClaim(actor, 'ABCD2345EFGH'),
        throwsA(isA<FileSystemException>()),
      );
      expect(session.hasPendingClaim(actor, 'ABCD2345EFGH'), isTrue);
      expect(await file.readAsString(), original);
      await obstruction.delete();
      final restored = await GuestSession.open(file);
      expect(await restored.startClaim(actor, 'ABCD2345EFGH'), key);
    },
  );
  test(
    'restart retains linked journey, actor, draft, and the original claim key',
    () async {
      final directory = await Directory.systemTemp.createTemp('velio-session-');
      addTearDown(() => directory.delete(recursive: true));
      final file = File('${directory.path}/guest.json');
      const journey = '44444444-4444-4444-8444-444444444444';
      const actor = '33333333-3333-4333-8333-333333333333';
      var session = await GuestSession.open(file);
      await session.enter('ABCD2345EFGH', linkedJourney: journey);
      await session.saveName('Tunde');
      await session.selectActor(actor);
      final key = await session.claimKey(actor, 'ABCD2345EFGH');
      session = await GuestSession.open(file);
      await session.enter(
        'ABCD2345EFGH',
        linkedJourney: '55555555-5555-4555-8555-555555555555',
      );
      expect(session.journeyId, journey);
      expect(session.actorId, actor);
      expect(session.displayName, 'Tunde');
      expect(await session.claimKey(actor, 'ABCD2345EFGH'), key);
      expect(await session.claimKey(actor, '123456789ABC'), isNot(key));
    },
  );
  test(
    'event response loss retries the exact persisted envelope after restart',
    () async {
      final directory = await Directory.systemTemp.createTemp('velio-events-');
      addTearDown(() => directory.delete(recursive: true));
      final file = File('${directory.path}/guest.json');
      var session = await GuestSession.open(file);
      await session.enter('ABCD2345EFGH');
      final event = <String, dynamic>{
        'id': newId(),
        'name': 'invite_opened',
        'schemaVersion': 1,
        'occurredAt': '2026-10-09T12:00:00Z',
        'source': 'client',
        'platform': 'mobile',
        'journeyId': session.journeyId,
        'inviteCode': 'ABCD2345EFGH',
        'displayedState': 'full',
      };
      await session.enqueue(event);
      final received = <Map<String, dynamic>>[];
      var fail = true;
      final client = MockClient((request) async {
        received.add(jsonDecode(request.body) as Map<String, dynamic>);
        if (fail) throw http.ClientException('Lost accepted response');
        return http.Response(
          jsonEncode({
            'data': {'id': event['id'], 'accepted': false},
            'requestId': 'dedup-reference',
          }),
          202,
        );
      });
      final api = GuestApi(client: client);
      addTearDown(() {
        api.dispose();
        client.close();
      });
      await expectLater(
        api.deliver(session),
        throwsA(isA<http.ClientException>()),
      );
      session = await GuestSession.open(file);
      fail = false;
      await api.deliver(session);
      expect(received, [event, event]);
      expect((await GuestSession.open(file)).pendingEvents, isEmpty);
    },
  );
}
