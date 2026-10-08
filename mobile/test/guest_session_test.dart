import 'dart:io';
import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:velio_mobile/guest_api.dart';

import 'package:flutter_test/flutter_test.dart';
import 'package:velio_mobile/guest_session.dart';

void main() {
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
